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

const TARGET_SAMPLE_RATE = 16000;

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

  const AudioContextCtor =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    stopTracks(stream);
    throw new Error("AudioContext is not available in this browser.");
  }

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const ws = new WebSocket(websocketUrl("/ws/channel"));
  let stopped = false;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    stopped = true;
    processor.disconnect();
    source.disconnect();
    if (audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
    stopTracks(stream);
  };

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", options.onMessage);
  ws.addEventListener("error", () => options.onError("Channel WebSocket error."));
  ws.addEventListener("close", () => {
    cleanup();
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
  });

  processor.onaudioprocess = (event) => {
    if (stopped || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const pcm = downsampleTo16BitPcm(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
    if (pcm.byteLength > 0) {
      ws.send(pcm);
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  return {
    channelId: options.channelId,
    stop: () => {
      if (stopped) {
        return;
      }

      stopped = true;
      cleanup();

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop_channel" }));
        window.setTimeout(() => ws.close(), 600);
      } else {
        ws.close();
      }
    }
  };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function downsampleTo16BitPcm(input: Float32Array, inputSampleRate: number, outputSampleRate: number): ArrayBuffer {
  if (inputSampleRate === outputSampleRate) {
    return floatTo16BitPcm(input);
  }

  if (inputSampleRate < outputSampleRate) {
    return floatTo16BitPcm(input);
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const downsampled = new Float32Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(Math.floor((outputIndex + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += input[inputIndex];
      count += 1;
    }

    downsampled[outputIndex] = count > 0 ? sum / count : 0;
  }

  return floatTo16BitPcm(downsampled);
}

function floatTo16BitPcm(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);

  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}
