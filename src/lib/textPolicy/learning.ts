/**
 * Self-growing lexicon, per policy: validate the terms a chat-model moderator
 * reports, load the active learned terms, record new hits, and translate accepted terms.
 *
 * Every language is learned the same way. A reported term is kept only when it:
 *   - normalizes to 2..48 characters and at most 4 words, with at least one letter,
 *   - contains only letters, digits, spaces, `-`, `'` (no markup or regex syntax),
 *   - appears in the scanned text (the moderator cannot invent words, and the text
 *     cannot steer it into "learning" something that is not there),
 *   - is not one of the policy's seed terms and not a stop word,
 *   - has a category whose weight is above 0 (`categories.ts`). The category sets the
 *     weight; the weight the moderator suggests is ignored. Words in a weight-0 category
 *     (everyday, identity, minors, other harms) or with no known category are reported as
 *     `ignoredTerms` and never stored.
 * At most 10 terms are kept per verdict.
 *
 * Translations: when a term is accepted (auto-activated, or approved by an operator), the
 * moderator is asked ONCE for its equivalents in `translateLanguages`. They are stored as
 * pending terms with 0 hits and need the same evidence as any other word: hits from fresh
 * flagged requests in auto mode, or an operator's approval in review mode.
 */

import {
  addTextPolicyTranslations,
  claimTextPolicyTermTranslation,
  getActiveTextPolicyTerms,
  normalizeTextPolicyTerm,
  recordTextPolicyTerms,
  type RecordTermsOptions,
  type RecordTermsResult,
  type TermInput,
} from "@/lib/db/textPolicyTerms";

import { categoryWeight, termCategoriesFor } from "./categories";
import { termKey } from "./lexicon";
import { defaultTranslate, type TranslateFn } from "./moderator";
import type {
  DiscoveredTerm,
  IgnoredTerm,
  KeywordTerm,
  TextPolicyConfig,
  TextPolicyDefinition,
} from "./types";

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

const LANGUAGE_CODE = /^[a-z]{2,3}$/;
const MEANING_MAX_LENGTH = 60;
/** Translations kept per requested language. */
export const MAX_TRANSLATIONS_PER_LANGUAGE = 2;

/** "pt-BR" / "zh_Hans" / "EN" → "pt" / "zh" / "en"; null when not a language code. */
export function normalizeLanguageCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_CODE.test(code) ? code : null;
}

/** A short single-line English gloss, or null. */
export function normalizeMeaning(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const meaning = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!meaning) return null;
  return meaning.length > MEANING_MAX_LENGTH
    ? `${meaning.slice(0, MEANING_MAX_LENGTH - 1)}…`
    : meaning;
}

type PolicyVocabulary = Pick<TextPolicyDefinition, "seedTerms" | "stopWords" | "termCategories">;

function blockedTerms(policy: PolicyVocabulary): Set<string> {
  return new Set<string>([
    ...DEFAULT_STOP_WORDS,
    ...(policy.stopWords ?? []).map(termKey),
    ...policy.seedTerms.map((entry) => termKey(entry.term)),
  ]);
}

/** Shape rules shared by reported terms and translations. Returns the normalized term or "". */
function acceptableTerm(raw: unknown, blocked: Set<string>): string {
  const term = normalizeTextPolicyTerm(raw);
  if (term.length < 2) return "";
  if (!ALLOWED_TERM.test(term) || !HAS_LETTER.test(term)) return "";
  if (term.split(" ").length > 4) return "";
  if (blocked.has(term)) return "";
  return term;
}

/**
 * Split a moderator's raw `terms` array into terms to learn (weight from their category)
 * and real words it reported in a never-learned category.
 */
