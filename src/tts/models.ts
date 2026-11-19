import type { JsonObject } from "../types.js";
import { object, string } from "../http.js";
import { locale } from "../stt/models.js";
import { DEFAULT_TIMBRE, VOICES } from "./voices.js";

const TAGS = new Set([
  "laugh", "giggle", "sigh", "exhales", "sniffles", "yawns", "coughs", "clears throat",
  "whispers", "shouting", "excited", "slow", "pauses",
]);
const CONTAINERS = ["wav", "mp3", "ogg", "raw", "mulaw", "alaw"] as const;
type Container = typeof CONTAINERS[number];
export type SpeechTarget = "audio-file" | "voice-note" | "telephony";
export const FORMATS: Record<Container, { outputFormat: string; fileExtension: string; mime: string; voiceCompatible: boolean }> = {
  wav: { outputFormat: "wav", fileExtension: ".wav", mime: "audio/wav", voiceCompatible: false },
  mp3: { outputFormat: "mp3", fileExtension: ".mp3", mime: "audio/mpeg", voiceCompatible: false },
  ogg: { outputFormat: "opus", fileExtension: ".ogg", mime: "audio/ogg", voiceCompatible: true },
  raw: { outputFormat: "pcm", fileExtension: ".pcm", mime: "application/octet-stream", voiceCompatible: false },
  mulaw: { outputFormat: "ulaw_8000", fileExtension: ".mulaw", mime: "audio/basic", voiceCompatible: false },
  alaw: { outputFormat: "alaw_8000", fileExtension: ".alaw", mime: "audio/alaw", voiceCompatible: false },
};

export function timbreModel(value: unknown) {
  const model = value ?? DEFAULT_TIMBRE;
  if (model !== "timbre-v2.5" && model !== "timbre-v3.0") throw new Error("Select timbre-v2.5 or timbre-v3.0");
  return model;
}

export function normalizeTts(text: string, raw: JsonObject, target?: SpeechTarget) {
  const model = timbreModel(raw.modelId ?? raw.model);
  const v3 = model === "timbre-v3.0";
  const voice = string(raw.speakerVoice ?? raw.speakerVoiceId ?? raw.voice ?? raw.voiceId) ?? (v3 ? "Shivani" : "Kaveri");
  if (!VOICES[model].some(({ id }) => id === voice)) throw new Error(`Select a case-sensitive voice from the ${model} voice catalog`);
  const hint = string(raw.language)?.toLowerCase() ?? "auto";
  const language = hint === "auto" || hint === "hi-en" ? hint : locale(hint);
  const speed = Number(raw.speed ?? 1);
  if (!Number.isFinite(speed) || (v3 ? ![0.8, 1, 1.2].includes(speed) : speed < 0.85 || speed > 1.15)) {
    throw new Error(v3 ? "Timbre v3.0 speed must be 0.8, 1.0 or 1.2" : "Timbre v2.5 speed must be between 0.85 and 1.15");
  }
  const plainText = text.replace(/<([^<>]+)>/g, (_tag: string, name: string) => v3 && TAGS.has(name) ? `<${name}>` : "");
  if (!plainText.replace(/<[^<>]+>/g, "").trim() || Buffer.byteLength(plainText) > 64 * 1024) {
    throw new Error("Gnani synthesis requires nonempty text up to 64 KiB");
  }
  const audio = raw.audio_config ?? raw.audioConfig;
  const config = audio === undefined ? {} : object(audio, "audioConfig");
  const encoding = string(config.encoding);
  const alias = encoding === "pcm_mulaw" ? "mulaw" : encoding === "pcm_alaw" ? "alaw" : encoding === "oggopus" ? "ogg" : undefined;
  const container = target === "telephony" ? "raw" : target === "voice-note" ? "ogg"
    : alias ?? config.container ?? "mp3";
  if (typeof container !== "string" || !CONTAINERS.includes(container as Container)) {
    throw new Error("Unsupported Gnani audio container");
  }
  if (encoding && !["linear_pcm", "pcm_s16le", "pcm_mulaw", "pcm_alaw", "oggopus"].includes(encoding)) {
    throw new Error("Unsupported Gnani audio encoding");
  }
  if ((alias && config.container !== undefined && config.container !== "raw" && config.container !== alias)
     ) {
    throw new Error("Gnani audio container and encoding do not match");
  }

  const rate = target === "telephony" || container === "mulaw" || container === "alaw"
    ? 8000 : Number(config.sample_rate ?? (container === "ogg" ? 48000 : 24000));
  const channels = target === "telephony" || target === "voice-note" ? 1 : Number(config.num_channels ?? 1);
  const width = target === "telephony" ? 2 : Number(config.sample_width ?? 2);
  const bitrate = string(config.bitrate);
  if (![8000, 16000, 22050, 24000, 44100, 48000].includes(rate)
    || !Number.isInteger(channels) || channels < 1 || channels > 8
    || !Number.isInteger(width) || width < 1 || width > 4) {
    throw new Error("Invalid Gnani output sample rate, channel count, or sample width");
  }
  if (bitrate !== undefined && target !== "voice-note" && target !== "telephony"
    && (container !== "mp3" || !/^\d+k$/.test(bitrate) || Number.parseInt(bitrate) < 32 || Number.parseInt(bitrate) > 192)) {
    throw new Error("Gnani MP3 bitrate must be between 32k and 192k");
  }
  return {
    body: {
      text: plainText, model, voice, language, speed,
      audio_config: {
        container,
        sample_rate: rate,
        num_channels: channels,
        sample_width: width,
        ...(container === "wav" || container === "raw" ? { encoding: "linear_pcm" } : {}),
        ...(container === "mp3" && bitrate ? { bitrate } : {}),
      },
    },
    format: FORMATS[container as Container],
    sampleRate: rate,
  };
}

export type TtsRequest = ReturnType<typeof normalizeTts>["body"];
