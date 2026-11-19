/**
 * Content-policy guardrail: detect adult/sexual requests and reroute, block, or flag them.
 *
 * Two stages, cheapest first:
 *   1. Keyword score on every request (`keywordScore.ts`, local, no network).
 *   2. Only when the score is in the middle band [lowThreshold, highThreshold) is the
 *      text sent to the configured moderation model (`moderator.ts`).
 *      Below the band the request is clean; at or above it, the request is adult.
 *      Neither of those two outcomes calls the moderator.
 *
 * Action for an adult request, by `mode`:
 *   - "reroute": replace `model` with `rerouteTarget`. chat.ts then applies the switch
 *     through `reconcileGuardrailReroute()` (same path as the vision bridge reroute),
 *     which keeps the original model if the caller's API key may not use the target.
 *   - "block":   reject with HTTP 400.
 *   - "flag":    let the request through unchanged; the decision is only recorded.
 *
 * Off by default. Configured globally and per API key under the `contentPolicy` setting
 * (`config.ts`). Fail-open: a moderator error lets the request through.
 *
 * Runs last among the pre-call guardrails (priority 40) so its model choice is the final one.
 */

import { getCachedSettings as defaultGetSettings } from "@/lib/db/readCache";
import { resolveSelfLoopBearer } from "@/shared/middleware/chatAdmissionIdentity";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";

import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "../base";
import { resolveContentPolicyConfig } from "./config";
import { CONTENT_POLICY_GUARDRAIL_NAME } from "./header";
import {
  classifyKeywordBand,
  extractContentPolicyText,
  scoreContentPolicyText,
  type KeywordBand,
  type KeywordTerm,
} from "./keywordScore";
import {
  loadActiveLearnedTerms,
  recordLearnedTerms,
  validateDiscoveredTerms,
  type DiscoveredTerm,
} from "./learning";
import {
  clipModeratorInput,
  defaultModerate,
  type ModerateFn,
  type ModeratorResult,
} from "./moderator";

export { CONTENT_POLICY_GUARDRAIL_NAME, buildContentPolicyHeader } from "./header";

export type ContentPolicyAction =
  "allowed" | "rerouted" | "blocked" | "flagged" | "already_target" | "no_reroute_target";

export interface ContentPolicyDecision {
  adult: boolean;
  /** Which stage made the decision. */
  stage: "keyword" | "moderator";
  band: KeywordBand;
  keywordScore: number;
  matchedTerms: string[];
  lowThreshold: number;
  highThreshold: number;
  scope: "global" | "key";
  action: ContentPolicyAction;
  moderatorModel?: string | null;
  moderatorScore?: number;
  moderatorThreshold?: number;
  moderatorCached?: boolean;
  /** Set when the moderator could not decide; the request then fails open. */
  moderatorError?: string;
  /** Learned lexicon terms that matched (subset of `matchedTerms`). */
  learnedMatches?: string[];
  /**
   * Chat moderator only: sexual terms it found in the request that are not in the
   * built-in lexicon, each with its weight (1 weak, 3 strong, 5 explicit).
   */
  discoveredTerms?: DiscoveredTerm[];
  /** What the self-growing lexicon did with `discoveredTerms`. */
  learning?: { mode: string; added: string[]; activated: string[]; skipped?: string };
  fromModel?: string;
  toModel?: string;
}

export interface ContentPolicyDependencies {
  getSettings?: () => Promise<Record<string, unknown>>;
  moderate?: ModerateFn;
  loadLearnedTerms?: () => Promise<KeywordTerm[]>;
  recordLearnedTerms?: typeof recordLearnedTerms;
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
  const match = /^bearer\s+(\S+)$/i.exec(
    headerValue(context.headers, "authorization")?.trim() ?? ""
  );
  if (!match) return false;
  return timingSafeCompare(match[1].trim().toLowerCase(), resolveSelfLoopBearer().toLowerCase());
}

const BLOCK_MESSAGE = "Request rejected by content policy";

export class ContentPolicyGuardrail extends BaseGuardrail {
  private readonly deps: ContentPolicyDependencies;

  constructor(
    options: { enabled?: boolean; priority?: number } = {},
    deps: ContentPolicyDependencies = {}
  ) {
    super(CONTENT_POLICY_GUARDRAIL_NAME, {
      enabled: options.enabled,
      priority: options.priority ?? 40,
    });
    this.deps = deps;
  }

  /**
   * Operator policy: a client cannot switch it off with the disable header/body
   * channels. Only OmniRoute's own self-loop calls (the chat moderator, bridges) can.
   * Per-key opt-out is `contentPolicy.keyOverrides[<keyId>].enabled = false`.
   */
  allowCallerDisable(context: GuardrailContext): boolean {
    return (this.deps.isSelfLoopRequest ?? isSelfLoopGuardrailRequest)(context);
  }

