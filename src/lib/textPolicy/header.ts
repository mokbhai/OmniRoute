/**
 * `x-omniroute-text-policy` response header, built from the text-policy guardrail's
 * meta (`meta.evaluations`). One entry per evaluated policy, comma-separated:
 *
 *   sexual-content=violation; stage=moderator; action=rerouted; score=3; moderator=0.910; discovered=2
 *
 * Header values stay ASCII and never carry request text or discovered words (count only).
 */

export const TEXT_POLICY_HEADER = "x-omniroute-text-policy";
export const TEXT_POLICY_GUARDRAIL_NAME = "text-policy";

interface HeaderEvaluation {
  policy?: unknown;
  violation?: unknown;
  stage?: unknown;
  action?: unknown;
  keywordScore?: unknown;
  moderatorScore?: unknown;
  moderatorError?: unknown;
  discoveredTerms?: unknown;
}

const SAFE_TOKEN = /^[a-z0-9_-]{1,48}$/;

function formatEvaluation(entry: HeaderEvaluation): string | null {
  if (typeof entry.policy !== "string" || !SAFE_TOKEN.test(entry.policy)) return null;
  if (typeof entry.stage !== "string" || typeof entry.action !== "string") return null;
  const parts = [
    `${entry.policy}=${entry.violation === true ? "violation" : "clean"}`,
    `stage=${entry.stage}`,
    `action=${entry.action}`,
    `score=${Number(entry.keywordScore) || 0}`,
  ];
  if (typeof entry.moderatorScore === "number") {
    parts.push(`moderator=${entry.moderatorScore.toFixed(3)}`);
  }
  if (typeof entry.moderatorError === "string" && SAFE_TOKEN.test(entry.moderatorError)) {
    parts.push(`moderator_error=${entry.moderatorError}`);
  }
  if (Array.isArray(entry.discoveredTerms) && entry.discoveredTerms.length > 0) {
    parts.push(`discovered=${entry.discoveredTerms.length}`);
  }
  return parts.join("; ");
}

export function buildTextPolicyHeader(
  results: Array<{ guardrail: string; meta?: Record<string, unknown> | null }>
): string | null {
  const meta = results.find((result) => result.guardrail === TEXT_POLICY_GUARDRAIL_NAME)?.meta;
  const evaluations = Array.isArray(meta?.evaluations) ? meta.evaluations : [];
  const formatted = evaluations
    .map((entry) => formatEvaluation((entry ?? {}) as HeaderEvaluation))
    .filter((entry): entry is string => entry !== null);
  return formatted.length > 0 ? formatted.join(", ") : null;
}
