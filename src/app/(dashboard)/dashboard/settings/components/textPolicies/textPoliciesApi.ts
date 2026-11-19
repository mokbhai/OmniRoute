/**
 * Client-side calls for the Text Policies settings page. Thin wrappers over:
 *   GET   /api/text-policies                      (policies + effective config + counts)
 *   GET   /api/settings / PATCH /api/settings     (stored `textPolicies` object)
 *   GET/PUT/DELETE /api/text-policies/<id>/terms  (learned terms)
 *   POST  /api/text-policies/<id>/evaluate        (try it)
 *   GET   /api/keys                               (API keys for per-key overrides)
 */

import type { StoredPolicies } from "./textPolicyForm";
import { readStoredPolicies } from "./textPolicyForm";

export interface PolicyConfigView {
  enabled: boolean;
  mode: "reroute" | "block" | "flag";
  lowThreshold: number;
  highThreshold: number;
  moderatorModel: string | null;
  moderationScoreThreshold: number;
  rerouteTarget: string | null;
  learnMode: "auto" | "review" | "off";
  learnMinHits: number;
}

export interface PolicySummary {
  id: string;
  label: string;
  description: string | null;
  builtIn: boolean;
  priority: number;
  moderationCategory: string;
  classifierInstruction: string;
  seedTermCount: number;
  config: PolicyConfigView;
  learnedTerms: { pending: number; active: number; rejected: number };
}

export type TermStatus = "pending" | "active" | "rejected";

export interface LearnedTerm {
  term: string;
  weight: number;
  status: TermStatus;
  source: "moderator" | "manual";
  hits: number;
  lastModeratorModel: string | null;
  lastSeenAt: string;
}

export interface ApiKeyOption {
  id: string;
  name: string;
}

export interface EvaluateResult {
  enabled: boolean;
  decision: {
    violation: boolean;
    stage: "keyword" | "moderator";
    band: "below" | "middle" | "above";
    keywordScore: number;
    matchedTerms: string[];
    learnedMatches?: string[];
    scope: "global" | "key";
    moderatorModel?: string | null;
    moderatorScore?: number;
    moderatorError?: string;
    discoveredTerms?: Array<{ term: string; weight: number }>;
  } | null;
  plan?: { action: string; block: boolean; toModel?: string };
}

export class TextPolicyApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function json<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    if (typeof body.error === "string") message = body.error;
    else if (body.error?.message) message = body.error.message;
  } catch {
    // keep the status text
  }
  throw new TextPolicyApiError(message, response.status);
}

export async function fetchPolicies(signal?: AbortSignal): Promise<PolicySummary[]> {
  const body = await json<{ policies: PolicySummary[] }>(
    await fetch("/api/text-policies", { signal })
  );
  return body.policies;
}

export async function fetchStoredPolicies(signal?: AbortSignal): Promise<StoredPolicies> {
  return readStoredPolicies(await json<unknown>(await fetch("/api/settings", { signal })));
}

export async function saveStoredPolicies(policies: StoredPolicies): Promise<void> {
  await json<unknown>(
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ textPolicies: policies }),
    })
  );
}

const termsUrl = (policyId: string) => `/api/text-policies/${encodeURIComponent(policyId)}/terms`;

export async function fetchTerms(policyId: string, signal?: AbortSignal): Promise<LearnedTerm[]> {
  const body = await json<{ terms: LearnedTerm[] }>(await fetch(termsUrl(policyId), { signal }));
  return body.terms;
}

export async function upsertTerm(
  policyId: string,
  input: { term: string; weight?: number; status?: TermStatus }
): Promise<void> {
  await json<unknown>(
    await fetch(termsUrl(policyId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function deleteTerm(policyId: string, term: string): Promise<void> {
  await json<unknown>(
    await fetch(termsUrl(policyId), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term }),
    })
  );
}

export async function evaluateText(
  policyId: string,
  input: { text: string; apiKeyId?: string; requestedModel?: string }
): Promise<EvaluateResult> {
  return json<EvaluateResult>(
    await fetch(`/api/text-policies/${encodeURIComponent(policyId)}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Dry run: always evaluate (even when disabled) and never grow the lexicon.
      body: JSON.stringify({ ...input, ignoreEnabled: true, learn: false }),
    })
  );
}

export async function fetchApiKeys(signal?: AbortSignal): Promise<ApiKeyOption[]> {
  const body = await json<{ keys?: Array<{ id?: unknown; name?: unknown }> }>(
    await fetch("/api/keys", { signal })
  );
  return (body.keys ?? [])
    .filter((key): key is { id: string; name?: unknown } => typeof key.id === "string")
    .map((key) => ({ id: key.id, name: typeof key.name === "string" ? key.name : key.id }));
}
