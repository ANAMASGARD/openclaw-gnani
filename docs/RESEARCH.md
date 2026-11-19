# Gnani and OpenClaw contracts

| Capability | Gnani endpoint | Wire contract |
|---|---|---|
| Recorded STT | POST `/stt/v3` | Multipart `audio_file`, model and language. A successful response can report an empty or truncated transcript. |
| Realtime STT | WSS `/stt/v3/stream` | Configuration in upgrade headers. Wait for `connected`, send 1,024-byte mono PCM16LE frames at audio cadence, then `commit` to finalize. |
| Batch STT | `/stt/v3/batch/jobs` | Create, start, poll, list files, retrieve signed transcript JSON, or cancel. Presigned creation uses `/stt/v3/batch/v2/jobs`. |
| Buffered TTS | POST `/api/v1/tts/inference` | JSON in, binary audio out. |
| SSE TTS | POST `/api/v1/tts/sse` | `start`, base64 `chunk`, `complete` or `error`. |
| WebSocket TTS | WSS `/api/v1/tts` | JSON request with one active turn. `start`, base64 `audio`, and `complete` with `data.is_final`. |

All Gnani API requests use `X-API-Key-ID`. Signed storage requests have their own authorization. REST accepts up to 30 seconds. Realtime sessions can reach 15 minutes and then require reconnection. Gnani documents completed utterance transcripts and a processing event with no text. Ogg/Opus is a single complete file on the streaming endpoints. [API index](https://docs.gnani.ai/llms.txt) · [Realtime STT](https://docs.gnani.ai/api/STT/stt-websocket) · [Batch STT](https://docs.gnani.ai/api/STTBatch/Introduction) · [TTS formats](https://docs.gnani.ai/api/TTS/tts-inference)

OpenClaw 2026.11.5 exposes descriptor/factory registration in `plugin-entry`. Through a factory, the host supplies credential, guarded Fetch, proxy, and realtime session operations. The direct realtime helper subpath and the provider HTTP barrel are private SDK surfaces. The public `ssrf-runtime` guard carries media request authority through to dispatch. The pinned realtime session type has `connect`, `sendAudio`, `close`, and `isConnected`. Settings updates and immediate cancellation are adapter methods beyond that host interface. [Native factories](https://docs.openclaw.ai/plugins/sdk-entrypoints/native-providers) · [Provider voice capabilities](https://docs.openclaw.ai/plugins/sdk-provider-plugins/voice-and-audio)

OpenClaw Voice Call sends Twilio G.711 µ-law to realtime transcription. Gnani requires PCM16LE and pacing, so the adapter owns sample conversion and buffering. The host exposes a separate streamed speech hook and a telephony hook. Its full-duplex voice protocol has additional session, playback, and turn-control requirements. [Voice Call streaming](https://docs.openclaw.ai/plugins/voice-call/realtime-and-streaming)

## Differences observed during verification

- Prisma v3.0 live STT rejected comma-separated `language_code` on the WebSocket upgrade. It accepted one primary locale plus `multi_lang_codes`. The same code-mixed audio produced a bilingual final transcript with that header combination.
- Both live Timbre WebSocket models closed the upstream connection between completed turns. The programmatic session can reopen between turns. A partial response followed by disconnect is an interrupted turn.
- The documented presigned Batch create endpoint returned HTTP 404 with the test account. The ordinary create, start, status, list, per-file results, signed transcript downloads, and cancellation all succeeded.
- The pinned OpenClaw schema puts model registrations in `tools.media.models` and shared audio options in `tools.media.audio`. For speech factories the host passes the whole TTS configuration in `resolveConfig.rawConfig`, with the Gnani settings under `providers.gnani`. These shapes were verified with real host config validation and round trips.
