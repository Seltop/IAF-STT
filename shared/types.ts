export type Severity = "low" | "medium" | "high";

export type ChannelStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "stopping"
  | "stopped"
  | "error";

export interface Channel {
  id: string;
  name: string;
  color: string;
  status: ChannelStatus;
  sourceLabel?: string;
  error?: string;
  createdAt: string;
}

export interface TranscriptToken {
  text: string;
  isFinal: boolean;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  speaker?: string;
  language?: string;
}

export interface TranscriptSegment {
  id: string;
  channelId: string;
  text: string;
  isFinal: boolean;
  tokens: TranscriptToken[];
  startedAtMs?: number;
  endedAtMs?: number;
  confidence?: number;
  speaker?: string;
  language?: string;
  createdAt: string;
  finalAudioMs?: number;
  totalAudioMs?: number;
  matchedRuleIds: string[];
}

export interface TriggerRule {
  id: string;
  phrase: string;
  normalizedPhrase: string;
  severity: Severity;
  color: string;
  enabled: boolean;
  cooldownSeconds: number;
}

export interface TriggerEvent {
  id: string;
  ruleId: string;
  phrase: string;
  severity: Severity;
  color: string;
  channelId: string;
  segmentId: string;
  transcriptText: string;
  createdAt: string;
  acknowledgedAt?: string;
}

export interface SessionState {
  id: string;
  createdAt: string;
  channels: Channel[];
  transcriptSegments: TranscriptSegment[];
  triggerRules: TriggerRule[];
  triggerEvents: TriggerEvent[];
  contextTerms: string[];
  providerName: string;
  providerConfigured: boolean;
  providerMessage?: string;
  maxChannels: number;
}

export type ChannelClientMessage =
  | {
      type: "join_channel";
      sessionId: string;
      channelId: string;
      name: string;
      color: string;
      sourceLabel?: string;
      contextTerms?: string[];
    }
  | {
      type: "audio_chunk";
      data: ArrayBuffer;
    }
  | {
      type: "stop_channel";
    };

export type MonitorClientMessage =
  | {
      type: "join_session";
      sessionId: string;
    }
  | {
      type: "ack_trigger";
      sessionId: string;
      triggerEventId: string;
    }
  | {
      type: "delete_channel";
      sessionId: string;
      channelId: string;
    }
  | {
      type: "update_trigger_rules";
      sessionId: string;
      rules: TriggerRule[];
    }
  | {
      type: "update_context_terms";
      sessionId: string;
      terms: string[];
    };

export type ServerMessage =
  | {
      type: "state";
      state: SessionState;
    }
  | {
      type: "channel_status";
      channel: Channel;
    }
  | {
      type: "transcript_segment";
      segment: TranscriptSegment;
    }
  | {
      type: "trigger_event";
      event: TriggerEvent;
    }
  | {
      type: "provider_error";
      channelId?: string;
      message: string;
      code?: number;
    };
