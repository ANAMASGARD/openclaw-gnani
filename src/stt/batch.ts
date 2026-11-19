import type { JsonObject } from "../types.js";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { audioFile } from "../audio/formats.js";
import { GnaniHttpError, jsonBody, object, readJson, request, requireKey, string } from "../http.js";
import { normalizeStt } from "./models.js";

const JOBS = "/stt/v3/batch/jobs";
const TERMINAL = new Set(["COMPLETED", "PARTIAL_FAILURE", "FAILED", "START_FAILED", "CANCELLED"]);
const STATES = new Set(["CREATED", "STARTING", "QUEUED", "IN_PROGRESS", "CANCELLING", ...TERMINAL]);
const STARTED = new Set(["STARTING", "QUEUED", "IN_PROGRESS", "COMPLETED", "PARTIAL_FAILURE", "FAILED", "START_FAILED"]);

export type BatchClientOptions = { apiKey?: string; signal?: AbortSignal; timeoutMs?: number; fetchFn?: typeof fetch };
export type BatchFile = { name: string; data: Blob };
export type BatchSource =
  | { kind: "upload"; files: readonly BatchFile[] }
  | { kind: "cloud"; paths: readonly string[]; provider?: string }
  | { kind: "presigned"; filenames: readonly string[] };
export type BatchJob = JsonObject & { job_id: string; status: string };
export type BatchFileResult = JsonObject & { file_id: string; status: string; transcript_url?: string | null };
export type BatchTranscript = JsonObject & { model: string; full_transcript: string; segments: JsonObject[] };
export type BatchPage<T> = { data: T[]; nextCursor: string | null };

function safeName(name: string): string {
  const value = basename(name);
  if (!value || value.length > 255 || /[\x00-\x1f\x7f"\\]/.test(value)) throw new Error("Invalid batch filename");
  return value;
}

function storageUrl(input: string): URL {
  const url = URL.parse(input);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port
    || !/(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i.test(url.hostname)) {
    throw new Error("Gnani returned an unsupported storage URL");
  }
  return url;
}

function job(raw: JsonObject): BatchJob {
  if (!string(raw.job_id) || !STATES.has(String(raw.status))) throw new Error("Gnani returned an invalid Batch job");
  return { ...raw, job_id: String(raw.job_id), status: String(raw.status) };
}

function page<T>(raw: JsonObject, convert: (value: JsonObject) => T): BatchPage<T> {
  if (!Array.isArray(raw.data)) throw new Error("Gnani returned an invalid Batch page");
  const cursor = object(raw.pagination, "Batch pagination").next_cursor;
  if (cursor !== null && !string(cursor)) throw new Error("Gnani returned an invalid Batch cursor");
  return {
    data: raw.data.map((value: unknown) => convert(object(value, "Batch result"))),
    nextCursor: typeof cursor === "string" ? cursor : null,
  };
}

export class AmbiguousBatchMutationError extends Error {
  constructor(readonly operation: "create" | "start" | "cancel", readonly jobId?: string) {
    super(`Gnani Batch ${operation} may have succeeded upstream. ${jobId ? "Check the job status before retrying." : "Review recent jobs before creating another."}`);
    this.name = "AmbiguousBatchMutationError";
  }
}

function mayHaveCommitted(error: unknown): boolean {
  return !(error instanceof GnaniHttpError) || error.status >= 500;
}

function multipart(config: JsonObject, source: Extract<BatchSource, { kind: "upload" }>, callbackUrl?: string) {
  if (!source.files.length || source.files.length > 100) throw new Error("Batch requires 1–100 direct files");
  const boundary = `gnani-${randomUUID()}`;
  const chunks: BlobPart[] = [
    `--${boundary}\r\nContent-Disposition: form-data; name="config"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(config)}\r\n`,
  ];
  if (callbackUrl) chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="callback_url"\r\n\r\n${callbackUrl}\r\n`);
  let bytes = 0;
  for (const file of source.files) {
    const name = safeName(file.name);
    const format = /\.zip$/i.test(name) ? { name, mime: "application/zip" } : audioFile(name, file.data.type);
    const fileLimit = format.mime === "application/zip" ? 50_000_000 : 10_000_000;
    bytes += file.data.size;
    if (!file.data.size || file.data.size > fileLimit || bytes > 100_000_000) {
      throw new Error("Batch direct upload exceeds its file or total size limit. Use presigned upload.");
    }
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${format.name}"\r\nContent-Type: ${format.mime}\r\n\r\n`, file.data, "\r\n");
  }
  chunks.push(`--${boundary}--\r\n`);
  return { method: "POST", body: new Blob(chunks), headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } };
}