export function classifyDiscoveredTerms(
  raw: unknown,
  scannedText: string,
  policy: PolicyVocabulary
): { terms: DiscoveredTerm[]; ignored: IgnoredTerm[] } {
  if (!Array.isArray(raw)) return { terms: [], ignored: [] };
  const haystack = scannedText.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  const blocked = blockedTerms(policy);
  const categories = termCategoriesFor(policy);
  const out = new Map<string, DiscoveredTerm>();
  const ignored = new Map<string, IgnoredTerm>();
  for (const item of raw) {
    if (out.size >= MAX_DISCOVERED_TERMS) break;
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const term = acceptableTerm(typeof item === "string" ? item : record?.term, blocked);
    if (!term || !haystack.includes(term)) continue;
    const category =
      typeof record?.category === "string" ? record.category.trim().toLowerCase() : "";
    const weight = categoryWeight(categories, category);
    if (weight <= 0) {
      if (ignored.size < MAX_DISCOVERED_TERMS && !out.has(term)) {
        ignored.set(term, { term, category: category || "unclassified" });
      }
      continue;
    }
    const previous = out.get(term);
    if (previous && previous.weight >= weight) continue;
    ignored.delete(term);
    const entry: DiscoveredTerm = { term, weight, category };
    const language = normalizeLanguageCode(record?.lang ?? record?.language);
    if (language) entry.language = language;
    const meaning = normalizeMeaning(record?.meaning);
    if (meaning) entry.meaning = meaning;
    out.set(term, entry);
  }
  return { terms: [...out.values()], ignored: [...ignored.values()] };
}

/** Filter a moderator's raw `terms` array down to safe, real, learnable terms for `policy`. */
export function validateDiscoveredTerms(
  raw: unknown,
  scannedText: string,
  policy: PolicyVocabulary
): DiscoveredTerm[] {
  return classifyDiscoveredTerms(raw, scannedText, policy).terms;
}

/** Filter a translator's raw `translations` array to safe terms in the requested languages. */
export function validateTranslations(
  raw: unknown,
  policy: PolicyVocabulary,
  options: { sourceTerm: string; languages: string[] }
): Array<{ term: string; language: string; meaning: string | null }> {
  if (!Array.isArray(raw)) return [];
  const blocked = blockedTerms(policy);
  blocked.add(normalizeTextPolicyTerm(options.sourceTerm));
  const wanted = new Set(options.languages);
  const perLanguage = new Map<string, number>();
  const out = new Map<string, { term: string; language: string; meaning: string | null }>();
  for (const item of raw) {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!record) continue;
    const language = normalizeLanguageCode(record.lang ?? record.language);
    if (!language || !wanted.has(language)) continue;
    if ((perLanguage.get(language) ?? 0) >= MAX_TRANSLATIONS_PER_LANGUAGE) continue;
    const term = acceptableTerm(record.term, blocked);
    if (!term || out.has(term)) continue;
    perLanguage.set(language, (perLanguage.get(language) ?? 0) + 1);
    out.set(term, { term, language, meaning: normalizeMeaning(record.meaning) });
  }
  return [...out.values()];
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

export interface TranslateTermsDeps {
  translate?: TranslateFn;
  claimTranslation?: typeof claimTextPolicyTermTranslation;
  addTranslations?: typeof addTextPolicyTranslations;
}

/**
 * Request translations for accepted terms (each term at most once, ever) and store them
 * as pending. Never throws. Returns the translations stored per source term.
 */
export async function translateAcceptedTerms(
  policy: TextPolicyDefinition,
  terms: string[],
  config: Pick<TextPolicyConfig, "moderatorModel" | "translateLanguages" | "learnMode">,
  deps: TranslateTermsDeps = {}
): Promise<Record<string, string[]>> {
  const stored: Record<string, string[]> = {};
  if (!config.moderatorModel || config.learnMode === "off") return stored;
  if (config.translateLanguages.length === 0) return stored;
  for (const term of terms) {
    try {
      const claimed = (deps.claimTranslation ?? claimTextPolicyTermTranslation)(policy.id, term);
      if (!claimed) continue;
      const categories = termCategoriesFor(policy);
      // A manual term has no category; a categorised one must be learnable to be translated.
      if (claimed.category && categoryWeight(categories, claimed.category) <= 0) continue;
      const languages = config.translateLanguages.filter((code) => code !== claimed.language);
      if (languages.length === 0) continue;
      const reply = await (deps.translate ?? defaultTranslate)({
        policy,
        model: config.moderatorModel,
        term: claimed.term,
        language: claimed.language,
        meaning: claimed.meaning,
        languages,
      });
      if (!reply.ok) continue;
      const translations = validateTranslations(reply.translations, policy, {
        sourceTerm: claimed.term,
        languages,
      });
      if (translations.length === 0) continue;
      stored[claimed.term] = (deps.addTranslations ?? addTextPolicyTranslations)(
        policy.id,
        claimed.term,
        translations,
        {
          weight: claimed.weight,
          category: claimed.category,
          moderatorModel: config.moderatorModel,
        }
      );
    } catch {
      // A failed translation never affects requests; the term simply stays untranslated.
    }
  }
  return stored;
}
