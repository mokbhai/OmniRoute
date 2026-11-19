/**
 * Effective configuration for the content-policy guardrail.
 *
 * Precedence, per field: per-API-key override → global setting → built-in default.
 * A per-key field that is absent means "inherit the global value". This matches
 * the existing `codexServiceMode: "inherit"` pattern on API keys, where a value
 * set on the key wins and an unset one falls back to the global behavior.
 *
 * Settings live under the single key `contentPolicy`:
 *
 *   {
 *     "enabled": true,
 *     "mode": "reroute",
 *     "lowThreshold": 3,
 *     "highThreshold": 10,
 *     "moderatorModel": "openai/omni-moderation-latest",
 *     "moderationScoreThreshold": 0.5,
 *     "rerouteTarget": "combo/nsfw-ok",
 *     "learnMode": "auto",
 *     "learnMinHits": 2,
 *     "keyOverrides": { "<apiKeyId>": { "enabled": true, "rerouteTarget": "grok/grok-4" } }
 *   }
 */

import {
  contentPolicyOverrideSchema,
  type ContentPolicyLearnMode,
  type ContentPolicyMode,
  type ContentPolicyOverride,
} from "@/shared/validation/contentPolicySchema";

export interface ContentPolicyConfig {
  enabled: boolean;
  mode: ContentPolicyMode;
  lowThreshold: number;
  highThreshold: number;
  moderatorModel: string | null;
  moderationScoreThreshold: number;
  rerouteTarget: string | null;
  learnMode: ContentPolicyLearnMode;
  learnMinHits: number;
}

export const DEFAULT_CONTENT_POLICY_CONFIG: Readonly<ContentPolicyConfig> = Object.freeze({
  enabled: false,
  mode: "reroute",
  lowThreshold: 3,
  highThreshold: 10,
  moderatorModel: null,
  moderationScoreThreshold: 0.5,
  rerouteTarget: null,
  learnMode: "auto",
  learnMinHits: 2,
});

export interface ResolvedContentPolicyConfig {
  config: ContentPolicyConfig;
  /** "key" when the caller's API key has an override entry, otherwise "global". */
  scope: "global" | "key";
  /** Fields whose value came from the per-key override. */
  keyOverriddenFields: (keyof ContentPolicyConfig)[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse one override layer leniently: a stored value that no longer validates
 * (hand-edited DB, older schema) is dropped field by field instead of disabling
 * the whole policy.
 */
function parseLayer(raw: unknown): ContentPolicyOverride {
  const record = asRecord(raw);
  if (!record) return {};
  const strict = contentPolicyOverrideSchema.safeParse(
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== "keyOverrides"))
  );
  if (strict.success) return strict.data;
  const out: Record<string, unknown> = {};
  const shape = contentPolicyOverrideSchema.shape;
  for (const [key, schema] of Object.entries(shape)) {
    const parsed = schema.safeParse(record[key]);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out as ContentPolicyOverride;
}

function emptyToNull(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.trim().length > 0 ? value.trim() : null;
}

function applyLayer(
  base: ContentPolicyConfig,
  layer: ContentPolicyOverride
): { config: ContentPolicyConfig; fields: (keyof ContentPolicyConfig)[] } {
  const config = { ...base };
  const fields: (keyof ContentPolicyConfig)[] = [];
  const set = <K extends keyof ContentPolicyConfig>(key: K, value: ContentPolicyConfig[K]) => {
    config[key] = value;
    fields.push(key);
  };
  if (layer.enabled !== undefined) set("enabled", layer.enabled);
  if (layer.mode !== undefined) set("mode", layer.mode);
  if (layer.lowThreshold !== undefined) set("lowThreshold", layer.lowThreshold);
  if (layer.highThreshold !== undefined) set("highThreshold", layer.highThreshold);
  if (layer.moderationScoreThreshold !== undefined)
    set("moderationScoreThreshold", layer.moderationScoreThreshold);
  if (layer.learnMode !== undefined) set("learnMode", layer.learnMode);
  if (layer.learnMinHits !== undefined) set("learnMinHits", layer.learnMinHits);
  const moderatorModel = emptyToNull(layer.moderatorModel);
  if (moderatorModel !== undefined) set("moderatorModel", moderatorModel);
  const rerouteTarget = emptyToNull(layer.rerouteTarget);
  if (rerouteTarget !== undefined) set("rerouteTarget", rerouteTarget);
  return { config, fields };
}

export function resolveContentPolicyConfig(
  settings: Record<string, unknown> | null | undefined,
  apiKeyId: string | null | undefined
): ResolvedContentPolicyConfig {
  const stored = asRecord(settings?.contentPolicy);
  const global = applyLayer({ ...DEFAULT_CONTENT_POLICY_CONFIG }, parseLayer(stored)).config;

  const overrides = asRecord(stored?.keyOverrides);
  const keyLayer = apiKeyId && overrides ? overrides[apiKeyId] : undefined;
  if (!asRecord(keyLayer)) {
    return { config: global, scope: "global", keyOverriddenFields: [] };
  }
  const { config, fields } = applyLayer(global, parseLayer(keyLayer));
  return { config, scope: "key", keyOverriddenFields: fields };
}
