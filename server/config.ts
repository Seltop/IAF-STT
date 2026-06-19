import "dotenv/config";

export interface AppConfig {
  port: number;
  maxChannels: number;
  sttProvider: "azure" | "soniox";
  azureSpeechKey?: string;
  azureSpeechRegion?: string;
  sonioxApiKey?: string;
  sonioxMaxEndpointDelayMs: number;
  sonioxModel: string;
  sonioxWsUrl: string;
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
  sttProvider: readProviderName(),
  azureSpeechKey: process.env.AZURE_SPEECH_KEY,
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION,
  sonioxApiKey: process.env.SONIOX_API_KEY,
  sonioxMaxEndpointDelayMs: readNumber("SONIOX_MAX_ENDPOINT_DELAY_MS", 2000),
  sonioxModel: process.env.SONIOX_MODEL || "stt-rt-v5",
  sonioxWsUrl: process.env.SONIOX_WS_URL || "wss://stt-rt.soniox.com/transcribe-websocket"
};

function readProviderName(): AppConfig["sttProvider"] {
  const value = process.env.STT_PROVIDER?.toLowerCase();
  if (value === "azure") {
    return "azure";
  }

  return "soniox";
}
