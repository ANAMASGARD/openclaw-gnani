# Compatibility matrix

## Live Gnani API

| Test | Model | Transport | Result |
|---|---|---|---|
| STT-01 | `prisma-v2.5` | REST | PASS |
| STT-02 | `prisma-v3.0` | REST | PASS |
| STT-03 | `prisma-v2.5` | WebSocket | PASS |
| STT-04 | `prisma-v3.0` | WebSocket | PASS |
| STT-05 | `prisma-v2.5` | Batch direct upload | PASS |
| STT-06 | `prisma-v3.0` | Batch direct upload | PASS |
| TTS-01 | `timbre-v2.5` | REST | PASS |
| TTS-02 | `timbre-v3.0` | REST | PASS |
| TTS-03 | `timbre-v2.5` | SSE | PASS |
| TTS-04 | `timbre-v3.0` | SSE | PASS |
| TTS-05 | `timbre-v2.5` | WebSocket | PASS |
| TTS-06 | `timbre-v3.0` | WebSocket | PASS |

PASS for transcription requires an intelligible result against a known reference. Exact wording varies by recording and model. The code-mixed Prisma v3.0 probe retained the Hindi-English phrase on WebSocket. REST and Batch returned intelligible parts of that probe, with variation in script and completeness. Shorter or synthetic utterances can yield incomplete output even when the service does not set its truncation indicator.

| Additional check | Result |
|---|---|
| Both Timbre models with WAV, Ogg/Opus, raw PCM and both G.711 formats | PASS |
| Direct Batch listing, per-file results, transcript download and cancellation | PASS |
| Presigned Batch creation and storage upload | BLOCKED. Live creation returned HTTP 404. Wire-level fixture passed. |
| Batch public HTTPS source and ZIP upload with Prisma v3.0 | PASS |
| Packaged OpenClaw Gateway, all four recorded voice pairs with live Gnani and a local Telegram adapter fixture | PASS |
| Host-driven SSE, WebSocket and telephony synthesis, plus Voice Call STT with a signed local carrier fixture | PASS |
| OpenClaw full-duplex Realtime Voice | UNSUPPORTED |
| Telegram external Bot API | BLOCKED. No authorized test chat and bot credentials supplied. |
| Local WhatsApp and Slack media targets | PASS. OpenClaw selected Opus voice notes and MP3 files, respectively. |
| External WhatsApp, Slack, and Twilio | BLOCKED. No authorized test accounts or destinations supplied. |

See the [test report](TEST_REPORT.md) for packaged Gateway results and how to reproduce the checks.
