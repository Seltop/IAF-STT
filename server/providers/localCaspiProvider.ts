import WebSocket from "ws";
import { containsNormalizedPhrase, normalizeHebrew } from "../../shared/hebrew.js";
import type { ProviderChannelCallbacks, ProviderError, ProviderResult, RealtimeProvider, StartChannelOptions } from "./types.js";

interface LocalCaspiProviderConfig {
  wsUrl: string;
  model: string;
  language: string;
  confirmationEnabled: boolean;
  stableWordLag: number;
  minCommitIntervalMs: number;
}

interface LocalConnectionState {
  ws: WebSocket;
  callbacks: ProviderChannelCallbacks;
  pendingChunks: Buffer[];
  opened: boolean;
  stopping: boolean;
  committedText: string;
  lastObservedText: string;
  lastCommitAt: number;
  keywordPhrases: string[];
}

interface LocalCaspiResult {
  text: string;
  isFinal: boolean;
  finished: boolean;
  confidence?: number;
  language?: string;
}

interface LocalCaspiError {
  message: string;
  type?: string;
  code?: number;
}

export class LocalCaspiProvider implements RealtimeProvider {
  private readonly connections = new Map<string, LocalConnectionState>();

  constructor(private readonly config: LocalCaspiProviderConfig) {}

  startChannel(options: StartChannelOptions, callbacks: ProviderChannelCallbacks): string {
    if (!this.config.wsUrl) {
      callbacks.onError({
        type: "missing_local_stt_url",
        message: "LOCAL_STT_WS_URL is not configured."
      });
      return "";
    }

    const connectionId = crypto.randomUUID();
    const ws = new WebSocket(this.config.wsUrl);
    const state: LocalConnectionState = {
      ws,
      callbacks,
      pendingChunks: [],
      opened: false,
      stopping: false,
      committedText: "",
      lastObservedText: "",
      lastCommitAt: 0,
      keywordPhrases:
        options.keywords
          ?.filter((keyword) => keyword.enabled && keyword.phrase.trim())
          .map((keyword) => normalizeHebrew(keyword.phrase)) || []
    };

    this.connections.set(connectionId, state);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "start",
          channel_id: options.channelId,
          channel_name: options.channelName,
          model: this.config.model,
          language: this.config.language,
          audio_format: "pcm_s16le",
          sample_rate: 16000,
          num_channels: 1,
          confirmation_enabled: this.config.confirmationEnabled,
          context_terms: options.contextTerms?.filter(Boolean).slice(0, 100) || [],
          keywords:
            options.keywords
              ?.filter((keyword) => keyword.enabled && keyword.phrase.trim())
              .map((keyword) => ({
                phrase: keyword.phrase,
                severity: keyword.severity
              })) || []
        })
      );
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }

      const raw = typeof data === "string" ? data : data.toString("utf8");
      const parsed = parseLocalCaspiMessage(raw);

      if (parsed.error) {
        callbacks.onError(parsed.error);
        return;
      }

      if (parsed.ready) {
        state.opened = true;
        for (const chunk of state.pendingChunks.splice(0)) {
          ws.send(chunk);
        }
        callbacks.onOpen();
        return;
      }

      if (!parsed.result) {
        return;
      }

      const result = this.createProviderResult(state, parsed.result);
      if (result.tokens.length > 0 || result.finished) {
        callbacks.onResult(result);
      }
    });

    ws.on("error", (error) => {
      callbacks.onError({
        type: "local_stt_websocket_error",
        message: formatLocalSttConnectionError(error.message, this.config.wsUrl)
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
      state.ws.send(JSON.stringify({ type: "stop" }));
      return;
    }

    state.ws.close();
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

  private createProviderResult(state: LocalConnectionState, result: LocalCaspiResult): ProviderResult {
    const tokens: ProviderResult["tokens"] = [];
    const text = result.text;

    if (result.isFinal) {
      const finalDelta = extractDelta(state.committedText, text);
      state.committedText = text;
      state.lastObservedText = text;

      if (finalDelta.trim()) {
        tokens.push({
          text: finalDelta,
          isFinal: true,
          confidence: result.confidence,
          language: result.language || "he"
        });
      }

      return {
        tokens,
        finished: result.finished
      };
    }

    state.lastObservedText = text;
    if (containsAnyKeyword(text, state.keywordPhrases) && text.length > state.committedText.length) {
      const finalDelta = extractDelta(state.committedText, text);
      if (finalDelta.trim()) {
        state.committedText = text;
        state.lastCommitAt = Date.now();
        tokens.push({
          text: finalDelta,
          isFinal: true,
          confidence: result.confidence,
          language: result.language || "he"
        });
        return {
          tokens,
          finished: result.finished
        };
      }
    }

    const stableText = dropTrailingWords(text, this.config.stableWordLag);
    const now = Date.now();
    const shouldCommit =
      stableText.length > state.committedText.length &&
      now - state.lastCommitAt >= this.config.minCommitIntervalMs;

    if (shouldCommit) {
      const finalDelta = extractDelta(state.committedText, stableText);
      if (finalDelta.trim()) {
        state.committedText = stableText;
        state.lastCommitAt = now;
        tokens.push({
          text: finalDelta,
          isFinal: true,
          confidence: result.confidence,
          language: result.language || "he"
        });
      }
    }

    const provisionalDelta = extractDelta(state.committedText, text);
    if (provisionalDelta.trim()) {
      tokens.push({
        text: provisionalDelta,
        isFinal: false,
        confidence: result.confidence,
        language: result.language || "he"
      });
    }

    return {
      tokens,
      finished: result.finished
    };
  }
}

export function parseLocalCaspiMessage(raw: string): { ready?: boolean; result?: LocalCaspiResult; error?: ProviderError } {
  let message: Record<string, unknown>;

  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      error: {
        type: "local_stt_invalid_json",
        message: "Received a non-JSON message from the local STT sidecar."
      }
    };
  }

  if (message.type === "ready") {
    return { ready: true };
  }

  if (message.type === "error") {
    const error = message.error && typeof message.error === "object" ? (message.error as LocalCaspiError) : undefined;
    return {
      error: {
        type: typeof message.error_type === "string" ? message.error_type : error?.type || "local_stt_error",
        code: typeof message.code === "number" ? message.code : error?.code,
        message:
          stringValue(message.message) ||
          stringValue(error?.message) ||
          "The local STT sidecar returned an unknown error."
      }
    };
  }

  if (message.type === "finished") {
    return {
      result: {
        text: stringValue(message.text) || "",
        isFinal: true,
        finished: true,
        language: stringValue(message.language)
      }
    };
  }

  if (message.type !== "result") {
    return {};
  }

  const text = stringValue(message.text);
  if (text === undefined) {
    return {};
  }

  return {
    result: {
      text,
      isFinal: Boolean(message.is_final ?? message.final),
      finished: Boolean(message.finished),
      confidence: typeof message.confidence === "number" ? message.confidence : undefined,
      language: stringValue(message.language)
    }
  };
}

