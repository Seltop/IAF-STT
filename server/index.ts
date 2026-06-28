import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { createProviders } from "./providers/providerFactory.js";
import { SessionStore } from "./sessionStore.js";
import type { Channel, MonitorClientMessage, ProviderMode, ServerMessage, TriggerRule } from "../shared/types.js";

const app = express();
const server = createServer(app);
const monitorWss = new WebSocketServer({ noServer: true });
const channelWss = new WebSocketServer({ noServer: true });
const providerRegistry = createProviders(config);
const store = new SessionStore(providerRegistry.statuses, config.maxChannels);

const monitorClients = new Map<string, Set<WebSocket>>();
const channelConnections = new Map<
  WebSocket,
  { sessionId: string; channelId: string; providerMode: ProviderMode; providerConnectionId: string }
>();
const basePath = config.publicBasePath;

app.use(express.json({ limit: "1mb" }));

app.post(routePath("/api/sessions"), (_req, res) => {
  res.status(201).json(store.createSession());
});

app.get(routePath("/api/sessions/:id/state"), (req, res) => {
  const sessionId = paramValue(req.params.id);
  const state = store.getSession(sessionId);
  if (!state) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json(state);
});

app.get(routePath("/api/sessions/:id/export"), (req, res) => {
  const sessionId = paramValue(req.params.id);

  try {
    const format = req.query.format === "csv" ? "csv" : "json";
    const filename = `stt-session-${sessionId}.${format}`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    if (format === "csv") {
      res.type("text/csv").send(store.exportCsv(sessionId));
      return;
    }

    res.type("application/json").send(store.exportJson(sessionId));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "Session not found" });
  }
});

const staticDir = path.resolve(process.cwd(), "dist");
app.use(routePath("/"), express.static(staticDir));
app.get(spaFallbackPattern(), (_req, res, next) => {
  if (process.env.NODE_ENV === "development") {
    next();
    return;
  }

  res.sendFile(path.join(staticDir, "index.html"));
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (url.pathname === routePath("/ws/monitor")) {
    monitorWss.handleUpgrade(request, socket, head, (ws) => monitorWss.emit("connection", ws, request));
    return;
  }

  if (url.pathname === routePath("/ws/channel")) {
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

      if (message.type === "delete_channel") {
        closeChannelConnection(message.sessionId, message.channelId);
        const state = store.deleteChannel(message.sessionId, message.channelId);
        broadcastState(message.sessionId, state);
        return;
      }

      if (message.type === "clear_chat") {
        const state = store.clearChat(message.sessionId);
        broadcastState(message.sessionId, state);
        return;
      }

      if (message.type === "update_trigger_rules") {
        const state = store.updateTriggerRules(message.sessionId, message.rules as TriggerRule[]);
        broadcastState(message.sessionId, state);
        return;
      }

      if (message.type === "update_context_terms") {
        const state = store.updateContextTerms(message.sessionId, message.terms);
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
        providerRegistry.providers.get(current.providerMode)?.sendAudio(current.providerConnectionId, Buffer.from(data as Buffer));
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
      providerRegistry.providers.get(current.providerMode)?.stopChannel(current.providerConnectionId);
    }
  });

  ws.on("close", () => {
    const current = channelConnections.get(ws);
    if (!current) {
      return;
    }

    providerRegistry.providers.get(current.providerMode)?.closeChannel(current.providerConnectionId);
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
  const providerMode = readProviderMode(raw.providerMode);
  const provider = providerRegistry.providers.get(providerMode);
  const sourceLabel = typeof raw.sourceLabel === "string" ? raw.sourceLabel : undefined;
  const contextTerms = Array.isArray(raw.contextTerms) ? raw.contextTerms.map(String) : [];

  try {
    if (!provider) {
      throw new Error(`Provider mode ${providerMode} is not available.`);
    }

    const channel: Channel = store.upsertChannel(sessionId, {
      id: channelId,
      name,
      color,
      mode: providerMode,
      sourceLabel
    });
    send(ws, { type: "channel_status", channel });
    broadcastState(sessionId);

    const providerConnectionId = provider.startChannel(
      {
        channelId,
        channelName: name,
        providerMode,
        contextTerms,
        keywords:
          store
            .getSession(sessionId)
            ?.triggerRules.map((rule) => ({
              phrase: rule.phrase,
              severity: rule.severity,
              enabled: rule.enabled
            })) || []
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
      providerMode,
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

function closeChannelConnection(sessionId: string, channelId: string): void {
  for (const [ws, connection] of channelConnections.entries()) {
    if (connection.sessionId !== sessionId || connection.channelId !== channelId) {
      continue;
    }

    providerRegistry.providers.get(connection.providerMode)?.closeChannel(connection.providerConnectionId);
    channelConnections.delete(ws);
    ws.close();
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
  const statuses = providerRegistry.statuses
    .map((provider) => `${provider.name}: ${provider.configured ? "configured" : "missing"}`)
    .join(", ");
  const publicPath = basePath || "/";
  console.log(`STT backend listening on http://127.0.0.1:${config.port}${publicPath} (${statuses})`);
});

function routePath(pathname: string): string {
  if (!basePath) {
    return pathname;
  }

  if (pathname === "/") {
    return basePath;
  }

  return `${basePath}${pathname}`;
}

function spaFallbackPattern(): RegExp {
  if (!basePath) {
    return /.*/;
  }

  return new RegExp(`^${escapeRegExp(basePath)}(?:/.*)?$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function paramValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function readProviderMode(value: unknown): ProviderMode {
  return value === "local" ? "local" : "soniox";
}
