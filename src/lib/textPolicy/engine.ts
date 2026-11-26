/**
 * Text policy engine: the one implementation every caller shares.
 *
 *   evaluateTextPolicy()       pure pipeline: keyword score → (middle band) moderator → learning.
 *                              Takes an explicit definition + config. No settings, no action.
 *   evaluateTextPoliciesFor()  convenience for a process: loads settings, resolves every
 *                              enabled policy for the caller's API key, evaluates them in
 *                              priority order. Optional `policyIds` narrows the set.
 *   planTextPolicyAction()     turns a decision + config into what the caller must do
 *                              (allow / reroute to a model / block / flag).
 *
 * The chat guardrail (`src/lib/guardrails/textPolicy.ts`) and the HTTP evaluate route
 * (`/api/text-policies/<id>/evaluate`) are both thin callers of these functions.
 */

import { getCachedSettings } from "@/lib/db/readCache";

import { listTextPolicyDefinitions, resolveTextPolicyDefinition } from "./catalog";
import { resolveTextPolicyConfig } from "./config";
import { classifyKeywordBand, scoreText } from "./lexicon";
import {
  classifyDiscoveredTerms,
  loadActiveLearnedTerms,
  recordLearnedTerms,
  translateAcceptedTerms,
} from "./learning";
import {
  clipModeratorInput,
  defaultModerate,
  type ModerateFn,
  type ModeratorResult,
} from "./moderator";
import type {
  KeywordTerm,
  TextPolicyActionPlan,
  TextPolicyConfig,
  TextPolicyDecision,
  TextPolicyDefinition,
} from "./types";

export interface TextPolicyLog {
  info?: (tag: string, message: string, meta?: Record<string, unknown>) => void;
  warn?: (tag: string, message: string, meta?: Record<string, unknown>) => void;
}

/** Injection points. Tests and alternative runtimes replace any of them. */
export interface TextPolicyEngineDeps {
  getSettings?: () => Promise<Record<string, unknown>>;
  moderate?: ModerateFn;
  loadLearnedTerms?: (policyId: string) => Promise<KeywordTerm[]>;
  recordLearnedTerms?: typeof recordLearnedTerms;
  /** Requests translations of newly accepted terms. Default: in the background. */
  translateTerms?: (
    policy: TextPolicyDefinition,
    terms: string[],
    config: TextPolicyConfig
  ) => Promise<unknown>;
}

export interface EvaluateTextPolicyInput {
  policy: TextPolicyDefinition;
  config: TextPolicyConfig;
  /** Plain text to check. Use `extractPolicyText()` for a request body. */
  text: string;
  scope?: "global" | "key";
  /** false = report discovered terms but never store them (e.g. dry runs). Default true. */
  learn?: boolean;
  signal?: AbortSignal;
  log?: TextPolicyLog | null;
}

/** Run the detection pipeline for one policy. Never throws; moderator failures fail open. */
export async function evaluateTextPolicy(
  input: EvaluateTextPolicyInput,
  deps: TextPolicyEngineDeps = {}
): Promise<TextPolicyDecision> {
  const { policy, config, text, log } = input;
  let learned: KeywordTerm[] = [];
  try {
    learned = await (deps.loadLearnedTerms ?? loadActiveLearnedTerms)(policy.id);
  } catch {
    learned = [];
  }
  const { score, matchedTerms, learnedMatches } = scoreText(text, policy.seedTerms, learned);
  const band = classifyKeywordBand(score, config.lowThreshold, config.highThreshold);
  const decision: TextPolicyDecision = {
    policy: policy.id,
    violation: band === "above",
    stage: "keyword",
    band,
    keywordScore: score,
    matchedTerms: matchedTerms.slice(0, 10),
    lowThreshold: config.lowThreshold,
    highThreshold: config.highThreshold,
    scope: input.scope ?? "global",
  };
  if (learnedMatches.length > 0) decision.learnedMatches = learnedMatches.slice(0, 10);
  if (band !== "middle") return decision;

  decision.stage = "moderator";
  decision.moderatorModel = config.moderatorModel;
  decision.moderatorThreshold = config.moderationScoreThreshold;
  if (!config.moderatorModel) {
    decision.moderatorError = "no_moderator_model";
  } else {
    let verdict: ModeratorResult;
    try {
      verdict = await (deps.moderate ?? defaultModerate)({
        policy,
        model: config.moderatorModel,
        text: clipModeratorInput(text),
        signal: input.signal,
      });
    } catch {
      verdict = { ok: false, reason: "moderator_error" };
    }
    if (verdict.ok) {
      decision.moderatorKind = verdict.kind;
      decision.moderatorScore = verdict.score;
      decision.moderatorCached = verdict.cached;
      decision.violation = verdict.score >= config.moderationScoreThreshold;
      if (verdict.kind === "chat") {
        const { terms, ignored } = classifyDiscoveredTerms(verdict.terms, text, policy);
        decision.discoveredTerms = terms;
        if (ignored.length > 0) decision.ignoredTerms = ignored;
        await learnFromVerdict(
          policy,
          decision,
          config,
          verdict.cached,
          input.learn !== false,
          deps,
          log
        );
      }
    } else {
      decision.moderatorError = verdict.reason;
    }
  }
  if (decision.moderatorError) {
    log?.warn?.(
      "TEXT_POLICY",
      `[${policy.id}] moderator unavailable (${decision.moderatorError}); failing open`,
      { keywordScore: score, moderatorModel: config.moderatorModel }
    );
  }
  return decision;
}