export function createBatchClient(transport: BatchClientOptions = {}) {
  async function securedJson(path: string, init: RequestInit = {}, retries = 0, signal = transport.signal) {
    const { response, release } = await request(path, init, { ...transport, signal }, retries);
    try {
      return await readJson(response);
    } finally {
      await release();
    }
  }

  function jobPath(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid Batch job ID");
    return `${JOBS}/${id}`;
  }

  async function status(id: string, signal?: AbortSignal): Promise<BatchJob> {
    return job(await securedJson(jobPath(id), {}, 2, signal));
  }

  async function mutate(id: string, operation: "start" | "cancel", body: JsonObject) {
    const path = `${jobPath(id)}/${operation}`;
    requireKey(transport.apiKey);
    transport.signal?.throwIfAborted();
    try {
      return job(await securedJson(path, jsonBody(body)));
    } catch (error) {
      if (!mayHaveCommitted(error)) throw error;
      if (!transport.signal?.aborted) {
        const existing = await status(id).catch(() => undefined);
        if (existing && (operation === "start" ? STARTED.has(existing.status) : ["CANCELLING", "CANCELLED"].includes(existing.status))) {
          return existing;
        }
      }
      throw new AmbiguousBatchMutationError(operation, id);
    }
  }

  function query(options: { limit?: number; cursor?: string; status?: string }) {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
      throw new Error("Batch page size must be 1–100");
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
    return params.size ? `?${params}` : "";
  }

  async function storage(url: string, init: RequestInit) {
    const deadline = AbortSignal.timeout(transport.timeoutMs ?? 60_000);
    const signal = transport.signal ? AbortSignal.any([transport.signal, deadline]) : deadline;
    let response: Response;
    try {
      response = await (transport.fetchFn ?? fetch)(storageUrl(url).href, { ...init, signal, redirect: "error" });
    } catch {
      signal.throwIfAborted();
      throw new Error("Gnani Batch storage request failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gnani Batch storage returned HTTP ${response.status}. Refresh the signed URL if it expired.`);
    }
    return response;
  }

  return {
    async create(settings: JsonObject, source: BatchSource, callbackUrl?: string) {
      requireKey(transport.apiKey);
      const config = normalizeStt(settings, "batch");
      let callback: string | undefined;
      if (callbackUrl) {
        const parsed = URL.parse(callbackUrl);
        if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Batch callback must be an HTTPS URL");
        callback = parsed.href;
      }
      let path = JOBS;
      let init: RequestInit;
      if (source.kind === "upload") {
        init = multipart(config, source, callback);
      } else if (source.kind === "cloud") {
        if (!source.paths.length || !source.paths.every((value) => /^(https|s3|gs|az):\/\//.test(value))) {
          throw new Error("Batch cloud sources must be public HTTPS URLs or storage paths");
        }
        init = jsonBody({ config, callback_url: callback, source: { type: "cloud_storage", provider: source.provider, paths: source.paths, auth: { mode: "public" } } });
      } else {
        if (!source.filenames.length || source.filenames.length > 100 || new Set(source.filenames).size !== source.filenames.length) {
          throw new Error("Batch presigned upload requires 1–100 distinct filenames");
        }
        path = "/stt/v3/batch/v2/jobs";
        init = jsonBody({ config, callback_url: callback, source: { type: "direct_upload_url",
          files: source.filenames.map((filename) => ({ filename: safeName(filename) })) } });
      }
      transport.signal?.throwIfAborted();
      try {
        const result = await securedJson(path, init);
        const created = job(result);
        const uploads = Array.isArray(result.uploads) ? result.uploads.map((value: unknown) => {
          const entry = object(value, "Batch upload");
          if (!string(entry.url)) throw new Error("Gnani returned an invalid presigned upload");
          return { ...entry, url: String(entry.url) };
        }) : [];
        return { job: created, uploads };
      } catch (error) {
        if (!mayHaveCommitted(error)) throw error;
        throw new AmbiguousBatchMutationError("create");
      }
    },
    async upload(url: string, file: Blob) {
      if (!file.size || file.size > 5 * 1024 ** 3) throw new Error("Batch presigned files must be nonempty and at most 5 GiB");
      const response = await storage(url, { method: "PUT", body: file });
      await response.body?.cancel();
    },
    start: (id: string) => mutate(id, "start", {}),
    cancel: (id: string, reason?: string) => mutate(id, "cancel", { reason }),
    status,
    async list(options: { limit?: number; cursor?: string; status?: string } = {}) {
      return page(await securedJson(JOBS + query(options), {}, 2), job);
    },
    async results(id: string, options: { limit?: number; cursor?: string; status?: string } = {}) {
      return page<BatchFileResult>(await securedJson(`${jobPath(id)}/files${query(options)}`, {}, 2), (value) => {
        if (!string(value.file_id) || !string(value.status)) throw new Error("Gnani returned an invalid Batch file");
        return { ...value, file_id: String(value.file_id), status: String(value.status),
          transcript_url: string(value.transcript_url) ?? null };
      });
    },
    async transcript(url: string): Promise<BatchTranscript> {
      const result = await readJson(await storage(url, {}));
      if (!string(result.model) || typeof result.full_transcript !== "string" || !Array.isArray(result.segments)) {
        throw new Error("Gnani returned an invalid Batch transcript");
      }
      return { ...result, model: String(result.model), full_transcript: result.full_transcript,
        segments: result.segments.map((segment: unknown) => object(segment, "Batch segment")) };
    },
    async wait(id: string, options: { timeoutMs?: number; pollMs?: number } = {}) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15 * 60_000);
      const signal = transport.signal ? AbortSignal.any([transport.signal, timeout]) : timeout;
      let interval = Math.max(10_000, options.pollMs ?? 10_000);
      for (;;) {
        const current = await status(id, signal);
        if (TERMINAL.has(current.status)) return current;
        if (current.status === "CREATED") throw new Error("Start the Gnani Batch job before waiting for results.");
        await delay(interval, undefined, { signal });
        interval = Math.min(60_000, Math.ceil(interval * 1.5));
      }
    },
  };
}
