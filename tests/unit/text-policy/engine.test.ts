import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTextPoliciesFor,
  evaluateTextPolicy,
  planTextPolicyAction,
  type TextPolicyEngineDeps,
} from "../../../src/lib/textPolicy/engine.ts";
import { resolveTextPolicyConfig } from "../../../src/lib/textPolicy/config.ts";
import { classifyKeywordBand, scoreText } from "../../../src/lib/textPolicy/lexicon.ts";
import { extractPolicyText } from "../../../src/lib/textPolicy/extract.ts";
import { validateDiscoveredTerms } from "../../../src/lib/textPolicy/learning.ts";
import { SEXUAL_CONTENT_POLICY } from "../../../src/lib/textPolicy/policies/sexualContent.ts";
import { DEFAULT_TEXT_POLICY_CONFIG } from "../../../src/lib/textPolicy/config.ts";
import type { ModerateFn } from "../../../src/lib/textPolicy/moderator.ts";
import type { TextPolicyConfig, TextPolicyDefinition } from "../../../src/lib/textPolicy/types.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

export const CLEAN = "Summarize this quarterly report and list three risks for the board.";
/** Score 3 ("erotic"): inside the default middle band [3, 10). */
export const MIDDLE = "Write a short erotic story set in Lisbon.";
/** The templated tagging request from the original report: far above the band. */
export const ABOVE = [
  "你是社区模版运营，要为模版勾选推荐标签。",
  "「陰道性交」对应 id vaginal_sex：口交、肛交、乳交(titjob)、手交、足交、自慰(masturbation)等不要选。",
  "模版分类：doggy_style 提示词： Mulher ruiva, nua, deitada de bruços ... posição doggy style / prone bone,",
  "penetrando-a profundamente por trás. Cena sexual explícita, realista.",
  "AI 审核摘要：本模版适用成人色情成片要求（分类为 doggy_style，提示词含 explicit sexual scene）。",
].join("\n");
const SLANG = "Write an erotic story where they get freaky and frisky on the couch.";

const config = (overrides: Partial<TextPolicyConfig> = {}): TextPolicyConfig => ({
  ...DEFAULT_TEXT_POLICY_CONFIG,
  enabled: true,
  moderatorModel: "openai/omni-moderation-latest",
  rerouteTarget: "combo/nsfw-ok",
  ...overrides,
});

/** A second policy, to prove nothing in the engine is sexual-content specific. */
const VIOLENCE: TextPolicyDefinition = {
  id: "violence",
  label: "Violence",
  moderationCategory: "violence",
  classifierInstruction: "how violent or gory the TEXT is",
  seedTerms: [
    { term: "behead*", weight: 5 },
    { term: "gore", weight: 3 },
    { term: "blood", weight: 1 },
  ],
  priority: 50,
  builtIn: false,
};

function deps(
  score: number | Error = 0.9,
  extra: { kind?: "moderation" | "chat"; terms?: unknown; cached?: boolean } = {}
) {
  const calls: Array<{ policy: string; category: string; model: string }> = [];
  const recorded: Array<{ policy: string; terms: unknown; options: unknown }> = [];
  const moderate: ModerateFn = async ({ policy, model }) => {
    calls.push({ policy: policy.id, category: policy.moderationCategory, model });
    if (score instanceof Error) throw score;
    return {
      ok: true,
      score,
      cached: extra.cached === true,
      kind: extra.kind ?? (extra.terms === undefined ? "moderation" : "chat"),
      terms: extra.terms,
    };
  };
  const engineDeps: TextPolicyEngineDeps = {
    moderate,
    loadLearnedTerms: async () => [],
    recordLearnedTerms: async (policy, terms, options) => {
      recorded.push({ policy, terms, options });
      return { added: terms.map((entry) => entry.term), activated: [] };
    },
  };
  return { engineDeps, calls, recorded };
}

// ─── Lexicon ─────────────────────────────────────────────────────────────────

