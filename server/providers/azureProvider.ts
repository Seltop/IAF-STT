import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import type { ProviderChannelCallbacks, ProviderResult, RealtimeProvider, StartChannelOptions } from "./types.js";

interface AzureProviderConfig {
  speechKey?: string;
  region?: string;
  language: string;
}

interface AzureConnectionState {
  callbacks: ProviderChannelCallbacks;
  stream: sdk.PushAudioInputStream;
  recognizer: sdk.SpeechRecognizer;
  opened: boolean;
  closing: boolean;
  closed: boolean;
  pendingChunks: Buffer[];
}

export class AzureSpeechProvider implements RealtimeProvider {
  private readonly connections = new Map<string, AzureConnectionState>();

  constructor(private readonly config: AzureProviderConfig) {}

  startChannel(options: StartChannelOptions, callbacks: ProviderChannelCallbacks): string {
    if (!this.config.speechKey || !this.config.region) {
      callbacks.onError({
        type: "missing_api_key",
        message:
          "Azure Speech is selected but AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is missing. Add them to .env and restart the server."
      });
      return "";
    }

    const connectionId = crypto.randomUUID();
    const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
    const stream = sdk.AudioInputStream.createPushStream(audioFormat);
    const speechConfig = sdk.SpeechConfig.fromSubscription(this.config.speechKey, this.config.region);
    speechConfig.speechRecognitionLanguage = this.config.language;
    speechConfig.outputFormat = sdk.OutputFormat.Detailed;

    const audioConfig = sdk.AudioConfig.fromStreamInput(stream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    const phraseList = sdk.PhraseListGrammar.fromRecognizer(recognizer);
    for (const term of options.contextTerms || []) {
      phraseList.addPhrase(term);
    }

    const state: AzureConnectionState = {
      callbacks,
      stream,
      recognizer,
      opened: false,
      closing: false,
      closed: false,
      pendingChunks: []
    };
    this.connections.set(connectionId, state);

    recognizer.recognizing = (_sender, event) => {
      const result = azureRecognitionToProviderResult(event.result, false);
      if (result.tokens.length > 0) {
        callbacks.onResult(result);
      }
    };

    recognizer.recognized = (_sender, event) => {
      const result = azureRecognitionToProviderResult(event.result, true);
      if (result.tokens.length > 0) {
        callbacks.onResult(result);
      }
    };

    recognizer.canceled = (_sender, event) => {
      if (event.errorDetails) {
        callbacks.onError({
          type: "azure_canceled",
          code: event.errorCode,
          message: event.errorDetails
        });
      }
      this.finishConnection(connectionId);
    };

    recognizer.sessionStopped = () => {
      this.finishConnection(connectionId);
    };

    recognizer.startContinuousRecognitionAsync(
      () => {
        state.opened = true;
        callbacks.onOpen();
        for (const chunk of state.pendingChunks.splice(0)) {
          this.writeChunk(state, chunk);
        }
      },
      (error) => {
        callbacks.onError({
          type: "azure_start_failed",
          message: String(error)
        });
        this.finishConnection(connectionId);
      }
    );

    return connectionId;
  }

  sendAudio(connectionId: string, chunk: Buffer): void {
    const state = this.connections.get(connectionId);
    if (!state || state.closing || state.closed) {
      return;
    }

    if (!state.opened) {
      if (state.pendingChunks.length < 200) {
        state.pendingChunks.push(chunk);
      }
      return;
    }

    this.writeChunk(state, chunk);
  }

  stopChannel(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state || state.closing || state.closed) {
      return;
    }

    state.closing = true;
    state.stream.close();
    state.recognizer.stopContinuousRecognitionAsync(
      () => this.finishConnection(connectionId),
      (error) => {
        state.callbacks.onError({
          type: "azure_stop_failed",
          message: String(error)
        });
        this.finishConnection(connectionId);
      }
    );
  }

  closeChannel(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state || state.closed) {
      return;
    }

    state.closing = true;
    state.stream.close();
    state.recognizer.close();
    this.finishConnection(connectionId);
  }

  private writeChunk(state: AzureConnectionState, chunk: Buffer): void {
    const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    state.stream.write(arrayBuffer as ArrayBuffer);
  }

  private finishConnection(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state || state.closed) {
      return;
    }

    state.closed = true;
    state.closing = true;
    state.recognizer.close();
    this.connections.delete(connectionId);
    state.callbacks.onClose();
  }
}

export function azureRecognitionToProviderResult(
  result: sdk.SpeechRecognitionResult,
  isFinal: boolean
): ProviderResult {
  if (!result.text || result.reason === sdk.ResultReason.NoMatch || result.reason === sdk.ResultReason.Canceled) {
    return { tokens: [] };
  }

  const startMs = ticksToMs(result.offset);
  const endMs = ticksToMs(result.offset + result.duration);

  return {
    tokens: [
      {
        text: result.text,
        isFinal,
        startMs,
        endMs,
        language: result.language || "he-IL"
      }
    ],
    finalAudioMs: isFinal ? endMs : undefined,
    totalAudioMs: endMs
  };
}

function ticksToMs(value: number): number {
  return Math.round(value / 10000);
}
