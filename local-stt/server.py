from __future__ import annotations

import asyncio
import json
import os
import re
import site
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

def add_nvidia_dll_directories() -> None:
    roots = site.getsitepackages() + [site.getusersitepackages()]
    for root in roots:
        nvidia_root = Path(root) / "nvidia"
        for relative_path in ("cublas/bin", "cudnn/bin", "cuda_nvrtc/bin"):
            dll_dir = nvidia_root / relative_path
            if not dll_dir.exists():
                continue
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(dll_dir))
            os.environ["PATH"] = str(dll_dir) + os.pathsep + os.environ.get("PATH", "")


add_nvidia_dll_directories()

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

try:
    from qwen_asr import Qwen3ASRModel
except Exception as exc:  # pragma: no cover - reported to the websocket client at runtime.
    Qwen3ASRModel = None
    QWEN_IMPORT_ERROR = exc
else:
    QWEN_IMPORT_ERROR = None

try:
    from faster_whisper import WhisperModel
except Exception as exc:  # pragma: no cover - reported to the websocket client at runtime.
    WhisperModel = None
    WHISPER_IMPORT_ERROR = exc
else:
    WHISPER_IMPORT_ERROR = None


HEBREW_DIACRITICS = re.compile(r"[\u0591-\u05C7]")
PUNCTUATION_OR_SYMBOLS = re.compile(r"[^\w\s]", re.UNICODE)
MULTIPLE_SPACES = re.compile(r"\s+")

app = FastAPI(title="IAF Local Hebrew STT")

_model: Optional[Any] = None
_faster_whisper_model: Optional[Any] = None
_faster_whisper_runtime: Dict[str, Any] = {}
_model_lock = threading.RLock()


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def get_model() -> Any:
    global _model

    if Qwen3ASRModel is None:
        raise RuntimeError(f"Could not import qwen_asr: {QWEN_IMPORT_ERROR}")

    with _model_lock:
        if _model is None:
            model_name = os.getenv("LOCAL_STT_MODEL", "OzLabs/Caspi-1.7B")
            gpu_memory_utilization = env_float("LOCAL_STT_GPU_MEMORY_UTILIZATION", 0.9)
            _model = Qwen3ASRModel.LLM(
                model=model_name,
                gpu_memory_utilization=gpu_memory_utilization,
                max_new_tokens=env_int("LOCAL_STT_MAX_NEW_TOKENS", 32),
            )
        return _model


def get_faster_whisper_model() -> Any:
    global _faster_whisper_model, _faster_whisper_runtime

    if WhisperModel is None:
        raise RuntimeError(f"Could not import faster_whisper: {WHISPER_IMPORT_ERROR}")

    with _model_lock:
        if _faster_whisper_model is None:
            model_name = os.getenv("LOCAL_STT_FASTER_WHISPER_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
            device = os.getenv("LOCAL_STT_DEVICE", "cuda")
            compute_type = os.getenv("LOCAL_STT_COMPUTE_TYPE", "float16")
            _faster_whisper_runtime = {
                "engine": "faster_whisper",
                "model": model_name,
                "requested_device": device,
                "requested_compute_type": compute_type,
                "device": device,
                "compute_type": compute_type,
                "model_loaded": False,
            }
            try:
                _faster_whisper_model = WhisperModel(
                    model_name,
                    device=device,
                    compute_type=compute_type,
                )
                _faster_whisper_runtime["model_loaded"] = True
            except Exception:
                if device == "cuda":
                    _faster_whisper_model = WhisperModel(
                        model_name,
                        device="cpu",
                        compute_type="int8",
                    )
                    _faster_whisper_runtime.update(
                        {
                            "device": "cpu",
                            "compute_type": "int8",
                            "model_loaded": True,
                            "message": "CUDA load failed; using CPU int8 fallback.",
                        }
                    )
                else:
                    raise
        return _faster_whisper_model


@dataclass
class Keyword:
    phrase: str
    severity: str


@dataclass
class StreamSession:
    model: Any
    language: str
    context_terms: List[str] = field(default_factory=list)
    keywords: List[Keyword] = field(default_factory=list)
    confirmation_enabled: bool = True
    sample_rate: int = 16000
    rolling_buffer_seconds: int = 20
    state: Any = None
    rolling_audio: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.float32))

    def __post_init__(self) -> None:
        self.state = call_init_streaming_state(self.model)

    @property
    def context_text(self) -> str:
        terms = [keyword.phrase for keyword in self.keywords] + self.context_terms
        if not terms:
            return "תמלול דיבור חי בעברית."
        return "תמלול דיבור חי בעברית. מונחים חשובים: " + ", ".join(terms[:140])

    def push_pcm16(self, chunk: bytes) -> str:
        audio = pcm16_to_float32(chunk)
        if audio.size == 0:
            return read_text(self.state)

        self.update_rolling_audio(audio)
        with _model_lock:
            self.state = call_streaming_transcribe(self.model, self.state, audio, self.language, self.context_text)

        return read_text(self.state)

    def finish(self) -> str:
        with _model_lock:
            self.state = call_finish_streaming_transcribe(self.model, self.state, self.language, self.context_text)

        text = read_text(self.state)
        return self.maybe_confirm(text)

    def update_rolling_audio(self, audio: np.ndarray) -> None:
        self.rolling_audio = np.concatenate([self.rolling_audio, audio])
        max_samples = max(1, self.rolling_buffer_seconds * self.sample_rate)
        if self.rolling_audio.size > max_samples:
            self.rolling_audio = self.rolling_audio[-max_samples:]

    def maybe_confirm(self, text: str) -> str:
        if not self.confirmation_enabled or not self.contains_high_severity_keyword(text):
            return text
        if self.rolling_audio.size == 0 or not hasattr(self.model, "transcribe"):
            return text

        try:
            with _model_lock:
                result = call_transcribe(self.model, self.rolling_audio, self.language, self.context_text)
            confirmed = read_text(result)
            return confirmed or text
        except Exception:
            return text

    def contains_high_severity_keyword(self, text: str) -> bool:
        normalized_text = normalize_hebrew(text)
        return any(
            keyword.severity == "high" and normalize_hebrew(keyword.phrase) in normalized_text
            for keyword in self.keywords
        )