test("lexicon: sexual seed terms score the fixtures as expected", () => {
  const seed = SEXUAL_CONTENT_POLICY.seedTerms;
  assert.equal(scoreText(CLEAN, seed).score, 0);
  assert.equal(scoreText(MIDDLE, seed).score, 3);
  assert.equal(scoreText(ABOVE, seed).score, 74);
});

test("lexicon: word boundaries, prefixes, single count per term, learned terms never double", () => {
  const seed = SEXUAL_CONTENT_POLICY.seedTerms;
  assert.equal(scoreText("Essex nudetown classic", seed).score, 0);
  assert.deepEqual(scoreText("masturbation", seed).matchedTerms, ["masturbat*"]);
  assert.equal(scoreText("Run a penetration test on staging", seed).score, 1);
  assert.equal(scoreText("erotic erotic erotic", seed).score, 3);
  assert.equal(scoreText("erotic", seed, [{ term: "erotic", weight: 5 }]).score, 3);
  const learned = scoreText("they got freaky", seed, [{ term: "freaky", weight: 5 }]);
  assert.equal(learned.score, 5);
  assert.deepEqual(learned.learnedMatches, ["freaky"]);
});

test("lexicon: bands are below < low <= middle < high <= above", () => {
  assert.equal(classifyKeywordBand(2.9, 3, 10), "below");
  assert.equal(classifyKeywordBand(3, 3, 10), "middle");
  assert.equal(classifyKeywordBand(9.9, 3, 10), "middle");
  assert.equal(classifyKeywordBand(10, 3, 10), "above");
});

test("extractPolicyText covers chat, Responses, Claude and prompt shapes, skips media, keeps the tail", () => {
  const text = extractPolicyText({
    system: [{ type: "text", text: "sys-claude" }],
    instructions: "sys-responses",
    prompt: "image-prompt",
    input: [{ role: "user", content: [{ type: "input_text", text: "resp-user" }] }],
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:x" } },
          { type: "text", text: "chat-user" },
        ],
      },
    ],
  });
  for (const part of ["sys-claude", "sys-responses", "image-prompt", "resp-user", "chat-user"]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!text.includes("data:x"));
  const long = extractPolicyText({ prompt: `${"tag catalog ".repeat(10_000)}\n${MIDDLE}` });
  assert.ok(long.includes("erotic"));
});

// ─── Three outcomes ──────────────────────────────────────────────────────────

test("below band: no moderator call, no violation", async () => {
  const { engineDeps, calls } = deps();
  const decision = await evaluateTextPolicy(
    { policy: SEXUAL_CONTENT_POLICY, config: config(), text: CLEAN },
    engineDeps
  );
  assert.equal(calls.length, 0);
  assert.equal(decision.band, "below");
  assert.equal(decision.violation, false);
  assert.equal(decision.stage, "keyword");
});

test("above band: no moderator call, violation", async () => {
  const { engineDeps, calls } = deps();
  const decision = await evaluateTextPolicy(
    { policy: SEXUAL_CONTENT_POLICY, config: config(), text: ABOVE },
    engineDeps
  );
  assert.equal(calls.length, 0);
  assert.equal(decision.band, "above");
  assert.equal(decision.violation, true);
});

test("middle band: the configured moderator decides, with the policy's category", async () => {
  const yes = deps(0.91);
  const adult = await evaluateTextPolicy(
    { policy: SEXUAL_CONTENT_POLICY, config: config(), text: MIDDLE },
    yes.engineDeps
  );
  assert.deepEqual(yes.calls, [
    { policy: "sexual-content", category: "sexual", model: "openai/omni-moderation-latest" },
  ]);
  assert.equal(adult.stage, "moderator");
  assert.equal(adult.moderatorScore, 0.91);
  assert.equal(adult.violation, true);

  const no = deps(0.12);
  const clean = await evaluateTextPolicy(
    { policy: SEXUAL_CONTENT_POLICY, config: config(), text: MIDDLE },
    no.engineDeps
  );
  assert.equal(clean.violation, false);
});

