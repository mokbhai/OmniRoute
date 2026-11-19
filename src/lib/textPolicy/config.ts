/**
 * Effective configuration of one text policy for one request.
 *
 * Precedence, per field: per-API-key override → global setting → built-in default.
 * A per-key field that is absent means "inherit the global value", the same rule as
 * the API key `codexServiceMode: "inherit"`.
 *
 *   {
 *     "textPolicies": {
 *       "sexual-content": {
 *         "enabled": true, "mode": "reroute", "lowThreshold": 3, "highThreshold": 10,
 *         "moderatorModel": "groq/llama-3.3-70b", "moderationScoreThreshold": 0.5,
 *         "rerouteTarget": "combo/nsfw-ok", "learnMode": "auto", "learnMinHits": 2,
 *         "keyOverrides": { "<apiKeyId>": { "enabled": false } }
 *       }
 *     }
 *   }
 */

import {
  textPolicyOverrideSchema,
  type TextPolicyOverride,
} from "@/shared/validation/textPolicySchema";

import { readTextPolicySettings } from "./catalog";
import type { TextPolicyConfig } from "./types";

export const DEFAULT_TEXT_POLICY_CONFIG: Readonly<TextPolicyConfig> = Object.freeze({
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

export interface ResolvedTextPolicyConfig {
  config: TextPolicyConfig;
  /** "key" when the caller's API key has an override entry for this policy. */
  scope: "global" | "key";
  /** Fields whose value came from the per-key override. */
  keyOverriddenFields: (keyof TextPolicyConfig)[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Lenient per-field parse: one invalid stored field never disables the whole policy. */
function parseLayer(raw: unknown): TextPolicyOverride {
  const record = asRecord(raw);
  if (!record) return {};
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(textPolicyOverrideSchema.shape)) {
    const parsed = schema.safeParse(record[key]);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  return out as TextPolicyOverride;
}

function emptyToNull(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.trim().length > 0 ? value.trim() : null;
}

function applyLayer(base: TextPolicyConfig, layer: TextPolicyOverride) {
  const config = { ...base };
  const fields: (keyof TextPolicyConfig)[] = [];
  const set = <K extends keyof TextPolicyConfig>(key: K, value: TextPolicyConfig[K]) => {
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

export function resolveTextPolicyConfig(
  settings: Record<string, unknown> | null | undefined,
  policyId: string,
  apiKeyId: string | null | undefined,
  defaults: Partial<TextPolicyConfig> = {}
): ResolvedTextPolicyConfig {
  const stored = readTextPolicySettings(settings)[policyId] ?? null;
  const global = applyLayer(
    { ...DEFAULT_TEXT_POLICY_CONFIG, ...defaults },
    parseLayer(stored)
  ).config;
  const overrides = asRecord(stored?.keyOverrides);
  const keyLayer = apiKeyId && overrides ? overrides[apiKeyId] : undefined;
  if (!asRecord(keyLayer)) return { config: global, scope: "global", keyOverriddenFields: [] };
  const { config, fields } = applyLayer(global, parseLayer(keyLayer));
  return { config, scope: "key", keyOverriddenFields: fields };
}
