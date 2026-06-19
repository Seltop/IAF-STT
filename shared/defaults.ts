import type { TriggerRule } from "./types.js";
import { normalizeHebrew } from "./hebrew.js";

export const DEFAULT_TRIGGER_RULES: TriggerRule[] = [
  {
    id: "rule-emergency",
    phrase: "חירום",
    normalizedPhrase: normalizeHebrew("חירום"),
    severity: "high",
    color: "#ef4444",
    enabled: true,
    cooldownSeconds: 10
  },
  {
    id: "rule-confirm",
    phrase: "אישור",
    normalizedPhrase: normalizeHebrew("אישור"),
    severity: "medium",
    color: "#f59e0b",
    enabled: true,
    cooldownSeconds: 8
  },
  {
    id: "rule-report",
    phrase: "דיווח",
    normalizedPhrase: normalizeHebrew("דיווח"),
    severity: "low",
    color: "#0ea5e9",
    enabled: true,
    cooldownSeconds: 5
  }
];

export const DEFAULT_CHANNEL_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#7c3aed"];

export const DEFAULT_CONTEXT_TERMS = ["כטבם", "חמ״ל", "מפקד משימה", "צוות קרקע", "יירוט צפוני"];
