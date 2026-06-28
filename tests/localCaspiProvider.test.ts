import { describe, expect, it } from "vitest";
import {
  dropTrailingWords,
  formatLocalSttConnectionError,
  parseLocalCaspiMessage
} from "../server/providers/localCaspiProvider.js";

describe("Local Caspi provider helpers", () => {
  it("parses sidecar ready messages", () => {
    const parsed = parseLocalCaspiMessage(
      JSON.stringify({
        type: "ready",
        model: "ivrit-ai/whisper-large-v3-turbo-ct2"
      })
    );

    expect(parsed).toEqual({ ready: true });
  });

  it("parses partial sidecar results", () => {
    const parsed = parseLocalCaspiMessage(
      JSON.stringify({
        type: "result",
        text: "×‘×“×™×§×” ×—×™×¨×•×",
        is_final: false,
        language: "Hebrew"
      })
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.result).toMatchObject({
      text: "×‘×“×™×§×” ×—×™×¨×•×",
      isFinal: false,
      finished: false,
      language: "Hebrew"
    });
  });

  it("parses sidecar errors", () => {
    const parsed = parseLocalCaspiMessage(
      JSON.stringify({
        type: "error",
        message: "sidecar failed"
      })
    );

    expect(parsed.error).toMatchObject({
      type: "local_stt_error",
      message: "sidecar failed"
    });
  });

  it("drops unstable trailing words from cumulative streaming text", () => {
    expect(dropTrailingWords("one two three four five", 2)).toBe("one two three");
    expect(dropTrailingWords("one two", 2)).toBe("");
  });

  it("formats connection refused errors with sidecar startup guidance", () => {
    expect(formatLocalSttConnectionError("connect ECONNREFUSED 127.0.0.1:8011", "ws://127.0.0.1:8011/ws")).toContain(
      "npm.cmd run local:stt"
    );
  });
});
