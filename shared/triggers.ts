import { containsNormalizedPhrase, normalizeHebrew } from "./hebrew.js";
import type { TriggerRule } from "./types.js";

export function hydrateTriggerRule(rule: Omit<TriggerRule, "normalizedPhrase"> & { normalizedPhrase?: string }): TriggerRule {
  return {
    ...rule,
    normalizedPhrase: normalizeHebrew(rule.phrase),
    cooldownSeconds: Math.max(1, Math.round(rule.cooldownSeconds || 1))
  };
}

export function matchTriggerRules(text: string, rules: TriggerRule[]): TriggerRule[] {
  return rules.filter((rule) => rule.enabled && containsNormalizedPhrase(text, rule.normalizedPhrase || rule.phrase));
}
