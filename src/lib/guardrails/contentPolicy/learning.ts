/**
 * Self-growing lexicon: validate the terms a chat-model moderator reports, and
 * load the active learned terms for the keyword scorer.
 *
 * A reported term is kept only when it:
 *   - normalizes to 2..48 characters and at most 4 words, with at least one letter,
 *   - contains only letters, digits, spaces, `-`, `'` (no markup or regex syntax),
 *   - appears in the scanned request text (the moderator cannot invent words or be
 *     steered by the request into "learning" text that is not there),
 *   - is not already in the built-in lexicon and not a common stop word.
 * At most 10 terms are kept per verdict.
 */

import {
  getActiveContentPolicyTerms,
  normalizeContentPolicyTerm,
  clampContentPolicyWeight,
  recordDiscoveredContentPolicyTerms,
  type DiscoveredTermInput,
  type RecordDiscoveredTermsOptions,
  type RecordDiscoveredTermsResult,
} from "@/lib/db/contentPolicyTerms";

import { BUILT_IN_TERM_KEYS, type KeywordTerm } from "./keywordScore";

export const MAX_DISCOVERED_TERMS = 10;

const ALLOWED_TERM = /^[\p{L}\p{M}\p{N}' -]+$/u;
const HAS_LETTER = /\p{L}/u;

/** Common words a moderator might echo that must never become adult signals. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "with",
  "for",
  "woman",
  "man",
  "women",
  "men",
  "girl",
  "boy",
  "bed",
  "body",
  "video",
  "photo",
  "image",
  "story",
  "scene",
  "love",
  "kiss",
  "camera",
  "room",
  "night",
  "tag",
  "tags",
  "id",
  "json",
]);

export interface DiscoveredTerm {
  term: string;
  weight: number;
}

/** Filter a moderator's raw `terms` array down to safe, real, new terms. */
export function validateDiscoveredTerms(raw: unknown, scannedText: string): DiscoveredTerm[] {
  if (!Array.isArray(raw)) return [];
  const haystack = scannedText.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  const out = new Map<string, number>();
  for (const item of raw) {
    if (out.size >= MAX_DISCOVERED_TERMS) break;
    const rawTerm = typeof item === "string" ? item : (item as { term?: unknown } | null)?.term;
    const rawWeight = typeof item === "string" ? 1 : (item as { weight?: unknown } | null)?.weight;
    const term = normalizeContentPolicyTerm(rawTerm);
    if (term.length < 2) continue;
    if (!ALLOWED_TERM.test(term) || !HAS_LETTER.test(term)) continue;
    if (term.split(" ").length > 4) continue;
    if (STOP_WORDS.has(term) || BUILT_IN_TERM_KEYS.has(term)) continue;
    if (!haystack.includes(term)) continue;
    out.set(term, Math.max(out.get(term) ?? 0, clampContentPolicyWeight(rawWeight)));
  }
  return [...out].map(([term, weight]) => ({ term, weight }));
}

// ─── Active learned terms (cached) ──────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
let cache: { terms: KeywordTerm[]; at: number } | null = null;

export function invalidateLearnedTermsCache(): void {
  cache = null;
}

export async function loadActiveLearnedTerms(): Promise<KeywordTerm[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.terms;
  try {
    const terms = getActiveContentPolicyTerms();
    cache = { terms, at: Date.now() };
    return terms;
  } catch {
    // Table missing (migration not applied yet) or DB unavailable: score with built-ins only.
    return cache?.terms ?? [];
  }
}

export async function recordLearnedTerms(
  terms: DiscoveredTermInput[],
  options: RecordDiscoveredTermsOptions
): Promise<RecordDiscoveredTermsResult> {
  const result = recordDiscoveredContentPolicyTerms(terms, options);
  if (result.activated.length > 0) invalidateLearnedTermsCache();
  return result;
}
