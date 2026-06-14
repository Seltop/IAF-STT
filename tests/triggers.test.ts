import { describe, expect, it } from "vitest";
import { hydrateTriggerRule, matchTriggerRules } from "../shared/triggers.js";

describe("trigger rules", () => {
  it("matches enabled exact phrases", () => {
    const rule = hydrateTriggerRule({
      id: "r1",
      phrase: "אישור ירי",
      severity: "high",
      color: "#ef4444",
      enabled: true,
      cooldownSeconds: 5
    });

    expect(matchTriggerRules("מבקש אישור ירי עכשיו", [rule])).toHaveLength(1);
  });

  it("ignores disabled rules", () => {
    const rule = hydrateTriggerRule({
      id: "r1",
      phrase: "חירום",
      severity: "high",
      color: "#ef4444",
      enabled: false,
      cooldownSeconds: 5
    });

    expect(matchTriggerRules("חירום", [rule])).toHaveLength(0);
  });
});
