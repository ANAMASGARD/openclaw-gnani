import { jsonBody, MAX_AUDIO_BYTES, object, redact, request, resolveKey, string, type Transport } from "../http.js";
import type { TtsRequest } from "./models.js";

const MAX_EVENT_LENGTH = 8 * 1024 * 1024;

export function audioChunk(value: unknown): Buffer {
  if (typeof value !== "string" || !value.length || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Gnani streaming TTS returned invalid base64 audio");
  }
  return Buffer.from(value, "base64");
}

export async function synthesizeSse(body: TtsRequest, transport: Transport) {
  const apiKey = resolveKey(transport.apiKey);
  const controller = new AbortController();
  const signal = transport.signal ? AbortSignal.any([transport.signal, controller.signal]) : controller.signal;
  const lease = await request("/api/v1/tts/sse", {
    ...jsonBody(body),
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
  }, { ...transport, signal }, 2);
  if (!lease.response.body || !lease.response.headers.get("content-type")?.startsWith("text/event-stream")) {
    controller.abort();
    await lease.release();
    throw new Error("Gnani TTS returned an invalid SSE response");
  }
  const reader = lease.response.body.getReader();
  let released: Promise<void> | undefined;
  function release(): Promise<void> {
    return released ??= (async () => {
      controller.abort();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await lease.release();
    })();
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let event = "";
  let data = "";
  let total = 0;
  let nextIndex = 1;
  let expectedLF = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        for (;;) {
          if (expectedLF && buffer.length) {
            if (buffer[0] === "\n") buffer = buffer.slice(1);
            expectedLF = false;
          }
          const offset = buffer.search(/[\r\n]/);
          if (offset === -1) {
            const { done, value } = await reader.read();
            if (done) throw new Error("Gnani TTS stream ended before completion");
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > MAX_EVENT_LENGTH) throw new Error("Gnani SSE event exceeds the size limit");
            continue;
          }
          const line = buffer.slice(0, offset);
          expectedLF = buffer[offset] === "\r";
          buffer = buffer.slice(offset + 1);
          if (line) {
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
            if (field === "event") event = value;
            if (field === "data") data += data ? `\n${value}` : value;
            if (data.length > MAX_EVENT_LENGTH) throw new Error("Gnani SSE event exceeds the size limit");
            continue;
          }
          const name = event;
          const payload = data;
          event = "";
          data = "";
          if (!name || name === "start") continue;
          let frame: Record<string, unknown>;
          try {
            frame = object(JSON.parse(payload), "Gnani SSE event");
          } catch {
            throw new Error("Gnani TTS returned a malformed SSE event");
          }
          if (name === "error") throw new Error(redact(string(frame.message) ?? "Gnani TTS SSE failed", apiKey));
          if (name === "complete") {
            if (frame.is_final !== true || !total) throw new Error("Gnani TTS returned an invalid SSE completion");
            await release();
            output.close();
            return;
          }
          if (name !== "chunk") continue;
          if (frame.chunk_index !== nextIndex++ || frame.is_final === true) {
            throw new Error("Gnani TTS returned an out-of-order SSE chunk");
          }
          const chunk = audioChunk(frame.audio);
          total += chunk.length;
          if (total > MAX_AUDIO_BYTES) throw new Error("Gnani TTS stream exceeded the audio limit");
          output.enqueue(chunk);
          return;
        }
      } catch (error) {
        await release();
        throw error;
      }
    },
    cancel: release,
  }, { highWaterMark: 0 });
  return { audioStream: stream, release };
}
