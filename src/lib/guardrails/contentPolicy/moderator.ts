/**
 * Stage 2 of the content-policy guardrail: ask the configured moderation model.
 *
 * Only called for requests whose keyword score is in the middle band. The call
 * goes through the same code as `POST /v1/moderations` (`handleModeration()`
 * plus the provider's configured connection), so the moderator must be one of
 * the moderation providers OmniRoute already has credentials for — OpenAI
 * (`omni-moderation-latest`) or Mistral (`mistral-moderation-latest`).
 *
 * The moderator is an operator-level policy check, not the caller's request, so
 * it uses the operator's provider connection and is not narrowed to the caller
 * key's connection scope.
 */

import { createHash } from "node:crypto";

import { parseModerationModel } from "@omniroute/open-sse/config/moderationRegistry.ts";

export interface ModeratorVerdict {
  ok: true;
  /** Highest `sexual*` category score returned (0..1). */
  sexualScore: number;
  /** Provider-reported `sexual` category flag, when present. */
  flagged: boolean;
  cached: boolean;
}

export interface ModeratorFailure {
  ok: false;
  reason: "unsupported_moderator" | "no_credentials" | "moderator_http_error" | "moderator_error";
  status?: number;
}

export type ModeratorResult = ModeratorVerdict | ModeratorFailure;

export type ModerateFn = (input: {
  model: string;
  text: string;
  signal?: AbortSignal;
}) => Promise<ModeratorResult>;

/** Characters sent to the moderator (head + tail of the scanned text). */
export const MODERATOR_INPUT_LIMIT = 12_000;

/** Head + tail window of the scanned text, sized for the moderation endpoint. */
export function clipModeratorInput(text: string, limit = MODERATOR_INPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
const verdictCache = new Map<string, { verdict: ModeratorVerdict; at: number }>();

export function clearModeratorCacheForTests(): void {
  verdictCache.clear();
}

function cacheKey(model: string, text: string): string {
  return createHash("sha256").update(model).update("\0").update(text).digest("hex");
}

/** Pull the highest `sexual` / `sexual/minors` score out of an OpenAI- or Mistral-shaped response. */
export function extractSexualScore(data: unknown): { score: number; flagged: boolean } | null {
  const results = (data as { results?: unknown })?.results;
  const first = Array.isArray(results) ? (results[0] as Record<string, unknown>) : null;
  if (!first || typeof first !== "object") return null;
  const scores = first.category_scores as Record<string, unknown> | undefined;
  const categories = first.categories as Record<string, unknown> | undefined;
  if (!scores || typeof scores !== "object") return null;
  let score = 0;
  let found = false;
  for (const [name, value] of Object.entries(scores)) {
    if (!name.toLowerCase().startsWith("sexual") || typeof value !== "number") continue;
    found = true;
    score = Math.max(score, value);
  }
  if (!found) return null;
  const flagged = Boolean(
    categories &&
    Object.entries(categories).some(
      ([name, value]) => name.toLowerCase().startsWith("sexual") && value === true
    )
  );
  return { score, flagged };
}

async function callModerationApi(model: string, text: string): Promise<ModeratorResult> {
  const { provider } = parseModerationModel(model);
  if (!provider) return { ok: false, reason: "unsupported_moderator" };

  const [{ handleModeration }, { getProviderCredentialsWithQuotaPreflight }] = await Promise.all([
    import("@omniroute/open-sse/handlers/moderations.ts"),
    import("@/sse/services/auth"),
  ]);
  const credentials = (await getProviderCredentialsWithQuotaPreflight(provider, null, null)) as
    Record<string, unknown> | null | undefined;
  const usable =
    credentials &&
    !(credentials as { allRateLimited?: unknown }).allRateLimited &&
    (typeof credentials.apiKey === "string" || typeof credentials.accessToken === "string");
  if (!usable) return { ok: false, reason: "no_credentials" };

  const response = (await handleModeration({
    body: { model, input: text },
    credentials,
  })) as Response;
  if (!response?.ok) {
    return { ok: false, reason: "moderator_http_error", status: response?.status };
  }
  const parsed = extractSexualScore(await response.json());
  if (!parsed) return { ok: false, reason: "moderator_error" };
  return { ok: true, sexualScore: parsed.score, flagged: parsed.flagged, cached: false };
}

/**
 * Default moderator: cached by (model, text) hash for 10 minutes so the many
 * near-identical templated requests a single client sends cost one call.
 */
export const defaultModerate: ModerateFn = async ({ model, text }) => {
  const key = cacheKey(model, text);
  const hit = verdictCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.verdict, cached: true };
  }
  let result: ModeratorResult;
  try {
    result = await callModerationApi(model, text);
  } catch {
    return { ok: false, reason: "moderator_error" };
  }
  if (result.ok) {
    if (verdictCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = verdictCache.keys().next().value;
      if (oldest !== undefined) verdictCache.delete(oldest);
    }
    verdictCache.set(key, { verdict: result, at: Date.now() });
  }
  return result;
};
