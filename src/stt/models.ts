import { object, string, type JsonObject } from "../http.js";

export const PRISMA_MODELS = ["prisma-v2.5", "prisma-v3.0"] as const;
export const DEFAULT_PRISMA = "prisma-v3.0";
export const LOCALES = ["bn", "en", "gu", "hi", "kn", "ml", "mr", "pa", "ta", "te"] as const;
type SttMode = "rest" | "realtime" | "batch";

export function locale(value: string): string {
  const match = LOCALES.find((item) => [item, `${item}-in`].includes(value.trim().toLowerCase()));
  if (!match) throw new Error(`Unsupported Gnani language: ${value.slice(0, 30)}`);
  return `${match}-IN`;
}

function strings(value: unknown, key: string, max: number): string[] | undefined {
  if (value === undefined) return;
  let input: unknown = value;
  if (typeof value === "string") {
    try {
      input = value.trim().startsWith("[") ? JSON.parse(value) : value.split(",");
    } catch {
      throw new Error(`Invalid ${key} list`);
    }
  }
  if (!Array.isArray(input) || !input.length || input.length > max || input.some((v) => !string(v))) {
    throw new Error(`${key} requires 1–${max} strings`);
  }
  return input.map((v: string) => v.trim());
}

function flag(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${key} must be a boolean`);
}

export function normalizeStt(raw: JsonObject, mode: SttMode): JsonObject {
  const model = raw.model ?? DEFAULT_PRISMA;
  if (model !== "prisma-v2.5" && model !== "prisma-v3.0") throw new Error("Select prisma-v2.5 or prisma-v3.0");
  const v3 = model === "prisma-v3.0";
  const languages = string(raw.language_code ?? raw.language) ?? (v3 ? "indic-auto" : "en-IN");
  const format = string(raw.format);
  const batch = mode === "batch";
  const auto = (v3 || mode === "realtime") && languages.toLowerCase() === "indic-auto"
    || (v3 && batch && languages.toLowerCase() === "auto");
  const codes = auto ? ["indic-auto"] : languages.split(",").map(locale);
  if (codes.length > (v3 ? 4 : batch ? 3 : 1) || new Set(codes).size !== codes.length) {
    throw new Error(`Invalid language list for ${model} ${mode}`);
  }
  if (format && ((batch && !v3) || !["verbatim", "transcribe", ...(v3 ? ["codemix", ...(!batch ? ["transliterate"] : [])] : [])].includes(format))) {
    throw new Error(`Unsupported format for ${model} ${mode}`);
  }

  const result: JsonObject = { model, language_code: codes.join(",") };
  if (format) result.format = format;
  const aliasTerms = v3 && raw.keyterms === undefined ? raw.bias_list : undefined;
  const terms = strings(raw.keyterms ?? aliasTerms, "keyterms", 200);
  const topic = string(raw.topic);
  const previous = string(raw.previous_text);
  const speakers = strings(raw.speaker_names, "speaker_names", 4);
  if (!v3 && (terms || topic || previous || speakers)) throw new Error("Context hints require Prisma v3.0");
  if (batch && (previous || (speakers && (topic || terms)))) throw new Error("Unsupported Batch context combination");
  if (topic && (topic.length > 1600 || (batch && topic.length < 30))) throw new Error("Invalid Prisma topic length");
  if (terms) result.keyterms = terms;
  if (topic) result.topic = topic;
  if (previous) result.previous_text = Array.from(previous).slice(-600).join("");
  if (speakers) result.speaker_names = speakers;

  const bias = v3 ? undefined : strings(raw.bias_list, "bias_list", 100);
  if (bias?.some((word) => !/^\p{L}[\p{L}\p{M}]*$/u.test(word))) throw new Error("bias_list entries must be single words");
  if (bias) result.bias_list = bias;
  if (!v3 && raw.bias_score !== undefined) {
    const score = Number(raw.bias_score);
    if (![0, 0.5, 1, 1.5, 2].includes(score)) throw new Error("Invalid bias_score");
    result.bias_score = score;
  }
  if (batch) {
    if (raw.itn_native_numerals !== undefined || raw.enable_substitution !== undefined || raw.substitution_map !== undefined) {
      throw new Error("Batch does not support REST substitution or numeral settings");
    }
    if (raw.mode !== undefined && raw.mode !== "transcribe") throw new Error("Batch mode must be transcribe");
    for (const key of ["with_diarization", "with_denoise", "is_multi_channel"]) {
      const value = flag(raw[key], key);
      if (value !== undefined) result[key] = value;
    }
    if (raw.num_speakers !== undefined) {
      const value = Number(raw.num_speakers);
      if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error("num_speakers must be 1–8");
      result.num_speakers = value;
    }
    return result;
  }
  const enable = flag(raw.enable_substitution, "enable_substitution");
  const numerals = flag(raw.itn_native_numerals, "itn_native_numerals");
  if (!v3 && numerals !== undefined) result.itn_native_numerals = numerals;
  if (enable !== undefined) result.enable_substitution = enable;
  if (raw.substitution_map !== undefined) {
    const rules: unknown = typeof raw.substitution_map === "string"
      ? JSON.parse(raw.substitution_map) : raw.substitution_map;
    if (!Array.isArray(rules) || rules.length > 10) throw new Error("substitution_map accepts at most 10 rules");
    result.substitution_map = rules.map((item: unknown) => {
      const rule = object(item, "Substitution rule");
      if (!Array.isArray(rule.patterns) || !rule.patterns.length
        || rule.patterns.some((part: unknown) => !string(part) || String(part).length > 200)
        || typeof rule.replacement !== "string") throw new Error("Invalid substitution rule");
      return { patterns: rule.patterns, replacement: rule.replacement };
    });
  }
  return result;
}

export function wireField(value: unknown): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
