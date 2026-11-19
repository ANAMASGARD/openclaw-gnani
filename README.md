# Gnani AI Speech for OpenClaw

Add Gnani Prisma transcription and Timbre speech synthesis to the OpenClaw agent you already use. The plugin ID is `gnani`. The compatibility target is OpenClaw 2026.11.5.

| Models | Transports |
|---|---|
| `prisma-v2.5`, `prisma-v3.0` | REST for audio attachments, WebSocket for Voice Call transcription, programmatic Batch for recordings over 30 seconds |
| `timbre-v2.5`, `timbre-v3.0` | REST for audio files, voice notes and telephony, SSE and WebSocket for streaming speech |

## Install and configure

```sh
npm ci
npm run build
npm pack
openclaw plugins install npm-pack:./openclaw-plugin-gnani-0.1.0.tgz
openclaw plugins enable gnani
```

Provide your own `GNANI_API_KEY` to the Gateway. Install FFmpeg and FFprobe. Use one of the [example configurations](examples/) or set the STT model in `tools.media.models` and the TTS model and voice in `tts.providers.gnani`.

Prisma v3.0 defaults to `indic-auto`. Prisma v2.5 recorded transcription needs a single language and defaults to `en-IN`. Select a case-sensitive Timbre voice from the model’s own catalog. For example, use `Nalini` with `timbre-v2.5` or `Shivani` with `timbre-v3.0`. Timbre v2.5 allows speeds from 0.85 to 1.15. Timbre v3.0 allows 0.8, 1.0, and 1.2 and supports expressive tags. [Timbre voice catalog](https://docs.gnani.ai/api/TTS/available-voices)

Set top-level `tts.auto` to `"inbound"` for eligible inbound voice replies or `"always"` for eligible text replies too. For Telegram, send a voice note up to 30 seconds to the configured bot and play the resulting Ogg/Opus voice note. See the [setup guide](docs/OPENCLAW_SETUP.md) for channel, realtime, and error-handling details. Full-duplex Realtime Voice and automatic Batch handling for long voice notes are outside this release.

## Programmatic Batch and WebSocket speech

```js
import { openAsBlob } from "node:fs";
import { createBatchClient } from "openclaw-plugin-gnani/batch";

const batch = createBatchClient();
const { job } = await batch.create(
  { model: "prisma-v3.0", language: "indic-auto", with_diarization: true },
  { kind: "upload", files: [{ name: "meeting.wav", data: await openAsBlob("./meeting.wav") }] },
);
await batch.start(job.job_id);
const finished = await batch.wait(job.job_id);
const { data } = await batch.results(finished.job_id);
for (const file of data) {
  if (file.transcript_url) {
    const transcript = await batch.transcript(file.transcript_url);
    // Process the transcript and speaker segments locally.
  }
}
```

Use direct upload within the per-file and total limits. For larger inputs, use a presigned upload or a cloud source. `results` and `list` return `nextCursor` for pagination.

```js
import { createTimbreWebSocketSession } from "openclaw-plugin-gnani/tts-websocket";

const session = await createTimbreWebSocketSession();
try {
  const { audioStream } = session.synthesize("नमस्ते, आप कैसे हैं?", {
    model: "timbre-v3.0", voice: "Shivani", language: "hi-IN",
  });
  for await (const bytes of audioStream) {
    // Deliver each byte chunk to your audio consumer.
  }
} finally {
  session.close();
}
```

## Verify and prepare a release

```sh
npm run typecheck
npm test
npm run validate
npm run lint
npm audit --omit=dev
GNANI_LIVE_TEST=1 npm run test:live
```

Live tests use your configured key, FFmpeg, FFprobe, and `espeak-ng` for synthetic reference speech. Media and synthesis text go to Gnani. Keep credentials, signed URLs, and private recordings out of logs and published artifacts. See the [test report](docs/TEST_REPORT.md) and [compatibility matrix](docs/COMPATIBILITY_MATRIX.md) for executed checks.
