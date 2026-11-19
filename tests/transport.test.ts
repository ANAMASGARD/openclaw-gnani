import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createHttpsServer, Agent } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { decodeMulaw, pcmConverter } from "../src/audio/conversion.js";
import { request } from "../src/http.js";
import { createBatchClient } from "../src/stt/batch.js";
import { transcribeAudio } from "../src/stt/rest.js";
import { createPrismaSession } from "../src/stt/websocket.js";
import { normalizeStt } from "../src/stt/models.js";
import { normalizeTts } from "../src/tts/models.js";
import { synthesizeRest } from "../src/tts/rest.js";
import { synthesizeSse } from "../src/tts/sse.js";
import { createTimbreWebSocketSession } from "../src/tts/websocket.js";
import { VOICES } from "../src/tts/voices.js";
import { socketSession } from "./socket-fixture.mjs";

const key = "gnani-secret-fixture";
const buffer = Buffer.from("audio-fixture");
const apiKey = key;
const formInput = { fileName: "speech.wav", settings: { model: "prisma-v3.0" } };
const payload = { ...formInput, buffer: Buffer.alloc(1644) };
payload.buffer.write("RIFF", 0);
payload.buffer.writeUInt32LE(1636, 4);
payload.buffer.write("WAVEfmt ", 8);
payload.buffer.writeUInt32LE(16, 16);
payload.buffer.writeUInt16LE(1, 20);
payload.buffer.writeUInt16LE(1, 22);
payload.buffer.writeUInt32LE(8000, 24);
payload.buffer.writeUInt32LE(16000, 28);
payload.buffer.writeUInt16LE(2, 32);
payload.buffer.writeUInt16LE(16, 34);
payload.buffer.write("data", 36);
payload.buffer.writeUInt32LE(1600, 40);

async function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return Buffer.concat(parts);
    parts.push(next.value);
  }
}

describe("configuration", () => {
  it("validates transport-specific Prisma options", () => {
    expect(normalizeStt({ model: "prisma-v2.5", language: "hi,en" }, "batch").language_code).toBe("hi-IN,en-IN");
    expect(normalizeStt({ model: "prisma-v3.0", language: "hi,en", format: "codemix" }, "realtime"))
      .toEqual({ model: "prisma-v3.0", language_code: "hi-IN,en-IN", format: "codemix" });
    expect(() => normalizeStt({ model: "prisma-v2.5", language: "hi,en" }, "rest")).toThrow("Invalid language list");
    expect(() => normalizeStt({ speaker_names: ["Asha"], keyterms: ["Gnani"] }, "batch")).toThrow("context combination");
    expect(() => normalizeStt({ format: "transliterate" }, "batch")).toThrow("Unsupported format");
  });

  it("uses separate voice catalogs, speeds and tags", () => {
    expect(VOICES["timbre-v2.5"]).toHaveLength(42);
    expect(VOICES["timbre-v3.0"]).toHaveLength(34);
    expect(normalizeTts("<laugh> Hello", { model: "timbre-v2.5", voice: "Kaveri" }).body.text.trim()).toBe("Hello");
    expect(normalizeTts("<laugh> Hello", { model: "timbre-v3.0", voice: "Shivani", speed: 1.2 }).body.text).toBe("<laugh> Hello");
    expect(() => normalizeTts("Hello", { model: "timbre-v3.0", voice: "Nalini" })).toThrow("voice catalog");
    expect(() => normalizeTts("Hello", { model: "timbre-v3.0", speed: 0.9 })).toThrow("speed");
    expect(normalizeTts("Hello", { model: "timbre-v2.5" }, "telephony").body.audio_config)
      .toMatchObject({ container: "raw", sample_rate: 8000, sample_width: 2, num_channels: 1 });
    expect(normalizeTts("Hello", {}, "voice-note").format).toMatchObject({ fileExtension: ".ogg", voiceCompatible: true });
  });

  it("decodes G.711 and resamples fragmented stereo input without dropping frames", () => {
    expect(decodeMulaw(0xff)).toBe(0);
    expect(decodeMulaw(0x80)).toBe(32124);
    const convert = pcmConverter({ encoding: "pcm16le", channels: 2, sampleRate: 16000 }, 8000);
    const input = Buffer.alloc(8);
    [1000, 3000, 5000, 7000].forEach((sample, offset) => input.writeInt16LE(sample, offset * 2));
    expect(convert(input.subarray(0, 5))).toHaveLength(0);
    expect(convert(input.subarray(5)).readInt16LE()).toBe(4000);
  });
});

