/**
 * Stage 1 of the content-policy guardrail: a local, deterministic keyword score.
 *
 * Score = sum of the weights of the DISTINCT lexicon terms found in the request
 * text (a term counts once however often it appears). The score is then placed
 * in a band by `classifyKeywordBand()`:
 *
 *   score <  lowThreshold                 -> "below"  (clean, moderator never called)
 *   lowThreshold <= score < highThreshold -> "middle" (moderator decides)
 *   score >= highThreshold                -> "above"  (adult, moderator never called)
 *
 * Weights: 5 = unambiguous sexual act / porn term, 3 = strong signal (nudity,
 * sex positions, fetish), 1 = weak signal that is common in ordinary text too
 * ("sexy", "penetration" as in pen-testing). Weak terms alone should land in the
 * middle band at most, so the moderator settles them.
 *
 * Latin-script terms match on word boundaries; a trailing `*` makes the term a
 * prefix (`masturbat*` matches masturbate / masturbation). CJK terms match as
 * substrings because those scripts have no word separators.
 *
 * Regexes are plain literal alternations with no nested quantifiers (ReDoS-safe).
 */

export interface KeywordTerm {
  term: string;
  weight: number;
}

export const CONTENT_POLICY_LEXICON: readonly KeywordTerm[] = [
  // ── weight 5: explicit acts / porn ───────────────────────────────────────
  ...[
    "porn",
    "porno",
    "pornographic",
    "pornography",
    "hardcore sex",
    "explicit sex",
    "explicit sexual",
    "sexual intercourse",
    "vaginal sex",
    "anal sex",
    "oral sex",
    "blowjob",
    "handjob",
    "titjob",
    "footjob",
    "cumshot",
    "creampie",
    "deepthroat",
    "gangbang",
    "bukkake",
    "cum in mouth",
    "cum on face",
    "facial cumshot",
    "squirting",
    // pt / es
    "pornô",
    "sexo explícito",
    "cena sexual explícita",
    "escena sexual explícita",
    "boquete",
    "felação",
    "mamada",
    // zh (simplified + traditional)
    "色情",
    "性交",
    "口交",
    "肛交",
    "乳交",
    "手交",
    "足交",
    "内射",
    "內射",
    "颜射",
    "顏射",
    "射精",
    "潮吹",
    "轮奸",
    "輪奸",
    "群交",
    "深喉",
    "口爆",
    "吞精",
    "成人影片",
    "黄片",
    "黃片",
    "做爱",
    "做愛",
    // ja
    "セックス",
    "フェラ",
    "中出し",
  ].map((term) => ({ term, weight: 5 })),

  // ── weight 3: strong signal ──────────────────────────────────────────────
  ...[
    "nsfw",
    "xxx",
    "nude",
    "nudes",
    "naked",
    "nudity",
    "erotic",
    "erotica",
    "orgasm*",
    "masturbat*",
    "dildo",
    "doggy style",
    "doggystyle",
    "prone bone",
    "missionary position",
    "reverse cowgirl",
    "cowgirl position",
    "threesome",
    "orgy",
    "bdsm",
    "fetish",
    "sex scene",
    "sex video",
    "sex toy",
    "sex toys",
    "adult content",
    "adult video",
    "nua",
    "pelada",
    "desnuda",
    "desnudo",
    "transando",
    "sexo",
    "裸体",
    "裸體",
    "自慰",
    "后入",
    "後入",
    "女上位",
    "传教士体位",
    "傳教士體位",
    "成人色情",
    "调教",
    "調教",
    "乱交",
    "亂交",
    "3p",
  ].map((term) => ({ term, weight: 3 })),

  // ── weight 1: weak signal (common in ordinary text) ──────────────────────
  ...[
    "sexy",
    "sexual",
    "lingerie",
    "seductive",
    "busty",
    "boobs",
    "penetrat*",
    "intimate",
    "vibrator",
    "性感",
    "巨乳",
    "高潮",
    "內衣",
    "内衣",
  ].map((term) => ({ term, weight: 1 })),
];

const CJK_OR_KANA = /[぀-ヿ㐀-鿿豈-﫿가-힯]/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledTerm {
  term: string;
  weight: number;
  test: (text: string) => boolean;
}