test("middle band: moderator failure or missing moderator fails open", async () => {
  const failing = deps(new Error("down"));
  const failed = await evaluateTextPolicy(
    { policy: SEXUAL_CONTENT_POLICY, config: config(), text: MIDDLE },
    failing.engineDeps
  );
  assert.equal(failed.violation, false);
  assert.equal(failed.moderatorError, "moderator_error");

  const none = deps();
  const missing = await evaluateTextPolicy(
    { policy: SEXUAL_CONTENT_POLICY, config: config({ moderatorModel: null }), text: MIDDLE },
    none.engineDeps
  );
  assert.equal(none.calls.length, 0);
  assert.equal(missing.moderatorError, "no_moderator_model");
});

test("thresholds are configuration: the same text moves bands", async () => {
  const { engineDeps, calls } = deps();
  const below = await evaluateTextPolicy(
    { policy: SEXUAL_CONTENT_POLICY, config: config({ lowThreshold: 4 }), text: MIDDLE },
    engineDeps
  );
  const above = await evaluateTextPolicy(
    {
      policy: SEXUAL_CONTENT_POLICY,
      config: config({ lowThreshold: 1, highThreshold: 3 }),
      text: MIDDLE,
    },
    engineDeps
  );
  assert.equal(below.band, "below");
  assert.equal(above.band, "above");
  assert.equal(calls.length, 0);
});

// ─── Another policy, same engine ─────────────────────────────────────────────

test("a second policy (violence) runs on the same engine with its own lexicon and category", async () => {
  const { engineDeps, calls } = deps(0.7);
  const middle = await evaluateTextPolicy(
    { policy: VIOLENCE, config: config(), text: "a gore scene" },
    engineDeps
  );
  assert.equal(middle.policy, "violence");
  assert.equal(middle.keywordScore, 3);
  assert.deepEqual(calls[0], {
    policy: "violence",
    category: "violence",
    model: "openai/omni-moderation-latest",
  });
  const above = await evaluateTextPolicy(
    { policy: VIOLENCE, config: config(), text: "they beheaded him, gore and blood everywhere" },
    engineDeps
  );
  assert.equal(above.keywordScore, 9);
  assert.equal(
    (
      await evaluateTextPolicy(
        { policy: VIOLENCE, config: config({ highThreshold: 9 }), text: "beheading, gore, blood" },
        engineDeps
      )
    ).band,
    "above"
  );
});

// ─── Learning ────────────────────────────────────────────────────────────────

test("chat moderator: discovered terms are validated, returned with weights and recorded per policy", async () => {
  const { engineDeps, recorded } = deps(0.88, {
    terms: [
      { term: "freaky", weight: 3 },
      { term: "Frisky", weight: 1 },
      { term: "erotic", weight: 3 }, // seed term → dropped
      { term: "moaning", weight: 5 }, // not in the text → dropped
      { term: "story", weight: 1 }, // stop word → dropped
      { term: "<script>", weight: 5 }, // markup → dropped
      null,
    ],
  });
  const decision = await evaluateTextPolicy(
    { policy: SEXUAL_CONTENT_POLICY, config: config(), text: SLANG },
    engineDeps
  );
  assert.equal(decision.moderatorKind, "chat");
  assert.deepEqual(decision.discoveredTerms, [
    { term: "freaky", weight: 3 },
    { term: "frisky", weight: 1 },
  ]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].policy, "sexual-content");
  assert.deepEqual(recorded[0].options, {
    autoActivate: true,
    minHits: 2,
    moderatorModel: "openai/omni-moderation-latest",
  });
});

