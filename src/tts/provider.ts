import type { PluginCapabilityCatalogHostContext, SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { object, requireKey, resolveKey, string, type JsonObject } from "../http.js";
import { normalizeTts, timbreModel } from "./models.js";
import { synthesizeRest } from "./rest.js";
import { synthesizeSse } from "./sse.js";
import { connectTimbre } from "./websocket.js";
import { DEFAULT_TIMBRE, TIMBRE_MODELS, VOICES } from "./voices.js";

type Request = Parameters<SpeechProviderPlugin["synthesize"]>[0];

export function speechProvider(context: PluginCapabilityCatalogHostContext): SpeechProviderPlugin {
  async function apiKey(req: Pick<Request, "cfg" | "providerConfig">) {
    const key = string(req.providerConfig.apiKey);
    if (key) return key;
    const env = resolveKey();
    if (env) return env;
    return requireKey((await context.resolveApiKeyForProvider({ provider: "gnani", cfg: req.cfg })).apiKey);
  }

  function settings(req: Omit<Request, "target">): JsonObject {
    return { ...req.providerConfig, ...req.providerOverrides };
  }

  const isConfigured: SpeechProviderPlugin["isConfigured"] = ({ cfg, providerConfig }) =>
    Boolean(resolveKey(providerConfig.apiKey) || cfg && context.isProviderApiKeyConfigured({ provider: "gnani", cfg }));

  return {
    id: "gnani",
    label: "Gnani Timbre",
    defaultModel: DEFAULT_TIMBRE,
    defaultTimeoutMs: 60_000,
    models: TIMBRE_MODELS,
    voices: VOICES[DEFAULT_TIMBRE].map(({ id }) => id),
    isConfigured,
    async isConfiguredAsync({ cfg, providerConfig }) {
      return Boolean(resolveKey(providerConfig.apiKey) || cfg && await context.isProviderApiKeyConfiguredAsync({ provider: "gnani", cfg }));
    },
    resolveConfig: ({ rawConfig }) => {
      const providers = rawConfig.providers;
      const nested = providers && typeof providers === "object" && !Array.isArray(providers)
        ? (providers as JsonObject).gnani : undefined;
      const config = nested ?? rawConfig.gnani;
      return config === undefined ? {} : object(config, "Gnani speech provider configuration");
    },
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => ({ ...baseTtsConfig, ...talkProviderConfig }),
    async listVoices({ providerConfig }) {
      return VOICES[timbreModel(providerConfig?.modelId ?? providerConfig?.model)];
    },
    async synthesize(req) {
      const { body, format } = normalizeTts(req.text, settings(req), req.target);
      const audioBuffer = await synthesizeRest(body, {
        apiKey: await apiKey(req), timeoutMs: req.timeoutMs, guard: context.fetchWithSsrFGuard,
      });
      return { ...format, audioBuffer };
    },
    async streamSynthesize(req) {
      const config = settings(req);
      const mode = config.streamTransport ?? "sse";
      if (mode !== "sse" && mode !== "websocket") throw new Error("Gnani streamTransport must be sse or websocket");
      const { body, format } = normalizeTts(req.text, config, req.target);
      const key = await apiKey(req);
      if (mode === "sse") return { ...format, ...await synthesizeSse(body, {
        apiKey: key, timeoutMs: req.timeoutMs, guard: context.fetchWithSsrFGuard,
      }) };
      const session = await connectTimbre({
        apiKey: key, timeoutMs: req.timeoutMs,
        agent: context.createDebugProxyWebSocketAgent(context.resolveDebugProxySettings()),
      });
      try {
        return { ...format, audioStream: session.synthesize(body), release: async () => session.close() };
      } catch (error) {
        session.close();
        throw error;
      }
    },
    async synthesizeTelephony(req) {
      const { body, sampleRate } = normalizeTts(req.text, settings(req), "telephony");
      const audioBuffer = await synthesizeRest(body, {
        apiKey: await apiKey(req), timeoutMs: req.timeoutMs, guard: context.fetchWithSsrFGuard,
      });
      return { audioBuffer, sampleRate, outputFormat: "pcm" };
    },
  };
}
