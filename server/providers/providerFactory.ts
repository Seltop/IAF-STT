import type { AppConfig } from "../config.js";
import { AzureSpeechProvider } from "./azureProvider.js";
import { SonioxProvider } from "./sonioxProvider.js";
import type { RealtimeProvider } from "./types.js";

export interface ProviderSelection {
  provider: RealtimeProvider;
  providerName: string;
  configured: boolean;
  message?: string;
}

export function createProvider(config: AppConfig): ProviderSelection {
  if (config.sttProvider === "soniox") {
    return {
      provider: new SonioxProvider({
        apiKey: config.sonioxApiKey,
        model: config.sonioxModel,
        wsUrl: config.sonioxWsUrl
      }),
      providerName: "Soniox",
      configured: Boolean(config.sonioxApiKey),
      message: config.sonioxApiKey ? undefined : "SONIOX_API_KEY is missing."
    };
  }

  const configured = Boolean(config.azureSpeechKey && config.azureSpeechRegion);

  return {
    provider: new AzureSpeechProvider({
      speechKey: config.azureSpeechKey,
      region: config.azureSpeechRegion,
      language: "he-IL"
    }),
    providerName: "Azure Speech",
    configured,
    message: configured ? undefined : "AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is missing."
  };
}