/**
 * Only fresh, confident violations teach: cached verdicts, clean verdicts, verdicts below
 * `learnMinModeratorScore` and dry runs never add hits.
 */
async function learnFromVerdict(
  policy: TextPolicyDefinition,
  decision: TextPolicyDecision,
  config: TextPolicyConfig,
  cached: boolean,
  learnAllowed: boolean,
  deps: TextPolicyEngineDeps,
  log?: TextPolicyLog | null
): Promise<void> {
  const terms = decision.discoveredTerms ?? [];
  const outcome: NonNullable<TextPolicyDecision["learning"]> = {
    mode: config.learnMode,
    added: [],
    activated: [],
  };
  decision.learning = outcome;
  if (terms.length === 0) outcome.skipped = "no_new_terms";
  else if (config.learnMode === "off" || !learnAllowed) outcome.skipped = "learning_off";
  else if (!decision.violation) outcome.skipped = "no_violation";
  else if ((decision.moderatorScore ?? 0) < config.learnMinModeratorScore)
    outcome.skipped = "low_confidence";
  else if (cached) outcome.skipped = "cached_verdict";
  if (outcome.skipped) return;
  try {
    const result = await (deps.recordLearnedTerms ?? recordLearnedTerms)(decision.policy, terms, {
      autoActivate: config.learnMode === "auto",
      minHits: config.learnMinHits,
      moderatorModel: config.moderatorModel,
    });
    outcome.added = result.added;
    outcome.activated = result.activated;
    if (result.activated.length > 0) {
      log?.info?.("TEXT_POLICY", `[${decision.policy}] learned terms activated`, {
        count: result.activated.length,
      });
      if (config.moderatorModel && config.translateLanguages.length > 0) {
        outcome.translating = result.activated;
        // Never blocks the request: translations are a second model call.
        const translate = deps.translateTerms ?? translateAcceptedTerms;
        void Promise.resolve()
          .then(() => translate(policy, result.activated, config))
          .catch(() => undefined);
      }
    }
  } catch {
    outcome.skipped = "store_error";
  }
}

/** What the caller must do with a decision. Pure; the caller applies it. */
export function planTextPolicyAction(
  decision: TextPolicyDecision,
  config: TextPolicyConfig,
  requestedModel?: string | null
): TextPolicyActionPlan {
  const fromModel = requestedModel ?? undefined;
  if (!decision.violation) return { action: "allowed", block: false, fromModel };
  if (config.mode === "block") return { action: "blocked", block: true, fromModel };
  if (config.mode === "flag") return { action: "flagged", block: false, fromModel };
  if (!config.rerouteTarget) return { action: "no_reroute_target", block: false, fromModel };
  if (config.rerouteTarget === requestedModel) {
    return { action: "already_target", block: false, fromModel, toModel: config.rerouteTarget };
  }
  return { action: "rerouted", block: false, fromModel, toModel: config.rerouteTarget };
}

export interface PolicyEvaluation {
  definition: TextPolicyDefinition;
  config: TextPolicyConfig;
  decision: TextPolicyDecision;
  plan: TextPolicyActionPlan;
}

export interface EvaluateForOptions {
  apiKeyId?: string | null;
  /** Only these policies (still subject to `enabled`). Default: every known policy. */
  policyIds?: string[];
  /** Used by `planTextPolicyAction` for reroute decisions. */
  requestedModel?: string | null;
  /** Stop after the first policy whose plan blocks or reroutes. Default true. */
  stopOnAction?: boolean;
  learn?: boolean;
  /** Evaluate even when the policy is disabled (dry runs / admin testing). */
  ignoreEnabled?: boolean;
  signal?: AbortSignal;
  log?: TextPolicyLog | null;
}

/**
 * Evaluate every enabled policy for one caller, in priority order. This is the entry
 * point other processes use: pass the text and the caller's API key id, act on the plans.
 */
export async function evaluateTextPoliciesFor(
  text: string,
  options: EvaluateForOptions = {},
  deps: TextPolicyEngineDeps = {}
): Promise<PolicyEvaluation[]> {
  let settings: Record<string, unknown> = {};
  try {
    settings = await (deps.getSettings ?? getCachedSettings)();
  } catch {
    return [];
  }
  const definitions = options.policyIds
    ? options.policyIds
        .map((id) => resolveTextPolicyDefinition(id, settings))
        .filter((entry): entry is TextPolicyDefinition => entry !== null)
        .sort((left, right) => left.priority - right.priority)
    : listTextPolicyDefinitions(settings);

  const evaluations: PolicyEvaluation[] = [];
  for (const definition of definitions) {
    const { config, scope } = resolveTextPolicyConfig(settings, definition.id, options.apiKeyId);
    if (!config.enabled && !options.ignoreEnabled) continue;
    const decision = await evaluateTextPolicy(
      {
        policy: definition,
        config,
        text,
        scope,
        learn: options.learn,
        signal: options.signal,
        log: options.log,
      },
      deps
    );
    const plan = planTextPolicyAction(decision, config, options.requestedModel);
    evaluations.push({ definition, config, decision, plan });
    if (options.stopOnAction !== false && (plan.block || plan.action === "rerouted")) break;
  }
  return evaluations;
}
