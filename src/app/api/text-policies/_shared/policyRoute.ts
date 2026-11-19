import { z } from "zod";

import { createErrorResponse } from "@/lib/api/errorResponse";
import { getCachedSettings } from "@/lib/db/readCache";
import { resolveTextPolicyDefinition, type TextPolicyDefinition } from "@/lib/textPolicy";
import { TEXT_POLICY_ID_PATTERN } from "@/shared/validation/textPolicySchema";

/** Resolve the `[policyId]` path segment to a known policy, or an error response. */
export async function resolvePolicyParam(
  params: Promise<{ policyId?: string }> | { policyId?: string } | undefined
): Promise<{ definition: TextPolicyDefinition } | { error: Response }> {
  const { policyId } = (await params) ?? {};
  if (typeof policyId !== "string" || !TEXT_POLICY_ID_PATTERN.test(policyId)) {
    return { error: createErrorResponse({ status: 400, message: "Invalid policy id" }) };
  }
  const definition = resolveTextPolicyDefinition(policyId, await getCachedSettings());
  if (!definition) {
    return { error: createErrorResponse({ status: 404, message: "Unknown text policy" }) };
  }
  return { definition };
}

export async function readJsonBody(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; error: Response }> {
  const text = await request.text();
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, error: createErrorResponse({ status: 400, message: "Invalid JSON body" }) };
  }
}

export function invalidBody(issues: z.ZodIssue[]): Response {
  return createErrorResponse({
    status: 400,
    message: "Invalid request body",
    details: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

export function routeFailure(route: string, error: unknown): Response {
  console.error(`[API] ${route} failed:`, error instanceof Error ? error.name : "unknown error");
  return createErrorResponse({ status: 500, message: "Text policy request failed" });
}
