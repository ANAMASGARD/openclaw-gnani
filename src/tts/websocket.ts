import type { JsonObject } from "../types.js";
import WebSocket from "ws";
import { AUTH_HEADER, MAX_AUDIO_BYTES, WS_ORIGIN, object, redact, requireKey, string } from "../http.js";
import { normalizeTts, type TtsRequest } from "./models.js";
import { audioChunk } from "./sse.js";

type SocketOptions = {
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  agent?: import("node:http").Agent;
};

type Turn = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timeout: ReturnType<typeof setTimeout>;
  started: boolean;
  nextIndex: number;
  size: number;
};

export async function connectTimbre(options: SocketOptions = {}) {
  const apiKey = requireKey(options.apiKey);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const signal = options.signal;
  signal?.throwIfAborted();
  const socket = new WebSocket(`${WS_ORIGIN}/api/v1/tts`, {
    headers: { [AUTH_HEADER]: apiKey },
    agent: options.agent,
    followRedirects: false,
    handshakeTimeout: Math.min(10_000, timeoutMs),
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
  });

  let current: Turn | undefined;
  let closed = false;
  let rejectConnection: ((reason: Error) => void) | undefined;
  function finishTurn(error?: Error) {
    const turn = current;
    if (!turn) return;
    current = undefined;
    clearTimeout(turn.timeout);
    if (error) turn.controller.error(error);
    else turn.controller.close();
  }
  function closeSocket(error?: Error) {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", abort);
    const failure = error ?? new Error("Gnani WebSocket synthesis was cancelled");
    rejectConnection?.(failure);
    finishTurn(failure);
    socket.terminate();
  }
  const abort = () => closeSocket(new Error("Gnani WebSocket synthesis was cancelled"));
  signal?.addEventListener("abort", abort, { once: true });

  socket.on("error", (error) => closeSocket(new Error(redact(error.message, apiKey))));
  socket.on("close", () => closeSocket(new Error("Gnani TTS WebSocket closed before completion")));
  socket.on("unexpected-response", (req, response) => {
    response.resume();
    req.destroy();
    closeSocket(new Error(`Gnani TTS WebSocket upgrade returned HTTP ${response.statusCode}`));
  });
  socket.on("message", (data, binary) => {
    if (closed) return;
    try {
      const turn = current;
      if (!turn || binary) throw new Error("Gnani TTS WebSocket sent an unexpected message");
      let event: JsonObject;
      try {
        event = object(JSON.parse(data.toString()), "Gnani TTS event");
      } catch {
        throw new Error("Gnani TTS WebSocket returned malformed JSON");
      }
      if (event.type === "error") throw new Error(redact(string(event.message) ?? "Gnani WebSocket synthesis failed", apiKey));
      if (event.type === "start" && !turn.started) {
        turn.started = true;
        return;
      }
      if (!turn.started || (event.type !== "audio" && event.type !== "complete")) {
        throw new Error("Gnani TTS WebSocket returned an out-of-order event");
      }
      const payload = object(event.data, "Gnani TTS payload");
      if (event.type === "audio") {
        if (payload.chunk_index !== turn.nextIndex++ || payload.is_final !== false) {
          throw new Error("Gnani TTS WebSocket returned an out-of-order audio chunk");
        }
        const audio = audioChunk(payload.audio);
        turn.size += audio.length;
        if (turn.size > MAX_AUDIO_BYTES) throw new Error("Gnani TTS stream exceeded the audio limit");
        turn.controller.enqueue(audio);
        if ((turn.controller.desiredSize ?? 0) <= 0) socket.pause();
        return;
      }
      if (payload.is_final !== true || payload.audio !== "" || !turn.size) throw new Error("Gnani TTS returned an invalid WebSocket completion");
      finishTurn();
      socket.resume();
    } catch (error) {
      closeSocket(error instanceof Error ? error : new Error("Gnani WebSocket synthesis failed"));
    }
  });

  await new Promise<void>((resolve, reject) => {
    rejectConnection = reject;
    socket.once("open", () => {
      rejectConnection = undefined;
      resolve();
    });
    if (signal?.aborted) abort();
  });

  function synthesize(body: TtsRequest): ReadableStream<Uint8Array> {
    if (closed || socket.readyState !== WebSocket.OPEN) throw new Error("Gnani TTS WebSocket is closed");
    if (current) throw new Error("Wait for the active Gnani synthesis turn to complete");
    return new ReadableStream<Uint8Array>({
      start(controller) {
        current = {
          controller, started: false, nextIndex: 1, size: 0,
          timeout: setTimeout(() => closeSocket(new Error("Gnani TTS WebSocket synthesis timed out")), timeoutMs),
        };
        socket.send(JSON.stringify(body), (error) => {
          if (error) closeSocket(new Error(redact(error.message, apiKey)));
        });
      },
      pull() { if (!closed) socket.resume(); },
      cancel() { closeSocket(); },
    }, { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength });
  }

  return {
    synthesize,
    isOpen: () => !closed && socket.readyState === WebSocket.OPEN,
    close: () => closeSocket(),
  };
}

export async function createTimbreWebSocketSession(options: SocketOptions = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let session = await connectTimbre({ ...options, signal });
  let active = false;
  return {
    synthesize(text: string, settings: JsonObject) {
      signal.throwIfAborted();
      if (active) throw new Error("Wait for the active Gnani synthesis turn to complete");
      const { body, format } = normalizeTts(text, settings);
      active = true;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let delivered = false;
      let retried = false;
      let cancelled = false;
      const audioStream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            for (;;) {
              try {
                if (!reader) {
                  if (!session.isOpen()) session = await connectTimbre({ ...options, signal });
                  signal.throwIfAborted();
                  reader = session.synthesize(body).getReader();
                }
                const { done, value } = await reader.read();
                if (cancelled) return;
                if (done) {
                  reader.releaseLock();
                  active = false;
                  output.close();
                } else {
                  delivered = true;
                  output.enqueue(value);
                }
                return;
              } catch (error) {
                if (cancelled) return;
                if (delivered || retried || signal.aborted || !(error instanceof Error)
                  || !/^Gnani TTS WebSocket (?:closed before completion|is closed)$/.test(error.message)) throw error;
                retried = true;
                reader?.releaseLock();
                reader = undefined;
                session.close();
              }
            }
          } catch (error) {
            reader?.releaseLock();
            active = false;
            throw error;
          }
        },
        async cancel() {
          cancelled = true;
          session.close();
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
          active = false;
        },
      }, { highWaterMark: 0 });
      return { ...format, audioStream };
    },
    close() {
      controller.abort();
      session.close();
    },
  };
}
