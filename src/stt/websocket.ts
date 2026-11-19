import type {
  PluginCapabilityCatalogHostContext, RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { pcmConverter, type AudioInput } from "../audio/conversion.js";
import { AUTH_HEADER, WS_ORIGIN, redact, requireKey, resolveKey, string, type JsonObject } from "../http.js";
import { DEFAULT_PRISMA, normalizeStt, PRISMA_MODELS, wireField } from "./models.js";

type HostSession = PluginCapabilityCatalogHostContext["createRealtimeTranscriptionWebSocketSession"];
type SessionTransport = Parameters<NonNullable<Parameters<HostSession>[0]["onOpen"]>>[0];
type SessionRequest = Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0];
const FRAME_BYTES = 1024;
const MAX_FRAME_QUEUE = 64;
const FINALIZE_MS = 5000;

// Header values must stay ASCII even for Indic keyterms and substitution strings.
function headerValue(value: unknown): string {
  const encoded = wireField(value);
  return typeof value === "object"
    ? encoded.replace(/[^\x20-\x7E]/g, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))
    : encoded;
}

export function createPrismaSession(
  req: SessionRequest,
  createSession: HostSession,
  apiKey: string,
) {
  const raw = req.providerConfig;
  const modelConfig = normalizeStt(raw, "realtime");
  const inputRate = Number(raw.sampleRate ?? 8000);
  const channels = Number(raw.channels ?? 1);
  const encoding = raw.encoding ?? "mulaw";
  if ((encoding !== "mulaw" && encoding !== "pcm16le") || ![1, 2].includes(channels)
    || ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(inputRate)) {
    throw new Error("Invalid realtime STT input encoding, sample rate, or channels");
  }
  const outputRate = [8000, 16000, 44100, 48000].includes(inputRate) ? inputRate : 16000;
  const input: AudioInput = { encoding, sampleRate: inputRate, channels };
  let convert = pcmConverter(input, outputRate);
  const headers: Record<string, string> = { [AUTH_HEADER]: apiKey, "x-sample-rate": String(outputRate) };
  for (const header of ["x-idle-timeout-sec", "x-vad-threshold", "x-min-silence-ms",
    "x-min-speech-ms", "x-min-segment-ms", "x-max-speech-s"]) {
    if (raw[header] !== undefined) {
      const number = Number(raw[header]);
      if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid Gnani header ${header}`);
      headers[header] = String(number);
    }
  }

  let active: SessionTransport | undefined;
  let queue: Buffer[] = [];
  let tail = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let stopped = false;
  let speaking = false;
  let pendingSegments = 0;
  let pendingConfig: JsonObject | undefined;
  let effectiveConfig = modelConfig;
  const completed = new Set<string>();
  const interval = (FRAME_BYTES / 2 / outputRate) * 1000;
  const report = (error: Error) => req.onError?.(new Error(redact(error.message, apiKey)));

  function discard() {
    clearTimeout(timer);
    timer = undefined;
    queue = [];
    tail = Buffer.alloc(0);
    convert = pcmConverter(input, outputRate);
  }

  function schedule() {
    if (timer || !active?.isReady() || stopped) return;
    if (!queue.length) {
      if (closing) session.close();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!active?.isReady() || stopped) return;
      const frame = queue.shift();
      if (frame && !active.sendBinary(frame)) {
        discard();
        report(new Error("Gnani realtime audio delivery was interrupted"));
      }
      schedule();
    }, interval);
  }

  const session = createSession<JsonObject>({
    providerId: "gnani",
    url: `${WS_ORIGIN}/stt/v3/stream`,
    headers: () => {
      const next = { ...headers };
      for (const [name, value] of Object.entries(effectiveConfig)) next[name] = headerValue(value);
      const [primary, ...alternatives] = next.language_code!.split(",");
      if (alternatives.length) {
        // The live service requires a single primary locale in language_code.
        next.multi_lang_codes = next.language_code!;
        next.language_code = primary!;
      }
      return next;
    },
    readyOnOpen: false,
    closeTimeoutMs: FINALIZE_MS,
    maxReconnectAttempts: 3,
    callbacks: { onError: report },
    onOpen(transport) {
      if (active) {
        discard();
        if (speaking || pendingSegments || pendingConfig) report(new Error("Gnani realtime connection interrupted an active utterance or settings update"));
      }
      active = transport;
      speaking = false;
      pendingSegments = 0;
      pendingConfig = undefined;
    },
    sendAudio() {
      // The outer session owns the bounded queue and its real-time cadence.
    },
    onClose(transport) {
      if (!stopped && transport.isOpen() && transport.sendJson({ type: "commit" })) return;
      transport.closeNow();
    },
    onMessage(event, transport) {
      if (stopped || transport !== active) return;
      switch (event.type) {
        case "connected":
          transport.markReady();
          schedule();
          break;
        case "speech_start":
          speaking = true;
          if (!closing) req.onSpeechStart?.();
          break;
        case "processing":
          speaking = false;
          pendingSegments++;
          break;
        case "transcript": {
          const id = string(event.segment_id);
          const transcript = string(event.text);
          if (id && completed.has(id)) return;
          pendingSegments = Math.max(0, pendingSegments - 1);
          if (id) {
            completed.add(id);
            if (completed.size > 4096) completed.delete(completed.values().next().value!);
          }
          if (transcript) req.onTranscript?.(transcript);
          if (closing && !queue.length && !timer && !pendingSegments && !speaking) transport.closeNow();
          break;
        }
        case "settings_updated":
          if (pendingConfig) effectiveConfig = pendingConfig;
          pendingConfig = undefined;
          break;
        case "error": {
          const error = new Error(string(event.message) ?? "Gnani realtime STT failed");
          pendingConfig = undefined;
          if (!transport.isReady() && !closing) transport.failConnect(error);
          else report(error);
          break;
        }
      }
    },
  });

  return {
    connect: () => session.connect(),
    isConnected: () => !closing && !stopped && session.isConnected(),
    sendAudio(audio: Buffer) {
      if (closing || stopped || !audio.length) return;
      if (audio.length > MAX_FRAME_QUEUE * FRAME_BYTES) {
        report(new Error("Gnani realtime audio input chunk is too large"));
        return;
      }
      const pcm = convert(audio);
      const bytes = tail.length ? Buffer.concat([tail, pcm]) : pcm;
      const frames = Math.floor(bytes.length / FRAME_BYTES);
      if (queue.length + frames > MAX_FRAME_QUEUE) {
        discard();
        report(new Error("Gnani realtime audio buffer overflow"));
        return;
      }
      for (let i = 0; i < frames; i++) queue.push(Buffer.from(bytes.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)));
      tail = Buffer.from(bytes.subarray(frames * FRAME_BYTES));
      schedule();
    },
    updateSettings(settings: JsonObject) {
      if (closing || stopped || !active?.isReady() || pendingConfig) throw new Error("Gnani realtime session is not ready for an update");
      const allowed = ["language_code", "format", "itn_native_numerals", "enable_substitution", "substitution_map", "keyterms", "bias_list", "bias_score"];
      if (Object.keys(settings).some((key) => !allowed.includes(key))) throw new Error("Invalid realtime settings update");
      const rawUpdate = { ...effectiveConfig, ...settings };
      const changedList = settings.keyterms !== undefined ? settings.keyterms : settings.bias_list;
      const clearList = changedList === null || Array.isArray(changedList) && changedList.length === 0;
      if (clearList) {
        delete rawUpdate.keyterms;
        delete rawUpdate.bias_list;
      } else if (effectiveConfig.model === "prisma-v3.0" && changedList !== undefined) {
        rawUpdate.keyterms = changedList;
      }
      const next = normalizeStt(rawUpdate, "realtime");
      const update: JsonObject = { type: "update_settings" };
      for (const key of allowed.slice(0, 3)) if (settings[key] !== undefined) update[key] = next[key];
      if (settings.enable_substitution !== undefined || settings.substitution_map !== undefined) {
        update.substitution = { enabled: next.enable_substitution, map: next.substitution_map };
      }
      if (settings.keyterms !== undefined || settings.bias_list !== undefined || settings.bias_score !== undefined) {
        update.bias = { list: clearList ? [] : next.keyterms ?? next.bias_list, score: next.bias_score };
      }
      if (!active.sendJson(update)) throw new Error("Could not send Gnani settings update");
      pendingConfig = next;
    },
    close() {
      if (closing || stopped) return;
      closing = true;
      if (!active?.isReady()) {
        discard();
        session.close();
        return;
      }
      if (tail.length) {
        const final = Buffer.alloc(FRAME_BYTES);
        tail.copy(final);
        queue.push(final);
        tail = Buffer.alloc(0);
      }
      schedule();
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      discard();
      session.close();
    },
  };
}

export function realtimeProvider(context: PluginCapabilityCatalogHostContext): RealtimeTranscriptionProviderPlugin {
  const directKey = (providerConfig: JsonObject) => resolveKey(providerConfig.apiKey);
  return {
    id: "gnani",
    label: "Gnani Prisma",
    defaultModel: DEFAULT_PRISMA,
    models: PRISMA_MODELS,
    isConfigured: ({ providerConfig }) => Boolean(directKey(providerConfig)),
    async isConfiguredAsync({ cfg, providerConfig }) {
      return Boolean(directKey(providerConfig) || (cfg && await context.isProviderApiKeyConfiguredAsync({ provider: "gnani", cfg })));
    },
    createSession(req) {
      const key = directKey(req.providerConfig);
      if (key) return createPrismaSession(req, context.createRealtimeTranscriptionWebSocketSession, key);
      // Session creation is synchronous. Resolve any host-owned credential on connect.
      let session: ReturnType<typeof createPrismaSession> | undefined;
      let closed = false;
      const pending: Buffer[] = [];
      let queuedBytes = 0;
      return {
        async connect() {
          if (closed) return;
          const auth = req.cfg && await context.resolveApiKeyForProvider({ provider: "gnani", cfg: req.cfg });
          if (closed) return;
          session = createPrismaSession(req, context.createRealtimeTranscriptionWebSocketSession, requireKey(auth?.apiKey));
          for (const frame of pending.splice(0)) session.sendAudio(frame);
          queuedBytes = 0;
          await session.connect();
        },
        sendAudio(audio) {
          if (closed) return;
          if (session) return session.sendAudio(audio);
          if (queuedBytes + audio.length > MAX_FRAME_QUEUE * FRAME_BYTES) return req.onError?.(new Error("Gnani realtime audio buffer overflow"));
          pending.push(Buffer.from(audio));
          queuedBytes += audio.length;
        },
        close() {
          closed = true;
          pending.length = 0;
          session?.close();
        },
        isConnected: () => !closed && Boolean(session?.isConnected()),
      };
    },
  };
}
