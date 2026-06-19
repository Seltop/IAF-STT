import { describe, expect, it } from "vitest";
import { parseSonioxMessage, renderTokens } from "../server/providers/sonioxParser.js";

describe("Soniox parser", () => {
  it("maps transcript tokens into app tokens", () => {
    const parsed = parseSonioxMessage(
      JSON.stringify({
        tokens: [
          {
            text: "שלום",
            is_final: true,
            start_ms: 10,
            end_ms: 400,
            confidence: 0.92,
            speaker: "spk_0",
            language: "he"
          }
        ],
        final_audio_proc_ms: 400,
        total_audio_proc_ms: 480
      })
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.result?.tokens[0]).toMatchObject({
      text: "שלום",
      isFinal: true,
      startMs: 10,
      endMs: 400,
      confidence: 0.92,
      speaker: "spk_0",
      language: "he"
    });
  });

  it("ignores translation tokens", () => {
    const parsed = parseSonioxMessage(
      JSON.stringify({
        tokens: [
          { text: "hello", is_final: true, translation_status: "translation" },
          { text: "שלום", is_final: true, translation_status: "original" }
        ]
      })
    );

    expect(renderTokens(parsed.result?.tokens || [])).toBe("שלום");
  });

  it("removes Soniox end markers from transcript tokens", () => {
    const parsed = parseSonioxMessage(
      JSON.stringify({
        tokens: [
          { text: "חירום.<end>", is_final: true },
          { text: "<end>", is_final: true }
        ]
      })
    );

    expect(renderTokens(parsed.result?.tokens || [])).toBe("חירום.");
  });

  it("returns provider errors", () => {
    const parsed = parseSonioxMessage(
      JSON.stringify({
        error_code: 401,
        error_type: "unauthenticated",
        error_message: "Missing API key"
      })
    );

    expect(parsed.error).toMatchObject({
      code: 401,
      type: "unauthenticated",
      message: "Missing API key"
    });
  });
});