export function dropTrailingWords(text: string, wordLag: number): string {
  if (wordLag <= 0) {
    return text;
  }

  const trimmed = text.trimEnd();
  if (!trimmed) {
    return "";
  }

  const words = [...trimmed.matchAll(/\S+/g)];
  if (words.length <= wordLag) {
    return "";
  }

  const lastKeptWord = words[words.length - wordLag - 1];
  return trimmed.slice(0, lastKeptWord.index + lastKeptWord[0].length);
}

function extractDelta(committedText: string, nextText: string): string {
  if (!nextText) {
    return "";
  }

  if (!committedText) {
    return nextText;
  }

  if (nextText.startsWith(committedText)) {
    return nextText.slice(committedText.length);
  }

  const commonLength = commonPrefixLength(committedText, nextText);
  if (commonLength >= Math.floor(committedText.length * 0.8)) {
    return nextText.slice(commonLength);
  }

  return "";
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function containsAnyKeyword(text: string, normalizedKeywords: string[]): boolean {
  return normalizedKeywords.some((keyword) => containsNormalizedPhrase(text, keyword));
}

export function formatLocalSttConnectionError(message: string, wsUrl: string): string {
  if (message.includes("ECONNREFUSED")) {
    return `Local STT sidecar is not running at ${wsUrl}. Run npm.cmd run local:stt in this project, then start the channel again.`;
  }

  return `Local STT sidecar error: ${message}`;
}
