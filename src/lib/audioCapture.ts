import { websocketUrl } from "./ws";

export interface ChannelCaptureOptions {
  sessionId: string;
  channelId: string;
  name: string;
  color: string;
  deviceId?: string;
  sourceLabel?: string;
  contextTerms?: string[];
  onMessage: (event: MessageEvent) => void;
  onError: (message: string) => void;
  onStopped: () => void;
}

export interface ActiveCapture {
  channelId: string;
  stop: () => void;
}

export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}

export async function requestDeviceLabels(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export async function startChannelCapture(options: ChannelCaptureOptions): Promise<ActiveCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  const mimeType = preferredMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const ws = new WebSocket(websocketUrl("/ws/channel"));
  let stopped = false;

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", options.onMessage);
  ws.addEventListener("error", () => options.onError("Channel WebSocket error."));
  ws.addEventListener("close", () => {
    stopped = true;
    stopTracks(stream);
    options.onStopped();
  });

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "join_channel",
        sessionId: options.sessionId,
        channelId: options.channelId,
        name: options.name,
        color: options.color,
        sourceLabel: options.sourceLabel,
        contextTerms: options.contextTerms || []
      })
    );
    recorder.start(250);
  });

  recorder.addEventListener("dataavailable", async (event) => {
    if (event.data.size === 0 || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(await event.data.arrayBuffer());
  });

  recorder.addEventListener("error", () => {
    options.onError("Audio recorder error.");
  });

  return {
    channelId: options.channelId,
    stop: () => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      stopTracks(stream);

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop_channel" }));
        window.setTimeout(() => ws.close(), 600);
      } else {
        ws.close();
      }
    }
  };
}

function preferredMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
