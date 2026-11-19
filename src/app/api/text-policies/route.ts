import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCachedSettings } from "@/lib/db/readCache";
import { countTextPolicyTerms } from "@/lib/db/textPolicyTerms";
import { listTextPolicyDefinitions, resolveTextPolicyConfig } from "@/lib/textPolicy";

import { routeFailure } from "./_shared/policyRoute";

export const dynamic = "force-dynamic";

/**
 * GET /api/text-policies — every known text policy (built-in + defined in settings)
 * with its effective global config and learned-term counts. Seed terms are counted,
 * not listed.
 */
export async function GET(request: Request) {
  try {
    const authError = await requireManagementAuth(request);
    if (authError) return authError;
    const settings = await getCachedSettings();
    const policies = listTextPolicyDefinitions(settings).map((definition) => {
      let learnedTerms = { pending: 0, active: 0, rejected: 0 };
      try {
        learnedTerms = countTextPolicyTerms(definition.id);
      } catch {
        // table not migrated yet: report zero
      }
      return {
        id: definition.id,
        label: definition.label,
        description: definition.description ?? null,
        builtIn: definition.builtIn,
        priority: definition.priority,
        moderationCategory: definition.moderationCategory,
        classifierInstruction: definition.classifierInstruction,
        seedTermCount: definition.seedTerms.length,
        config: resolveTextPolicyConfig(settings, definition.id, null).config,
        learnedTerms,
      };
    });
    return NextResponse.json({ policies });
  } catch (error) {
    return routeFailure("GET /api/text-policies", error);
  }
}
