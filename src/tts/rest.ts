import { jsonBody, MAX_AUDIO_BYTES, readBytes, request, type Transport } from "../http.js";
import type { TtsRequest } from "./models.js";

export async function synthesizeRest(body: TtsRequest, transport: Transport): Promise<Buffer> {
  const { response, release } = await request("/api/v1/tts/inference", jsonBody(body), transport, 2);
  try {
    const type = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (!type || (type !== "application/octet-stream" && !type.startsWith("audio/"))) {
      throw new Error("Gnani TTS returned an unexpected content type");
    }
    const audio = await readBytes(response, MAX_AUDIO_BYTES);
    if (!audio.length) throw new Error("Gnani TTS returned empty audio");
    return audio;
  } finally {
    await release();
  }
}
