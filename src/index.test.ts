import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import entry from "./index.js";

describe("Gnani plugin", () => {
  it("registers the three native audio capabilities", () => {
    const media: string[] = [];
    const factories: unknown[] = [];
    const api = {
      registerMediaUnderstandingProvider(provider) { media.push(provider.id); },
      registerRealtimeTranscriptionProvider(factory) { factories.push(factory); },
      registerSpeechProvider(factory) { factories.push(factory); },
    } satisfies Partial<OpenClawPluginApi>;
    entry.register(api as OpenClawPluginApi);
    expect(media).toEqual(["gnani"]);
    expect(factories.map((factory) => typeof factory)).toEqual(["function", "function"]);
  });
});
