import { describe, expect, it } from "vitest";
import { containsNormalizedPhrase, normalizeHebrew } from "../shared/hebrew.js";

describe("Hebrew normalization", () => {
  it("removes niqqud and punctuation", () => {
    expect(normalizeHebrew("חִירוּם!!!")).toBe("חירום");
  });

  it("matches exact normalized phrases", () => {
    expect(containsNormalizedPhrase("יש כאן מצב חירום עכשיו", "חירום")).toBe(true);
  });

  it("matches phrases after common Hebrew prefixes", () => {
    expect(containsNormalizedPhrase("קבלו התראה במתג 30", "מתג")).toBe(true);
    expect(containsNormalizedPhrase("קבלו התראה במתג 30", "מתג 30")).toBe(true);
  });

  it("does not match inside a larger word", () => {
    expect(containsNormalizedPhrase("הראשון הגיע", "ראש")).toBe(false);
  });
});
