# Verification report

Verified on Fedora with Node 24.18.0, npm 12.2.0, OpenClaw 2026.11.5 (e13cf15), ClawHub 0.26.0, TypeScript 7.0.2, Vitest 5.1.1, Vite 8.3.8, ws 8.23.0, and FFmpeg/FFprobe 8.1.3.

## Local and live API checks

| Check | Result |
|---|---|
| Scaffold baseline | One scaffold test and ClawHub validation passed before changes |
| `npm test` | 30 passed across registration, models, audio conversion, request and response wire formats, errors, lifecycle and cleanup |
| `npm run typecheck`, `npm run build`, `npm run lint` | PASS. The OpenClaw lint reported zero compatibility warnings for Gnani. |
| `npm run validate` | PASS. The ClawHub inspector found zero breakages, warnings or findings. |
| `openclaw plugins build/validate --root .` | UNSUPPORTED for this provider-only entry point. The CLI rejected it for lacking tool or feature authoring metadata. Use the npm build and ClawHub validation above. |
| `npm pack --dry-run`, `npm pack`, `openclaw plugins install npm-pack:…` | PASS |
| Clean archive consumer | PASS. Both exported clients imported and typechecked under strict TypeScript without installing an OpenClaw host. |
| `openclaw plugins inspect gnani --runtime --json` | PASS. Plugin loaded and reported `gnani` in all three provider contract lists. |
| Both example configs with `openclaw config validate --json` | PASS |
| `npm audit --omit=dev` | Zero production findings |
| Full audit | 26 development dependency findings, 24 moderate and two high, with zero critical. The Vitest and Tinypool critical advisories from the baseline are absent. |
| Real vendor tests | 12/12 primary model/transport cells passed. Presigned Batch was blocked by upstream HTTP 404. See the [matrix](COMPATIBILITY_MATRIX.md). |

