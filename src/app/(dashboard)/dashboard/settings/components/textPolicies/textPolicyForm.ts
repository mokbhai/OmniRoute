/**
 * Pure state helpers for the Text Policies settings page. No React, no fetch, so the
 * merge rules are unit-tested directly (tests/unit/text-policy/ui-form.test.ts).
 *
 * The page edits the stored `textPolicies` settings object and writes the WHOLE object
 * back with PATCH /api/settings (the setting is replaced on each write). Every helper
 * here returns a new object and never mutates its input.
 */

import {
  TEXT_POLICY_ID_PATTERN,
  textPoliciesSettingsSchema,
} from "@/shared/validation/textPolicySchema";

export type StoredPolicies = Record<string, Record<string, unknown>>;

/** Fields that tune how a policy runs (global and per key). */
export const CONFIG_FIELDS = [
  "enabled",
  "mode",
  "lowThreshold",
  "highThreshold",
  "moderatorModel",
  "moderationScoreThreshold",
  "rerouteTarget",
  "learnMode",
  "learnMinHits",
] as const;
export type ConfigField = (typeof CONFIG_FIELDS)[number];

/** Fields that define what a policy detects (global only). */
export const DEFINITION_FIELDS = [
  "label",
  "description",
  "moderationCategory",
  "classifierInstruction",
  "seedTerms",
  "stopWords",
  "priority",
] as const;

export interface PolicyTermInput {
  term: string;
  weight: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Normalize whatever GET /api/settings returned for `textPolicies`. */
export function readStoredPolicies(settings: unknown): StoredPolicies {
  const root = asRecord(asRecord(settings)?.textPolicies);
  if (!root) return {};
  const out: StoredPolicies = {};
  for (const [id, value] of Object.entries(root)) {
    const record = asRecord(value);
    if (record) out[id] = { ...record };
  }
  return out;
}

/** Drop undefined / empty-string / empty-array values so "blank" means "use default". */
export function compactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

/**
 * Replace the global (non-override) fields of one policy, keeping its `keyOverrides`.
 * `fields` holds every editable global field; blank ones are removed from storage.
 */
export function setPolicyGlobalFields(
  policies: StoredPolicies,
  policyId: string,
  fields: Record<string, unknown>
): StoredPolicies {
  const current = policies[policyId] ?? {};
  const next: Record<string, unknown> = compactFields(fields);
  if (current.keyOverrides !== undefined) next.keyOverrides = current.keyOverrides;
  return { ...policies, [policyId]: next };
}

/** Flip one policy's global `enabled` flag. */
export function setPolicyEnabled(
  policies: StoredPolicies,
  policyId: string,
  enabled: boolean
): StoredPolicies {
  return { ...policies, [policyId]: { ...(policies[policyId] ?? {}), enabled } };
}

/** Set (or with `null` / an empty override, remove) one API key's override for a policy. */
export function setKeyOverride(
  policies: StoredPolicies,
  policyId: string,
  apiKeyId: string,
  override: Record<string, unknown> | null
): StoredPolicies {
  const current = { ...(policies[policyId] ?? {}) };
  const overrides = { ...(asRecord(current.keyOverrides) ?? {}) };
  const compacted = override ? compactFields(override) : {};
  if (Object.keys(compacted).length === 0) delete overrides[apiKeyId];
  else overrides[apiKeyId] = compacted;
  if (Object.keys(overrides).length === 0) delete current.keyOverrides;
  else current.keyOverrides = overrides;
  return { ...policies, [policyId]: current };
}

export function getKeyOverrides(
  policies: StoredPolicies,
  policyId: string
): Record<string, Record<string, unknown>> {
  const overrides = asRecord(policies[policyId]?.keyOverrides) ?? {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [keyId, value] of Object.entries(overrides)) {
    const record = asRecord(value);
    if (record) out[keyId] = record;
  }
  return out;
}

/** Remove a custom policy entirely (built-in policies only lose their stored settings). */
export function removePolicy(policies: StoredPolicies, policyId: string): StoredPolicies {
  const next = { ...policies };
  delete next[policyId];
  return next;
}

// ─── Text <-> list conversions for textareas ────────────────────────────────

/** One term per line: `term` or `term:weight` (weight 1-5, default 3). */
export function parseTermLines(text: string): { terms: PolicyTermInput[]; invalid: string[] } {
  const terms: PolicyTermInput[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.lastIndexOf(":");
    const hasWeight = separator > 0 && /^\s*\d+\s*$/.test(line.slice(separator + 1));
    const term = (hasWeight ? line.slice(0, separator) : line).trim();
    const weight = hasWeight ? Number.parseInt(line.slice(separator + 1), 10) : 3;
    if (!term || term.length > 48 || weight < 1 || weight > 5) {
      invalid.push(line);
      continue;
    }
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({ term, weight });
  }
  return { terms, invalid };
}

export function formatTermLines(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => `${String(entry.term ?? "")}:${Number(entry.weight ?? 3)}`)
    .join("\n");
}

export function parseWordLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((word) => word.trim())
        .filter((word) => word.length > 0 && word.length <= 48)
    ),
  ];
}

export function formatWordLines(value: unknown): string {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string").join("\n") : "";
}

/** Blank → undefined, otherwise a finite number (or NaN for garbage). */
export function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return Number(trimmed);
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type NewPolicyError = "invalidId" | "duplicateId" | "missingDefinition";

export function validateNewPolicyId(
  id: string,
  existingIds: readonly string[]
): NewPolicyError | null {
  if (!TEXT_POLICY_ID_PATTERN.test(id)) return "invalidId";
  if (existingIds.includes(id)) return "duplicateId";
  return null;
}

/** Validate the whole object before saving; returns the first Zod issue message or null. */
export function validatePolicies(policies: StoredPolicies): string | null {
  const parsed = textPoliciesSettingsSchema.safeParse(policies);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return issue ? `${issue.path.join(".") || "textPolicies"}: ${issue.message}` : "invalid";
}
