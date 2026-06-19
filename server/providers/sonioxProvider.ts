import WebSocket from "ws";
import type { RealtimeProvider, ProviderChannelCallbacks, StartChannelOptions } from "./types.js";
import { parseSonioxMessage } from "./sonioxParser.js";

interface SonioxProviderConfig {
  apiKey?: string;
  maxEndpointDelayMs: number;
  model: string;
  wsUrl: string;
}

interface ConnectionState {
  ws: WebSocket;
  callbacks: ProviderChannelCallbacks;
  pendingChunks: Buffer[];
  opened: boolean;
  stopping: boolean;
}

export class SonioxProvider implements RealtimeProvider {
  private readonly connections = new Map<string, ConnectionState>();

  constructor(private readonly config: SonioxProviderConfig) {}

  startChannel(options: StartChannelOptions, callbacks: ProviderChannelCallbacks): string {
    if (!this.config.apiKey) {
      callbacks.onError({
        type: "missing_api_key",
        message: "SONIOX_API_KEY is not configured. Add it to .env and restart the server."
      });
      return "";
    }

    const connectionId = crypto.randomUUID();
    const ws = new WebSocket(this.config.wsUrl);
    const state: ConnectionState = {
      ws,
      callbacks,
      pendingChunks: [],
      opened: false,
      stopping: false
    };

    this.connections.set(connectionId, state);

    ws.on("open", () => {
      state.opened = true;
      ws.send(
        JSON.stringify({
          api_key: this.config.apiKey,
          model: this.config.model,
          audio_format: "pcm_s16le",
          sample_rate: 16000,
          num_channels: 1,
          language_hints: ["he"],
          enable_language_identification: true,
          enable_speaker_diarization: true,
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: this.config.maxEndpointDelayMs,
          client_reference_id: `${options.channelName}-${options.channelId}`.slice(0, 256),
          context: {
            general: [
              { key: "domain", value: "UAV operations monitoring prototype" },
              { key: "channel", value: options.channelName }
            ],
            terms: options.contextTerms?.filter(Boolean).slice(0, 100) || []
          }
        })
      );

      for (const chunk of state.pendingChunks.splice(0)) {
        ws.send(chunk);
      }

      callbacks.onOpen();
    });

    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      const parsed = parseSonioxMessage(raw);

      if (parsed.error) {
        callbacks.onError(parsed.error);
        return;
      }

      if (parsed.result) {
        callbacks.onResult(parsed.result);
      }
    });

    ws.on("error", (error) => {
      callbacks.onError({
        type: "websocket_error",
        message: error.message
      });
    });

    ws.on("close", () => {
      this.connections.delete(connectionId);
      callbacks.onClose();
    });

    return connectionId;
  }

  sendAudio(connectionId: string, chunk: Buffer): void {
    const state = this.connections.get(connectionId);
    if (!state || state.stopping) {
      return;
    }

    if (state.opened && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(chunk);
      return;
    }

    if (state.pendingChunks.length < 200) {
      state.pendingChunks.push(chunk);
    }
  }

  stopChannel(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state || state.stopping) {
      return;
    }

    state.stopping = true;
    if (state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(Buffer.alloc(0));
    } else {
      state.ws.close();
    }
  }

  closeChannel(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state) {
      return;
    }

    state.stopping = true;
    state.ws.close();
    this.connections.delete(connectionId);
  }
}
