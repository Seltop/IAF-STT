import { DEFAULT_CONTEXT_TERMS, DEFAULT_TRIGGER_RULES } from "../shared/defaults.js";
import { findLastNormalizedPhraseIndex, normalizeHebrew } from "../shared/hebrew.js";
import { hydrateTriggerRule, matchTriggerRules } from "../shared/triggers.js";
import type {
  Channel,
  ChannelStatus,
  ProviderMode,
  ProviderStatus,
  SessionState,
  TranscriptSegment,
  TranscriptToken,
  TriggerEvent,
  TriggerRule
} from "../shared/types.js";
import type { ProviderResult } from "./providers/types.js";
import { renderTokens } from "./providers/sonioxParser.js";

interface SessionInternal {
  state: SessionState;
  channelFinalText: Map<string, string>;
  lastRuleOffsets: Map<string, number>;
  lastRuleTriggerAt: Map<string, number>;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionInternal>();
  private readonly providerStatuses: ProviderStatus[];

  constructor(
    providerStatuses: ProviderStatus[],
    private readonly maxChannels: number
  ) {
    this.providerStatuses = providerStatuses.map((provider) => ({ ...provider }));
  }

  createSession(): SessionState {
    const id = crypto.randomUUID();
    const state: SessionState = {
      id,
      createdAt: new Date().toISOString(),
      channels: [],
      transcriptSegments: [],
      triggerRules: DEFAULT_TRIGGER_RULES.map((rule) => ({ ...rule })),
      triggerEvents: [],
      contextTerms: [...DEFAULT_CONTEXT_TERMS],
      providers: this.providerStatuses.map((provider) => ({ ...provider })),
      providerName: this.providerStatuses[0]?.name || "Unknown",
      providerConfigured: this.providerStatuses[0]?.configured || false,
      providerMessage: this.providerStatuses[0]?.message,
      maxChannels: this.maxChannels
    };

    this.sessions.set(id, {
      state,
      channelFinalText: new Map(),
      lastRuleOffsets: new Map(),
      lastRuleTriggerAt: new Map()
    });

    return this.cloneState(state);
  }

  getSession(id: string): SessionState | undefined {
    const session = this.sessions.get(id);
    return session ? this.cloneState(session.state) : undefined;
  }

  getInternal(id: string): SessionInternal | undefined {
    return this.sessions.get(id);
  }

  upsertChannel(
    sessionId: string,
    channel: Omit<Channel, "status" | "createdAt" | "mode"> & { mode?: ProviderMode }
  ): Channel {
    const session = this.requireSession(sessionId);
    const existing = session.state.channels.find((item) => item.id === channel.id);
    const updated: Channel = {
      ...channel,
      mode: channel.mode || existing?.mode || "soniox",
      status: existing?.status || "connecting",
      createdAt: existing?.createdAt || new Date().toISOString()
    };

    if (existing) {
      Object.assign(existing, updated);
      return { ...existing };
    }

    if (session.state.channels.length >= this.maxChannels) {
      throw new Error(`Maximum channel count reached (${this.maxChannels}).`);
    }

    session.state.channels.push(updated);
    return { ...updated };
  }

