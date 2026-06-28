import type { AppConfig } from "../config.js";
import type { ProviderMode, ProviderStatus } from "../../shared/types.js";
import { AzureSpeechProvider } from "./azureProvider.js";
import { LocalCaspiProvider } from "./localCaspiProvider.js";
import { SonioxProvider } from "./sonioxProvider.js";
import type { RealtimeProvider } from "./types.js";

export interface ProviderSelection {
  provider: RealtimeProvider;
  mode: ProviderMode;
  providerName: string;
  configured: boolean;
  message?: string;
}

export interface ProviderRegistry {
  providers: Map<ProviderMode, RealtimeProvider>;
  statuses: ProviderStatus[];
  defaultMode: ProviderMode;
}

export function createProviders(config: AppConfig): ProviderRegistry {
  const primarySelection = config.sttProvider === "azure" ? createAzureProvider(config) : createSonioxProvider(config);
  const selections = [primarySelection, createLocalProvider(config)];
  const providers = new Map<ProviderMode, RealtimeProvider>(
    selections.map((selection) => [selection.mode, selection.provider])
  );
  const statuses = selections.map((selection) => ({
    mode: selection.mode,
    name: selection.providerName,
    configured: selection.configured,
    message: selection.message
  }));

  return {
    providers,
    statuses,
    defaultMode: config.sttProvider === "local" ? "local" : "soniox"
  };
}

export function createProvider(config: AppConfig): ProviderSelection {
  if (config.sttProvider === "local") {
    return createLocalProvider(config);
  }

  if (config.sttProvider === "azure") {
    return createAzureProvider(config);
  }

  return createSonioxProvider(config);
}

function createSonioxProvider(config: AppConfig): ProviderSelection {
  return {
    provider: new SonioxProvider({
      apiKey: config.sonioxApiKey,
      maxEndpointDelayMs: config.sonioxMaxEndpointDelayMs,
      model: config.sonioxModel,
      wsUrl: config.sonioxWsUrl
    }),
    mode: "soniox",
    providerName: "Soniox",
    configured: Boolean(config.sonioxApiKey),
    message: config.sonioxApiKey ? undefined : "SONIOX_API_KEY is missing."
  };
}

function createLocalProvider(config: AppConfig): ProviderSelection {
  const engine = config.localSttEngine.toLowerCase();
  const usesCaspi = ["qwen", "qwen3", "caspi", "vllm"].includes(engine);
  const providerName = usesCaspi ? "Local Caspi" : "Local Whisper";
  const model = usesCaspi ? config.localSttModel : config.localSttFasterWhisperModel;

  return {
    provider: new LocalCaspiProvider({
      wsUrl: config.localSttWsUrl,
      model: config.localSttModel,
      language: config.localSttLanguage,
      confirmationEnabled: config.localSttConfirmationEnabled,
      stableWordLag: config.localSttStableWordLag,
      minCommitIntervalMs: config.localSttMinCommitIntervalMs
    }),
    mode: "local",
    providerName,
    configured: Boolean(config.localSttWsUrl),
    message: config.localSttWsUrl
      ? `${model} via ${usesCaspi ? "Qwen3-ASR/vLLM" : `${config.localSttDevice}/${config.localSttComputeType}`}`
      : "LOCAL_STT_WS_URL is missing."
  };
}

function createAzureProvider(config: AppConfig): ProviderSelection {
  const configured = Boolean(config.azureSpeechKey && config.azureSpeechRegion);

  return {
    provider: new AzureSpeechProvider({
      speechKey: config.azureSpeechKey,
      region: config.azureSpeechRegion,
      language: "he-IL"
    }),
    mode: "soniox",
    providerName: "Azure Speech",
    configured,
    message: configured ? undefined : "AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is missing."
  };
}
