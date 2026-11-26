/**
 * Word categories for the self-growing lexicon.
 *
 * A chat moderator classifies every word it reports into one of its policy's categories.
 * The category sets the learned weight, so the moderator cannot give an everyday word a
 * high weight just by saying so. Categories with weight 0 are never learned and never
 * translated: everyday words that only match in context, identity words, words about
 * minors, and other harms. A word reported with an unknown or missing category is not
 * learned either.
 */

import type { TermCategory, TextPolicyDefinition } from "./types";

/** Used by policies that do not define their own categories (e.g. custom ones from settings). */
export const DEFAULT_TERM_CATEGORIES: readonly TermCategory[] = Object.freeze([
  {
    id: "core",
    description: "a word whose usual meaning is exactly what this policy detects",
    weight: 5,
  },
  {
    id: "strong",
    description: "slang, a euphemism or a word that strongly suggests it",
    weight: 3,
  },
  {
    id: "context",
    description:
      "an everyday word with common ordinary meanings that only matches because of the rest of the TEXT",
    weight: 0,
  },
  {
    id: "other",
    description: "anything else: names, ordinary words, or content this policy is not about",
    weight: 0,
  },
]);

/**
 * Languages an accepted word is translated into by default: the most used languages on
 * the web and in LLM traffic.
 */
export const DEFAULT_TRANSLATE_LANGUAGES: readonly string[] = Object.freeze([
  "en",
  "es",
  "pt",
  "fr",
  "de",
  "it",
  "ru",
  "zh",
  "ja",
  "ko",
  "hi",
  "ar",
  "id",
  "vi",
  "tr",
]);

export function termCategoriesFor(
  policy: Pick<TextPolicyDefinition, "termCategories">
): readonly TermCategory[] {
  return policy.termCategories && policy.termCategories.length > 0
    ? policy.termCategories
    : DEFAULT_TERM_CATEGORIES;
}

/** The learned weight for a category id, or 0 when the id is unknown or never learned. */
export function categoryWeight(categories: readonly TermCategory[], id: unknown): number {
  if (typeof id !== "string") return 0;
  const key = id.trim().toLowerCase();
  const match = categories.find((category) => category.id === key);
  return match ? Math.max(0, Math.min(5, Math.round(match.weight))) : 0;
}