function compileTerm({ term, weight }: KeywordTerm): CompiledTerm {
  const normalized = term.normalize("NFKC").toLowerCase();
  if (CJK_OR_KANA.test(normalized)) {
    return { term, weight, test: (text) => text.includes(normalized) };
  }
  const isPrefix = normalized.endsWith("*");
  const body = escapeRegExp(isPrefix ? normalized.slice(0, -1) : normalized).replace(
    / /g,
    "[\\s_-]+"
  );
  const tail = isPrefix ? "" : "(?![\\p{L}\\p{N}])";
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${body}${tail}`, "u");
  return { term, weight, test: (text) => pattern.test(text) };
}

const COMPILED_LEXICON: readonly CompiledTerm[] = CONTENT_POLICY_LEXICON.map(compileTerm);

export interface KeywordScoreResult {
  score: number;
  /** Matched lexicon terms (lexicon entries, never request text), highest weight first. */
  matchedTerms: string[];
  /** The subset of `matchedTerms` that came from the learned lexicon. */
  learnedMatches: string[];
}

/** Normalized form of every built-in term, so learned duplicates are skipped. */
export const BUILT_IN_TERM_KEYS: ReadonlySet<string> = new Set(
  CONTENT_POLICY_LEXICON.map(({ term }) => term.normalize("NFKC").toLowerCase().replace(/\*$/, ""))
);

const LEARNED_COMPILE_CACHE_MAX = 5_000;
const learnedCompileCache = new Map<string, CompiledTerm>();

function compileLearned(entry: KeywordTerm): CompiledTerm {
  // Learned terms are literals: a trailing `*` is not a prefix marker here.
  const literal = entry.term.replace(/\*+$/, "");
  const key = `${literal}\u0000${entry.weight}`;
  const cached = learnedCompileCache.get(key);
  if (cached) return cached;
  if (learnedCompileCache.size >= LEARNED_COMPILE_CACHE_MAX) learnedCompileCache.clear();
  const compiled = compileTerm({ term: literal, weight: entry.weight });
  learnedCompileCache.set(key, compiled);
  return compiled;
}

/**
 * Score already-extracted request text against the built-in lexicon plus any
 * learned terms (`content_policy_terms` rows with status `active`).
 */
export function scoreContentPolicyText(
  text: string,
  learnedTerms: readonly KeywordTerm[] = []
): KeywordScoreResult {
  if (!text) return { score: 0, matchedTerms: [], learnedMatches: [] };
  const haystack = text.normalize("NFKC").toLowerCase();
  let score = 0;
  const matched: CompiledTerm[] = [];
  for (const entry of COMPILED_LEXICON) {
    if (entry.test(haystack)) {
      score += entry.weight;
      matched.push(entry);
    }
  }
  const learnedMatches: string[] = [];
  for (const learned of learnedTerms) {
    if (!learned?.term || BUILT_IN_TERM_KEYS.has(learned.term)) continue;
    const entry = compileLearned(learned);
    if (entry.test(haystack)) {
      score += entry.weight;
      matched.push(entry);
      learnedMatches.push(entry.term);
    }
  }
  matched.sort((left, right) => right.weight - left.weight);
  return { score, matchedTerms: matched.map((entry) => entry.term), learnedMatches };
}

export type KeywordBand = "below" | "middle" | "above";

export function classifyKeywordBand(
  score: number,
  lowThreshold: number,
  highThreshold: number
): KeywordBand {
  if (score >= highThreshold) return "above";
  if (score < lowThreshold) return "below";
  return "middle";
}

// ─── Request text extraction ────────────────────────────────────────────────

/** Max characters scanned. Longer text keeps its head and tail halves. */
export const CONTENT_POLICY_SCAN_LIMIT = 32_000;

function pushText(out: string[], value: unknown, depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushText(out, item, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  // Text-bearing fields across OpenAI chat, Responses, and Claude message shapes.
  // Media payloads (image_url, input_audio, base64 data) are deliberately skipped.
  if (typeof record.text === "string") out.push(record.text);
  if (record.content !== undefined) pushText(out, record.content, depth + 1);
}

/** Head + tail window, so a huge constant preamble cannot hide the variable tail. */
export function clipContentPolicyText(text: string, limit = CONTENT_POLICY_SCAN_LIMIT): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

/** Collect the user-controlled text of a chat / Responses / Claude request body. */
export function extractContentPolicyText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const body = payload as Record<string, unknown>;
  const out: string[] = [];
  pushText(out, body.system);
  pushText(out, body.instructions);
  pushText(out, body.prompt);
  if (Array.isArray(body.messages)) pushText(out, body.messages);
  if (body.input !== undefined) pushText(out, body.input);
  return clipContentPolicyText(out.join("\n"));
}
