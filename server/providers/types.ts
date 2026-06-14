import type { TranscriptToken } from "../../shared/types.js";

export interface ProviderResult {
  tokens: TranscriptToken[];
  finalAudioMs?: number;
  totalAudioMs?: number;
  finished?: boolean;
}

export interface ProviderError {
  code?: number;
  type?: string;
  message: string;
  requestId?: string;
}

export interface ProviderChannelCallbacks {
  onOpen: () => void;
  onResult: (result: ProviderResult) => void;
  onError: (error: ProviderError) => void;
  onClose: () => void;
}

export interface StartChannelOptions {
  channelId: string;
  channelName: string;
  contextTerms?: string[];
}

export interface RealtimeProvider {
  startChannel(options: StartChannelOptions, callbacks: ProviderChannelCallbacks): string;
  sendAudio(connectionId: string, chunk: Buffer): void;
  stopChannel(connectionId: string): void;
  closeChannel(connectionId: string): void;
}
