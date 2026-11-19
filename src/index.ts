import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { mediaProvider } from "./stt/rest.js";
import { realtimeProvider } from "./stt/websocket.js";
import { speechProvider } from "./tts/provider.js";

export default definePluginEntry({
  id: "gnani",
  name: "Gnani AI Speech",
  description: "Prisma transcription and Timbre speech synthesis for OpenClaw.",
  register(api) {
    api.registerMediaUnderstandingProvider(mediaProvider);
    api.registerRealtimeTranscriptionProvider(realtimeProvider);
    api.registerSpeechProvider(speechProvider);
  },
});
