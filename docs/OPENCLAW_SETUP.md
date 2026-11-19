# OpenClaw setup

1. Install OpenClaw 2026.11.5, Node supported by that release, and FFmpeg with `ffprobe` on PATH.
2. Build and pack this checkout with `npm ci`, `npm run build`, and `npm pack`. Install the output with `openclaw plugins install npm-pack:./openclaw-plugin-gnani-0.1.0.tgz` and review the stated capabilities when prompted.
3. Provide `GNANI_API_KEY` to the OpenClaw Gateway process using your service environment or secret store. Merge an example in `examples/` into your OpenClaw configuration. Add `gnani` to your existing plugin allowlist if you use one.
4. Run `openclaw config validate`, then `openclaw plugins inspect gnani --runtime --json`. Restart the Gateway through your normal service manager.
5. Keep your existing OpenClaw text model configured. In an eligible chat, send a voice note under 30 seconds. With `tts.auto: "inbound"`, an audio reply is requested for inbound voice. Use `"always"` for audio on eligible text turns as well.

```sh
openclaw infer audio transcribe --file ./sample.wav --model gnani/prisma-v3.0 --language hi --json
openclaw infer tts convert --gateway --provider gnani --text 'नमस्ते, आप कैसे हैं?' --output ./reply.mp3 --json
```

Put recorded STT options in `tools.media.audio.providerOptions.gnani` or in the selected audio model entry's `providerOptions.gnani`. Prisma v3.0 accepts, for example, `format: "codemix"` and `keyterms: ["Gnani"]`. For v2.5 boosting, supply both `bias_list` and a positive supported `bias_score`. Set the TTS model, case-sensitive voice, language, speed and optional `audioConfig` in `tts.providers.gnani`. OpenClaw requests compatible formats for voice notes and telephony. [Prisma model options](https://docs.gnani.ai/api/STT/models/overview) · [Timbre audio configuration](https://docs.gnani.ai/api/TTS/tts-inference)

For Voice Call, select `plugins.entries.voice-call.config.streaming.provider: "gnani"`, enable the streaming path, and set model and language under `streaming.providers.gnani`. That path requires an OpenClaw Voice Call installation with Twilio Media Streams. Use `tts.providers.gnani.streamTransport` to select `sse` or `websocket` for host consumers of progressive speech. [OpenClaw Voice Call](https://docs.openclaw.ai/plugins/voice-call/realtime-and-streaming)

Telegram voice notes use Ogg/Opus. WhatsApp and Slack delivery depends on the selected channel adapter, its account permissions, and its handling of the host's output format. FFmpeg may be needed by the channel for transcoding. Check the release test report for actual external delivery coverage.

## Troubleshooting

- For missing credentials, check the environment of the Gateway process. A key in an interactive shell is available only to processes inheriting that environment.
- For HTTP 401, 402, or 403, check key validity, credit, and STT/TTS/Batch scopes. For HTTP 429, let the active request finish before retrying.
- For invalid voice or speed, check the selected Timbre model’s catalog. For truncated transcription, shorten the clip. Use Batch for recordings over 30 seconds.
- Uploaded recordings and synthesis text go to Gnani. Use fixtures you are authorized to send. Keep test transcripts, signed URLs, and keys out of shared logs.
