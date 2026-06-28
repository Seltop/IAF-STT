import "dotenv/config";

export interface AppConfig {
  port: number;
  maxChannels: number;
  publicBasePath: string;
  sttProvider: "azure" | "soniox" | "local";
  azureSpeechKey?: string;
  azureSpeechRegion?: string;
  sonioxApiKey?: string;
  sonioxMaxEndpointDelayMs: number;
  sonioxModel: string;
  sonioxWsUrl: string;
  localSttWsUrl: string;
  localSttEngine: string;
  localSttModel: string;
  localSttFasterWhisperModel: string;
  localSttDevice: string;
  localSttComputeType: string;
  localSttLanguage: string;
  localSttConfirmationEnabled: boolean;
  localSttStableWordLag: number;
  localSttMinCommitIntervalMs: number;
}

function readNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config: AppConfig = {
  port: readNumber("PORT", 8787),
  maxChannels: readNumber("MAX_CHANNELS", 4),
  publicBasePath: readBasePath(process.env.PUBLIC_BASE_PATH || process.env.BASE_PATH),
  sttProvider: readProviderName(),
  azureSpeechKey: process.env.AZURE_SPEECH_KEY,
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION,
  sonioxApiKey: process.env.SONIOX_API_KEY,
  sonioxMaxEndpointDelayMs: readNumber("SONIOX_MAX_ENDPOINT_DELAY_MS", 2000),
  sonioxModel: process.env.SONIOX_MODEL || "stt-rt-v5",
  sonioxWsUrl: process.env.SONIOX_WS_URL || "wss://stt-rt.soniox.com/transcribe-websocket",
  localSttWsUrl: process.env.LOCAL_STT_WS_URL || "ws://127.0.0.1:8011/ws",
  localSttEngine: process.env.LOCAL_STT_ENGINE || "faster_whisper",
  localSttModel: process.env.LOCAL_STT_MODEL || "OzLabs/Caspi-1.7B",
  localSttFasterWhisperModel: process.env.LOCAL_STT_FASTER_WHISPER_MODEL || "ivrit-ai/whisper-large-v3-turbo-ct2",
  localSttDevice: process.env.LOCAL_STT_DEVICE || "cuda",
  localSttComputeType: process.env.LOCAL_STT_COMPUTE_TYPE || "float16",
  localSttLanguage: process.env.LOCAL_STT_LANGUAGE || "Hebrew",
  localSttConfirmationEnabled: readBoolean("LOCAL_STT_CONFIRMATION_ENABLED", true),
  localSttStableWordLag: readNumber("LOCAL_STT_STABLE_WORD_LAG", 0),
  localSttMinCommitIntervalMs: readNumber("LOCAL_STT_MIN_COMMIT_INTERVAL_MS", 600)
};

function readProviderName(): AppConfig["sttProvider"] {
  const value = process.env.STT_PROVIDER?.toLowerCase();
  if (value === "azure") {
    return "azure";
  }
  if (value === "local") {
    return "local";
  }

  return "soniox";
}

function readBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.toLowerCase();
  if (!value) {
    return fallback;
  }

  return value === "1" || value === "true" || value === "yes" || value === "on";
}