@dataclass
class FasterWhisperSession:
    model: Any
    language: str
    context_terms: List[str] = field(default_factory=list)
    keywords: List[Keyword] = field(default_factory=list)
    confirmation_enabled: bool = True
    sample_rate: int = 16000
    rolling_buffer_seconds: int = 18
    decode_interval_ms: int = 1200
    rolling_audio: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.float32))
    cached_text: str = ""
    last_decode_at: float = 0.0

    @property
    def context_text(self) -> str:
        terms = [keyword.phrase for keyword in self.keywords] + self.context_terms
        if not terms:
            return "תמלול דיבור חי בעברית."
        return "תמלול דיבור חי בעברית. מונחים חשובים: " + ", ".join(terms[:140])

    @property
    def hotwords(self) -> str:
        terms = [keyword.phrase for keyword in self.keywords if keyword.phrase.strip()]
        return " ".join(terms[:100])

    def push_pcm16(self, chunk: bytes) -> str:
        audio = pcm16_to_float32(chunk)
        if audio.size == 0:
            return self.cached_text

        self.update_rolling_audio(audio)
        now = time.monotonic()
        if now - self.last_decode_at < self.decode_interval_ms / 1000:
            return self.cached_text

        self.cached_text = self.decode()
        self.last_decode_at = now
        return self.cached_text

    def finish(self) -> str:
        self.cached_text = self.decode()
        return self.cached_text

    def update_rolling_audio(self, audio: np.ndarray) -> None:
        self.rolling_audio = np.concatenate([self.rolling_audio, audio])
        max_samples = max(1, self.rolling_buffer_seconds * self.sample_rate)
        if self.rolling_audio.size > max_samples:
            self.rolling_audio = self.rolling_audio[-max_samples:]

    def decode(self) -> str:
        if self.rolling_audio.size < self.sample_rate:
            return self.cached_text

        with _model_lock:
            segments = transcribe_faster_whisper(
                self.model,
                self.rolling_audio,
                language=language_code(self.language),
                prompt=self.context_text,
                hotwords=self.hotwords,
            )

        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
        return text or self.cached_text


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "runtime": selected_runtime_status(),
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    session: Optional[Any] = None

    try:
        while True:
            message = await websocket.receive()
            if message.get("text") is not None:
                session = await handle_text_message(websocket, session, message["text"])
                if message["text"] and parse_message_type(message["text"]) == "stop":
                    return
                continue

            chunk = message.get("bytes")
            if chunk is None:
                continue

            if session is None:
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": "Audio arrived before a start message.",
                    }
                )
                continue

            try:
                text = await run_blocking(session.push_pcm16, chunk)
                await websocket.send_json(
                    {
                        "type": "result",
                        "text": text,
                        "is_final": False,
                        "language": session.language,
                    }
                )
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
    except WebSocketDisconnect:
        return


