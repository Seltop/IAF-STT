import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { createProvider } from "./providers/providerFactory.js";
import { SessionStore } from "./sessionStore.js";
import type { Channel, MonitorClientMessage, ServerMessage, TriggerRule } from "../shared/types.js";

const app = express();
const server = createServer(app);
const monitorWss = new WebSocketServer({ noServer: true });
const channelWss = new WebSocketServer({ noServer: true });
const providerSelection = createProvider(config);
const store = new SessionStore(
  providerSelection.providerName,
  providerSelection.configured,
  providerSelection.message,
  config.maxChannels
);
const provider = providerSelection.provider;

const monitorClients = new Map<string, Set<WebSocket>>();
const channelConnections = new Map<WebSocket, { sessionId: string; channelId: string; providerConnectionId: string }>();

app.use(express.json({ limit: "1mb" }));

app.post("/api/sessions", (_req, res) => {
  res.status(201).json(store.createSession());
});

app.get("/api/sessions/:id/state", (req, res) => {
  const state = store.getSession(req.params.id);
  if (!state) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json(state);
});

app.get("/api/sessions/:id/export", (req, res) => {
  try {
    const format = req.query.format === "csv" ? "csv" : "json";
    const filename = `stt-session-${req.params.id}.${format}`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    if (format === "csv") {
      res.type("text/csv").send(store.exportCsv(req.params.id));
      return;
    }

    res.type("application/json").send(store.exportJson(req.params.id));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "Session not found" });
  }
});

const staticDir = path.resolve(process.cwd(), "dist");
app.use(express.static(staticDir));
app.get(/.*/, (_req, res, next) => {
  if (process.env.NODE_ENV === "development") {
    next();
    return;
  }

  res.sendFile(path.join(staticDir, "index.html"));
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/ws/monitor") {
    monitorWss.handleUpgrade(request, socket, head, (ws) => monitorWss.emit("connection", ws, request));
    return;
  }

  if (url.pathname === "/ws/channel") {
    channelWss.handleUpgrade(request, socket, head, (ws) => channelWss.emit("connection", ws, request));
    return;
  }

  socket.destroy();
});

monitorWss.on("connection", (ws) => {
  let joinedSessionId: string | undefined;

  ws.on("message", (data) => {
    const message = parseJson<MonitorClientMessage>(data.toString("utf8"));
    if (!message) {
      send(ws, { type: "provider_error", message: "Invalid monitor message." });
      return;
    }

    try {
      if (message.type === "join_session") {
        joinedSessionId = message.sessionId;
        const subscribers = getSubscribers(message.sessionId);
        subscribers.add(ws);
        const state = store.getSession(message.sessionId);
        if (state) {
          send(ws, { type: "state", state });
        }
        return;
      }

      if (message.type === "ack_trigger") {
        const state = store.acknowledgeTrigger(message.sessionId, message.triggerEventId);
        broadcastState(message.sessionId, state);
        return;
      }

      if (message.type === "update_trigger_rules") {
        const state = store.updateTriggerRules(message.sessionId, message.rules as TriggerRule[]);
        broadcastState(message.sessionId, state);
      }
    } catch (error) {
      send(ws, {
        type: "provider_error",
        message: error instanceof Error ? error.message : "Monitor action failed."
      });
    }
  });

  ws.on("close", () => {
    if (joinedSessionId) {
      monitorClients.get(joinedSessionId)?.delete(ws);
    }
  });
});

