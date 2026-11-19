/**
 * Text policy catalog: which policies exist and what each one detects.
 *
 * Two sources, merged per lookup:
 *   1. Built-in definitions registered in code (`registerTextPolicy()`), e.g.
 *      `sexual-content`. A module adds its own policy by calling `registerTextPolicy()`
 *      once at import time.
 *   2. Settings (`textPolicies.<id>`). For a built-in id, definition fields extend it:
 *      `seedTerms` / `stopWords` are ADDED, `label` / `description` /
 *      `moderationCategory` / `classifierInstruction` / `priority` REPLACE. An id that is
 *      not built in becomes a custom policy when it sets `classifierInstruction` or
 *      `seedTerms` (moderationCategory then defaults to the id).
 */

import { TEXT_POLICY_ID_PATTERN, textPolicyTermSchema } from "@/shared/validation/textPolicySchema";

import { SEXUAL_CONTENT_POLICY } from "./policies/sexualContent";
import type { KeywordTerm, TextPolicyDefinition } from "./types";

const builtIns = new Map<string, TextPolicyDefinition>();

/** Register a code-defined policy. Re-registering an id replaces it. */
export function registerTextPolicy(definition: TextPolicyDefinition): TextPolicyDefinition {
  if (!TEXT_POLICY_ID_PATTERN.test(definition.id)) {
    throw new Error(`Invalid text policy id: ${definition.id}`);
  }
  const frozen = Object.freeze({ ...definition, builtIn: true });
  builtIns.set(definition.id, frozen);
  return frozen;
}

export function listBuiltInTextPolicies(): TextPolicyDefinition[] {
  return [...builtIns.values()];
}

/** Test helper: drop every registration except the shipped built-ins. */
export function resetTextPolicyCatalogForTests(): void {
  builtIns.clear();
  registerTextPolicy(SEXUAL_CONTENT_POLICY);
}

registerTextPolicy(SEXUAL_CONTENT_POLICY);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTerms(value: unknown): KeywordTerm[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = textPolicyTermSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function readString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
}

/** All per-policy settings blocks: `settings.textPolicies`. */
export function readTextPolicySettings(
  settings: Record<string, unknown> | null | undefined
): Record<string, Record<string, unknown>> {
  const root = asRecord(settings?.textPolicies);
  if (!root) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, value] of Object.entries(root)) {
    const record = asRecord(value);
    if (record && TEXT_POLICY_ID_PATTERN.test(id)) out[id] = record;
  }
  return out;
}

/** The effective definition of one policy, or null when the id is unknown. */
export function resolveTextPolicyDefinition(
  policyId: string,
  settings: Record<string, unknown> | null | undefined
): TextPolicyDefinition | null {
  const stored = readTextPolicySettings(settings)[policyId] ?? null;
  const base = builtIns.get(policyId);
  const extraTerms = readTerms(stored?.seedTerms);
  const instruction = readString(stored?.classifierInstruction, 500);

  if (!base) {
    if (!stored || (!instruction && extraTerms.length === 0)) return null;
    return {
      id: policyId,
      label: readString(stored.label, 80) ?? policyId,
      description: readString(stored.description, 300),
      moderationCategory: readString(stored.moderationCategory, 40) ?? policyId,
      classifierInstruction:
        instruction ??
        `how strongly the TEXT matches the "${policyId}" policy (0 = not at all, 1 = clearly)`,
      seedTerms: extraTerms,
      stopWords: readStrings(stored.stopWords),
      priority: typeof stored.priority === "number" ? stored.priority : 100,
      builtIn: false,
    };
  }
  if (!stored) return base;
  return {
    ...base,
    label: readString(stored.label, 80) ?? base.label,
    description: readString(stored.description, 300) ?? base.description,
    moderationCategory: readString(stored.moderationCategory, 40) ?? base.moderationCategory,
    classifierInstruction: instruction ?? base.classifierInstruction,
    seedTerms: extraTerms.length > 0 ? [...base.seedTerms, ...extraTerms] : base.seedTerms,
    stopWords: [...(base.stopWords ?? []), ...readStrings(stored.stopWords)],
    priority: typeof stored.priority === "number" ? stored.priority : base.priority,
  };
}

/** Every known policy (built-in + custom from settings), lowest priority first. */
export function listTextPolicyDefinitions(
  settings: Record<string, unknown> | null | undefined
): TextPolicyDefinition[] {
  const ids = new Set([...builtIns.keys(), ...Object.keys(readTextPolicySettings(settings))]);
  return [...ids]
    .map((id) => resolveTextPolicyDefinition(id, settings))
    .filter((definition): definition is TextPolicyDefinition => definition !== null)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}
