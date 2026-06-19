# Hebrew STT Monitor

Prototype web app for multi-channel Hebrew live speech-to-text monitoring with exact phrase triggers. The app keeps speech-provider keys on the backend and streams browser microphone audio through local WebSockets.

## Setup

1. Install dependencies:

   ```powershell
   npm.cmd install
   ```

2. Copy `.env.example` to `.env`.

3. Create a Soniox API key and set:

   ```env
   STT_PROVIDER=soniox
   SONIOX_API_KEY=your-key
   SONIOX_MODEL=stt-rt-v5
   ```

4. Start the app:

   ```powershell
   npm.cmd run dev
   ```

5. Open `http://127.0.0.1:5173`.

## Providers

- `soniox`: default. Uses Soniox real-time model `stt-rt-v5` with Hebrew language hints, language identification, speaker diarization, endpoint detection, and custom context terms.
- `azure`: optional baseline. Set `STT_PROVIDER=azure`, `AZURE_SPEECH_KEY`, and `AZURE_SPEECH_REGION`. Uses Azure Speech with Hebrew locale `he-IL`.

## Cost

Soniox lists real-time streaming STT at roughly `$0.12` per hour of typical speech. This app opens one live Soniox stream per active channel, so estimate cost as:

```text
active channel hours x $0.12
```

Examples:

- 10 channel-hours/month: about `$1.20`
- 100 channel-hours/month: about `$12`
- 1,000 channel-hours/month: about `$120`
- 4 channels running 24/7 for 30 days: about `$345.60`

## Notes

- V1 actions are UI/log only: transcript highlights, trigger events, and acknowledgement.
- Raw audio is streamed to the STT provider and is not stored by this app.
- Multi-channel means one live STT stream per configured browser microphone/client channel.
