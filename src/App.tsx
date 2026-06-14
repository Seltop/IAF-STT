import {
  Activity,
  AlertTriangle,
  Check,
  Download,
  Mic,
  Plus,
  Radio,
  Settings,
  Square,
  Trash2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CHANNEL_COLORS } from "../shared/defaults.js";
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

const severityLabels: Record<Severity, string> = {
  low: "נמוך",
  medium: "בינוני",
  high: "גבוה"
};

const severityColors: Record<Severity, string> = {
  low: "#0ea5e9",
  medium: "#f59e0b",
  high: "#ef4444"
};

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [channelName, setChannelName] = useState("ערוץ 1");
  const [contextText, setContextText] = useState("כטבם, חמ״ל, מפקד משימה, צוות קרקע");
  const [newRulePhrase, setNewRulePhrase] = useState("");
  const [newRuleSeverity, setNewRuleSeverity] = useState<Severity>("medium");
  const [toast, setToast] = useState<string | null>(null);
  const [monitorConnected, setMonitorConnected] = useState(false);
  const monitorWsRef = useRef<WebSocket | null>(null);
  const capturesRef = useRef(new Map<string, ActiveCapture>());

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

        setSession(initialSession);
        window.history.replaceState(null, "", `?session=${initialSession.id}`);
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
      ws.send(JSON.stringify({ type: "join_session", sessionId: session.id }));
    });

    ws.addEventListener("close", () => setMonitorConnected(false));
    ws.addEventListener("message", handleServerMessage);

    return () => {
      ws.close();
    };
  }, [session?.id]);

  const finalSegments = useMemo(
    () => session?.transcriptSegments.filter((segment) => segment.isFinal).slice(-120) || [],
    [session]
  );
  const provisionalSegments = useMemo(
    () => session?.transcriptSegments.filter((segment) => !segment.isFinal) || [],
    [session]
  );
  const openTriggerEvents = useMemo(
    () => session?.triggerEvents.filter((event) => !event.acknowledgedAt).slice().reverse() || [],
    [session]
  );
  const acknowledgedEvents = useMemo(
    () => session?.triggerEvents.filter((event) => event.acknowledgedAt).slice(-20).reverse() || [],
    [session]
  );
  const canAddChannel = Boolean(session && session.channels.length < session.maxChannels);

  async function unlockDevices() {
    try {
      await requestDeviceLabels();
      await refreshDevices();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "אין הרשאת מיקרופון");
    }
  }

  async function startChannel() {
    if (!session || !canAddChannel) {
      return;
    }

    const color = DEFAULT_CHANNEL_COLORS[session.channels.length % DEFAULT_CHANNEL_COLORS.length];
    const channelId = crypto.randomUUID();
    const device = devices.find((item) => item.deviceId === selectedDeviceId);

    try {
      const capture = await startChannelCapture({
        sessionId: session.id,
        channelId,
        name: channelName.trim() || `ערוץ ${session.channels.length + 1}`,
        color,
        deviceId: selectedDeviceId || undefined,
        sourceLabel: device?.label,
        contextTerms: contextText
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        onMessage: handleServerMessage,
        onError: setToast,
        onStopped: () => capturesRef.current.delete(channelId)
      });

      capturesRef.current.set(channelId, capture);
      setChannelName(`ערוץ ${session.channels.length + 2}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "הפעלת הערוץ נכשלה");
    }
  }

  function stopChannel(channelId: string) {
    capturesRef.current.get(channelId)?.stop();
    capturesRef.current.delete(channelId);
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

  function updateRule(ruleId: string, patch: Partial<TriggerRule>) {
    if (!session) {
      return;
    }

    sendRules(
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
    sendRules([
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

    sendRules(session.triggerRules.filter((rule) => rule.id !== ruleId));
  }

  function acknowledge(eventId: string) {
    if (!session || monitorWsRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    monitorWsRef.current.send(
      JSON.stringify({
        type: "ack_trigger",
        sessionId: session.id,
        triggerEventId: eventId
      })
    );
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
            <span>{session.channels.length}/{session.maxChannels} ערוצים</span>
            <span>{session.id.slice(0, 8)}</span>
          </div>
        </div>
        <div className="top-actions">
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
          <span>SONIOX_API_KEY חסר בשרת. התצוגה תעבוד, אך תמלול חי לא יתחיל עד להגדרת המפתח.</span>
        </section>
      )}

      <section className="workspace">
        <aside className="control-panel">
          <section className="panel-section">
            <div className="section-heading">
              <Mic size={18} />
              <h2>ערוצים</h2>
            </div>

            <label className="field">
              <span>שם</span>
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
              <textarea value={contextText} onChange={(event) => setContextText(event.target.value)} rows={3} />
            </label>

            <div className="button-row">
              <button className="icon-button" onClick={unlockDevices} title="רענון מיקרופונים">
                <Settings size={18} />
                הרשאה
              </button>
              <button className="primary-button" onClick={startChannel} disabled={!canAddChannel} title="הפעלת ערוץ">
                <Plus size={18} />
                הפעל
              </button>
            </div>

            <div className="channel-list">
              {session.channels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={capturesRef.current.has(channel.id)}
                  onStop={() => stopChannel(channel.id)}
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
          <div className="section-heading">
            <Activity size={18} />
            <h2>תמלול</h2>
          </div>

          <div className="transcript-stream">
            {finalSegments.length === 0 && provisionalSegments.length === 0 && (
              <div className="empty-state">ממתין לשמע חי</div>
            )}

            {finalSegments.map((segment) => (
              <TranscriptLine
                key={segment.id}
                segment={segment}
                channel={session.channels.find((channel) => channel.id === segment.channelId)}
                rules={session.triggerRules}
              />
            ))}

            {provisionalSegments.map((segment) => (
              <TranscriptLine
                key={segment.id}
                segment={segment}
                channel={session.channels.find((channel) => channel.id === segment.channelId)}
                rules={session.triggerRules}
              />
            ))}
          </div>
        </section>

        <aside className="event-panel">
          <div className="section-heading">
            <AlertTriangle size={18} />
            <h2>אירועים</h2>
          </div>

          <div className="event-list">
            {openTriggerEvents.length === 0 && <div className="empty-state">אין אירועים פתוחים</div>}
            {openTriggerEvents.map((event) => (
              <article className={`event-item severity-${event.severity}`} key={event.id}>
                <div className="event-top">
                  <span style={{ backgroundColor: event.color }}>{severityLabels[event.severity]}</span>
                  <time>{formatTime(event.createdAt)}</time>
                </div>
                <strong>{event.phrase}</strong>
                <p>{event.transcriptText}</p>
                <button className="icon-button" onClick={() => acknowledge(event.id)} title="אישור אירוע">
                  <Check size={17} />
                  אישור
                </button>
              </article>
            ))}
          </div>

          <div className="section-heading compact-heading">
            <Check size={16} />
            <h2>טופלו</h2>
          </div>
          <div className="ack-list">
            {acknowledgedEvents.map((event) => (
              <div className="ack-item" key={event.id}>
                <span>{event.phrase}</span>
                <time>{formatTime(event.acknowledgedAt || event.createdAt)}</time>
              </div>
            ))}
          </div>
        </aside>
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

function ChannelRow({ channel, active, onStop }: { channel: Channel; active: boolean; onStop: () => void }) {
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
        <button className="icon-only" onClick={onStop} disabled={!active} title="עצירת ערוץ">
          <Square size={15} />
        </button>
      </div>
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
  const matchedRules = rules.filter((rule) => segment.matchedRuleIds.includes(rule.id));

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
      <p>{segment.text}</p>
      {matchedRules.length > 0 && (
        <div className="match-row">
          {matchedRules.map((rule) => (
            <span key={rule.id} style={{ backgroundColor: rule.color }}>
              {rule.phrase}
            </span>
          ))}
        </div>
      )}
    </article>
  );
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
