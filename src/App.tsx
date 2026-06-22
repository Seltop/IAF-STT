import {
  Activity,
  AlertTriangle,
  Copy,
  Download,
  Mic,
  Plus,
  Radio,
  Settings,
  Square,
  Trash2,
  UserPlus
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CHANNEL_COLORS, DEFAULT_CONTEXT_TERMS } from "../shared/defaults.js";
import { normalizeHebrew } from "../shared/hebrew.js";
import type { Channel, ServerMessage, SessionState, Severity, TriggerRule } from "../shared/types.js";
import { createSession, exportUrl, fetchSession } from "./lib/api";
import {
  type ActiveCapture,
  listAudioInputs,
  requestDeviceLabels,
  startChannelCapture
} from "./lib/audioCapture";
import { websocketUrl } from "./lib/ws";

const severityColors: Record<Severity, string> = {
  low: "#0ea5e9",
  medium: "#f59e0b",
  high: "#ef4444"
};

const CHAT_GROUP_GAP_MS = 25_000;
const HEBREW_TRIGGER_PREFIXES = "ובכלמהש";
const SETTINGS_STORAGE_KEY = "hebrew-stt-monitor-settings-v1";

interface PersistedSettings {
  contextTerms?: string[];
  contextText?: string;
  triggerRules?: TriggerRule[];
}

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [channelName, setChannelName] = useState("ערוץ 1");
  const [contextText, setContextText] = useState("");
  const [newRulePhrase, setNewRulePhrase] = useState("");
  const [newRuleSeverity, setNewRuleSeverity] = useState<Severity>("medium");
  const [toast, setToast] = useState<string | null>(null);
  const [monitorConnected, setMonitorConnected] = useState(false);
  const monitorWsRef = useRef<WebSocket | null>(null);
  const capturesRef = useRef(new Map<string, ActiveCapture>());
  const pendingSettingsRestoreRef = useRef<{ sessionId: string; settings: PersistedSettings } | null>(null);
  const syncedContextSessionIdRef = useRef<string | null>(null);

  const refreshDevices = useCallback(async () => {
    const inputs = await listAudioInputs();
    setDevices(inputs);
    if (!selectedDeviceId && inputs[0]) {
      setSelectedDeviceId(inputs[0].deviceId);
    }
  }, [selectedDeviceId]);

  const handleServerMessage = useCallback((event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === "state") {
        setSession(message.state);
      } else if (message.type === "provider_error") {
        setToast(message.message);
      }
    } catch {
      setToast("התקבלה הודעה לא תקינה מהשרת");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const fromUrl = new URLSearchParams(window.location.search).get("session");
        const initialSession = fromUrl ? await fetchSession(fromUrl).catch(() => createSession()) : await createSession();

        if (cancelled) {
          return;
        }

        const persistedSettings = readPersistedSettings();
        const restoredSession = applyPersistedSettings(initialSession, persistedSettings);
        setSession(restoredSession);
        setContextText(formatContextTerms(restoredSession.contextTerms?.length ? restoredSession.contextTerms : DEFAULT_CONTEXT_TERMS));
        pendingSettingsRestoreRef.current = hasPersistedSettings(persistedSettings)
          ? {
              sessionId: restoredSession.id,
              settings: persistedSettings
            }
          : null;
        window.history.replaceState(null, "", `?session=${restoredSession.id}`);
        await refreshDevices();
      } catch (error) {
        setToast(error instanceof Error ? error.message : "טעינת המערכת נכשלה");
      }
    }

    boot();
    return () => {
      cancelled = true;
      monitorWsRef.current?.close();
      for (const capture of capturesRef.current.values()) {
        capture.stop();
      }
    };
  }, []);

  useEffect(() => {
    if (!session?.id) {
      return;
    }

    const ws = new WebSocket(websocketUrl("/ws/monitor"));
    monitorWsRef.current = ws;

    ws.addEventListener("open", () => {
      setMonitorConnected(true);
      restoreSettingsBeforeJoin(ws, session.id);
      ws.send(JSON.stringify({ type: "join_session", sessionId: session.id }));
    });

    ws.addEventListener("close", () => setMonitorConnected(false));
    ws.addEventListener("message", handleServerMessage);

    return () => {
      ws.close();
    };
  }, [session?.id]);

  useEffect(() => {
    if (!session?.id || syncedContextSessionIdRef.current === session.id) {
      return;
    }

    syncedContextSessionIdRef.current = session.id;
    setContextText(formatContextTerms(session.contextTerms?.length ? session.contextTerms : DEFAULT_CONTEXT_TERMS));
  }, [session?.id, session?.contextTerms]);

  const finalSegments = useMemo(() => {
    const segments = session?.transcriptSegments.filter((segment) => segment.isFinal).slice(-120) || [];
    return groupFinalSegments(segments);
  }, [session]);
  const provisionalSegments = useMemo(
    () => session?.transcriptSegments.filter((segment) => !segment.isFinal) || [],
    [session]
  );
  const chatItems = useMemo<ChatItem[]>(() => {
    if (!session) {
      return [];
    }

    return [
      ...session.channels.map((channel) => ({
        type: "join" as const,
        id: `join-${channel.id}`,
        createdAt: channel.createdAt,
        channel
      })),
      ...finalSegments.map((segment) => ({
        type: "segment" as const,
        id: segment.id,
        createdAt: segment.createdAt,
        segment
      })),
      ...provisionalSegments.map((segment) => ({
        type: "segment" as const,
        id: segment.id,
        createdAt: segment.createdAt,
        segment
      }))
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [session, finalSegments, provisionalSegments]);
  const canAddChannel = Boolean(session && session.channels.length < session.maxChannels);

  async function unlockDevices() {
    try {
      await requestDeviceLabels();
      await refreshDevices();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "אין הרשאת מיקרופון");
    }
  }

  async function startChannel(channel?: Channel) {
    if (!session || (!channel && !canAddChannel)) {
      return;
    }

    const color = channel?.color || DEFAULT_CHANNEL_COLORS[session.channels.length % DEFAULT_CHANNEL_COLORS.length];
    const channelId = channel?.id || crypto.randomUUID();
    const name = channel?.name || channelName.trim() || `ערוץ ${session.channels.length + 1}`;
    const device = devices.find((item) => item.deviceId === selectedDeviceId);

    try {
      const capture = await startChannelCapture({
        sessionId: session.id,
        channelId,
        name,
        color,
        deviceId: selectedDeviceId || undefined,
        sourceLabel: device?.label,
        contextTerms: parseContextTerms(contextText),
        onMessage: handleServerMessage,
        onError: setToast,
        onStopped: () => capturesRef.current.delete(channelId)
      });

      capturesRef.current.set(channelId, capture);
      if (!channel) {
        setChannelName(`ערוץ ${session.channels.length + 2}`);
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "הפעלת הערוץ נכשלה");
    }
  }

  function stopChannel(channelId: string) {
    capturesRef.current.get(channelId)?.stop();
    capturesRef.current.delete(channelId);
  }

  function deleteChannel(channelId: string) {
    if (!session || monitorWsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    stopChannel(channelId);
    monitorWsRef.current.send(
      JSON.stringify({
        type: "delete_channel",
        sessionId: session.id,
        channelId
      })
    );
  }

  function clearChat() {
    if (!session || monitorWsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    const hasHistory = session.transcriptSegments.length > 0 || session.triggerEvents.length > 0;
    if (!hasHistory) {
      return;
    }

    setSession((current) =>
      current
        ? {
            ...current,
            transcriptSegments: [],
            triggerEvents: []
          }
        : current
    );
    monitorWsRef.current.send(
      JSON.stringify({
        type: "clear_chat",
        sessionId: session.id
      })
    );
  }

  function sendRules(rules: TriggerRule[]) {
    if (!session || monitorWsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    monitorWsRef.current.send(
      JSON.stringify({
        type: "update_trigger_rules",
        sessionId: session.id,
        rules
      })
    );
  }

  function applyTriggerRules(rules: TriggerRule[]) {
    setSession((current) => (current ? { ...current, triggerRules: rules } : current));
    persistSettings({
      contextTerms: parseContextTerms(contextText),
      contextText,
      triggerRules: rules
    });
    sendRules(rules);
  }

  function sendContextTerms(terms: string[]) {
    if (!session || monitorWsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    monitorWsRef.current.send(
      JSON.stringify({
        type: "update_context_terms",
        sessionId: session.id,
        terms
      })
    );
  }

  function updateContextText(value: string) {
    const terms = parseContextTerms(value);
    setContextText(value);
    setSession((current) => (current ? { ...current, contextTerms: terms } : current));
    persistSettings({
      contextTerms: terms,
      contextText: value,
      triggerRules: session?.triggerRules
    });
    sendContextTerms(terms);
  }

  function restoreSettingsBeforeJoin(ws: WebSocket, sessionId: string) {
    const pending = pendingSettingsRestoreRef.current;
    if (!pending || pending.sessionId !== sessionId) {
      return;
    }

    const terms = pending.settings.contextTerms || parseContextTerms(pending.settings.contextText || "");
    if (terms.length > 0) {
      ws.send(
        JSON.stringify({
          type: "update_context_terms",
          sessionId,
          terms
        })
      );
    }

    if (pending.settings.triggerRules?.length) {
      ws.send(
        JSON.stringify({
          type: "update_trigger_rules",
          sessionId,
          rules: pending.settings.triggerRules
        })
      );
    }

    pendingSettingsRestoreRef.current = null;
  }

  function updateRule(ruleId: string, patch: Partial<TriggerRule>) {
    if (!session) {
      return;
    }

    applyTriggerRules(
      session.triggerRules.map((rule) =>
        rule.id === ruleId
          ? {
              ...rule,
              ...patch,
              normalizedPhrase: normalizeHebrew(patch.phrase ?? rule.phrase)
            }
          : rule
      )
    );
  }

  function addRule() {
    if (!session || !newRulePhrase.trim()) {
      return;
    }

    const phrase = newRulePhrase.trim();
    applyTriggerRules([
      ...session.triggerRules,
      {
        id: crypto.randomUUID(),
        phrase,
        normalizedPhrase: normalizeHebrew(phrase),
        severity: newRuleSeverity,
        color: severityColors[newRuleSeverity],
        enabled: true,
        cooldownSeconds: 8
      }
    ]);
    setNewRulePhrase("");
  }

  function removeRule(ruleId: string) {
    if (!session) {
      return;
    }

    applyTriggerRules(session.triggerRules.filter((rule) => rule.id !== ruleId));
  }

  async function copySessionLink() {
    if (!session) {
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("session", session.id);
    const copied = await copyText(url.toString());
    setToast(copied ? "Session link copied" : url.toString());
  }

  if (!session) {
    return (
      <main className="boot" dir="rtl">
        <Activity className="spin" />
        <span>טוען מוניטור</span>
      </main>
    );
  }

  return (
    <main className="app-shell" dir="rtl">
      <header className="topbar">
        <div className="title-block">
          <div className="title-row">
            <Radio size={24} />
            <h1>מוניטור תמלול חי</h1>
          </div>
          <div className="meta-row">
            <StatusPill active={monitorConnected} label={monitorConnected ? "מחובר" : "מנותק"} />
            <span>{session.providerName}</span>
            <span>{session.channels.length}/{session.maxChannels} ערוצים</span>
            <span>{session.id.slice(0, 8)}</span>
          </div>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={() => void copySessionLink()} title="Copy session link">
            <Copy size={18} />
            Link
          </button>
          <a className="icon-button" href={exportUrl(session.id, "csv")} title="ייצוא CSV">
            <Download size={18} />
            CSV
          </a>
          <a className="icon-button" href={exportUrl(session.id, "json")} title="ייצוא JSON">
            <Download size={18} />
            JSON
          </a>
        </div>
      </header>

      {!session.providerConfigured && (
        <section className="alert-strip">
          <AlertTriangle size={18} />
          <span>{session.providerMessage || "חסרים פרטי התחברות לספק התמלול. התצוגה תעבוד, אך תמלול חי לא יתחיל."}</span>
        </section>
      )}

      <section className="workspace">
        <aside className="control-panel">
          <section className="panel-section">
            <div className="section-heading">
              <Mic size={18} />
              <h2>משתתפים</h2>
            </div>

            <label className="field">
              <span>שם משתתף</span>
              <input value={channelName} onChange={(event) => setChannelName(event.target.value)} />
            </label>

            <label className="field">
              <span>מקור שמע</span>
              <select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>
                {devices.length === 0 && <option value="">ברירת מחדל</option>}
                {devices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `מיקרופון ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>מונחי הקשר</span>
              <textarea value={contextText} onChange={(event) => updateContextText(event.target.value)} rows={3} />
              <small className="field-hint">נשלח ל-Soniox בהפעלת מיקרופון חדשה או בהפעלה מחדש של משתתף.</small>
            </label>

            <div className="button-row">
              <button className="icon-button" onClick={unlockDevices} title="רענון מיקרופונים">
                <Settings size={18} />
                הרשאה
              </button>
              <button
                className="primary-button"
                onClick={() => void startChannel()}
                disabled={!canAddChannel}
                title="הוספת משתתף חדש"
              >
                <Plus size={18} />
                משתתף חדש
              </button>
            </div>

            <div className="channel-list">
              {session.channels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={capturesRef.current.has(channel.id)}
                  onStart={() => void startChannel(channel)}
                  onStop={() => stopChannel(channel.id)}
                  onDelete={() => deleteChannel(channel.id)}
                />
              ))}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <AlertTriangle size={18} />
              <h2>טריגרים</h2>
            </div>

            <div className="rule-add">
              <input
                value={newRulePhrase}
                onChange={(event) => setNewRulePhrase(event.target.value)}
                placeholder="מילה או ביטוי"
              />
              <select value={newRuleSeverity} onChange={(event) => setNewRuleSeverity(event.target.value as Severity)}>
                <option value="low">נמוך</option>
                <option value="medium">בינוני</option>
                <option value="high">גבוה</option>
              </select>
              <button className="icon-only" onClick={addRule} title="הוספת טריגר">
                <Plus size={18} />
              </button>
            </div>

            <div className="rule-list">
              {session.triggerRules.map((rule) => (
                <div className="rule-row" key={rule.id}>
                  <input
                    value={rule.phrase}
                    onChange={(event) => updateRule(rule.id, { phrase: event.target.value })}
                    aria-label="ביטוי טריגר"
                  />
                  <select
                    value={rule.severity}
                    onChange={(event) =>
                      updateRule(rule.id, {
                        severity: event.target.value as Severity,
                        color: severityColors[event.target.value as Severity]
                      })
                    }
                    aria-label="חומרה"
                  >
                    <option value="low">נמוך</option>
                    <option value="medium">בינוני</option>
                    <option value="high">גבוה</option>
                  </select>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
                    />
                    <span />
                  </label>
                  <button className="icon-only quiet" onClick={() => removeRule(rule.id)} title="מחיקה">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <section className="transcript-panel">
          <div className="chat-heading">
            <div className="section-heading">
              <Activity size={18} />
              <h2>צ'אט</h2>
            </div>
            <button
              className="icon-button danger-button"
              onClick={clearChat}
              disabled={session.transcriptSegments.length === 0 && session.triggerEvents.length === 0}
              title="מחיקת היסטוריית צ'אט"
            >
              <Trash2 size={16} />
              נקה צ'אט
            </button>
          </div>

          <div className="transcript-stream">
            {chatItems.length === 0 && (
              <div className="empty-state">ממתין לשמע חי</div>
            )}

            {chatItems.map((item) =>
              item.type === "join" ? (
                <ParticipantJoinedNotice key={item.id} channel={item.channel} />
              ) : (
                <TranscriptLine
                  key={item.id}
                  segment={item.segment}
                  channel={session.channels.find((channel) => channel.id === item.segment.channelId)}
                  rules={session.triggerRules}
                />
              )
            )}
          </div>
        </section>

      </section>

      {toast && (
        <button className="toast" onClick={() => setToast(null)} title="סגירה">
          <AlertTriangle size={17} />
          <span>{toast}</span>
        </button>
      )}
    </main>
  );
}

type TranscriptSegment = SessionState["transcriptSegments"][number];
type ChatItem =
  | {
      type: "join";
      id: string;
      createdAt: string;
      channel: Channel;
    }
  | {
      type: "segment";
      id: string;
      createdAt: string;
      segment: TranscriptSegment;
    };

function groupFinalSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const groups: TranscriptSegment[] = [];

  for (const segment of segments) {
    const previous = groups[groups.length - 1];
    if (!previous || !shouldMergeSegments(previous, segment)) {
      groups.push({
        ...segment,
        matchedRuleIds: [...segment.matchedRuleIds],
        tokens: [...segment.tokens]
      });
      continue;
    }

    previous.id = `${previous.id}:${segment.id}`;
    previous.text = joinTranscriptText(previous.text, segment.text);
    previous.tokens = [...previous.tokens, ...segment.tokens];
    previous.endedAtMs = segment.endedAtMs ?? previous.endedAtMs;
    previous.finalAudioMs = segment.finalAudioMs ?? previous.finalAudioMs;
    previous.totalAudioMs = segment.totalAudioMs ?? previous.totalAudioMs;
    previous.createdAt = segment.createdAt;
    previous.confidence = averageConfidence(previous.confidence, segment.confidence);
    previous.matchedRuleIds = [...new Set([...previous.matchedRuleIds, ...segment.matchedRuleIds])];
  }

  return groups;
}

function shouldMergeSegments(previous: TranscriptSegment, current: TranscriptSegment): boolean {
  if (previous.channelId !== current.channelId) {
    return false;
  }

  if (previous.speaker && current.speaker && previous.speaker !== current.speaker) {
    return false;
  }

  const previousTime = new Date(previous.createdAt).getTime();
  const currentTime = new Date(current.createdAt).getTime();
  return Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime - previousTime <= CHAT_GROUP_GAP_MS;
}

function joinTranscriptText(previous: string, current: string): string {
  const left = previous.trimEnd();
  const right = current.trimStart();
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return startsWithClosingPunctuation(right) ? `${left}${right}` : `${left} ${right}`;
}

function averageConfidence(previous?: number, current?: number): number | undefined {
  if (typeof previous === "number" && typeof current === "number") {
    return (previous + current) / 2;
  }
  return previous ?? current;
}

function startsWithClosingPunctuation(value: string): boolean {
  return /^[,.;:!?…،؟]/u.test(value);
}

function applyPersistedSettings(session: SessionState, settings: PersistedSettings): SessionState {
  const contextTerms = settings.contextTerms?.length
    ? settings.contextTerms
    : settings.contextText
      ? parseContextTerms(settings.contextText)
      : session.contextTerms;

  return {
    ...session,
    contextTerms,
    triggerRules: settings.triggerRules?.length ? settings.triggerRules : session.triggerRules
  };
}

function readPersistedSettings(): PersistedSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      contextTerms: Array.isArray(parsed.contextTerms) ? parsed.contextTerms.map(String).filter(Boolean) : undefined,
      contextText: typeof parsed.contextText === "string" ? parsed.contextText : undefined,
      triggerRules: Array.isArray(parsed.triggerRules) ? parsed.triggerRules.filter(isTriggerRule) : undefined
    };
  } catch {
    return {};
  }
}

function persistSettings(settings: PersistedSettings): void {
  try {
    const current = readPersistedSettings();
    const next: PersistedSettings = {
      ...current,
      ...settings
    };
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be unavailable in hardened browser settings.
  }
}

function hasPersistedSettings(settings: PersistedSettings): boolean {
  return Boolean(settings.contextTerms?.length || settings.contextText?.trim() || settings.triggerRules?.length);
}

function isTriggerRule(value: unknown): value is TriggerRule {
  if (!value || typeof value !== "object") {
    return false;
  }

  const rule = value as Partial<TriggerRule>;
  return (
    typeof rule.id === "string" &&
    typeof rule.phrase === "string" &&
    (rule.severity === "low" || rule.severity === "medium" || rule.severity === "high") &&
    typeof rule.color === "string" &&
    typeof rule.enabled === "boolean" &&
    typeof rule.cooldownSeconds === "number"
  );
}

function parseContextTerms(value: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const rawTerm of value.split(",")) {
    const term = rawTerm.trim();
    const key = term.toLocaleLowerCase("he-IL");
    if (!term || seen.has(key)) {
      continue;
    }

    seen.add(key);
    terms.push(term);
  }

  return terms.slice(0, 100);
}

function formatContextTerms(terms: string[]): string {
  return terms.join(", ");
}

function ChannelRow({
  channel,
  active,
  onStart,
  onStop,
  onDelete
}: {
  channel: Channel;
  active: boolean;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const canStart = !active && (channel.status === "stopped" || channel.status === "idle" || channel.status === "error");

  return (
    <article className="channel-row">
      <div className="channel-main">
        <span className="channel-dot" style={{ backgroundColor: channel.color }} />
        <div>
          <strong>{channel.name}</strong>
          <small>{channel.sourceLabel || channel.status}</small>
        </div>
      </div>
      <div className="channel-actions">
        <StatusPill active={channel.status === "listening"} label={statusLabel(channel.status)} />
        <button
          className="icon-only"
          onClick={active ? onStop : onStart}
          disabled={active ? false : !canStart}
          title={active ? "עצירת מיקרופון" : "הפעלת מיקרופון לערוץ"}
        >
          {active ? <Square size={15} /> : <Mic size={16} />}
        </button>
        <button className="icon-only quiet" onClick={onDelete} title="מחיקת ערוץ">
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}

function ParticipantJoinedNotice({ channel }: { channel: Channel }) {
  return (
    <article className="join-notice">
      <UserPlus size={15} />
      <span>
        משתתף הצטרף: <strong>{channel.name}</strong>
      </span>
      <time>{formatTime(channel.createdAt)}</time>
    </article>
  );
}

function TranscriptLine({
  segment,
  channel,
  rules
}: {
  segment: SessionState["transcriptSegments"][number];
  channel?: Channel;
  rules: TriggerRule[];
}) {
  const highlightedText = renderHighlightedTranscript(segment.text, rules);

  return (
    <article className={`transcript-line ${segment.isFinal ? "" : "provisional"}`}>
      <div className="line-meta">
        <span className="channel-tag" style={{ borderColor: channel?.color || "#64748b" }}>
          {channel?.name || "ערוץ"}
        </span>
        <time>{formatTime(segment.createdAt)}</time>
        {typeof segment.confidence === "number" && <span>{Math.round(segment.confidence * 100)}%</span>}
        {segment.speaker && <span>{segment.speaker}</span>}
      </div>
      <p>{highlightedText}</p>
    </article>
  );
}

function renderHighlightedTranscript(text: string, rules: TriggerRule[]): ReactNode[] {
  const matches = findTriggerMatches(text, rules);
  if (matches.length === 0) {
    return [text];
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      nodes.push(text.slice(cursor, match.start));
    }

    nodes.push(
      <mark className="trigger-highlight" key={`${match.start}-${match.end}-${match.rule.id}`} title={match.rule.phrase}>
        {text.slice(match.start, match.end)}
      </mark>
    );
    cursor = match.end;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function findTriggerMatches(text: string, rules: TriggerRule[]): Array<{ start: number; end: number; rule: TriggerRule }> {
  const matches: Array<{ start: number; end: number; rule: TriggerRule }> = [];

  for (const rule of rules) {
    const pattern = triggerPattern(rule.phrase);
    if (!rule.enabled || !pattern) {
      continue;
    }

    for (const match of text.matchAll(pattern)) {
      const separator = match[1] || "";
      const attachedPrefix = match[2] || "";
      const value = match[3] || "";
      if (!value) {
        continue;
      }

      const start = match.index + separator.length + attachedPrefix.length;
      matches.push({
        start,
        end: start + value.length,
        rule
      });
    }
  }

  return matches
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
    .filter((match, index, sorted) => {
      const previous = sorted
        .slice(0, index)
        .find((item) => item.start < match.end && match.start < item.end);
      return !previous;
    });
}

function triggerPattern(phrase: string): RegExp | undefined {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return undefined;
  }

  const source = words.map(escapeRegExp).join("\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])([${HEBREW_TRIGGER_PREFIXES}]{0,3})(${source})(?=$|[^\\p{L}\\p{N}])`, "giu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function StatusPill({ active, label }: { active: boolean; label: string }) {
  return (
    <span className={`status-pill ${active ? "active" : ""}`}>
      <span />
      {label}
    </span>
  );
}

function statusLabel(status: Channel["status"]): string {
  const labels: Record<Channel["status"], string> = {
    idle: "ממתין",
    connecting: "מתחבר",
    listening: "חי",
    stopping: "עוצר",
    stopped: "עצור",
    error: "שגיאה"
  };

  return labels[status];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back to a temporary textarea below.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}
