import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { describe, expect, it } from "vitest";
import { azureRecognitionToProviderResult } from "../server/providers/azureProvider.js";

describe("Azure provider mapping", () => {
  it("maps Azure recognition results into provider tokens", () => {
    const result = new sdk.SpeechRecognitionResult(
      "result-1",
      sdk.ResultReason.RecognizedSpeech,
      "שלום עולם",
      20_000_000,
      10_000_000,
      "he-IL"
    );

    expect(azureRecognitionToProviderResult(result, true)).toMatchObject({
      tokens: [
        {
          text: "שלום עולם",
          isFinal: true,
          startMs: 1000,
          endMs: 3000,
          language: "he-IL"
        }
      ],
      finalAudioMs: 3000,
      totalAudioMs: 3000
    });
  });
});