describe("recorded STT", () => {
  it("sends the selected model and language and preserves empty transcripts", async () => {
    const fetchFn = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.vachana.ai/stt/v3");
      expect(new Headers(init.headers).get("x-api-key-id")).toBe(apiKey);
      expect(init.body.get("model")).toBe("prisma-v3.0");
      expect(init.body.get("language_code")).toBe("indic-auto");
      expect(init.body.get("audio_file").name).toBe("speech.wav");
      return Response.json({ transcript: "", success: true });
    });
    await expect(transcribeAudio(payload, { apiKey, fetchFn })).resolves.toEqual({ text: "", model: "prisma-v3.0" });
  });

  it.each(["wav", "mp3", "ogg", "flac", "aac", "m4a"])("validates %s audio before uploading", async (extension) => {
    const directory = mkdtempSync(join(tmpdir(), "gnani-format-test-"));
    const path = join(directory, `sample.${extension}`);
    try {
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=0.25", path]);
      const fetchFn = vi.fn(async (_url, init) => {
        expect(init.body.get("audio_file").name).toBe(`sample.${extension}`);
        return Response.json({ transcript: "fixture", success: true, model: "prisma-v2.5" });
      });
      await expect(transcribeAudio({
        fileName: `sample.${extension}`, buffer: readFileSync(path), settings: { model: "prisma-v2.5" },
      }, { apiKey, fetchFn })).resolves.toEqual({ text: "fixture", model: "prisma-v2.5" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects corrupt, long, truncated or cancelled audio", async () => {
    const fetchFn = vi.fn(async () => Response.json({ transcript: "unfinished", success: true, truncated: true }));
    const long = Buffer.alloc(44 + 31 * 16000);
    payload.buffer.copy(long, 0, 0, 44);
    long.writeUInt32LE(long.length - 8, 4);
    long.writeUInt32LE(long.length - 44, 40);
    await expect(transcribeAudio({ ...payload, buffer }, { apiKey, fetchFn })).rejects.toThrow("could not read");
    await expect(transcribeAudio({ ...payload, buffer: long }, { apiKey, fetchFn })).rejects.toThrow("Use Batch");
    await expect(transcribeAudio(payload, { apiKey, fetchFn, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    const guard = vi.fn(async (options) => {
      const stop = options.beforeRequest;
      const signal = options.signal;
      expect(signal?.aborted).toBe(false);
      stop?.();
      throw new Error("authority revoked before dispatch");
    });
    await expect(transcribeAudio(payload, { apiKey, fetchFn, guard })).rejects.toThrow("authority revoked");
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(transcribeAudio(payload, { apiKey, fetchFn })).rejects.toThrow("incomplete transcript");
  });
});

describe("HTTP and streaming", () => {
  it.each([400, 401, 402, 403, 422, 429, 500, 503, 504])("extracts and redacts HTTP %s", async (status) => {
    const echoed = `${key} https://s3.amazonaws.com/bucket?signature=private`;
    const body = status === 422 ? { detail: [{ msg: echoed }] }
      : status === 504 ? { error: "Gateway Timeout", code: "UPSTREAM_TIMEOUT", message: echoed }
      : { detail: { error_code: "ERROR", message: echoed } };
    const fetchFn = vi.fn(async () => Response.json(body, { status }));
    await expect(request("/stt/v3", {}, { apiKey, fetchFn })).rejects.toMatchObject({
      status, message: expect.stringContaining("[redacted] [redacted URL]"),
    });
  });

  it("retries a transient response and returns binary speech", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(new Response(buffer, { headers: { "content-type": "audio/mpeg" } }));
    await expect(synthesizeRest(normalizeTts("Hello", {}).body, { apiKey, fetchFn })).resolves.toEqual(buffer);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("parses SSE across split CRLF, Unicode, and JSON boundaries", async () => {
    const encoder = new TextEncoder();
    const sse = 'event: start\r\ndata: {"text":"नमस्ते"}\r\n\r\n'
      + 'event: chunk\r\ndata: {"chunk_index":1,"audio":"YWJj","is_final":false}\r\n\r\n'
      + 'event: chunk\r\ndata: {"chunk_index":2,"audio":"ZGVm","is_final":false}\r\n\r\n'
      + 'event: complete\r\ndata: {"is_final":true,"audio":""}\r\n\r\n';
    const fetchFn = vi.fn(async () => new Response(new ReadableStream({
      start(output) {
        for (const byte of encoder.encode(sse)) output.enqueue(Uint8Array.of(byte));
        output.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const stream = await synthesizeSse(normalizeTts("Hello", {}).body, { apiKey, fetchFn });
    await expect(collect(stream.audioStream)).resolves.toEqual(Buffer.from("abcdef"));
    await stream.release();
  });

  it("reports SSE interruption and cleans up a cancelled reader", async () => {
    const body = normalizeTts("Hello", {}).body;
    const headers = { "content-type": "text/event-stream" };
    const response = 'event: chunk\ndata: {"chunk_index":1,"audio":"YWJj","is_final":false}\n\n';
    const stream = await synthesizeSse(body, { apiKey, fetchFn: async () => new Response(response, { headers }) });
    await expect(collect(stream.audioStream)).rejects.toThrow("before completion");
    const cancel = vi.fn();
    const pending = await synthesizeSse(body, { apiKey, fetchFn: async () =>
      new Response(new ReadableStream({ cancel }), { headers }) });
    await pending.audioStream.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("Batch", () => {
  it("reports missing credentials as a configuration failure before creating jobs", async () => {
    vi.stubEnv("GNANI_API_KEY", "");
    try {
      const fetchFn = vi.fn<typeof fetch>();
      const client = createBatchClient({ fetchFn });
      const source = { kind: "presigned", filenames: ["clip.wav"] } as const;
      await expect(client.create({}, source)).rejects.toThrow("Gnani credentials missing");
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses separate presigned, upload, lifecycle and transcript requests", async () => {
    const url = "https://bucket.s3.amazonaws.com/upload?fixture=1";
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ job_id: "job-1", status: "CREATED", uploads: [{ url }] }))
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(Response.json({ job_id: "job-1", status: "QUEUED" }))
      .mockResolvedValueOnce(Response.json({ job_id: "job-1", status: "COMPLETED" }))
      .mockResolvedValueOnce(Response.json({ data: [{ file_id: "file-1", status: "COMPLETED", transcript_url: url }], pagination: { next_cursor: null } }))
      .mockResolvedValueOnce(Response.json({ model: "prisma-v2.5", full_transcript: "Hello", segments: [{ speaker_id: 1 }] }));
    const client = createBatchClient({ apiKey, fetchFn });
    const { job, uploads } = await client.create({ model: "prisma-v2.5" }, { kind: "presigned", filenames: ["clip.wav"] });
    await client.upload(uploads[0]!.url, new Blob([buffer]));
    await client.start(job.job_id);
    expect((await client.wait(job.job_id)).status).toBe("COMPLETED");
    const results = await client.results(job.job_id);
    expect((await client.transcript(results.data[0]!.transcript_url!)).segments[0]).toEqual({ speaker_id: 1 });
    expect(fetchFn.mock.calls.map(([uri]) => new URL(String(uri)).pathname)).toEqual([
      "/stt/v3/batch/v2/jobs", "/upload", "/stt/v3/batch/jobs/job-1/start",
      "/stt/v3/batch/jobs/job-1", "/stt/v3/batch/jobs/job-1/files", "/upload",
    ]);
    expect(new Headers(fetchFn.mock.calls[1]![1]?.headers).has("X-API-Key-ID")).toBe(false);
  });

  it("encodes ZIP and public cloud sources with their respective create request formats", async () => {
    const result = () => Response.json({ job_id: "job-1", status: "CREATED" });
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const type = new Headers(init?.headers).get("content-type");
      if (type?.startsWith("multipart/form-data")) {
        const form = await new Response(init?.body, { headers: { "Content-Type": type } }).formData();
        expect(form.get("config")).toContain('"model":"prisma-v3.0"');
        expect(form.get("files")).toMatchObject({ name: "batch.zip", type: "application/zip" });
      } else {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          source: { type: "cloud_storage", auth: { mode: "public" }, paths: ["https://audio.example.org/clip.wav"] },
        });
      }
      return result();
    });
    const client = createBatchClient({ apiKey, fetchFn });
    const created = await client.create({}, { kind: "upload", files: [{ name: "batch.zip", data: new Blob([buffer]) }] });
    expect(created.job.status).toBe("CREATED");
    await client.create({}, { kind: "cloud", paths: ["https://audio.example.org/clip.wav"] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry ambiguous creation and reconciles cancellation", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("network disconnect"))
      .mockRejectedValueOnce(new TypeError("network disconnect"))
      .mockResolvedValueOnce(Response.json({ job_id: "job-1", status: "CANCELLED" }));
    const client = createBatchClient({ apiKey, fetchFn });
    await expect(client.create({}, { kind: "upload", files: [{ name: "sample.wav", data: new Blob([buffer]) }] }))
      .rejects.toThrow("may have succeeded upstream");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await expect(client.cancel("job-1")).resolves.toMatchObject({ status: "CANCELLED" });
  });
});

describe("WebSocket adapters", () => {
  it("paces STT frames, sends commit, and emits a final transcript once", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    const received: number[] = [];
    const transcript = vi.fn();
    let committed = false;
    const disconnected = vi.fn();
    sockets.on("connection", (socket, upgrade) => {
      expect(upgrade.headers.model).toBe("prisma-v3.0");
      expect(upgrade.headers.multi_lang_codes).toBe("hi-IN,en-IN");
      expect(upgrade.headers["x-api-key-id"]).toBe(apiKey);
      socket.send('{"type":"connected"}');
      socket.on("close", disconnected);
      socket.on("message", (message, binary) => {
        if (binary) {
          expect(message).toHaveLength(1024);
          received.push(performance.now());
        } else if (JSON.parse(message.toString()).type === "commit") {
          committed = true;
          socket.send('{"type":"transcript","text":"Hello","segment_id":"one","is_final":true}');
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const session = createPrismaSession({
      providerConfig: { model: "prisma-v3.0", language: "hi,en", encoding: "mulaw" },
      onTranscript: transcript,
    }, (options) => socketSession(options, `ws://127.0.0.1:${address.port}`), apiKey);
    try {
      await session.connect();
      session.sendAudio(Buffer.alloc(520, 0xff));
      session.close();
      await vi.waitFor(() => expect(transcript).toHaveBeenCalledWith("Hello"));
      expect(committed).toBe(true);
      expect(received).toHaveLength(2);
      expect(received[1]! - received[0]!).toBeGreaterThan(45);
      await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
    } finally {
      session.cancel();
      sockets.close();
      server.close();
    }
  });

  it("reconnects between completed TTS turns and cancels an active turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gnani-tests-"));
    const certPath = join(directory, "cert.pem");
    const keyPath = join(directory, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=api.vachana.ai", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
    const ca = readFileSync(certPath);
    const server = createHttpsServer({ key: readFileSync(keyPath), cert: ca });
    const sockets = new WebSocketServer({ server });
    const opened = vi.fn();
    const closed = vi.fn();
    sockets.on("connection", (socket, upgrade) => {
      opened();
      expect(upgrade.headers["x-api-key-id"]).toBe(apiKey);
      socket.on("close", closed);
      socket.on("message", (message) => {
        expect(["timbre-v2.5", "timbre-v3.0"]).toContain(JSON.parse(message.toString()).model);
        socket.send('{"type":"start"}');
        socket.send('{"type":"audio","data":{"chunk_index":1,"audio":"YWJj","is_final":false}}');
        if (JSON.parse(message.toString()).text !== "cancel") {
          socket.send('{"type":"complete","data":{"chunk_index":2,"audio":"","is_final":true}}');
          socket.close();
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    const agent = new Agent({ ca, servername: "api.vachana.ai" });
    const dial = agent.createConnection.bind(agent);
    agent.createConnection = (options, done) => dial({ ...options, host: "127.0.0.1", port: address.port }, done);
    const session = await createTimbreWebSocketSession({ apiKey, agent });
    try {
      for (const model of ["timbre-v2.5", "timbre-v3.0"]) {
        const result = session.synthesize("hello", { model });
        await expect(collect(result.audioStream)).resolves.toEqual(Buffer.from("abc"));
        await sleep(50);
      }
      const turn = session.synthesize("cancel", {}).audioStream.getReader();
      await expect(turn.read()).resolves.toMatchObject({ done: false });
      await turn.cancel();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(3));
      expect(opened).toHaveBeenCalledTimes(3);
    } finally {
      session.close();
      agent.destroy();
      sockets.close();
      server.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
