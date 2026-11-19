/**
 * Text-policy guardrail: runs every enabled text policy on chat requests.
 *
 * A thin consumer of the shared engine (`src/lib/textPolicy/`): it extracts the
 * request text, calls `evaluateTextPoliciesFor()` with the caller's API key id, and
 * applies the first acting plan:
 *   - block   → HTTP 400 "Request rejected by text policy: <policy>"
 *   - reroute → payload `model` replaced; chat.ts applies it through
 *               `reconcileGuardrailReroute()` (kept original if the key may not use it)
 *   - flag / allowed → passes unchanged
 * Every evaluation is returned in `meta.evaluations` and the `x-omniroute-text-policy`
 * response header.
 *
 * Off unless a policy is enabled. Runs last among the pre-call guardrails (priority 40)
 * so its model choice is final. Clients cannot switch it off with the caller-controlled
 * disable channels; only OmniRoute's own self-loop calls can (the chat moderator's
 * recursion guard).
 */

import { resolveSelfLoopBearer } from "@/shared/middleware/chatAdmissionIdentity";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";
import {
  evaluateTextPoliciesFor,
  extractPolicyText,
  TEXT_POLICY_GUARDRAIL_NAME,
  type PolicyEvaluation,
  type TextPolicyEngineDeps,
} from "@/lib/textPolicy";

import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";

export interface TextPolicyGuardrailDeps extends TextPolicyEngineDeps {
  /** True when the request is OmniRoute's own self-loop call (may skip this guardrail). */
  isSelfLoopRequest?: (context: GuardrailContext) => boolean;
}

function headerValue(headers: GuardrailContext["headers"], name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return null;
}

/** The request authenticated with the self-loop bearer (constant-time compare). */
export function isSelfLoopGuardrailRequest(context: GuardrailContext): boolean {
  const auth = headerValue(context.headers, "authorization")?.trim() ?? "";
  const match = /^bearer\s+(\S+)$/i.exec(auth);
  if (!match) return false;
  return timingSafeCompare(match[1].trim().toLowerCase(), resolveSelfLoopBearer().toLowerCase());
}

/** Per-policy summary placed in guardrail meta (no request text). */
function summarize(evaluation: PolicyEvaluation): Record<string, unknown> {
  return { ...evaluation.decision, ...evaluation.plan };
}

export class TextPolicyGuardrail extends BaseGuardrail {
  private readonly deps: TextPolicyGuardrailDeps;

  constructor(
    options: { enabled?: boolean; priority?: number } = {},
    deps: TextPolicyGuardrailDeps = {}
  ) {
    super(TEXT_POLICY_GUARDRAIL_NAME, {
      enabled: options.enabled,
      priority: options.priority ?? 40,
    });
    this.deps = deps;
  }

  allowCallerDisable(context: GuardrailContext): boolean {
    return (this.deps.isSelfLoopRequest ?? isSelfLoopGuardrailRequest)(context);
  }

  async preCall(payload: unknown, context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    if (!payload || typeof payload !== "object") return { block: false };
    const requestedModel =
      typeof (payload as { model?: unknown }).model === "string"
        ? (payload as { model: string }).model
        : (context.model ?? null);
    const apiKeyId =
      typeof context.apiKeyInfo?.id === "string" ? (context.apiKeyInfo.id as string) : null;

    const evaluations = await evaluateTextPoliciesFor(
      extractPolicyText(payload),
      { apiKeyId, requestedModel, signal: context.signal, log: context.log },
      this.deps
    );
    if (evaluations.length === 0) return { block: false };

    const meta = { evaluations: evaluations.map(summarize) };
    const acting = evaluations.find(
      (entry) => entry.plan.block || entry.plan.action === "rerouted"
    );
    for (const entry of evaluations) {
      if (entry.plan.action === "flagged" || entry.plan.action === "no_reroute_target") {
        context.log?.warn?.("TEXT_POLICY", `[${entry.definition.id}] ${entry.plan.action}`, {
          stage: entry.decision.stage,
          keywordScore: entry.decision.keywordScore,
          moderatorScore: entry.decision.moderatorScore,
        });
      }
    }
    if (!acting) return { block: false, meta };

    if (acting.plan.block) {
      context.log?.warn?.("TEXT_POLICY", `[${acting.definition.id}] blocked request`, {
        stage: acting.decision.stage,
        keywordScore: acting.decision.keywordScore,
        scope: acting.decision.scope,
      });
      return {
        block: true,
        message: `Request rejected by text policy: ${acting.definition.id}`,
        meta,
      };
    }

    // Like the vision bridge reroute (#14003): the answer comes from a different model
    // than the client named, so it is always visible in the log.
    context.log?.warn?.(
      "TEXT_POLICY",
      `[${acting.definition.id}] reroute ${requestedModel ?? "?"} -> ${acting.plan.toModel}`,
      { stage: acting.decision.stage, scope: acting.decision.scope }
    );
    return {
      block: false,
      modifiedPayload: { ...(payload as Record<string, unknown>), model: acting.plan.toModel },
      meta,
    };
  }
}