Live transcription used short [Google FLEURS](https://huggingface.co/datasets/google/fleurs) English and Hindi recordings (CC BY 4.0), plus a synthetic Hindi-English phrase from espeak-ng. The recordings and transcripts are excluded from the npm artifact. Both Prisma models also transcribed a human-recorded clip through the installed OpenClaw CLI using `openclaw infer audio transcribe --file … --model gnani/<model> --language en-IN --json`. OpenClaw returned the requested model and `gnani` provider with zero fallback attempts. The CLI also generated playable 24 kHz mono MP3 using `openclaw infer tts convert --provider gnani --text … --output … --json`. The live suite uses FFprobe to confirm sample rates, codecs, channels and durations, and verifies streaming completion from the server events. Both Timbre models also passed WAV, Ogg/Opus, PCM, µ-law and A-law checks. Live Prisma v3.0 Batch accepted a ZIP of the English sample and a public FLAC URL from the Google Cloud documentation. [Public FLAC fixture](https://docs.cloud.google.com/speech-to-text/docs/v1/transcribe-api)

```sh
GNANI_LIVE_TEST=1 npm run test:live
```

Set `GNANI_LIVE_REFERENCE_DIR` to a directory with `references.json` and your own authorized audio files for human-reference testing. Each entry supplies `name`, `file`, `language`, `text`, `expect` (reference-term regex) and an optional short `synthesis` phrase. `GNANI_LIVE_IDS` restricts a rerun to a comma-separated list and merges results with the previous run. Select `BATCH-ZIP,BATCH-CLOUD` to repeat the optional source checks. The ZIP case uses the `zip` executable. Local JSON reports are written under `.clawhub-validation/`.

## Packaged Gateway

All four Prisma/Timbre pairs passed the isolated Telegram round trip with an actual OpenClaw agent turn. The stock Telegram adapter delivered an Ogg/Opus voice note in each run. A second Gateway run used live Gnani STT and TTS with the local Telegram Bot API and deterministic text model. All four pairs passed. FFprobe verified four mono 48 kHz Opus outputs between 1.77 and 2.33 seconds. The offline suite separately exercised the host's SSE, WebSocket and raw 8 kHz telephony synthesis operations, cancellation, and the real OpenClaw Voice Call consumer with a locally signed Twilio webhook and G.711 stream. The expected Prisma and Timbre model IDs reached the upstream fixtures, and the WebSocket and SSE resources closed after use.

## Isolated Gateway reproduction

```sh
archive="$PWD/openclaw-plugin-gnani-0.1.0.tgz"
e2e_state="$(mktemp -d /tmp/gnani-openclaw.XXXXXX)"
OPENCLAW_STATE_DIR="$e2e_state" OPENCLAW_CONFIG_PATH="$e2e_state/openclaw.json" \
  openclaw plugins install "npm-pack:$archive" --accept-capabilities
OPENCLAW_STATE_DIR="$e2e_state" OPENCLAW_CONFIG_PATH="$e2e_state/openclaw.json" \
  openclaw plugins install '@openclaw/voice-call@2026.11.5'
GNANI_E2E_OPENCLAW_STATE="$e2e_state" GNANI_E2E_VOICE_CALL=1 npm run test:e2e
```

The harness starts the actual Gateway, Telegram adapter and Voice Call plugin on loopback. It supplies local Gnani, text-model, Telegram Bot API and signed Twilio webhook fixtures. It checks modeled requests, the transcript reaching a real agent turn, and the outgoing `sendVoice` bytes. Through the Gateway's speech runtime it checks streamed SSE and WebSocket chunks, cancellation and raw telephony audio. Through the Voice Call consumer it checks incoming G.711 frames, the final transcript, and session cleanup. The carrier and channel endpoints are loopback fixtures throughout the harness.

With the official WhatsApp and Slack adapters installed in the isolated profile, `GNANI_E2E_CHANNEL_TARGETS=1` verified their local speech-media targets. For WhatsApp, OpenClaw selected the voice-note target and produced an Opus file. For Slack it selected the audio-file target and produced MP3. External delivery requires separate channel credentials and an authorized destination.

To repeat the Gateway round trip with live Gnani, use an isolated npm-pack install and supply a recording and expected phrase pattern. The Telegram and text-model fixtures remain local.

```sh
GNANI_E2E_OPENCLAW_STATE="$e2e_state" GNANI_E2E_LIVE=1 \
  GNANI_E2E_AUDIO=./authorized-recording.wav GNANI_E2E_EXPECT='known phrase' npm run test:e2e
```

Pass `GNANI_API_KEY` through the process environment. ClawHub authentication was unavailable in the verification environment. GitHub ownership was verified separately.

## Publication checklist

Verify that the GitHub account can write to the target repository and the signed-in ClawHub account can publish the package. Do this before publishing any artifact. Run every applicable command from the release commit.

```sh
gh api user --jq .login
gh repo view ANAMASGARD/openclaw-gnani --json nameWithOwner,viewerPermission
npm exec -- clawhub whoami

git add --all
git commit --signoff -m "Add Gnani Prisma and Timbre speech providers"
git push -u origin feat/gnani-speech
gh pr create --repo ANAMASGARD/openclaw-gnani --base main --head feat/gnani-speech \
  --title "Add Gnani Prisma and Timbre speech providers" --body-file docs/TEST_REPORT.md

npm run validate
npm pack
npm exec -- clawhub package publish ./openclaw-plugin-gnani-0.1.0.tgz \
  --source-repo ANAMASGARD/openclaw-gnani --source-commit "$(git rev-parse HEAD)" --dry-run
npm exec -- clawhub package publish ./openclaw-plugin-gnani-0.1.0.tgz \
  --source-repo ANAMASGARD/openclaw-gnani --source-commit "$(git rev-parse HEAD)"
```

The authenticated GitHub account was ANAMASGARD and had ADMIN access to the target repository. The ClawHub dry-run format was verified with the local artifact. No changes were uploaded. Omit `--dry-run` only after approval and after checking that the archive was built from the source commit provided to ClawHub.