  setChannelStatus(sessionId: string, channelId: string, status: ChannelStatus, error?: string): Channel {
    const session = this.requireSession(sessionId);
    const channel = session.state.channels.find((item) => item.id === channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} was not found.`);
    }

    channel.status = status;
    channel.error = error;
    return { ...channel };
  }

  deleteChannel(sessionId: string, channelId: string): SessionState {
    const session = this.requireSession(sessionId);
    session.state.channels = session.state.channels.filter((channel) => channel.id !== channelId);
    session.state.transcriptSegments = session.state.transcriptSegments.filter(
      (segment) => segment.channelId !== channelId
    );
    session.state.triggerEvents = session.state.triggerEvents.filter((event) => event.channelId !== channelId);
    session.channelFinalText.delete(channelId);
    this.deleteChannelScopedKeys(session.lastRuleOffsets, channelId);
    this.deleteChannelScopedKeys(session.lastRuleTriggerAt, channelId);
    return this.cloneState(session.state);
  }

  clearChat(sessionId: string): SessionState {
    const session = this.requireSession(sessionId);
    session.state.transcriptSegments = [];
    session.state.triggerEvents = [];
    session.channelFinalText.clear();
    session.lastRuleOffsets.clear();
    session.lastRuleTriggerAt.clear();
    return this.cloneState(session.state);
  }

  updateTriggerRules(sessionId: string, rules: TriggerRule[]): SessionState {
    const session = this.requireSession(sessionId);
    session.state.triggerRules = rules.map((rule) => hydrateTriggerRule(rule));
    return this.cloneState(session.state);
  }

  updateContextTerms(sessionId: string, terms: string[]): SessionState {
    const session = this.requireSession(sessionId);
    session.state.contextTerms = normalizeContextTerms(terms);
    return this.cloneState(session.state);
  }

  acknowledgeTrigger(sessionId: string, triggerEventId: string): SessionState {
    const session = this.requireSession(sessionId);
    const event = session.state.triggerEvents.find((item) => item.id === triggerEventId);

    if (event && !event.acknowledgedAt) {
      event.acknowledgedAt = new Date().toISOString();
    }

    return this.cloneState(session.state);
  }

  applyProviderResult(sessionId: string, channelId: string, result: ProviderResult): {
    segments: TranscriptSegment[];
    triggerEvents: TriggerEvent[];
    finished: boolean;
  } {
    const session = this.requireSession(sessionId);
    const mode = this.getChannelMode(session, channelId);
    const finalTokens = result.tokens.filter((token) => token.isFinal);
    const provisionalTokens = result.tokens.filter((token) => !token.isFinal);
    const segments: TranscriptSegment[] = [];
    const triggerEvents: TriggerEvent[] = [];

    if (finalTokens.length > 0) {
      const segment = this.createSegment(channelId, mode, finalTokens, true, result);
      const rollingText = `${session.channelFinalText.get(channelId) || ""}${segment.text}`;
      session.channelFinalText.set(channelId, rollingText);
      segment.matchedRuleIds = this.findTriggeredRules(session, channelId, rollingText, segment, triggerEvents);
      session.state.transcriptSegments.push(segment);
      segments.push(segment);
    }

    this.removeProvisionalSegment(session.state, channelId);

    if (provisionalTokens.length > 0) {
      const segment = this.createSegment(channelId, mode, provisionalTokens, false, result);
      segment.matchedRuleIds = matchTriggerRules(segment.text, session.state.triggerRules).map((rule) => rule.id);
      session.state.transcriptSegments.push(segment);
      segments.push(segment);
    }

    session.state.triggerEvents.push(...triggerEvents);

    if (result.finished) {
      this.removeProvisionalSegment(session.state, channelId);
    }

    return {
      segments,
      triggerEvents,
      finished: Boolean(result.finished)
    };
  }

  exportJson(sessionId: string): string {
    return JSON.stringify(this.requireSession(sessionId).state, null, 2);
  }

  exportCsv(sessionId: string): string {
    const state = this.requireSession(sessionId).state;
    const rows = [["type", "time", "mode", "channel", "severity", "text", "acknowledged_at"]];
    const channelNames = new Map(state.channels.map((channel) => [channel.id, channel.name]));

    for (const segment of state.transcriptSegments.filter((item) => item.isFinal)) {
      rows.push([
        "transcript",
        segment.createdAt,
        segment.mode,
        channelNames.get(segment.channelId) || segment.channelId,
        "",
        segment.text,
        ""
      ]);
    }

    for (const event of state.triggerEvents) {
      rows.push([
        "trigger",
        event.createdAt,
        event.mode,
        channelNames.get(event.channelId) || event.channelId,
        event.severity,
        event.transcriptText,
        event.acknowledgedAt || ""
      ]);
    }

    return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  }

  private findTriggeredRules(
    session: SessionInternal,
    channelId: string,
    rollingText: string,
    segment: TranscriptSegment,
    triggerEvents: TriggerEvent[]
  ): string[] {
    const now = Date.now();
    const matchedRuleIds: string[] = [];

    for (const rule of session.state.triggerRules) {
      if (!rule.enabled || !rule.normalizedPhrase) {
        continue;
      }

      const offset = findLastNormalizedPhraseIndex(rollingText, rule.normalizedPhrase);
      const offsetKey = `${channelId}:${rule.id}`;
      if (offset === -1 || offset <= (session.lastRuleOffsets.get(offsetKey) ?? -1)) {
        continue;
      }

      session.lastRuleOffsets.set(offsetKey, offset);
      matchedRuleIds.push(rule.id);

      const lastTriggered = session.lastRuleTriggerAt.get(offsetKey) || 0;
      if (now - lastTriggered < rule.cooldownSeconds * 1000) {
        continue;
      }

      session.lastRuleTriggerAt.set(offsetKey, now);
      triggerEvents.push({
        id: crypto.randomUUID(),
        ruleId: rule.id,
        phrase: rule.phrase,
        severity: rule.severity,
        color: rule.color,
        channelId,
        mode: segment.mode,
        segmentId: segment.id,
        transcriptText: segment.text.trim() || rollingText.slice(-280),
        createdAt: new Date().toISOString()
      });
    }

    return matchedRuleIds;
  }

  private createSegment(
    channelId: string,
    mode: ProviderMode,
    tokens: TranscriptToken[],
    isFinal: boolean,
    result: ProviderResult
  ): TranscriptSegment {
    const tokenConfidence = tokens
      .map((token) => token.confidence)
      .filter((value): value is number => typeof value === "number");
    const confidence =
      tokenConfidence.length > 0
        ? tokenConfidence.reduce((sum, value) => sum + value, 0) / tokenConfidence.length
        : undefined;

    return {
      id: isFinal ? crypto.randomUUID() : `provisional-${channelId}`,
      channelId,
      mode,
      text: renderTokens(tokens),
      isFinal,
      tokens,
      startedAtMs: firstNumber(tokens.map((token) => token.startMs)),
      endedAtMs: lastNumber(tokens.map((token) => token.endMs)),
      confidence,
      speaker: tokens.find((token) => token.speaker)?.speaker,
      language: tokens.find((token) => token.language)?.language,
      createdAt: new Date().toISOString(),
      finalAudioMs: result.finalAudioMs,
      totalAudioMs: result.totalAudioMs,
      matchedRuleIds: []
    };
  }

  private removeProvisionalSegment(state: SessionState, channelId: string): void {
    state.transcriptSegments = state.transcriptSegments.filter(
      (segment) => !(segment.channelId === channelId && !segment.isFinal)
    );
  }

  private requireSession(id: string): SessionInternal {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} was not found.`);
    }

    return session;
  }

  private cloneState(state: SessionState): SessionState {
    return JSON.parse(JSON.stringify(state)) as SessionState;
  }

  private getChannelMode(session: SessionInternal, channelId: string): ProviderMode {
    return session.state.channels.find((channel) => channel.id === channelId)?.mode || "soniox";
  }

  private deleteChannelScopedKeys(map: Map<string, unknown>, channelId: string): void {
    const prefix = `${channelId}:`;
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) {
        map.delete(key);
      }
    }
  }
}

function firstNumber(values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => typeof value === "number");
}

function lastNumber(values: Array<number | undefined>): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (typeof value === "number") {
      return value;
    }
  }

  return undefined;
}

function csvEscape(value: string): string {
  if (!/[",\n]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeContextTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawTerm of terms) {
    const term = rawTerm.trim();
    const key = term.toLocaleLowerCase("he-IL");
    if (!term || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(term);
  }

  return normalized.slice(0, 100);
}
