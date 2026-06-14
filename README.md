# Hebrew STT Monitor

Prototype web app for multi-channel Hebrew live speech-to-text monitoring with exact phrase triggers. The app keeps the Soniox API key on the backend and streams browser audio through local WebSockets.

## Setup

1. Install dependencies:

   ```powershell
   npm.cmd install
   ```

2. Copy `.env.example` to `.env` and set `SONIOX_API_KEY`.

3. Start the app:

   ```powershell
   npm.cmd run dev
   ```

4. Open `http://127.0.0.1:5173`.

## Notes

- V1 actions are UI/log only: transcript highlights, trigger events, and acknowledgement.
- Raw audio is streamed to the STT provider and is not stored by this app.
- Multi-channel means one live STT stream per configured browser microphone/client channel.
