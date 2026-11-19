import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { setTimeout as delay } from "node:timers/promises";

export const ORIGIN = "https://api.vachana.ai";
export const WS_ORIGIN = "wss://api.vachana.ai";
export const AUTH_HEADER = "X-API-Key-ID";
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

import type { JsonObject } from "./types.js";
export type { JsonObject } from "./types.js";
export type Guard = typeof fetchWithSsrFGuard;
export type Transport = {
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  guard?: Guard;
  dispatcherPolicy?: Parameters<Guard>[0]["dispatcherPolicy"];
};

export function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveKey(value?: unknown): string | undefined {
  return string(value) ?? string(process.env.GNANI_API_KEY);
}

export function requireKey(value?: unknown): string {
  const apiKey = resolveKey(value);
  if (!apiKey) throw new Error("Gnani credentials missing. Set GNANI_API_KEY.");
  return apiKey;
}

export function redact(message: string, apiKey?: string): string {
  const safe = apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
  return safe.replace(/https?:\/\/[^\s"'<>]+\?[^\s"'<>]+/gi, "[redacted URL]").slice(0, 500);
}

export class GnaniHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    detail?: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Gnani HTTP ${status}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "GnaniHttpError";
  }
}

export async function readBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > limit) throw new Error(`Gnani response exceeded ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readJson(response: Response, limit = 8 * 1024 * 1024): Promise<JsonObject> {
  const bytes = await readBytes(response, limit);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Gnani returned malformed JSON");
  }
  return object(value, "Gnani response");
}

async function httpError(response: Response, apiKey?: string): Promise<GnaniHttpError> {
  const body = await readJson(response, 16_384).catch((): JsonObject => ({}));
  const nested = typeof body.detail === "object" && body.detail !== null && !Array.isArray(body.detail)
    ? object(body.detail, "detail")
    : typeof body.error === "object" && body.error !== null && !Array.isArray(body.error)
      ? object(body.error, "error")
      : {};
  const fields = Array.isArray(body.detail) ? body.detail.slice(0, 3).map((entry: unknown) => {
    if (entry && typeof entry === "object" && "msg" in entry) return string(entry.msg);
    return undefined;
  }).filter(Boolean).join("; ") : undefined;
  const code = string(nested.error_code) ?? string(nested.type) ?? string(body.error_code) ?? string(body.code);
  const detail = string(nested.message) ?? string(body.message) ?? string(body.detail) ?? fields;
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter ? (/^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : Math.max(0, Date.parse(retryAfter) - Date.now())) : undefined;
  return new GnaniHttpError(response.status, code && redact(code, apiKey), detail && redact(detail, apiKey), retryAfterMs);
}

type ResponseLease = { response: Response; release: () => Promise<void> };

export async function request(
  path: string,
  init: RequestInit,
  transport: Transport,
  retries = 0,
): Promise<ResponseLease> {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error("Invalid Gnani API origin");
  const apiKey = requireKey(transport.apiKey);
  const headers = new Headers(init.headers);
  headers.set(AUTH_HEADER, apiKey);
  const timeout = AbortSignal.timeout(transport.timeoutMs ?? 60_000);
  const signal = transport.signal ? AbortSignal.any([transport.signal, timeout]) : timeout;
  const fetchFn = transport.fetchFn ?? fetch;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let error: unknown;
    let lease: ResponseLease | undefined;
    try {
      const initWithSignal = { ...init, headers, signal, redirect: "error" as const };
      lease = transport.guard
        ? await transport.guard({
          url: url.href,
          init: initWithSignal,
          fetchImpl: fetchFn,
          signal,
          beforeRequest: () => signal.throwIfAborted(),
          maxRedirects: 0,
          requireHttps: true,
          mode: transport.dispatcherPolicy?.mode === "explicit-proxy"
            ? "trusted_explicit_proxy" : "trusted_env_proxy",
          dispatcherPolicy: transport.dispatcherPolicy,
          capture: false,
          auditContext: "Gnani speech",
        })
        : { response: await fetchFn(url.href, initWithSignal), release: async () => {} };
      if (lease.response.ok) return lease;
      error = await httpError(lease.response, apiKey);
    } catch (caught) {
      error = caught;
    }
    await lease?.release();
    signal.throwIfAborted();
    const transient = error instanceof GnaniHttpError ? RETRYABLE.has(error.status) : error instanceof TypeError;
    const retryAfter = error instanceof GnaniHttpError ? error.retryAfterMs : undefined;
    if (!transient || attempt >= retries || (retryAfter ?? 0) > 10_000) {
      if (error instanceof GnaniHttpError) throw error;
      throw new Error(redact(error instanceof Error ? error.message : "Gnani request failed", apiKey));
    }
    await delay(Math.max(500 * 2 ** attempt, retryAfter ?? 0), undefined, { signal });
  }
}

export function jsonBody(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}
