import type { SessionState } from "../../shared/types.js";

export async function createSession(): Promise<SessionState> {
  const response = await fetch("/api/sessions", {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("Could not create session.");
  }

  return (await response.json()) as SessionState;
}

export async function fetchSession(sessionId: string): Promise<SessionState> {
  const response = await fetch(`/api/sessions/${sessionId}/state`);

  if (!response.ok) {
    throw new Error("Session not found.");
  }

  return (await response.json()) as SessionState;
}

export function exportUrl(sessionId: string, format: "json" | "csv"): string {
  return `/api/sessions/${sessionId}/export?format=${format}`;
}