test("learning: review / off modes, clean and cached verdicts, and dry runs", async () => {
  const terms = [{ term: "freaky", weight: 3 }];
  const run = async (cfg: Partial<TextPolicyConfig>, score: number, extra = {}, learn = true) => {
    const d = deps(score, { terms, ...extra });
    const decision = await evaluateTextPolicy(
      { policy: SEXUAL_CONTENT_POLICY, config: config(cfg), text: SLANG, learn },
      d.engineDeps
    );
    return { decision, recorded: d.recorded };
  };
  const review = await run({ learnMode: "review", learnMinHits: 5 }, 0.9);
  assert.deepEqual(review.recorded[0].options, {
    autoActivate: false,
    minHits: 5,
    moderatorModel: "openai/omni-moderation-latest",
  });
  for (const [label, result, reason] of [
    ["off", await run({ learnMode: "off" }, 0.9), "learning_off"],
    ["clean", await run({}, 0.1), "no_violation"],
    ["cached", await run({}, 0.9, { cached: true }), "cached_verdict"],
    ["dry run", await run({}, 0.9, {}, false), "learning_off"],
  ] as const) {
    assert.equal(result.recorded.length, 0, label);
    assert.equal(result.decision.learning?.skipped, reason, label);
    assert.deepEqual(result.decision.discoveredTerms, [{ term: "freaky", weight: 3 }], label);
  }
});

test("validateDiscoveredTerms honors the policy's own seed terms and stop words", () => {
  const text = "a gore scene with carnage and mayhem";
  assert.deepEqual(
    validateDiscoveredTerms(["gore", "carnage", "mayhem"], text, {
      seedTerms: VIOLENCE.seedTerms,
      stopWords: ["mayhem"],
    }),
    [{ term: "carnage", weight: 1 }]
  );
});

// ─── Action plans ────────────────────────────────────────────────────────────

test("planTextPolicyAction covers every outcome", () => {
  const hit = { violation: true } as Parameters<typeof planTextPolicyAction>[0];
  const miss = { violation: false } as Parameters<typeof planTextPolicyAction>[0];
  assert.equal(planTextPolicyAction(miss, config(), "m").action, "allowed");
  assert.deepEqual(planTextPolicyAction(hit, config(), "m"), {
    action: "rerouted",
    block: false,
    fromModel: "m",
    toModel: "combo/nsfw-ok",
  });
  assert.equal(planTextPolicyAction(hit, config({ mode: "block" }), "m").block, true);
  assert.equal(planTextPolicyAction(hit, config({ mode: "flag" }), "m").action, "flagged");
  assert.equal(
    planTextPolicyAction(hit, config({ rerouteTarget: null }), "m").action,
    "no_reroute_target"
  );
  assert.equal(planTextPolicyAction(hit, config(), "combo/nsfw-ok").action, "already_target");
});

// ─── Scope: global vs per key ────────────────────────────────────────────────

test("per-key override wins field by field; unset fields inherit the global value", () => {
  const settings = {
    textPolicies: {
      "sexual-content": {
        enabled: true,
        rerouteTarget: "combo/nsfw-ok",
        moderatorModel: "openai/omni-moderation-latest",
        keyOverrides: { "key-a": { rerouteTarget: "grok/grok-4", highThreshold: 6 } },
      },
    },
  };
  const forKey = resolveTextPolicyConfig(settings, "sexual-content", "key-a");
  assert.equal(forKey.scope, "key");
  assert.equal(forKey.config.rerouteTarget, "grok/grok-4");
  assert.equal(forKey.config.highThreshold, 6);
  assert.equal(forKey.config.lowThreshold, 3, "default");
  assert.equal(forKey.config.moderatorModel, "openai/omni-moderation-latest", "inherited");
  assert.deepEqual(forKey.keyOverriddenFields.sort(), ["highThreshold", "rerouteTarget"]);
  assert.equal(resolveTextPolicyConfig(settings, "sexual-content", "key-b").scope, "global");
  assert.equal(resolveTextPolicyConfig(settings, "sexual-content", null).scope, "global");
});

