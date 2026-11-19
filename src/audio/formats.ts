import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { MAX_AUDIO_BYTES, object } from "../http.js";

const MIME_BY_EXTENSION = {
  wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg",
  flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4",
} as const;
type AudioExtension = keyof typeof MIME_BY_EXTENSION;

export function audioFile(fileName: string, mime?: string): { name: string; mime: string } {
  const safeName = basename(fileName || "audio");
  const ext = extname(safeName).slice(1).toLowerCase();
  const type = mime?.split(";")[0]?.trim().toLowerCase();
  const inferred = Object.entries(MIME_BY_EXTENSION).find(([, value]) => value === type)?.[0]
    ?? ({ "audio/x-wav": "wav", "audio/x-m4a": "m4a", "application/ogg": "ogg", "audio/opus": "ogg" } as Record<string, string>)[type ?? ""];
  const normalized = ext === "oga" || ext === "opus" ? "ogg" : ext || inferred;
  if (!normalized || !Object.hasOwn(MIME_BY_EXTENSION, normalized)) {
    throw new Error("Gnani STT supports WAV, MP3, OGG, FLAC, AAC, and M4A audio");
  }
  const format = normalized as AudioExtension;
  const name = ext === format ? safeName : `${safeName.slice(0, safeName.length - extname(safeName).length)}.${format}`;
  return { name, mime: MIME_BY_EXTENSION[format] };
}

export async function validateShortAudio(buffer: Buffer, name: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (buffer.length === 0 || buffer.length > MAX_AUDIO_BYTES) {
    throw new Error("Gnani REST audio must be nonempty and at most 32 MiB");
  }
  const directory = await mkdtemp(join(tmpdir(), "gnani-stt-"));
  try {
    const extension = extname(name).slice(1).toLowerCase();
    const demuxer = extension === "m4a" ? "mov" : extension;
    const path = join(directory, `input.${extension}`);
    await writeFile(path, buffer, { mode: 0o600, signal });
    const { stdout } = await promisify(execFile)("ffprobe", [
      "-v", "error", "-protocol_whitelist", "file", "-f", demuxer, "-select_streams", "a:0",
      "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", path,
    ], { timeout: 10_000, maxBuffer: 16_384, signal });
    const result = object(JSON.parse(stdout), "FFprobe result");
    const streams = Array.isArray(result.streams) ? result.streams : [];
    const format = object(result.format, "FFprobe format");
    const duration = Number(format.duration);
    if (!streams.length || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("Could not determine the audio duration");
    }
    if (duration > 30) {
      throw new RangeError("Gnani REST accepts recordings up to 30 seconds. Use Batch STT for longer recordings.");
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof RangeError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Install FFmpeg and make ffprobe available on PATH to use Gnani recorded transcription.");
    }
    throw new Error("Gnani could not read the recording. Provide valid audio in a supported format.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
