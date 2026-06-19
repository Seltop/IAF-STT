import { describe, expect, it } from "vitest";
import { SessionStore } from "../server/sessionStore.js";

describe("SessionStore", () => {
  it("creates trigger events when final phrase is split across provider chunks", () => {
    const store = new SessionStore("test", true, undefined, 4);
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
    const store = new SessionStore("test", true, undefined, 4);
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
    const store = new SessionStore("test", true, undefined, 4);
    const state = store.createSession();

    const updated = store.updateContextTerms(state.id, ["יירוט צפוני", " יירוט צפוני ", "חמ״ל"]);

    expect(updated.contextTerms).toEqual(["יירוט צפוני", "חמ״ל"]);
  });

  it("keeps temporarily empty trigger rules while editing", () => {
    const store = new SessionStore("test", true, undefined, 4);
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
});