async def handle_text_message(
    websocket: WebSocket,
    session: Optional[Any],
    raw: str,
) -> Optional[Any]:
    try:
        message = json.loads(raw)
    except json.JSONDecodeError:
        await websocket.send_json({"type": "error", "message": "Invalid JSON control message."})
        return session

    message_type = message.get("type")
    if message_type == "start":
        try:
            session = await run_blocking(create_stream_session, message)
            await websocket.send_json(
                {
                    "type": "ready",
                    "model": selected_model_name(),
                    "language": session.language,
                    "runtime": selected_runtime_status(),
                }
            )
            return session
        except Exception as exc:
            await websocket.send_json({"type": "error", "message": str(exc)})
            return None

    if message_type == "stop":
        if session is None:
            await websocket.send_json({"type": "finished", "text": "", "language": os.getenv("LOCAL_STT_LANGUAGE", "Hebrew")})
            return None

        try:
            text = await run_blocking(session.finish)
            await websocket.send_json(
                {
                    "type": "result",
                    "text": text,
                    "is_final": True,
                    "finished": True,
                    "language": session.language,
                }
            )
        except Exception as exc:
            await websocket.send_json({"type": "error", "message": str(exc)})
        return session

    await websocket.send_json({"type": "error", "message": f"Unknown control message: {message_type}"})
    return session


def create_stream_session(message: Dict[str, Any]) -> Any:
    engine = os.getenv("LOCAL_STT_ENGINE", "faster_whisper").lower()
    language = str(message.get("language") or os.getenv("LOCAL_STT_LANGUAGE", "Hebrew"))
    context_terms = list_of_strings(message.get("context_terms"))
    keywords = parse_keywords(message.get("keywords"))
    confirmation_enabled = bool(message.get("confirmation_enabled", env_bool("LOCAL_STT_CONFIRMATION_ENABLED", True)))
    sample_rate = int(message.get("sample_rate") or 16000)

    if engine in {"qwen", "qwen3", "caspi", "vllm"}:
        return StreamSession(
            model=get_model(),
            language=language,
            context_terms=context_terms,
            keywords=keywords,
            confirmation_enabled=confirmation_enabled,
            sample_rate=sample_rate,
            rolling_buffer_seconds=env_int("LOCAL_STT_ROLLING_BUFFER_SECONDS", 20),
        )

    return FasterWhisperSession(
        model=get_faster_whisper_model(),
        language=language,
        context_terms=context_terms,
        keywords=keywords,
        confirmation_enabled=confirmation_enabled,
        sample_rate=sample_rate,
        rolling_buffer_seconds=env_int("LOCAL_STT_ROLLING_BUFFER_SECONDS", 18),
        decode_interval_ms=env_int("LOCAL_STT_DECODE_INTERVAL_MS", 1200),
    )


async def run_blocking(function: Any, *args: Any) -> Any:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: function(*args))


def selected_model_name() -> str:
    engine = os.getenv("LOCAL_STT_ENGINE", "faster_whisper").lower()
    if engine in {"qwen", "qwen3", "caspi", "vllm"}:
        return os.getenv("LOCAL_STT_MODEL", "OzLabs/Caspi-1.7B")
    return os.getenv("LOCAL_STT_FASTER_WHISPER_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")


def selected_runtime_status() -> Dict[str, Any]:
    engine = os.getenv("LOCAL_STT_ENGINE", "faster_whisper").lower()
    if engine in {"qwen", "qwen3", "caspi", "vllm"}:
        return {
            "engine": "qwen3_asr",
            "model": os.getenv("LOCAL_STT_MODEL", "OzLabs/Caspi-1.7B"),
            "device": "cuda",
            "model_loaded": _model is not None,
        }

    status = {
        "engine": "faster_whisper",
        "model": os.getenv("LOCAL_STT_FASTER_WHISPER_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2"),
        "requested_device": os.getenv("LOCAL_STT_DEVICE", "cuda"),
        "requested_compute_type": os.getenv("LOCAL_STT_COMPUTE_TYPE", "float16"),
        "device": os.getenv("LOCAL_STT_DEVICE", "cuda"),
        "compute_type": os.getenv("LOCAL_STT_COMPUTE_TYPE", "float16"),
        "model_loaded": _faster_whisper_model is not None,
    }
    status.update(_faster_whisper_runtime)
    return status


