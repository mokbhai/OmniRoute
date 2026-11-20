/**
 * Text policy engine — public surface for any OmniRoute process.
 *
 * Typical use from a route, handler, MCP tool or background job:
 *
 *   import { evaluateTextPoliciesFor } from "@/lib/textPolicy";
 *
 *   const [first] = await evaluateTextPoliciesFor(prompt, {
 *     apiKeyId: apiKeyInfo?.id,
 *     requestedModel: body.model,
 *   });
 *   if (first?.plan.block) return reject(...);
 *   if (first?.plan.toModel && first.plan.action === "rerouted") body.model = first.plan.toModel;
 *
 * Add a policy in code with `registerTextPolicy({...})`, or without code under
 * `settings.textPolicies.<id>` (see docs/security/TEXT_POLICIES.md).
 */

export {
  listBuiltInTextPolicies,
  listTextPolicyDefinitions,
  readTextPolicySettings,
  registerTextPolicy,
  resolveTextPolicyDefinition,
} from "./catalog";
export { DEFAULT_TEXT_POLICY_CONFIG, resolveTextPolicyConfig } from "./config";
export {
  evaluateTextPoliciesFor,
  evaluateTextPolicy,
  planTextPolicyAction,
  type EvaluateForOptions,
  type EvaluateTextPolicyInput,
  type PolicyEvaluation,
  type TextPolicyEngineDeps,
  type TextPolicyLog,
} from "./engine";
export { clipPolicyText, extractPolicyText } from "./extract";
export { buildTextPolicyHeader, TEXT_POLICY_GUARDRAIL_NAME, TEXT_POLICY_HEADER } from "./header";
export { classifyKeywordBand, scoreText } from "./lexicon";
export { invalidateLearnedTermsCache, validateDiscoveredTerms } from "./learning";
export {
  isOwnModeratorRequest,
  MAX_IN_FLIGHT_CHAT_MODERATOR_CALLS,
  MODERATOR_NONCE_HEADER,
} from "./moderator";
export type { ModerateFn, ModeratorPolicy, ModeratorResult } from "./moderator";
export { SEXUAL_CONTENT_POLICY } from "./policies/sexualContent";
export type * from "./types";
