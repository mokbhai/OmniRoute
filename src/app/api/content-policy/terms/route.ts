import { NextResponse } from "next/server";
import { z } from "zod";

import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  CONTENT_POLICY_TERM_STATUSES,
  deleteContentPolicyTerm,
  listContentPolicyTerms,
  upsertContentPolicyTerm,
} from "@/lib/db/contentPolicyTerms";
import { invalidateLearnedTermsCache } from "@/lib/guardrails/contentPolicy/learning";

export const dynamic = "force-dynamic";

/**
 * Self-growing lexicon of the content-policy guardrail.
 *
 *   GET    /api/content-policy/terms[?status=pending|active|rejected]  list terms
 *   PUT    /api/content-policy/terms  { term, weight?, status? }       add or edit (activate, reject, reweight)
 *   DELETE /api/content-policy/terms  { term }                         remove (learning may add it again)
 *
 * To stop a term coming back, set `status: "rejected"` instead of deleting it.
 */

const statusSchema = z.enum(CONTENT_POLICY_TERM_STATUSES);

const upsertSchema = z
  .object({
    term: z.string().trim().min(1).max(48),
    weight: z.number().int().min(1).max(5).optional(),
    status: statusSchema.optional(),
  })
  .strict();

const deleteSchema = z.object({ term: z.string().trim().min(1).max(48) }).strict();

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const text = await request.text();
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function invalidBody(issues: z.ZodIssue[]) {
  return createErrorResponse({
    status: 400,
    message: "Invalid request body",
    details: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

function failure(action: string, error: unknown) {
  console.error(
    `[API] ${action} /api/content-policy/terms failed:`,
    error instanceof Error ? error.name : "unknown error"
  );
  return createErrorResponse({ status: 500, message: "Failed to update content-policy terms" });
}

export async function GET(request: Request) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
    const rawStatus = new URL(request.url).searchParams.get("status");
    const status = rawStatus ? statusSchema.safeParse(rawStatus) : null;
    if (status && !status.success) {
      return createErrorResponse({ status: 400, message: "Invalid status filter" });
    }
    return NextResponse.json({ terms: listContentPolicyTerms(status?.data) });
  } catch (error) {
    return failure("GET", error);
  }
}

export async function PUT(request: Request) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
    const json = await readJson(request);
    if (!json.ok) return createErrorResponse({ status: 400, message: "Invalid JSON body" });
    const parsed = upsertSchema.safeParse(json.body);
    if (!parsed.success) return invalidBody(parsed.error.issues);
    const term = upsertContentPolicyTerm(parsed.data);
    if (!term) return createErrorResponse({ status: 400, message: "Invalid term" });
    invalidateLearnedTermsCache();
    return NextResponse.json({ ok: true, term });
  } catch (error) {
    return failure("PUT", error);
  }
}

export async function DELETE(request: Request) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
    const json = await readJson(request);
    if (!json.ok) return createErrorResponse({ status: 400, message: "Invalid JSON body" });
    const parsed = deleteSchema.safeParse(json.body);
    if (!parsed.success) return invalidBody(parsed.error.issues);
    const deleted = deleteContentPolicyTerm(parsed.data.term);
    invalidateLearnedTermsCache();
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return failure("DELETE", error);
  }
}
