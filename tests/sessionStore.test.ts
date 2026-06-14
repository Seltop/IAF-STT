import { describe, expect, it } from "vitest";
import { SessionStore } from "../server/sessionStore.js";

describe("SessionStore", () => {
  it("creates trigger events when final phrase is split across provider chunks", () => {
    const store = new SessionStore(true, 4);
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
});
