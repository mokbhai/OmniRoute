/**
 * Self-growing lexicon, per policy: validate the terms a chat-model moderator
 * reports, load the active learned terms, and record new hits.
 *
 * A reported term is kept only when it:
 *   - normalizes to 2..48 characters and at most 4 words, with at least one letter,
 *   - contains only letters, digits, spaces, `-`, `'` (no markup or regex syntax),
 *   - appears in the scanned text (the moderator cannot invent words, and the text
 *     cannot steer it into "learning" something that is not there),
 *   - is not one of the policy's seed terms and not a stop word.
 * At most 10 terms are kept per verdict.
 */

import {
  clampTextPolicyWeight,
  getActiveTextPolicyTerms,
  normalizeTextPolicyTerm,
  recordTextPolicyTerms,
  type RecordTermsOptions,
  type RecordTermsResult,
  type TermInput,
} from "@/lib/db/textPolicyTerms";

import { termKey } from "./lexicon";
import type { DiscoveredTerm, KeywordTerm, TextPolicyDefinition } from "./types";

export const MAX_DISCOVERED_TERMS = 10;

const ALLOWED_TERM = /^[\p{L}\p{M}\p{N}' -]+$/u;
const HAS_LETTER = /\p{L}/u;

/** Never learned by any policy. Policies add their own via `stopWords`. */
export const DEFAULT_STOP_WORDS: readonly string[] = [
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
  "is",
  "it",
  "this",
  "that",
  "video",
  "photo",
  "image",
  "story",
  "scene",
  "camera",
  "room",
  "night",
  "text",
  "tag",
  "tags",
  "id",
  "json",
  "user",
  "assistant",
  "prompt",
];

/** Filter a moderator's raw `terms` array down to safe, real, new terms for `policy`. */
export function validateDiscoveredTerms(
  raw: unknown,
  scannedText: string,
  policy: Pick<TextPolicyDefinition, "seedTerms" | "stopWords">
): DiscoveredTerm[] {
  if (!Array.isArray(raw)) return [];
  const haystack = scannedText.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  const blocked = new Set<string>([
    ...DEFAULT_STOP_WORDS,
    ...(policy.stopWords ?? []).map(termKey),
    ...policy.seedTerms.map((entry) => termKey(entry.term)),
  ]);
  const out = new Map<string, number>();
  for (const item of raw) {
    if (out.size >= MAX_DISCOVERED_TERMS) break;
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const rawTerm = typeof item === "string" ? item : record?.term;
    const rawWeight = typeof item === "string" ? 1 : record?.weight;
    const term = normalizeTextPolicyTerm(rawTerm);
    if (term.length < 2) continue;
    if (!ALLOWED_TERM.test(term) || !HAS_LETTER.test(term)) continue;
    if (term.split(" ").length > 4) continue;
    if (blocked.has(term)) continue;
    if (!haystack.includes(term)) continue;
    out.set(term, Math.max(out.get(term) ?? 0, clampTextPolicyWeight(rawWeight)));
  }
  return [...out].map(([term, weight]) => ({ term, weight }));
}

// ─── Active learned terms (cached per policy) ───────────────────────────────

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { terms: KeywordTerm[]; at: number }>();

export function invalidateLearnedTermsCache(policyId?: string): void {
  if (policyId) cache.delete(policyId);
  else cache.clear();
}

export async function loadActiveLearnedTerms(policyId: string): Promise<KeywordTerm[]> {
  const hit = cache.get(policyId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.terms;
  try {
    const terms = getActiveTextPolicyTerms(policyId);
    cache.set(policyId, { terms, at: Date.now() });
    return terms;
  } catch {
    // Table missing (migration not applied yet) or DB unavailable: seed terms only.
    return hit?.terms ?? [];
  }
}

export async function recordLearnedTerms(
  policyId: string,
  terms: TermInput[],
  options: RecordTermsOptions
): Promise<RecordTermsResult> {
  const result = recordTextPolicyTerms(policyId, terms, options);
  if (result.activated.length > 0) invalidateLearnedTermsCache(policyId);
  return result;
}
