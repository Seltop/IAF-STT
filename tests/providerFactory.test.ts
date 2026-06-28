import { describe, expect, it } from "vitest";
import type { AppConfig } from "../server/config.js";
import { createProvider, createProviders } from "../server/providers/providerFactory.js";

const baseConfig: AppConfig = {
  port: 8787,
  maxChannels: 4,
  publicBasePath: "",
  sttProvider: "soniox",
  azureSpeechKey: undefined,
  azureSpeechRegion: undefined,
  sonioxApiKey: "soniox-key",
  sonioxMaxEndpointDelayMs: 2000,
  sonioxModel: "stt-rt-v5",
  sonioxWsUrl: "wss://example.test/soniox",
  localSttWsUrl: "ws://127.0.0.1:8011/ws",
  localSttEngine: "faster_whisper",
  localSttModel: "OzLabs/Caspi-1.7B",
  localSttFasterWhisperModel: "ivrit-ai/whisper-large-v3-turbo-ct2",
  localSttDevice: "cuda",
  localSttComputeType: "float16",
  localSttLanguage: "Hebrew",
  localSttConfirmationEnabled: true,
  localSttStableWordLag: 3,
  localSttMinCommitIntervalMs: 600
};

describe("provider factory", () => {
  it("creates Soniox and Local provider statuses", () => {
    const registry = createProviders(baseConfig);

    expect([...registry.providers.keys()]).toEqual(["soniox", "local"]);
    expect(registry.statuses).toEqual([
      {
        mode: "soniox",
        name: "Soniox",
        configured: true,
        message: undefined
      },
      {
        mode: "local",
        name: "Local Whisper",
        configured: true,
        message: "ivrit-ai/whisper-large-v3-turbo-ct2 via cuda/float16"
      }
    ]);
    expect(registry.defaultMode).toBe("soniox");
  });

  it("labels Qwen/Caspi local mode separately", () => {
    const registry = createProviders({
      ...baseConfig,
      localSttEngine: "qwen"
    });

    expect(registry.statuses.find((provider) => provider.mode === "local")).toMatchObject({
      name: "Local Caspi",
      message: "OzLabs/Caspi-1.7B via Qwen3-ASR/vLLM"
    });
  });

  it("uses Local as the default mode when requested", () => {
    const registry = createProviders({
      ...baseConfig,
      sttProvider: "local"
    });

    expect(registry.defaultMode).toBe("local");
    expect(createProvider({ ...baseConfig, sttProvider: "local" }).mode).toBe("local");
  });
});
