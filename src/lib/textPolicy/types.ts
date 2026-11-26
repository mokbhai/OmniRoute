/**
 * Text policy engine — shared types.
 *
 * A *text policy* detects one kind of content in text (sexual content, violence,
 * self-harm, a customer's banned topics, ...) with the same two-stage pipeline:
 *
 *   1. keyword score (local lexicon: seed terms + learned terms)
 *   2. moderator, only for scores inside the middle band
 *
 * and then lets the caller apply an action (reroute / block / flag). The pipeline
 * is identical for every policy; a policy only supplies its *definition* (what to
 * look for) and the operator supplies its *config* (how strict, which moderator,
 * what to do), globally and per API key.
 */

import type { TextPolicyLearnMode, TextPolicyMode } from "@/shared/validation/textPolicySchema";

export type { TextPolicyLearnMode, TextPolicyMode };

export interface KeywordTerm {
  term: string;
  /** 1 = weak signal, 3 = strong signal, 5 = unambiguous. */
  weight: number;
}

/**
 * How a moderator classifies a word it reports. The category, not the moderator, sets
 * the weight a learned word gets; weight 0 means the word is never learned or translated
 * (everyday words, identity words, words about minors, other harms).
 */
export interface TermCategory {
  /** Short id the moderator returns, `[a-z_]`. */
  id: string;
  /** Shown to the moderator. */
  description: string;
  /** Weight of a learned term of this category (1..5), or 0 = never learned. */
  weight: number;
}

/** A worked example for the moderator prompt (any language). */
export interface TermExample {
  term: string;
  lang: string;
  meaning: string;
  category: string;
}

/** WHAT a policy detects. Built-in definitions live in code; custom ones come from settings. */
export interface TextPolicyDefinition {
  /** Stable id: settings key, learned-terms partition, API path segment. `[a-z0-9-]`, max 48. */
  id: string;
  label: string;
  description?: string;
  /**
   * Category prefix read from a moderation-model response (`category_scores`).
   * OpenAI/Mistral examples: "sexual", "violence", "self-harm", "hate", "harassment".
   */
  moderationCategory: string;
  /**
   * What a chat-model moderator rates, completing "Rate <instruction>". Example:
   * "how violent or gory the TEXT is (0 = not at all, 1 = graphic violence)".
   */
  classifierInstruction: string;
  /** Built-in lexicon. A trailing `*` on a Latin term makes it a prefix match. */
  seedTerms: readonly KeywordTerm[];
  /** Words a moderator may report that must never be learned for this policy. */
  stopWords?: readonly string[];
  /** Categories the moderator classifies reported words into. Default: generic ones. */
  termCategories?: readonly TermCategory[];
  /** Worked examples shown to the moderator, ideally in several languages. */
  termExamples?: readonly TermExample[];
  /** Lower runs first when several policies are enabled. */
  priority: number;
  /** True for definitions shipped in code; false for ones defined only in settings. */
  builtIn: boolean;
}

/** HOW a policy runs. Resolved per request: per-key override → global → default. */
export interface TextPolicyConfig {
  enabled: boolean;
  mode: TextPolicyMode;
  lowThreshold: number;
  highThreshold: number;
  moderatorModel: string | null;
  moderationScoreThreshold: number;
  rerouteTarget: string | null;
  learnMode: TextPolicyLearnMode;
  learnMinHits: number;
  /** A verdict teaches only when the moderator's score is at least this (0..1). */
  learnMinModeratorScore: number;
  /**
   * ISO 639-1 codes. When a learned word is accepted, the moderator is asked once for its
   * equivalents in these languages; they start pending and are learned like any other
   * word. Empty = no translations.
   */
  translateLanguages: string[];
}

export type KeywordBand = "below" | "middle" | "above";

export interface DiscoveredTerm {
  term: string;
  /** Set from the category, not from the moderator. */
  weight: number;
  /** ISO 639-1 code reported by the moderator. */
  language?: string;
  /** Short English meaning reported by the moderator. */
  meaning?: string;
  category?: string;
}

/** A reported word that is real but must not be learned (its category has weight 0). */
export interface IgnoredTerm {
  term: string;
  category: string;
}

export interface TextPolicyLearningOutcome {
  mode: TextPolicyLearnMode;
  added: string[];
  activated: string[];
  /** Activated terms whose translations were requested. */
  translating?: string[];
  skipped?:
    | "no_new_terms"
    | "learning_off"
    | "no_violation"
    | "low_confidence"
    | "cached_verdict"
    | "store_error";
}

/** Result of the detection stages. Contains no request text. */
export interface TextPolicyDecision {
  policy: string;
  /** The text matches the policy (keyword stage above band, or moderator score ≥ threshold). */
  violation: boolean;
  stage: "keyword" | "moderator";
  band: KeywordBand;
  keywordScore: number;
  /** Lexicon entries that matched (never request text), highest weight first, max 10. */
  matchedTerms: string[];
  learnedMatches?: string[];
  lowThreshold: number;
  highThreshold: number;
  scope: "global" | "key";
  moderatorModel?: string | null;
  moderatorKind?: "moderation" | "chat";
  moderatorScore?: number;
  moderatorThreshold?: number;
  moderatorCached?: boolean;
  /** Set when the moderator could not decide; the decision then fails open (no violation). */
  moderatorError?: string;
  /** Chat moderator only: new terms it found in the text, with weights. */
  discoveredTerms?: DiscoveredTerm[];
  /** Chat moderator only: words it reported in a never-learned category. */
  ignoredTerms?: IgnoredTerm[];
  learning?: TextPolicyLearningOutcome;
}

export type TextPolicyAction =
  "allowed" | "rerouted" | "blocked" | "flagged" | "already_target" | "no_reroute_target";

export interface TextPolicyActionPlan {
  action: TextPolicyAction;
  /** True when the caller must reject the request. */
  block: boolean;
  /** Set when the caller must switch to this model. */
  toModel?: string;
  fromModel?: string;
}
