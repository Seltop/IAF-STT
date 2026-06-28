# Local Hebrew STT Sidecar

This service runs the local AI mode for the monitor. It accepts 16 kHz mono
PCM over WebSocket and streams cumulative Hebrew transcript text back to the
Node backend.

## Run Without Docker

From the repo root:

```powershell
npm.cmd run local:stt
```

This creates `local-stt/.venv` when Python supports venv, installs
`requirements-native.txt`, and starts the service with `faster-whisper` and
`ivrit-ai/whisper-large-v3-turbo-ct2`. On NVIDIA machines the launcher installs
the Python CUDA/cuDNN runtime packages and uses `cuda`/`float16`; if CUDA cannot
load, the sidecar falls back to CPU `int8`.

## Optional Docker/VLLM Path

Use this only if Docker Desktop/WSL GPU works on the machine:

```powershell
npm.cmd run local:stt:docker
```

The sidecar listens on:

```text
ws://127.0.0.1:8011/ws
```

The first start downloads the selected model into the local Python or Docker
model cache.

## Protocol

The Node backend sends:

```json
{
  "type": "start",
  "language": "Hebrew",
  "sample_rate": 16000,
  "context_terms": ["term"],
  "keywords": [{ "phrase": "keyword", "severity": "high" }],
  "confirmation_enabled": true
}
```

Then it streams binary `pcm_s16le` chunks. The sidecar responds with:

```json
{ "type": "result", "text": "...", "is_final": false, "language": "Hebrew" }
```

On stop, it sends a final result with `finished: true`.