  async preCall(payload: unknown, context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    if (!payload || typeof payload !== "object") return { block: false };

    let settings: Record<string, unknown> = {};
    try {
      settings = await (this.deps.getSettings ?? defaultGetSettings)();
    } catch {
      return { block: false };
    }
    const apiKeyId =
      typeof context.apiKeyInfo?.id === "string" ? (context.apiKeyInfo.id as string) : null;
    const { config, scope } = resolveContentPolicyConfig(settings, apiKeyId);
    if (!config.enabled) return { block: false };

    const text = extractContentPolicyText(payload);
    let learnedTerms: KeywordTerm[] = [];
    try {
      learnedTerms = await (this.deps.loadLearnedTerms ?? loadActiveLearnedTerms)();
    } catch {
      learnedTerms = [];
    }
    const { score, matchedTerms, learnedMatches } = scoreContentPolicyText(text, learnedTerms);
    const band = classifyKeywordBand(score, config.lowThreshold, config.highThreshold);
    const decision: ContentPolicyDecision = {
      adult: band === "above",
      stage: "keyword",
      band,
      keywordScore: score,
      matchedTerms: matchedTerms.slice(0, 10),
      lowThreshold: config.lowThreshold,
      highThreshold: config.highThreshold,
      scope,
      action: "allowed",
    };
    if (learnedMatches.length > 0) decision.learnedMatches = learnedMatches.slice(0, 10);

    if (band === "middle") {
      decision.stage = "moderator";
      decision.moderatorModel = config.moderatorModel;
      decision.moderatorThreshold = config.moderationScoreThreshold;
      if (!config.moderatorModel) {
        decision.moderatorError = "no_moderator_model";
      } else {
        let verdict: ModeratorResult;
        try {
          verdict = await (this.deps.moderate ?? defaultModerate)({
            model: config.moderatorModel,
            text: clipModeratorInput(text),
            signal: context.signal,
          });
        } catch {
          verdict = { ok: false, reason: "moderator_error" };
        }
        if (verdict.ok) {
          decision.moderatorScore = verdict.sexualScore;
          decision.moderatorCached = verdict.cached;
          decision.adult = verdict.sexualScore >= config.moderationScoreThreshold;
          if (verdict.kind === "chat") {
            decision.discoveredTerms = validateDiscoveredTerms(verdict.terms, text);
            await this.learn(decision, config, verdict.cached, context);
          }
        } else {
          decision.moderatorError = verdict.reason;
        }
      }
      if (decision.moderatorError) {
        context.log?.warn?.(
          "CONTENT_POLICY",
          `Moderator unavailable (${decision.moderatorError}); letting middle-band request through`,
          { keywordScore: score, moderatorModel: config.moderatorModel }
        );
      }
    }

    if (!decision.adult) {
      return { block: false, meta: { ...decision } };
    }

    const requestedModel =
      typeof (payload as { model?: unknown }).model === "string"
        ? (payload as { model: string }).model
        : (context.model ?? "");
    decision.fromModel = requestedModel;

    if (config.mode === "block") {
      decision.action = "blocked";
      context.log?.warn?.("CONTENT_POLICY", "Blocked adult request", logMeta(decision));
      return { block: true, message: BLOCK_MESSAGE, meta: { ...decision } };
    }

    if (config.mode === "flag") {
      decision.action = "flagged";
      context.log?.info?.("CONTENT_POLICY", "Flagged adult request", logMeta(decision));
      return { block: false, meta: { ...decision } };
    }

    if (!config.rerouteTarget) {
      decision.action = "no_reroute_target";
      context.log?.warn?.(
        "CONTENT_POLICY",
        "Adult request detected but no rerouteTarget is configured; passing through",
        logMeta(decision)
      );
      return { block: false, meta: { ...decision } };
    }

    decision.toModel = config.rerouteTarget;
    if (config.rerouteTarget === requestedModel) {
      decision.action = "already_target";
      return { block: false, meta: { ...decision } };
    }

    decision.action = "rerouted";
    // Like the vision bridge reroute (#14003): the answer comes from a different model
    // than the client named, so it is always visible in the log.
    context.log?.warn?.(
      "CONTENT_POLICY",
      `Content-policy reroute ${requestedModel} -> ${config.rerouteTarget}`,
      logMeta(decision)
    );
    return {
      block: false,
      modifiedPayload: { ...(payload as Record<string, unknown>), model: config.rerouteTarget },
      meta: { ...decision },
    };
  }

  /**
   * Self-growing lexicon. Only adult verdicts teach, only fresh (uncached) verdicts
   * count as a hit, and "off" reports terms without storing them.
   */
  private async learn(
    decision: ContentPolicyDecision,
    config: { learnMode: string; learnMinHits: number; moderatorModel: string | null },
    cached: boolean,
    context: GuardrailContext
  ): Promise<void> {
    const terms = decision.discoveredTerms ?? [];
    const learning: NonNullable<ContentPolicyDecision["learning"]> = {
      mode: config.learnMode,
      added: [],
      activated: [],
    };
    decision.learning = learning;
    if (terms.length === 0) return void (learning.skipped = "no_new_terms");
    if (config.learnMode === "off") return void (learning.skipped = "learning_off");
    if (!decision.adult) return void (learning.skipped = "not_adult");
    if (cached) return void (learning.skipped = "cached_verdict");
    try {
      const result = await (this.deps.recordLearnedTerms ?? recordLearnedTerms)(terms, {
        autoActivate: config.learnMode === "auto",
        minHits: config.learnMinHits,
        moderatorModel: config.moderatorModel,
      });
      learning.added = result.added;
      learning.activated = result.activated;
      if (result.activated.length > 0) {
        context.log?.info?.("CONTENT_POLICY", "Learned lexicon terms activated", {
          count: result.activated.length,
        });
      }
    } catch {
      learning.skipped = "store_error";
    }
  }
}

/** Log metadata without request text (matched terms are lexicon entries only). */
function logMeta(decision: ContentPolicyDecision): Record<string, unknown> {
  return {
    stage: decision.stage,
    band: decision.band,
    keywordScore: decision.keywordScore,
    moderatorScore: decision.moderatorScore,
    scope: decision.scope,
    action: decision.action,
  };
}
