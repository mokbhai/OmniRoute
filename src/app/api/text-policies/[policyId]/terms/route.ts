import { NextResponse } from "next/server";
import { z } from "zod";

import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  TEXT_POLICY_TERM_STATUSES,
  deleteTextPolicyTerm,
  listTextPolicyTerms,
  upsertTextPolicyTerm,
} from "@/lib/db/textPolicyTerms";
import { invalidateLearnedTermsCache } from "@/lib/textPolicy";

import {
  invalidBody,
  readJsonBody,
  resolvePolicyParam,
  routeFailure,
} from "../../_shared/policyRoute";

export const dynamic = "force-dynamic";

/**
 * Learned terms of one text policy.
 *
 *   GET    /api/text-policies/<id>/terms[?status=pending|active|rejected]
 *   PUT    /api/text-policies/<id>/terms  { term, weight?, status? }  add / activate / reject / reweight
 *   DELETE /api/text-policies/<id>/terms  { term }                    remove (learning may add it again)
 */

const statusSchema = z.enum(TEXT_POLICY_TERM_STATUSES);
const upsertSchema = z
  .object({
    term: z.string().trim().min(1).max(48),
    weight: z.number().int().min(1).max(5).optional(),
    status: statusSchema.optional(),
  })
  .strict();
const deleteSchema = z.object({ term: z.string().trim().min(1).max(48) }).strict();

type RouteContext = { params: Promise<{ policyId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
    const policy = await resolvePolicyParam(params);
    if ("error" in policy) return policy.error;
    const rawStatus = new URL(request.url).searchParams.get("status");
    const status = rawStatus ? statusSchema.safeParse(rawStatus) : null;
    if (status && !status.success) {
      return createErrorResponse({ status: 400, message: "Invalid status filter" });
    }
    return NextResponse.json({
      policy: policy.definition.id,
      terms: listTextPolicyTerms(policy.definition.id, status?.data),
    });
  } catch (error) {
    return routeFailure("GET /api/text-policies/[policyId]/terms", error);
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
    const policy = await resolvePolicyParam(params);
    if ("error" in policy) return policy.error;
    const json = await readJsonBody(request);
    if (!json.ok) return json.error;
    const parsed = upsertSchema.safeParse(json.body);
    if (!parsed.success) return invalidBody(parsed.error.issues);
    const term = upsertTextPolicyTerm(policy.definition.id, parsed.data);
    if (!term) return createErrorResponse({ status: 400, message: "Invalid term" });
    invalidateLearnedTermsCache(policy.definition.id);
    return NextResponse.json({ ok: true, term });
  } catch (error) {
    return routeFailure("PUT /api/text-policies/[policyId]/terms", error);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
    const policy = await resolvePolicyParam(params);
    if ("error" in policy) return policy.error;
    const json = await readJsonBody(request);
    if (!json.ok) return json.error;
    const parsed = deleteSchema.safeParse(json.body);
    if (!parsed.success) return invalidBody(parsed.error.issues);
    const deleted = deleteTextPolicyTerm(policy.definition.id, parsed.data.term);
    invalidateLearnedTermsCache(policy.definition.id);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return routeFailure("DELETE /api/text-policies/[policyId]/terms", error);
  }
}
