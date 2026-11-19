import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { MediaUnderstandingProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { audioFile, validateShortAudio } from "../audio/formats.js";
import { AUTH_HEADER, readJson, request, resolveKey, type JsonObject, type Transport } from "../http.js";
import { DEFAULT_PRISMA, normalizeStt, wireField } from "./models.js";

export async function transcribeAudio(input: {
  buffer: Buffer; fileName: string; mime?: string; settings: JsonObject; headers?: HeadersInit;
}, transport: Transport): Promise<{ text: string; model: string }> {
  const config = normalizeStt(input.settings, "rest");
  const file = audioFile(input.fileName, input.mime);
  const deadline = AbortSignal.timeout(transport.timeoutMs ?? 60_000);
  const signal = transport.signal ? AbortSignal.any([transport.signal, deadline]) : deadline;
  await validateShortAudio(input.buffer, file.name, signal);
  const form = new FormData();
  for (const [key, value] of Object.entries(config)) form.set(key, wireField(value));
  form.set("audio_file", new Blob([Uint8Array.from(input.buffer)], { type: file.mime }), file.name);
  const headers = new Headers(input.headers);
  for (const name of ["Authorization", "Cookie", "Content-Type", "Content-Length", "Host"]) headers.delete(name);
  const { response, release } = await request("/stt/v3", { method: "POST", body: form, headers }, { ...transport, signal }, 2);
  try {
    const result = await readJson(response);
    if (result.success !== true || typeof result.transcript !== "string") {
      throw new Error("Gnani returned an invalid transcription result");
    }
    if (result.truncated === true) throw new Error("Gnani returned an incomplete transcript. Retry with a shorter recording.");
    if (result.model !== undefined && result.model !== config.model) throw new Error("Gnani returned a different Prisma model than requested");
    return { text: result.transcript.trim(), model: String(config.model) };
  } finally {
    await release();
  }
}

type HostRequest = Parameters<NonNullable<MediaUnderstandingProviderPlugin["transcribeAudio"]>>[0];
type RequestSettings = NonNullable<HostRequest["request"]>;
function tlsOptions(tls?: RequestSettings["tls"]) {
  if (!tls) return;
  const { ca, cert, key, passphrase, serverName, insecureSkipVerify } = tls;
  return { ca, cert, key, passphrase, servername: serverName,
    rejectUnauthorized: insecureSkipVerify === undefined ? undefined : !insecureSkipVerify };
}

function dispatcher(settings?: RequestSettings): Transport["dispatcherPolicy"] {
  if (!settings) return;
  const connect = tlsOptions(settings.tls);
  const proxy = settings.proxy;
  if (proxy?.mode === "env-proxy") return { mode: "env-proxy", connect, proxyTls: tlsOptions(proxy.tls) };
  if (proxy?.mode === "explicit-proxy") return { mode: "explicit-proxy", proxyUrl: proxy.url, proxyTls: tlsOptions(proxy.tls) };
  if (connect) return { mode: "direct", connect };
}

export const mediaProvider: MediaUnderstandingProviderPlugin = {
  id: "gnani",
  capabilities: ["audio"],
  defaultModels: { audio: DEFAULT_PRISMA },
  resolveAuth: () => {
    const apiKey = resolveKey();
    return apiKey ? { kind: "api-key", mode: "api-key", source: "GNANI_API_KEY", apiKey } : null;
  },
  async transcribeAudio(req) {
    const { query, model, language, prompt } = req;
    const override = req.request?.auth;
    const explicitKey = override?.mode === "header" && override.headerName.toLowerCase() === AUTH_HEADER.toLowerCase()
      ? `${override.prefix ?? ""}${override.value}` : undefined;
    const chosenModel = model?.trim() || DEFAULT_PRISMA;
    return transcribeAudio({
      buffer: req.buffer,
      fileName: req.fileName,
      mime: req.mime,
      headers: req.headers,
      settings: {
        ...query,
        model: chosenModel,
        language_code: language ?? query?.language_code,
        topic: query?.topic ?? (chosenModel === DEFAULT_PRISMA ? prompt : undefined),
      },
    }, {
      apiKey: explicitKey ?? (req.auth?.kind === "api-key" ? req.auth.apiKey : req.apiKey),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      fetchFn: req.fetchFn,
      guard: fetchWithSsrFGuard,
      dispatcherPolicy: dispatcher(req.request),
    });
  },
};
