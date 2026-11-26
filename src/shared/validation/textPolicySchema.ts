import { z } from "zod";

/**
 * Settings shape for text policies (`src/lib/textPolicy/`), stored under the single
 * settings key `textPolicies`, keyed by policy id:
 *
 *   { "textPolicies": { "sexual-content": { ... }, "violence": { ... } } }
 *
 * Every field is optional. For a built-in policy, config fields fall back to the
 * built-in defaults and definition fields (`seedTerms`, `classifierInstruction`, ...)
 * extend or replace the built-in definition. An id that is not built in becomes a
 * custom policy when it supplies `classifierInstruction` or `seedTerms`.
 * Per-key fields under `keyOverrides` win over the global ones ("inherit" when unset).
 */

export const TEXT_POLICY_MODES = ["reroute", "block", "flag"] as const;
export type TextPolicyMode = (typeof TEXT_POLICY_MODES)[number];

/**
 * What happens to new terms a chat-model moderator reports:
 * - "auto":   stored, and active once reported in `learnMinHits` fresh violations.
 * - "review": stored as pending; an operator activates them.
 * - "off":    reported in the decision only, never stored.
 */
export const TEXT_POLICY_LEARN_MODES = ["auto", "review", "off"] as const;
export type TextPolicyLearnMode = (typeof TEXT_POLICY_LEARN_MODES)[number];

/** ISO 639-1 (two letters) or 639-2/3 (three letters) language code. */
export const TEXT_POLICY_LANGUAGE_PATTERN = /^[a-z]{2,3}$/;
export const MAX_TRANSLATE_LANGUAGES = 30;

export const TEXT_POLICY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const textPolicyIdSchema = z.string().regex(TEXT_POLICY_ID_PATTERN, {
  message: "policy id must match [a-z0-9][a-z0-9-]{0,47}",
});

export const textPolicyTermSchema = z
  .object({
    term: z.string().trim().min(1).max(48),
    weight: z.number().int().min(1).max(5),
  })
  .strict();

/** Fields that tune HOW a policy runs. Allowed globally and per API key. */
export const textPolicyOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(TEXT_POLICY_MODES).optional(),
    /** Keyword score below this never reaches the moderator (no violation). */
    lowThreshold: z.number().min(0).max(1000).optional(),
    /** Keyword score at or above this is a violation without calling the moderator. */
    highThreshold: z.number().min(0).max(1000).optional(),
    /**
     * Moderator. A moderation model (`openai/omni-moderation-latest`,
     * `mistral/mistral-moderation-latest`) returns a score only. Any other configured
     * model or combo is called as a chat model and also reports terms it found.
     */
    moderatorModel: z.string().trim().max(200).optional(),
    /** Moderator score at or above this is a violation (0..1). */
    moderationScoreThreshold: z.number().min(0).max(1).optional(),
    /** Model or combo a violating request is sent to (mode `reroute`). */
    rerouteTarget: z.string().trim().max(200).optional(),
    learnMode: z.enum(TEXT_POLICY_LEARN_MODES).optional(),
    /** In `auto` learn mode, fresh violations a term must appear in before it becomes active. */
    learnMinHits: z.number().int().min(1).max(100).optional(),
    /** A moderator verdict teaches only when its score is at least this (0..1). */
    learnMinModeratorScore: z.number().min(0).max(1).optional(),
    /**
     * Languages (ISO 639-1) an accepted learned word is translated into. The translations
     * start pending and are learned like any other word. [] = no translations.
     */
    translateLanguages: z
      .array(z.string().trim().toLowerCase().regex(TEXT_POLICY_LANGUAGE_PATTERN))
      .max(MAX_TRANSLATE_LANGUAGES)
      .optional(),
  })
  .strict();

/** Fields that define WHAT a policy detects. Global only. */
const textPolicyDefinitionFields = {
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  /** Category prefix read from a moderation-model response (e.g. "violence"). */
  moderationCategory: z
    .string()
    .regex(/^[a-z][a-z/_-]{0,39}$/)
    .optional(),
  /** Completes "Rate <instruction>" in the chat-moderator prompt. */
  classifierInstruction: z.string().trim().min(10).max(500).optional(),
  /** Extra lexicon terms. For a built-in policy they are added to the built-in ones. */
  seedTerms: z.array(textPolicyTermSchema).max(500).optional(),
  /** Words that must never be learned for this policy. */
  stopWords: z.array(z.string().trim().min(1).max(48)).max(500).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
};

export type TextPolicyOverride = z.infer<typeof textPolicyOverrideSchema>;

function bandIsOrdered(value: { lowThreshold?: number; highThreshold?: number }) {
  return (
    value.lowThreshold === undefined ||
    value.highThreshold === undefined ||
    value.lowThreshold < value.highThreshold
  );
}

const BAND_ORDER_MESSAGE = "textPolicies: lowThreshold must be lower than highThreshold";

export const textPolicySettingsSchema = textPolicyOverrideSchema
  .extend({
    ...textPolicyDefinitionFields,
    /** Per-API-key overrides, keyed by API key id. A field set here wins over the global one. */
    keyOverrides: z
      .record(
        z.string().min(1).max(100),
        textPolicyOverrideSchema.refine(bandIsOrdered, { message: BAND_ORDER_MESSAGE })
      )
      .optional(),
  })
  .strict()
  .refine(bandIsOrdered, { message: BAND_ORDER_MESSAGE });

export type TextPolicySettings = z.infer<typeof textPolicySettingsSchema>;

export const MAX_TEXT_POLICIES = 50;

export const textPoliciesSettingsSchema = z
  .record(textPolicyIdSchema, textPolicySettingsSchema)
  .refine((value) => Object.keys(value).length <= MAX_TEXT_POLICIES, {
    message: `textPolicies: at most ${MAX_TEXT_POLICIES} policies`,
  });
