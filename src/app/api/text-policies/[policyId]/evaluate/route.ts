import { NextResponse } from "next/server";
import { z } from "zod";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { evaluateTextPoliciesFor } from "@/lib/textPolicy";

import {
  invalidBody,
  readJsonBody,
  resolvePolicyParam,
  routeFailure,
} from "../../_shared/policyRoute";

export const dynamic = "force-dynamic";

/**
 * POST /api/text-policies/<id>/evaluate — run one policy on a piece of text and
 * return the decision and the action plan. For processes outside OmniRoute (a worker,
 * a CMS hook, a batch job) that want the same verdict the chat guardrail would give.
 * Nothing is rerouted or blocked here: the caller acts on `plan`.
 *
 * Body: { text, apiKeyId?, requestedModel?, learn? = false, ignoreEnabled? = false }
 * `learn` defaults to false so probes never grow the lexicon unless asked to.
 */

const evaluateSchema = z
  .object({
    text: z.string().min(1).max(200_000),
    apiKeyId: z.string().min(1).max(100).optional(),
    requestedModel: z.string().min(1).max(200).optional(),
    learn: z.boolean().optional(),
    ignoreEnabled: z.boolean().optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ policyId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
    const policy = await resolvePolicyParam(params);
    if ("error" in policy) return policy.error;
    const json = await readJsonBody(request);
    if (!json.ok) return json.error;
    const parsed = evaluateSchema.safeParse(json.body);
    if (!parsed.success) return invalidBody(parsed.error.issues);

    const [evaluation] = await evaluateTextPoliciesFor(parsed.data.text, {
      policyIds: [policy.definition.id],
      apiKeyId: parsed.data.apiKeyId ?? null,
      requestedModel: parsed.data.requestedModel ?? null,
      learn: parsed.data.learn === true,
      ignoreEnabled: parsed.data.ignoreEnabled === true,
      signal: request.signal,
    });
    if (!evaluation) {
      return NextResponse.json({ policy: policy.definition.id, enabled: false, decision: null });
    }
    return NextResponse.json({
      policy: policy.definition.id,
      enabled: evaluation.config.enabled,
      decision: evaluation.decision,
      plan: evaluation.plan,
    });
  } catch (error) {
    return routeFailure("POST /api/text-policies/[policyId]/evaluate", error);
  }
}
