import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { transcribeAudio } from "../dist/stt/rest.js";
import { createPrismaSession } from "../dist/stt/websocket.js";
import { createBatchClient } from "../dist/stt/batch.js";
import { normalizeTts } from "../dist/tts/models.js";
import { synthesizeRest } from "../dist/tts/rest.js";
import { synthesizeSse } from "../dist/tts/sse.js";
import { createTimbreWebSocketSession } from "../dist/tts/websocket.js";
import { redact } from "../dist/http.js";
import { socketSession } from "./socket-fixture.mjs";

if (process.env.GNANI_LIVE_TEST !== "1") throw new Error("Set GNANI_LIVE_TEST=1 to run live Gnani tests");
const apiKey = process.env.GNANI_API_KEY?.trim();
if (!apiKey) throw new Error("GNANI_API_KEY is required for live tests");
const transport = { apiKey, timeoutMs: 60_000 };
const directory = await mkdtemp(join(tmpdir(), "gnani-live-"));
const report = [];
const selected = process.env.GNANI_LIVE_IDS?.split(",");
const models = ["prisma-v2.5", "prisma-v3.0"];

async function run(id, model, method, work) {
  if (selected && !selected.includes(id)) return;
  try {
    const evidence = await work();
    report.push({ id, model, method, status: "PASS", evidence });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), apiKey);
    const blocked = /HTTP (401|402|403|429)\b|scope_not_allowed|credit|rate.limit/i.test(message)
      || (id === "BATCH-PRESIGNED" && /Gnani HTTP 404/.test(message));
    report.push({ id, model, method, status: blocked ? "BLOCKED" : "FAIL", error: message });
  }
  console.log(JSON.stringify(report.at(-1)));
  await sleep(500);
}

function wave(name, voice, text) {
  const path = join(directory, name + ".wav");
  execFileSync("espeak-ng", ["-v", voice, "-s", "135", "-w", path, text]);
  return path;
}

function verifyText(text, pattern) {
  assert.ok(pattern.test(text), `Transcript did not include a reference term: ${text.slice(0, 160)}`);
  return text;
}

async function gather(stream) {
  let chunks = 0;
  const parts = [];
  for await (const bytes of stream) {
    chunks++;
    parts.push(bytes);
  }
  assert.ok(chunks > 1, "Expected progressive audio chunks");
  return { chunks, audio: Buffer.concat(parts) };
}

async function probe(name, audio, { codec: expected = "mp3", rate: expectedRate = 24000, demuxer } = {}) {
  const path = join(directory, name);
  const rawInput = demuxer ? ["-f", demuxer, "-sample_rate", String(expectedRate), "-ch_layout", "mono"] : [];
  await writeFile(path, audio);
  const response = JSON.parse(execFileSync("ffprobe", ["-v", "error", ...rawInput, "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", path], { encoding: "utf8" }));
  const { codec_name: codec, sample_rate: rate, channels } = response.streams[0];
  const seconds = Number(response.format.duration);
  assert.equal(codec, expected);
  assert.equal(Number(rate), expectedRate);
  assert.equal(channels, 1);
  assert.ok(seconds > 0.3 && seconds < 25);
  return { codec, rate: Number(rate), channels, seconds };
}

