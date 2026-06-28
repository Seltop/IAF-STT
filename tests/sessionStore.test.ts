import { describe, expect, it } from "vitest";
import { SessionStore } from "../server/sessionStore.js";
import type { ProviderStatus } from "../shared/types.js";

const TEST_PROVIDERS: ProviderStatus[] = [
  {
    mode: "soniox",
    name: "test",
    configured: true
  },
  {
    mode: "local",
    name: "local test",
    configured: true
  }
];

describe("SessionStore", () => {
  it("creates trigger events when final phrase is split across provider chunks", () => {
    const store = new SessionStore(TEST_PROVIDERS, 4);
    const state = store.createSession();
    store.upsertChannel(state.id, {
      id: "channel-1",
      name: "ערוץ בדיקה",
      color: "#2563eb"
    });

    store.applyProviderResult(state.id, "channel-1", {
      tokens: [{ text: "חי", isFinal: true }]
    });
    expect(store.getSession(state.id)?.triggerEvents).toHaveLength(0);

    store.applyProviderResult(state.id, "channel-1", {
      tokens: [{ text: "רום", isFinal: true }]
    });

    expect(store.getSession(state.id)?.triggerEvents).toHaveLength(1);
    expect(store.getSession(state.id)?.triggerEvents[0].phrase).toBe("חירום");
  });

  it("deletes a channel with its transcript and trigger events", () => {
    const store = new SessionStore(TEST_PROVIDERS, 4);
    const state = store.createSession();
    store.upsertChannel(state.id, {
      id: "channel-1",
      name: "ערוץ בדיקה",
      color: "#2563eb"
    });

    store.applyProviderResult(state.id, "channel-1", {
      tokens: [{ text: "חירום", isFinal: true }]
    });

    expect(store.getSession(state.id)?.channels).toHaveLength(1);
    expect(store.getSession(state.id)?.transcriptSegments).toHaveLength(1);
    expect(store.getSession(state.id)?.triggerEvents).toHaveLength(1);

    const updated = store.deleteChannel(state.id, "channel-1");

    expect(updated.channels).toHaveLength(0);
    expect(updated.transcriptSegments).toHaveLength(0);
    expect(updated.triggerEvents).toHaveLength(0);
  });

  it("updates context terms on the session", () => {
    const store = new SessionStore(TEST_PROVIDERS, 4);
    const state = store.createSession();

    const updated = store.updateContextTerms(state.id, ["יירוט צפוני", " יירוט צפוני ", "חמ״ל"]);

    expect(updated.contextTerms).toEqual(["יירוט צפוני", "חמ״ל"]);
  });

  it("keeps temporarily empty trigger rules while editing", () => {
    const store = new SessionStore(TEST_PROVIDERS, 4);
    const state = store.createSession();
    const updated = store.updateTriggerRules(state.id, [
      {
        ...state.triggerRules[0],
        phrase: "",
        normalizedPhrase: "old-value"
      }
    ]);

    expect(updated.triggerRules).toHaveLength(1);
    expect(updated.triggerRules[0].phrase).toBe("");
    expect(updated.triggerRules[0].normalizedPhrase).toBe("");
  });

  it("matches final trigger phrases after Hebrew prefixes", () => {
    const store = new SessionStore(TEST_PROVIDERS, 4);
    const state = store.createSession();
    store.upsertChannel(state.id, {
      id: "channel-1",
      name: "ערוץ בדיקה",
      color: "#2563eb"
    });
    store.updateTriggerRules(state.id, [
      {
        id: "rule-switch",
        phrase: "מתג",
        normalizedPhrase: "מתג",
        severity: "high",
        color: "#ef4444",
        enabled: true,
        cooldownSeconds: 8
      }
    ]);

    const update = store.applyProviderResult(state.id, "channel-1", {
      tokens: [{ text: "קבלו התראה במתג 30", isFinal: true }]
    });

    expect(update.segments[0].matchedRuleIds).toEqual(["rule-switch"]);
    expect(update.triggerEvents).toHaveLength(1);
  });

  it("clears chat history without deleting channels or trigger rules", () => {
    const store = new SessionStore(TEST_PROVIDERS, 4);
    const state = store.createSession();
    store.upsertChannel(state.id, {
      id: "channel-1",
      name: "ערוץ בדיקה",
      color: "#2563eb"
    });
    store.applyProviderResult(state.id, "channel-1", {
      tokens: [{ text: "חירום", isFinal: true }]
    });

    const updated = store.clearChat(state.id);

    expect(updated.channels).toHaveLength(1);
    expect(updated.triggerRules).toHaveLength(state.triggerRules.length);
    expect(updated.transcriptSegments).toHaveLength(0);
    expect(updated.triggerEvents).toHaveLength(0);
  });

  it("tags local transcript segments and trigger events with the local provider mode", () => {
    const store = new SessionStore(TEST_PROVIDERS, 4);
    const state = store.createSession();
    store.upsertChannel(state.id, {
      id: "channel-local",
      name: "local",
      color: "#d97706",
      mode: "local"
    });

    const update = store.applyProviderResult(state.id, "channel-local", {
      tokens: [{ text: state.triggerRules[0].phrase, isFinal: true }]
    });

    expect(update.segments[0].mode).toBe("local");
    expect(update.triggerEvents[0].mode).toBe("local");
    expect(store.exportCsv(state.id)).toContain("local,local");
  });
});
