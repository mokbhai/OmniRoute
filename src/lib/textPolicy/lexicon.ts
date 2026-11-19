/**
 * Stage 1: deterministic keyword score, shared by every text policy.
 *
 * Score = sum of the weights of the DISTINCT terms found (a term counts once however
 * often it appears). `classifyKeywordBand()` then places it:
 *
 *   score <  lowThreshold                 -> "below"  (no violation, moderator not called)
 *   lowThreshold <= score < highThreshold -> "middle" (moderator decides)
 *   score >= highThreshold                -> "above"  (violation, moderator not called)
 *
 * Latin-script terms match on word boundaries (spaces in a term also match `_`/`-`);
 * a trailing `*` makes a seed term a prefix (`masturbat*`). CJK / kana terms match as
 * substrings because those scripts have no word separators. Learned terms are always
 * literals. Patterns are escaped literals with no nested quantifiers (ReDoS-safe).
 */

import type { KeywordBand, KeywordTerm } from "./types";

const CJK_OR_KANA = /[぀-ヿ㐀-鿿豈-﫿가-힯]/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Canonical comparison key for a term: NFKC, lowercase, single spaces, no trailing `*`. */
export function termKey(term: string): string {
  return term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/\*+$/, "");
}

interface CompiledTerm {
  term: string;
  key: string;
  weight: number;
  test: (haystack: string) => boolean;
}

function compileTerm(entry: KeywordTerm, allowPrefix: boolean): CompiledTerm {
  const normalized = entry.term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const key = termKey(normalized);
  if (CJK_OR_KANA.test(key)) {
    return { term: entry.term, key, weight: entry.weight, test: (text) => text.includes(key) };
  }
  const isPrefix = allowPrefix && normalized.endsWith("*");
  const body = escapeRegExp(key).replace(/ /g, "[\\s_-]+");
  const tail = isPrefix ? "" : "(?![\\p{L}\\p{N}])";
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${body}${tail}`, "u");
  return { term: entry.term, key, weight: entry.weight, test: (text) => pattern.test(text) };
}

const COMPILE_CACHE_MAX = 20_000;
const compileCache = new Map<string, CompiledTerm>();

function compiled(entry: KeywordTerm, allowPrefix: boolean): CompiledTerm {
  const cacheKey = `${allowPrefix ? "s" : "l"}\u0000${entry.weight}\u0000${entry.term}`;
  let hit = compileCache.get(cacheKey);
  if (!hit) {
    if (compileCache.size >= COMPILE_CACHE_MAX) compileCache.clear();
    hit = compileTerm(entry, allowPrefix);
    compileCache.set(cacheKey, hit);
  }
  return hit;
}

export interface KeywordScoreResult {
  score: number;
  /** Matched terms (lexicon entries, never request text), highest weight first. */
  matchedTerms: string[];
  /** The subset of `matchedTerms` that came from `learnedTerms`. */
  learnedMatches: string[];
}

/**
 * Score text against a policy's seed terms plus its active learned terms. A learned
 * term that duplicates a seed term is ignored, so nothing counts twice.
 */
export function scoreText(
  text: string,
  seedTerms: readonly KeywordTerm[],
  learnedTerms: readonly KeywordTerm[] = []
): KeywordScoreResult {
  if (!text) return { score: 0, matchedTerms: [], learnedMatches: [] };
  const haystack = text.normalize("NFKC").toLowerCase();
  const seen = new Set<string>();
  const matched: CompiledTerm[] = [];
  const learnedMatches: string[] = [];
  let score = 0;
  for (const entry of seedTerms) {
    const term = compiled(entry, true);
    if (seen.has(term.key)) continue;
    seen.add(term.key);
    if (term.test(haystack)) {
      score += term.weight;
      matched.push(term);
    }
  }
  for (const entry of learnedTerms) {
    if (!entry?.term) continue;
    const term = compiled(entry, false);
    if (seen.has(term.key)) continue;
    seen.add(term.key);
    if (term.test(haystack)) {
      score += term.weight;
      matched.push(term);
      learnedMatches.push(term.key);
    }
  }
  matched.sort((left, right) => right.weight - left.weight);
  return { score, matchedTerms: matched.map((entry) => entry.term), learnedMatches };
}

export function classifyKeywordBand(
  score: number,
  lowThreshold: number,
  highThreshold: number
): KeywordBand {
  if (score >= highThreshold) return "above";
  if (score < lowThreshold) return "below";
  return "middle";
}
