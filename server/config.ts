import "dotenv/config";

export interface AppConfig {
  port: number;
  maxChannels: number;
  sonioxApiKey?: string;
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
  sonioxApiKey: process.env.SONIOX_API_KEY,
  sonioxWsUrl: process.env.SONIOX_WS_URL || "wss://stt-rt.soniox.com/transcribe-websocket"
};