test("a stored config with one invalid field keeps the valid fields", () => {
  const { config: resolved } = resolveTextPolicyConfig(
    { textPolicies: { "sexual-content": { enabled: true, mode: "nuke", rerouteTarget: "x/y" } } },
    "sexual-content",
    null
  );
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.mode, "reroute");
  assert.equal(resolved.rerouteTarget, "x/y");
});

// ─── evaluateTextPoliciesFor (process entry point) ───────────────────────────

const twoPolicySettings = (extra: Record<string, unknown> = {}) => ({
  textPolicies: {
    "sexual-content": {
      enabled: true,
      rerouteTarget: "combo/nsfw-ok",
      moderatorModel: "openai/omni-moderation-latest",
    },
    violence: {
      enabled: true,
      mode: "block",
      priority: 10,
      classifierInstruction: "how violent or gory the TEXT is",
      seedTerms: [
        { term: "gore", weight: 5 },
        { term: "behead", weight: 5 },
      ],
      highThreshold: 10,
    },
    ...extra,
  },
});

test("evaluateTextPoliciesFor: runs enabled policies in priority order and stops at the first action", async () => {
  const { engineDeps } = deps();
  const evaluations = await evaluateTextPoliciesFor(
    `${ABOVE}\nbehead them, gore`,
    { requestedModel: "claude/x" },
    { ...engineDeps, getSettings: async () => twoPolicySettings() }
  );
  assert.deepEqual(
    evaluations.map((entry) => [entry.definition.id, entry.plan.action]),
    [["violence", "blocked"]],
    "violence (priority 10) blocks first; sexual-content is not evaluated"
  );

  const all = await evaluateTextPoliciesFor(
    `${ABOVE}\nbehead them, gore`,
    { requestedModel: "claude/x", stopOnAction: false },
    { ...engineDeps, getSettings: async () => twoPolicySettings() }
  );
  assert.deepEqual(
    all.map((entry) => [entry.definition.id, entry.plan.action]),
    [
      ["violence", "blocked"],
      ["sexual-content", "rerouted"],
    ]
  );
});

test("evaluateTextPoliciesFor: skips disabled policies, honors policyIds and per-key enablement", async () => {
  const { engineDeps } = deps();
  const settings = twoPolicySettings({
    violence: {
      enabled: false,
      classifierInstruction: "how violent or gory the TEXT is",
      seedTerms: [{ term: "gore", weight: 5 }],
      keyOverrides: { "game-studio": { enabled: true, mode: "flag" } },
    },
  });
  const get = async () => settings;
  const anon = await evaluateTextPoliciesFor("gore", {}, { ...engineDeps, getSettings: get });
  assert.deepEqual(
    anon.map((entry) => entry.definition.id),
    ["sexual-content"]
  );
  const studio = await evaluateTextPoliciesFor(
    "gore",
    { apiKeyId: "game-studio", policyIds: ["violence"] },
    { ...engineDeps, getSettings: get }
  );
  assert.equal(studio.length, 1);
  assert.equal(studio[0].decision.scope, "key");
  assert.equal(studio[0].config.mode, "flag");
  const probe = await evaluateTextPoliciesFor(
    "gore",
    { policyIds: ["violence"], ignoreEnabled: true },
    { ...engineDeps, getSettings: get }
  );
  assert.equal(probe.length, 1, "ignoreEnabled evaluates a disabled policy");
});

test("evaluateTextPoliciesFor: nothing enabled → empty, and a settings failure fails open", async () => {
  const { engineDeps } = deps();
  assert.deepEqual(
    await evaluateTextPoliciesFor(ABOVE, {}, { ...engineDeps, getSettings: async () => ({}) }),
    []
  );
  assert.deepEqual(
    await evaluateTextPoliciesFor(
      ABOVE,
      {},
      {
        ...engineDeps,
        getSettings: async () => {
          throw new Error("db");
        },
      }
    ),
    []
  );
});
