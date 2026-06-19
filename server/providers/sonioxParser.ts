import type { ProviderError, ProviderResult } from "./types.js";

interface SonioxToken {
  text?: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  is_final?: boolean;
  speaker?: string;
  language?: string;
  translation_status?: string;
}

interface SonioxMessage {
  tokens?: SonioxToken[];
  final_audio_proc_ms?: number;
  total_audio_proc_ms?: number;
  finished?: boolean;
  error_code?: number;
  error_type?: string;
  error_message?: string;
  request_id?: string;
}

export function parseSonioxMessage(raw: string): { result?: ProviderResult; error?: ProviderError } {
  let message: SonioxMessage;

  try {
    message = JSON.parse(raw) as SonioxMessage;
  } catch {
    return {
      error: {
        message: "Received a non-JSON message from Soniox."
      }
    };
  }

  if (message.error_code || message.error_type || message.error_message) {
    return {
      error: {
        code: message.error_code,
        type: message.error_type,
        message: message.error_message || "Soniox returned an unknown error.",
        requestId: message.request_id
      }
    };
  }

  const tokens =
    message.tokens
      ?.filter((token) => token.translation_status !== "translation")
      .map((token) => ({
        text: sanitizeTokenText(token.text),
        isFinal: Boolean(token.is_final),
        startMs: token.start_ms,
        endMs: token.end_ms,
        confidence: token.confidence,
        speaker: token.speaker,
        language: token.language
      }))
      .filter((token) => token.text.length > 0) || [];

  return {
    result: {
      tokens,
      finalAudioMs: message.final_audio_proc_ms,
      totalAudioMs: message.total_audio_proc_ms,
      finished: message.finished
    }
  };
}

export function renderTokens(tokens: { text: string }[]): string {
  return tokens.map((token) => token.text).join("");
}

function sanitizeTokenText(text = ""): string {
  return text.replaceAll("<end>", "");
}