def parse_message_type(raw: str) -> Optional[str]:
    try:
        return json.loads(raw).get("type")
    except Exception:
        return None


def call_init_streaming_state(model: Any) -> Any:
    if hasattr(model, "init_streaming_state"):
        try:
            return model.init_streaming_state(
                unfixed_chunk_num=env_int("LOCAL_STT_UNFIXED_CHUNK_NUM", 2),
                unfixed_token_num=env_int("LOCAL_STT_UNFIXED_TOKEN_NUM", 5),
                chunk_size_sec=env_float("LOCAL_STT_CHUNK_SIZE_SEC", 2.0),
            )
        except TypeError:
            return model.init_streaming_state()
    raise RuntimeError("qwen-asr model does not expose init_streaming_state().")


def call_streaming_transcribe(model: Any, state: Any, audio: np.ndarray, language: str, context: str) -> Any:
    if not hasattr(model, "streaming_transcribe"):
        raise RuntimeError("qwen-asr model does not expose streaming_transcribe().")
    try:
        output = model.streaming_transcribe(audio, state)
        return output or state
    except TypeError:
        try:
            output = model.streaming_transcribe(audio, state, language=language, context=context)
            return output or state
        except TypeError:
            try:
                output = model.streaming_transcribe(audio, state, language=language)
                return output or state
            except TypeError:
                output = model.streaming_transcribe(state, audio)
                return output or state


def call_finish_streaming_transcribe(model: Any, state: Any, language: str, context: str) -> Any:
    if not hasattr(model, "finish_streaming_transcribe"):
        return state
    try:
        output = model.finish_streaming_transcribe(state)
        return output or state
    except TypeError:
        try:
            output = model.finish_streaming_transcribe(state, language=language, context=context)
            return output or state
        except TypeError:
            output = model.finish_streaming_transcribe(state, language=language)
            return output or state


def call_transcribe(model: Any, audio: np.ndarray, language: str, context: str) -> Any:
    try:
        return model.transcribe(audio, language=language, context=context)
    except TypeError:
        try:
            return model.transcribe(audio, language=language)
        except TypeError:
            return model.transcribe(audio)


def transcribe_faster_whisper(model: Any, audio: np.ndarray, language: str, prompt: str, hotwords: str) -> List[Any]:
    try:
        segments, _info = model.transcribe(
            audio,
            language=language,
            beam_size=5,
            vad_filter=True,
            initial_prompt=prompt,
            hotwords=hotwords or None,
        )
    except TypeError:
        try:
            segments, _info = model.transcribe(
                audio,
                language=language,
                beam_size=5,
                vad_filter=True,
                initial_prompt=prompt,
            )
        except TypeError:
            segments, _info = model.transcribe(audio, language=language, beam_size=5, vad_filter=True)

    return list(segments)


def read_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("text") or value.get("transcript") or "")
    return str(getattr(value, "text", "") or getattr(value, "transcript", "") or "")


def pcm16_to_float32(chunk: bytes) -> np.ndarray:
    if not chunk:
        return np.empty(0, dtype=np.float32)
    pcm = np.frombuffer(chunk, dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


def parse_keywords(value: Any) -> List[Keyword]:
    if not isinstance(value, list):
        return []
    keywords: List[Keyword] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        phrase = str(item.get("phrase") or "").strip()
        severity = str(item.get("severity") or "medium")
        if phrase:
            keywords.append(Keyword(phrase=phrase, severity=severity))
    return keywords[:100]


def list_of_strings(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()][:100]


def normalize_hebrew(value: str) -> str:
    value = HEBREW_DIACRITICS.sub("", value)
    value = PUNCTUATION_OR_SYMBOLS.sub(" ", value)
    value = MULTIPLE_SPACES.sub(" ", value)
    return value.strip().lower()


def language_code(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"hebrew", "he-il", "he"}:
        return "he"
    return normalized or "he"


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("LOCAL_STT_HOST", "127.0.0.1"),
        port=env_int("LOCAL_STT_PORT", 8011),
        reload=False,
    )
