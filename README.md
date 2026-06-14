# Hebrew STT Monitor

Prototype web app for multi-channel Hebrew live speech-to-text monitoring with exact phrase triggers. The app keeps speech-provider keys on the backend and streams browser microphone audio through local WebSockets.

## Setup

1. Install dependencies:

   ```powershell
   npm.cmd install
   ```

2. Copy `.env.example` to `.env`.

3. For free Hebrew testing, create an Azure AI Speech resource on the Free F0 tier and set:

   ```env
   STT_PROVIDER=azure
   AZURE_SPEECH_KEY=your-key
   AZURE_SPEECH_REGION=your-region
   ```

4. Start the app:

   ```powershell
   npm.cmd run dev
   ```

5. Open `http://127.0.0.1:5173`.

## Providers

- `azure`: default. Uses Azure Speech with Hebrew locale `he-IL`. Azure Free F0 includes limited monthly speech-to-text capacity.
- `soniox`: optional. Set `STT_PROVIDER=soniox` and `SONIOX_API_KEY`.

## Notes

- V1 actions are UI/log only: transcript highlights, trigger events, and acknowledgement.
- Raw audio is streamed to the STT provider and is not stored by this app.
- Multi-channel means one live STT stream per configured browser microphone/client channel.