channelWss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    const current = channelConnections.get(ws);

    if (isBinary) {
      if (current?.providerConnectionId) {
        provider.sendAudio(current.providerConnectionId, Buffer.from(data as Buffer));
      }
      return;
    }

    const message = parseJson<Record<string, unknown>>(data.toString("utf8"));
    if (!message) {
      send(ws, { type: "provider_error", message: "Invalid channel message." });
      return;
    }

    if (message.type === "join_channel") {
      handleJoinChannel(ws, message);
      return;
    }

    if (message.type === "stop_channel" && current) {
      store.setChannelStatus(current.sessionId, current.channelId, "stopping");
      broadcastState(current.sessionId);
      provider.stopChannel(current.providerConnectionId);
    }
  });

  ws.on("close", () => {
    const current = channelConnections.get(ws);
    if (!current) {
      return;
    }

    provider.closeChannel(current.providerConnectionId);
    channelConnections.delete(ws);

    try {
      store.setChannelStatus(current.sessionId, current.channelId, "stopped");
      broadcastState(current.sessionId);
    } catch {
      // Session may have already been removed in future persistence implementations.
    }
  });
});

function handleJoinChannel(ws: WebSocket, raw: Record<string, unknown>): void {
  const sessionId = String(raw.sessionId || "");
  const channelId = String(raw.channelId || crypto.randomUUID());
  const name = String(raw.name || "Channel");
  const color = String(raw.color || "#2563eb");
  const sourceLabel = typeof raw.sourceLabel === "string" ? raw.sourceLabel : undefined;
  const contextTerms = Array.isArray(raw.contextTerms) ? raw.contextTerms.map(String) : [];

  try {
    const channel: Channel = store.upsertChannel(sessionId, {
      id: channelId,
      name,
      color,
      sourceLabel
    });
    send(ws, { type: "channel_status", channel });
    broadcastState(sessionId);

    const providerConnectionId = provider.startChannel(
      {
        channelId,
        channelName: name,
        contextTerms
      },
      {
        onOpen: () => {
          const updated = store.setChannelStatus(sessionId, channelId, "listening");
          send(ws, { type: "channel_status", channel: updated });
          broadcastState(sessionId);
        },
        onResult: (result) => {
          const update = store.applyProviderResult(sessionId, channelId, result);

          for (const segment of update.segments) {
            broadcast(sessionId, { type: "transcript_segment", segment });
          }

          for (const event of update.triggerEvents) {
            broadcast(sessionId, { type: "trigger_event", event });
          }

          if (update.finished) {
            store.setChannelStatus(sessionId, channelId, "stopped");
          }

          broadcastState(sessionId);
        },
        onError: (error) => {
          const updated = store.setChannelStatus(sessionId, channelId, "error", error.message);
          send(ws, { type: "provider_error", channelId, message: error.message, code: error.code });
          send(ws, { type: "channel_status", channel: updated });
          broadcast(sessionId, { type: "provider_error", channelId, message: error.message, code: error.code });
          broadcastState(sessionId);
        },
        onClose: () => {
          const current = store.getSession(sessionId)?.channels.find((item) => item.id === channelId);
          if (current && current.status !== "error") {
            store.setChannelStatus(sessionId, channelId, "stopped");
            broadcastState(sessionId);
          }
        }
      }
    );

    if (!providerConnectionId) {
      store.setChannelStatus(sessionId, channelId, "error", "Provider connection was not created.");
      broadcastState(sessionId);
      return;
    }

    channelConnections.set(ws, {
      sessionId,
      channelId,
      providerConnectionId
    });
  } catch (error) {
    send(ws, {
      type: "provider_error",
      channelId,
      message: error instanceof Error ? error.message : "Could not join channel."
    });
  }
}

function getSubscribers(sessionId: string): Set<WebSocket> {
  let subscribers = monitorClients.get(sessionId);
  if (!subscribers) {
    subscribers = new Set();
    monitorClients.set(sessionId, subscribers);
  }

  return subscribers;
}

function broadcastState(sessionId: string, state = store.getSession(sessionId)): void {
  if (state) {
    broadcast(sessionId, { type: "state", state });
  }
}

function broadcast(sessionId: string, message: ServerMessage): void {
  for (const client of getSubscribers(sessionId)) {
    send(client, message);
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

server.listen(config.port, () => {
  const keyStatus = providerSelection.configured ? "configured" : "missing";
  console.log(
    `STT backend listening on http://127.0.0.1:${config.port} (${providerSelection.providerName}: ${keyStatus})`
  );
});