try {
  const custom = process.env.GNANI_LIVE_REFERENCE_DIR
    ? JSON.parse(await readFile(join(process.env.GNANI_LIVE_REFERENCE_DIR, "references.json"), "utf8")) : undefined;
  const samples = custom ? custom.map((clip) => ({
    ...clip,
    path: join(process.env.GNANI_LIVE_REFERENCE_DIR, clip.file),
    pattern: new RegExp(clip.expect, "iu"),
  })) : [
    { name: "english", language: "en-IN", text: "Hello. Good morning.", pattern: /hello|good morning|हेलो|गुड मॉर्निंग/iu, path: wave("english", "en-us", "Hello. Good morning.") },
    { name: "hindi", language: "hi-IN", text: "नमस्ते। आज मौसम बहुत अच्छा है।", pattern: /नमस्त|मौसम|अच्छ/u, path: wave("hindi", "hi", "नमस्ते। आज मौसम बहुत अच्छा है।") },
  ];
  const mixed = { name: "mixed", language: "hi-IN,en-IN", pattern: /मीटिंग|meeting|नमस्त|आज/u,
    path: wave("mixed", "hi", "नमस्ते, आज meeting है।") };
  for (const [index, model] of models.entries()) {
    const clips = index === 1 ? [...samples, mixed] : samples;
    await run(`STT-0${index + 1}`, model, "REST", async () => {
      const results = {};
      for (const clip of clips) {
        const result = await transcribeAudio({
          buffer: await readFile(clip.path), fileName: clip.name + ".wav",
          settings: { model, language: clip.language, ...(clip === mixed ? { format: "codemix" } : {}) },
        }, transport);
        assert.equal(result.model, model);
        results[clip.name] = verifyText(result.text, clip.pattern);
      }
      return results;
    });
    await run(`STT-0${index + 3}`, model, "WebSocket", async () => {
      const results = {};
      for (const clip of clips) {
        const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", clip.path, "-f", "s16le", "-ar", "16000", "-ac", "1", "-"]);
        const transcripts = [];
        let matched;
        const ready = new Promise((resolve) => { matched = resolve; });
        const errors = [];
        const session = createPrismaSession({
          providerConfig: { model, language: clip.language, encoding: "pcm16le", sampleRate: 16000,
            ...(clip === mixed ? { format: "codemix" } : {}) },
          onTranscript(text) {
            transcripts.push(text);
            if (clip.pattern.test(transcripts.join(" "))) matched();
          },
          onError(error) { errors.push(error); },
        }, socketSession, apiKey);
        try {
          await session.connect();
          for (let offset = 0; offset < pcm.length; offset += 1024) {
            session.sendAudio(pcm.subarray(offset, offset + 1024));
            await sleep(32);
          }
          session.close();
          await Promise.race([ready, sleep(5500)]);
          if (!transcripts.length && errors.length) throw errors[0];
          results[clip.name] = verifyText(transcripts.join(" "), clip.pattern);
        } finally {
          session.cancel();
          await sleep(200);
        }
      }
      return results;
    });
    await run(`STT-0${index + 5}`, model, "Batch", async () => {
      const client = createBatchClient(transport);
      const files = await Promise.all(clips.map(async (clip) => ({
        name: clip.name + ".wav", data: new Blob([await readFile(clip.path)], { type: "audio/wav" }),
      })));
      const { job } = await client.create({ model, language: "hi-IN,en-IN", with_diarization: true }, { kind: "upload", files });
      let terminal = false;
      try {
        await client.start(job.job_id);
        const completed = await client.wait(job.job_id, { timeoutMs: 150_000 });
        terminal = true;
        assert.equal(completed.status, "COMPLETED", `Batch terminal status ${completed.status}`);
        const results = await client.results(job.job_id, { limit: 10 });
        const listed = await client.list({ limit: 10 });
        assert.ok(listed.data.some(({ job_id }) => job_id === job.job_id));
        const output = {};
        for (const clip of clips) {
          const file = results.data.find(({ original_path }) => String(original_path).endsWith(clip.name + ".wav"));
          assert.ok(file?.transcript_url, `No transcript artifact for ${clip.name}`);
          const transcript = await client.transcript(file.transcript_url);
          assert.equal(transcript.model, model);
          assert.ok(transcript.segments.length);
          output[clip.name] = verifyText(transcript.full_transcript, clip.pattern);
        }
        return output;
      } finally {
        if (!terminal) await client.cancel(job.job_id, "Gnani plugin live test cleanup").catch(() => {});
      }
    });
  }
  await run("BATCH-PRESIGNED", "prisma-v3.0", "presigned upload and cancellation", async () => {
    const client = createBatchClient(transport);
    const { job, uploads } = await client.create({ model: "prisma-v3.0", language: "en" }, {
      kind: "presigned", filenames: ["english.wav"],
    });
    let cancelled = false;
    try {
      assert.equal(uploads.length, 1);
      await client.upload(uploads[0].url, new Blob([await readFile(samples[0].path)], { type: "audio/wav" }));
      const result = await client.cancel(job.job_id, "Gnani plugin live cancellation test");
      assert.equal(result.status, "CANCELLED");
      cancelled = true;
      return { uploaded: true, status: (await client.status(job.job_id)).status };
    } finally {
      if (!cancelled) await client.cancel(job.job_id, "Gnani plugin live test cleanup").catch(() => {});
    }
  });
  await run("BATCH-CANCEL", "prisma-v3.0", "direct job cancellation", async () => {
    const client = createBatchClient(transport);
    const { job } = await client.create({ model: "prisma-v3.0", language: "en" }, {
      kind: "upload", files: [{ name: "english.wav", data: new Blob([await readFile(samples[0].path)], { type: "audio/wav" }) }],
    });
    const result = await client.cancel(job.job_id, "Gnani plugin live cancellation test");
    assert.equal(result.status, "CANCELLED");
    assert.equal((await client.status(job.job_id)).status, "CANCELLED");
    return { status: result.status };
  });
  async function verifyBatchSource(source, expected) {
    const client = createBatchClient(transport);
    const { job } = await client.create({ model: "prisma-v3.0", language: "en-IN" }, source);
    let terminal = false;
    try {
      await client.start(job.job_id);
      const finished = await client.wait(job.job_id, { timeoutMs: 90_000 });
      terminal = true;
      assert.equal(finished.status, "COMPLETED");
      const files = await client.results(job.job_id);
      assert.ok(files.data[0]?.transcript_url, "Batch result has no transcript URL");
      const transcript = await client.transcript(files.data[0].transcript_url);
      return verifyText(transcript.full_transcript, expected);
    } finally {
      if (!terminal) await client.cancel(job.job_id, "Gnani plugin live test cleanup").catch(() => {});
    }
  }

  if (selected?.includes("BATCH-ZIP")) {
    await run("BATCH-ZIP", "prisma-v3.0", "ZIP upload", async () => {
      const archive = join(directory, "audio.zip");
      execFileSync("zip", ["-j", "-q", archive, samples[0].path]);
      return verifyBatchSource({ kind: "upload", files: [
        { name: "audio.zip", data: new Blob([await readFile(archive)]) },
      ] }, samples[0].pattern);
    });
  }
  if (selected?.includes("BATCH-CLOUD")) {
    await run("BATCH-CLOUD", "prisma-v3.0", "public HTTPS source", () => verifyBatchSource({
      kind: "cloud", paths: ["https://storage.googleapis.com/cloud-samples-tests/speech/brooklyn.flac"],
    }, /brooklyn|bridge/i));
  }

  for (const [index, model] of ["timbre-v2.5", "timbre-v3.0"].entries()) {
    for (const [offset, method] of ["REST", "SSE", "WebSocket"].entries()) {
      const id = `TTS-0${1 + index + offset * 2}`;
      await run(id, model, method, async () => {
        const output = {};
        const ws = method === "WebSocket" ? await createTimbreWebSocketSession(transport) : undefined;
        try {
          for (const sample of samples) {
            const config = { model, language: sample.language,
              voice: model === "timbre-v3.0" ? "Shivani" : sample === samples[0] ? "Kaveri" : "Nalini" };
            const text = (sample.synthesis ?? sample.text).repeat(2).replaceAll(".", ". ");
            const { body } = normalizeTts(text, config);
            if (method === "REST") {
              output[sample.name] = await probe(`${id}-${sample.name}`, await synthesizeRest(body, transport));
            } else if (method === "SSE") {
              const lease = await synthesizeSse(body, transport);
              try {
                const { audio, chunks } = await gather(lease.audioStream);
                output[sample.name] = { ...await probe(`${id}-${sample.name}`, audio), chunks };
              } finally {
                await lease.release();
              }
            } else {
              const { audio, chunks } = await gather(ws.synthesize(text, config).audioStream);
              output[sample.name] = { ...await probe(`${id}-${sample.name}`, audio), chunks };
            }
          }
        } finally {
          ws?.close();
        }
        return output;
      });
    }
    await run(`TTS-FORMATS-${index + 1}`, model, "REST output formats", async () => {
      const shape = {
        wav: { codec: "pcm_s16le", rate: 16000 },
        ogg: { codec: "opus", rate: 48000 },
        raw: { codec: "pcm_s16le", rate: 8000, demuxer: "s16le" },
        mulaw: { codec: "pcm_mulaw", rate: 8000, demuxer: "mulaw" },
        alaw: { codec: "pcm_alaw", rate: 8000, demuxer: "alaw" },
      };
      const output = {};
      for (const [container, params] of Object.entries(shape)) {
        const { body } = normalizeTts("Hello. Good morning.", {
          model, language: "en-IN", voice: model === "timbre-v2.5" ? "Kaveri" : "Arko",
          audioConfig: { container, sample_rate: params.rate },
        });
        output[container] = await probe(`formats-${index}-${container}`, await synthesizeRest(body, transport), params);
      }
      return output;
    });
  }
} finally {
  await mkdir(".clawhub-validation", { recursive: true });
  const path = ".clawhub-validation/live-results.json";
  const previous = selected ? JSON.parse(await readFile(path, "utf8").catch(() => "[]")) : [];
  const results = new Map([...previous, ...report].map((result) => [result.id, result]));
  await writeFile(path, JSON.stringify([...results.values()], null, 2) + "\n");
  await rm(directory, { recursive: true, force: true });
}
if (report.some(({ status }) => status !== "PASS")) process.exitCode = 1;
