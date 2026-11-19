import { z } from "zod";

/**
 * Settings shape for the content-policy guardrail (`src/lib/guardrails/contentPolicy.ts`).
 *
 * Stored under the single settings key `contentPolicy`. Every field is optional:
 * a missing global field falls back to the built-in default, and a missing
 * per-key field falls back to the global value ("inherit"). See
 * `resolveContentPolicyConfig()` for the precedence rules.
 */

export const CONTENT_POLICY_MODES = ["reroute", "block", "flag"] as const;
export type ContentPolicyMode = (typeof CONTENT_POLICY_MODES)[number];

export const contentPolicyOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(CONTENT_POLICY_MODES).optional(),
    /** Keyword score below this never reaches the moderator (treated as clean). */
    lowThreshold: z.number().min(0).max(1000).optional(),
    /** Keyword score at or above this is treated as adult without calling the moderator. */
    highThreshold: z.number().min(0).max(1000).optional(),
    /** Moderation model, e.g. `openai/omni-moderation-latest` or `mistral/mistral-moderation-latest`. */
    moderatorModel: z.string().trim().max(200).optional(),
    /** Moderator `sexual` category score at or above this counts as adult (0..1). */
    moderationScoreThreshold: z.number().min(0).max(1).optional(),
    /** Model or combo the request is sent to instead when it is judged adult (mode `reroute`). */
    rerouteTarget: z.string().trim().max(200).optional(),
  })
  .strict();

export type ContentPolicyOverride = z.infer<typeof contentPolicyOverrideSchema>;

function bandIsOrdered(value: { lowThreshold?: number; highThreshold?: number }) {
  return (
    value.lowThreshold === undefined ||
    value.highThreshold === undefined ||
    value.lowThreshold < value.highThreshold
  );
}

const BAND_ORDER_MESSAGE = "contentPolicy: lowThreshold must be lower than highThreshold";

export const contentPolicySettingsSchema = contentPolicyOverrideSchema
  .extend({
    /** Per-API-key overrides, keyed by API key id. A field set here wins over the global one. */
    keyOverrides: z
      .record(
        z.string().min(1).max(100),
        contentPolicyOverrideSchema.refine(bandIsOrdered, { message: BAND_ORDER_MESSAGE })
      )
      .optional(),
  })
  .strict()
  .refine(bandIsOrdered, { message: BAND_ORDER_MESSAGE });

export type ContentPolicySettings = z.infer<typeof contentPolicySettingsSchema>;
