export const CONTENT_POLICY_GUARDRAIL_NAME = "content-policy";

/**
 * Value of the `x-omniroute-content-policy` response header, built from the
 * guardrail's meta. Null when the guardrail did not run or the policy is off.
 * Format: `<adult|clean>; stage=<keyword|moderator>; action=<action>; score=<n>[; moderator=<0..1>]`
 */
export function buildContentPolicyHeader(
  results: Array<{ guardrail: string; meta?: Record<string, unknown> | null }>
): string | null {
  const meta = results.find((result) => result.guardrail === CONTENT_POLICY_GUARDRAIL_NAME)?.meta;
  if (!meta || typeof meta.stage !== "string" || typeof meta.action !== "string") return null;
  const parts = [
    meta.adult === true ? "adult" : "clean",
    `stage=${meta.stage}`,
    `action=${meta.action}`,
    `score=${Number(meta.keywordScore) || 0}`,
  ];
  if (typeof meta.moderatorScore === "number") {
    parts.push(`moderator=${meta.moderatorScore.toFixed(3)}`);
  }
  if (typeof meta.moderatorError === "string") parts.push(`moderator_error=${meta.moderatorError}`);
  return parts.join("; ");
}
