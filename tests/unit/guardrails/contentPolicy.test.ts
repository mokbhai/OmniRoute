import assert from "node:assert/strict";
import test from "node:test";

import {
  ContentPolicyGuardrail,
  isSelfLoopGuardrailRequest,
} from "../../../src/lib/guardrails/contentPolicy/guardrail.ts";
import { validateDiscoveredTerms } from "../../../src/lib/guardrails/contentPolicy/learning.ts";
import { resolveContentPolicyConfig } from "../../../src/lib/guardrails/contentPolicy/config.ts";
import {
  classifyKeywordBand,
  extractContentPolicyText,
  scoreContentPolicyText,
} from "../../../src/lib/guardrails/contentPolicy/keywordScore.ts";
import {
  extractSexualScore,
  clearModeratorCacheForTests,
  defaultModerate,
  isModerationApiModel,
  parseChatModeratorReply,
  type ModerateFn,
} from "../../../src/lib/guardrails/contentPolicy/moderator.ts";
import { buildContentPolicyHeader } from "../../../src/lib/guardrails/contentPolicy/header.ts";
import { GuardrailRegistry } from "../../../src/lib/guardrails/registry.ts";
import { contentPolicySettingsSchema } from "../../../src/shared/validation/contentPolicySchema.ts";
import { updateSettingsSchema } from "../../../src/shared/validation/settingsSchemas.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Score 0: ordinary request. */
const CLEAN = "Summarize this quarterly report and list three risks for the board.";
/** Score 3 ("erotic"): inside the default middle band [3, 10). */
const MIDDLE = "Write a short erotic story set in Lisbon.";
/** The templated tagging request from the original report: far above the band. */
const ABOVE = [
  "你是社区模版运营，要为模版勾选推荐标签。",
  "「陰道性交」对应 id vaginal_sex：口交、肛交、乳交(titjob)、手交、足交、自慰(masturbation)等不要选。",
  "模版分类：doggy_style 提示词： Mulher ruiva, nua, deitada de bruços ... posição doggy style / prone bone,",
  "penetrando-a profundamente por trás. Cena sexual explícita, realista.",
  "AI 审核摘要：本模版适用成人色情成片要求（分类为 doggy_style，提示词含 explicit sexual scene）。",
].join("\n");

const chat = (text: string, model = "claude/claude-sonnet-4-5") => ({
  model,
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: [{ type: "text", text }] },
  ],
});

const BASE_POLICY = {
  enabled: true,
  mode: "reroute",
  lowThreshold: 3,
  highThreshold: 10,
  moderatorModel: "openai/omni-moderation-latest",
  moderationScoreThreshold: 0.5,
  rerouteTarget: "combo/nsfw-ok",
};

interface SetupOptions {
  /** Chat-moderator terms; when set the stub moderator reports kind "chat". */
  terms?: unknown;
  cached?: boolean;
  learned?: Array<{ term: string; weight: number }>;
  selfLoop?: boolean;
}

function setup(
  contentPolicy: Record<string, unknown>,
  moderatorScore: number | Error = 0.9,
  options: SetupOptions = {}
) {
  const calls: Array<{ model: string; text: string }> = [];
  const recorded: Array<{ terms: unknown; options: unknown }> = [];
  const moderate: ModerateFn = async ({ model, text }) => {
    calls.push({ model, text });
    if (moderatorScore instanceof Error) throw moderatorScore;
    return {
      ok: true,
      sexualScore: moderatorScore,
      flagged: moderatorScore >= 0.5,
      cached: options.cached === true,
      kind: options.terms === undefined ? "moderation" : "chat",
      terms: options.terms,
    };
  };
  const guardrail = new ContentPolicyGuardrail(
    {},
    {
      getSettings: async () => ({ contentPolicy }),
      moderate,
      loadLearnedTerms: async () => options.learned ?? [],
      recordLearnedTerms: async (terms, recordOptions) => {
        recorded.push({ terms, options: recordOptions });
        return { added: terms.map((entry) => entry.term), activated: [] };
      },
      isSelfLoopRequest: () => options.selfLoop === true,
    }
  );
  return { guardrail, calls, recorded };
}

const keyCtx = (id: string | null) => ({
  apiKeyInfo: id ? { id } : null,
  model: "claude/claude-sonnet-4-5",
});

// ─── Keyword stage ───────────────────────────────────────────────────────────

test("keyword score: clean text scores 0, middle fixture 3, report fixture far above 10", () => {
  assert.equal(scoreContentPolicyText(CLEAN).score, 0);
  assert.equal(scoreContentPolicyText(MIDDLE).score, 3);
  const above = scoreContentPolicyText(ABOVE);
  assert.ok(above.score >= 10, `expected >= 10, got ${above.score}`);
  assert.ok(above.matchedTerms.includes("色情"));
});

test("keyword score: Latin terms match whole words only; prefix terms match suffixes", () => {
  assert.equal(scoreContentPolicyText("Essex nudetown classic").score, 0);
  assert.deepEqual(scoreContentPolicyText("masturbation").matchedTerms, ["masturbat*"]);
  // "penetration testing" is weak on purpose: alone it stays below the band.
  assert.equal(scoreContentPolicyText("Run a penetration test on staging").score, 1);
  // A term counts once however often it repeats.
  assert.equal(scoreContentPolicyText("erotic erotic erotic").score, 3);
});

test("classifyKeywordBand: below < low <= middle < high <= above", () => {
  assert.equal(classifyKeywordBand(2.9, 3, 10), "below");
  assert.equal(classifyKeywordBand(3, 3, 10), "middle");
  assert.equal(classifyKeywordBand(9.9, 3, 10), "middle");
  assert.equal(classifyKeywordBand(10, 3, 10), "above");
});

test("text extraction covers chat, Responses, and Claude shapes and skips media", () => {
  const text = extractContentPolicyText({
    system: [{ type: "text", text: "sys-claude" }],
    instructions: "sys-responses",
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
  for (const part of ["sys-claude", "sys-responses", "resp-user", "chat-user"]) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!text.includes("data:x"));
});

test("text extraction keeps the tail of a long preamble so the variable part is scanned", () => {
  const text = extractContentPolicyText(chat(`${"tag catalog ".repeat(10_000)}\n${MIDDLE}`));
  assert.ok(text.includes("erotic"));
});

// ─── Three routing outcomes (global scope) ───────────────────────────────────

test("below band: moderator is never called and the request passes unchanged", async () => {
  const { guardrail, calls } = setup(BASE_POLICY);
  const result = await guardrail.preCall(chat(CLEAN), keyCtx(null));
  assert.equal(calls.length, 0);
  assert.equal(result.block, false);
  assert.equal(result.modifiedPayload, undefined);
  assert.equal(result.meta?.band, "below");
  assert.equal(result.meta?.stage, "keyword");
  assert.equal(result.meta?.action, "allowed");
});

test("above band: moderator is never called and the request is rerouted to the target", async () => {
  const { guardrail, calls } = setup(BASE_POLICY);
  const result = await guardrail.preCall(chat(ABOVE), keyCtx(null));
  assert.equal(calls.length, 0);
  assert.equal(result.block, false);
  assert.equal((result.modifiedPayload as { model: string }).model, "combo/nsfw-ok");
  assert.equal(result.meta?.band, "above");
  assert.equal(result.meta?.stage, "keyword");
  assert.equal(result.meta?.action, "rerouted");
  assert.equal(result.meta?.fromModel, "claude/claude-sonnet-4-5");
});

test("middle band: the selected moderator decides adult -> reroute, and the decision is returned", async () => {
  const { guardrail, calls } = setup(BASE_POLICY, 0.91);
  const result = await guardrail.preCall(chat(MIDDLE), keyCtx(null));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "openai/omni-moderation-latest");
  assert.ok(calls[0].text.includes("erotic"));
  assert.equal((result.modifiedPayload as { model: string }).model, "combo/nsfw-ok");
  assert.equal(result.meta?.band, "middle");
  assert.equal(result.meta?.stage, "moderator");
  assert.equal(result.meta?.moderatorScore, 0.91);
  assert.equal(result.meta?.adult, true);
});

test("middle band: a low moderator score lets the request through on the requested model", async () => {
  const { guardrail, calls } = setup(BASE_POLICY, 0.12);
  const result = await guardrail.preCall(chat(MIDDLE), keyCtx(null));
  assert.equal(calls.length, 1);
  assert.equal(result.modifiedPayload, undefined);
  assert.equal(result.meta?.adult, false);
  assert.equal(result.meta?.action, "allowed");
  assert.equal(result.meta?.moderatorScore, 0.12);
});

test("middle band: a moderator failure fails open and records the error", async () => {
  const { guardrail } = setup(BASE_POLICY, new Error("upstream down"));
  const result = await guardrail.preCall(chat(MIDDLE), keyCtx(null));
  assert.equal(result.block, false);
  assert.equal(result.modifiedPayload, undefined);
  assert.equal(result.meta?.moderatorError, "moderator_error");
});

test("middle band with no moderatorModel configured fails open without a call", async () => {
  const { guardrail, calls } = setup({ ...BASE_POLICY, moderatorModel: "" });
  const result = await guardrail.preCall(chat(MIDDLE), keyCtx(null));
  assert.equal(calls.length, 0);
  assert.equal(result.meta?.moderatorError, "no_moderator_model");
});

test("band thresholds are configurable: raising lowThreshold moves the middle fixture below the band", async () => {
  const { guardrail, calls } = setup({ ...BASE_POLICY, lowThreshold: 4 });
  const result = await guardrail.preCall(chat(MIDDLE), keyCtx(null));
  assert.equal(calls.length, 0);
  assert.equal(result.meta?.band, "below");
});

test("band thresholds are configurable: lowering highThreshold skips the moderator", async () => {
  const { guardrail, calls } = setup({ ...BASE_POLICY, lowThreshold: 1, highThreshold: 3 });
  const result = await guardrail.preCall(chat(MIDDLE), keyCtx(null));
  assert.equal(calls.length, 0);
  assert.equal(result.meta?.band, "above");
  assert.equal(result.meta?.action, "rerouted");
});

// ─── Modes ───────────────────────────────────────────────────────────────────

test("mode block rejects adult requests; mode flag records them without changing the model", async () => {
  const blocked = await setup({ ...BASE_POLICY, mode: "block" }).guardrail.preCall(
    chat(ABOVE),
    keyCtx(null)
  );
  assert.equal(blocked.block, true);
  assert.equal(blocked.meta?.action, "blocked");

  const flagged = await setup({ ...BASE_POLICY, mode: "flag" }).guardrail.preCall(
    chat(ABOVE),
    keyCtx(null)
  );
  assert.equal(flagged.block, false);
  assert.equal(flagged.modifiedPayload, undefined);
  assert.equal(flagged.meta?.action, "flagged");
});

test("reroute without a target passes through; a request already on the target is left alone", async () => {
  const noTarget = await setup({ ...BASE_POLICY, rerouteTarget: undefined }).guardrail.preCall(
    chat(ABOVE),
    keyCtx(null)
  );
  assert.equal(noTarget.modifiedPayload, undefined);
  assert.equal(noTarget.meta?.action, "no_reroute_target");

  const onTarget = await setup(BASE_POLICY).guardrail.preCall(
    chat(ABOVE, "combo/nsfw-ok"),
    keyCtx(null)
  );
  assert.equal(onTarget.modifiedPayload, undefined);
  assert.equal(onTarget.meta?.action, "already_target");
});

test("disabled (the default) does nothing at all", async () => {
  const { guardrail, calls } = setup({});
  const result = await guardrail.preCall(chat(ABOVE), keyCtx(null));
  assert.deepEqual(result, { block: false });
  assert.equal(calls.length, 0);
});

// ─── Scope: global vs per API key ────────────────────────────────────────────

test("per-key override wins field by field; unset fields inherit the global value", () => {
  const settings = {
    contentPolicy: {
      ...BASE_POLICY,
      keyOverrides: { "key-a": { rerouteTarget: "grok/grok-4", highThreshold: 6 } },
    },
  };
  const forKey = resolveContentPolicyConfig(settings, "key-a");
  assert.equal(forKey.scope, "key");
  assert.equal(forKey.config.rerouteTarget, "grok/grok-4");
  assert.equal(forKey.config.highThreshold, 6);
  assert.equal(forKey.config.lowThreshold, 3, "inherited from global");
  assert.equal(
    forKey.config.moderatorModel,
    "openai/omni-moderation-latest",
    "inherited from global"
  );
  assert.deepEqual(forKey.keyOverriddenFields.sort(), ["highThreshold", "rerouteTarget"]);

  const otherKey = resolveContentPolicyConfig(settings, "key-b");
  assert.equal(otherKey.scope, "global");
  assert.equal(otherKey.config.rerouteTarget, "combo/nsfw-ok");

  const noKey = resolveContentPolicyConfig(settings, null);
  assert.equal(noKey.scope, "global");
});

test("global scope: one setting applies to every key without an override", async () => {
  const { guardrail } = setup(BASE_POLICY);
  for (const id of ["key-a", "key-b", null]) {
    const result = await guardrail.preCall(chat(ABOVE), keyCtx(id));
    assert.equal((result.modifiedPayload as { model: string }).model, "combo/nsfw-ok");
    assert.equal(result.meta?.scope, "global");
  }
});

test("per-key scope: a key can enable the policy while it is off globally", async () => {
  const { guardrail } = setup({
    enabled: false,
    rerouteTarget: "combo/nsfw-ok",
    keyOverrides: { "adult-tenant": { enabled: true } },
  });
  const tenant = await guardrail.preCall(chat(ABOVE), keyCtx("adult-tenant"));
  assert.equal((tenant.modifiedPayload as { model: string }).model, "combo/nsfw-ok");
  assert.equal(tenant.meta?.scope, "key");

  const other = await guardrail.preCall(chat(ABOVE), keyCtx("someone-else"));
  assert.deepEqual(other, { block: false });
});

test("per-key scope: a key can opt out, or use its own target, moderator and band", async () => {
  const { guardrail, calls } = setup(
    {
      ...BASE_POLICY,
      keyOverrides: {
        trusted: { enabled: false },
        custom: {
          rerouteTarget: "grok/grok-4",
          moderatorModel: "mistral/mistral-moderation-latest",
          lowThreshold: 2,
          highThreshold: 100,
        },
      },
    },
    0.8
  );
  const trusted = await guardrail.preCall(chat(ABOVE), keyCtx("trusted"));
  assert.deepEqual(trusted, { block: false });

  // The report fixture (score 74) is above 10 but below this key's highThreshold of 100 → moderator.
  const custom = await guardrail.preCall(chat(ABOVE), keyCtx("custom"));
  assert.equal(calls.at(-1)?.model, "mistral/mistral-moderation-latest");
  assert.equal(custom.meta?.band, "middle");
  assert.equal((custom.modifiedPayload as { model: string }).model, "grok/grok-4");
});

// ─── Settings schema ─────────────────────────────────────────────────────────

test("settings schema accepts a full config and rejects an inverted band or unknown field", () => {
  const full = {
    ...BASE_POLICY,
    keyOverrides: { "key-a": { enabled: true, rerouteTarget: "x/y" } },
  };
  assert.equal(contentPolicySettingsSchema.safeParse(full).success, true);
  assert.equal(updateSettingsSchema.safeParse({ contentPolicy: full }).success, true);
  assert.equal(
    contentPolicySettingsSchema.safeParse({ lowThreshold: 10, highThreshold: 3 }).success,
    false
  );
  assert.equal(
    contentPolicySettingsSchema.safeParse({
      keyOverrides: { k: { lowThreshold: 9, highThreshold: 2 } },
    }).success,
    false
  );
  assert.equal(contentPolicySettingsSchema.safeParse({ mode: "nuke" }).success, false);
  assert.equal(contentPolicySettingsSchema.safeParse({ bogus: 1 }).success, false);
});

test("a stored config with one invalid field keeps the valid fields", () => {
  const { config } = resolveContentPolicyConfig(
    { contentPolicy: { enabled: true, mode: "nuke", rerouteTarget: "combo/x" } },
    null
  );
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "reroute", "invalid mode falls back to the default");
  assert.equal(config.rerouteTarget, "combo/x");
});

// ─── Moderator response parsing + header ─────────────────────────────────────

test("extractSexualScore reads OpenAI and Mistral shapes and takes the highest sexual* score", () => {
  assert.deepEqual(
    extractSexualScore({
      results: [
        {
          categories: { sexual: true },
          category_scores: { sexual: 0.7, "sexual/minors": 0.1, violence: 0.9 },
        },
      ],
    }),
    { score: 0.7, flagged: true }
  );
  assert.deepEqual(
    extractSexualScore({
      results: [{ categories: { sexual: false }, category_scores: { sexual: 0.02 } }],
    }),
    { score: 0.02, flagged: false }
  );
  assert.equal(extractSexualScore({ results: [] }), null);
});

test("buildContentPolicyHeader summarizes the decision without request text", async () => {
  const { guardrail } = setup(BASE_POLICY, 0.91);
  const result = await guardrail.preCall(chat(MIDDLE), keyCtx(null));
  const header = buildContentPolicyHeader([{ guardrail: "content-policy", meta: result.meta }]);
  assert.equal(header, "adult; stage=moderator; action=rerouted; score=3; moderator=0.910");
  assert.equal(buildContentPolicyHeader([{ guardrail: "pii-masker", meta: {} }]), null);
});

// ─── Registry integration ────────────────────────────────────────────────────

test("through the registry the rerouted payload carries the target model", async () => {
  const registry = new GuardrailRegistry();
  registry.register(setup(BASE_POLICY).guardrail);
  const outcome = await registry.runPreCallHooks(chat(ABOVE), keyCtx(null));
  assert.equal(outcome.blocked, false);
  assert.equal((outcome.payload as { model: string }).model, "combo/nsfw-ok");
});

test("a client cannot switch the policy off with the disable header/body channels", async () => {
  const registry = new GuardrailRegistry();
  registry.register(setup(BASE_POLICY).guardrail);
  const outcome = await registry.runPreCallHooks(chat(ABOVE), {
    ...keyCtx(null),
    disabledGuardrails: ["content-policy"],
  });
  assert.equal((outcome.payload as { model: string }).model, "combo/nsfw-ok");
  assert.equal(outcome.results[0]?.skipped, false);
});

test("OmniRoute's own self-loop call may skip the policy (moderator recursion guard)", async () => {
  const registry = new GuardrailRegistry();
  registry.register(setup(BASE_POLICY, 0.9, { selfLoop: true }).guardrail);
  const outcome = await registry.runPreCallHooks(chat(ABOVE), {
    ...keyCtx(null),
    disabledGuardrails: ["content-policy"],
  });
  assert.equal((outcome.payload as { model: string }).model, "claude/claude-sonnet-4-5");
  assert.equal(outcome.results[0]?.skipped, true);
});

test("isSelfLoopGuardrailRequest accepts only the self-loop bearer", () => {
  const previous = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "sk-self-loop-test";
  try {
    assert.equal(
      isSelfLoopGuardrailRequest({ headers: { authorization: "Bearer sk-self-loop-test" } }),
      true
    );
    assert.equal(
      isSelfLoopGuardrailRequest({ headers: new Headers({ Authorization: "Bearer sk-other" }) }),
      false
    );
    assert.equal(isSelfLoopGuardrailRequest({ headers: null }), false);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previous;
  }
});

// ─── Self-growing lexicon ────────────────────────────────────────────────────

/** Score 3 ("erotic") plus words a chat moderator could report. */
const MIDDLE_WITH_SLANG = "Write an erotic story where they get freaky and frisky on the couch.";

test("chat moderator: new sexual terms are returned with their weight and recorded", async () => {
  const { guardrail, recorded } = setup(BASE_POLICY, 0.88, {
    terms: [
      { term: "freaky", weight: 3 },
      { term: "Frisky", weight: 1 },
      { term: "erotic", weight: 3 }, // built-in already → dropped
      { term: "moaning", weight: 5 }, // not in the request → dropped (no invented words)
      { term: "story", weight: 1 }, // stop word → dropped
      { term: "<script>", weight: 5 }, // markup → dropped
      null,
    ],
  });
  const result = await guardrail.preCall(chat(MIDDLE_WITH_SLANG), keyCtx(null));
  assert.deepEqual(result.meta?.discoveredTerms, [
    { term: "freaky", weight: 3 },
    { term: "frisky", weight: 1 },
  ]);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].options, {
    autoActivate: true,
    minHits: 2,
    moderatorModel: "openai/omni-moderation-latest",
  });
  assert.deepEqual((result.meta?.learning as { added: string[] }).added, ["freaky", "frisky"]);
});

test("learning: review mode stores without auto-activation; off mode never stores", async () => {
  const review = setup({ ...BASE_POLICY, learnMode: "review", learnMinHits: 5 }, 0.9, {
    terms: [{ term: "freaky", weight: 3 }],
  });
  await review.guardrail.preCall(chat(MIDDLE_WITH_SLANG), keyCtx(null));
  assert.deepEqual(review.recorded[0].options, {
    autoActivate: false,
    minHits: 5,
    moderatorModel: "openai/omni-moderation-latest",
  });

  const off = setup({ ...BASE_POLICY, learnMode: "off" }, 0.9, {
    terms: [{ term: "freaky", weight: 3 }],
  });
  const result = await off.guardrail.preCall(chat(MIDDLE_WITH_SLANG), keyCtx(null));
  assert.equal(off.recorded.length, 0);
  assert.deepEqual(result.meta?.discoveredTerms, [{ term: "freaky", weight: 3 }]);
  assert.equal((result.meta?.learning as { skipped: string }).skipped, "learning_off");
});

test("learning: clean verdicts and cached verdicts report terms but do not count as hits", async () => {
  const clean = setup(BASE_POLICY, 0.1, { terms: [{ term: "freaky", weight: 3 }] });
  const cleanResult = await clean.guardrail.preCall(chat(MIDDLE_WITH_SLANG), keyCtx(null));
  assert.equal(clean.recorded.length, 0);
  assert.equal((cleanResult.meta?.learning as { skipped: string }).skipped, "not_adult");

  const cached = setup(BASE_POLICY, 0.9, { terms: [{ term: "freaky", weight: 3 }], cached: true });
  const cachedResult = await cached.guardrail.preCall(chat(MIDDLE_WITH_SLANG), keyCtx(null));
  assert.equal(cached.recorded.length, 0);
  assert.equal((cachedResult.meta?.learning as { skipped: string }).skipped, "cached_verdict");
});

test("learning: a moderation-API moderator returns no terms", async () => {
  const { guardrail, recorded } = setup(BASE_POLICY, 0.9);
  const result = await guardrail.preCall(chat(MIDDLE_WITH_SLANG), keyCtx(null));
  assert.equal(result.meta?.discoveredTerms, undefined);
  assert.equal(recorded.length, 0);
});

test("active learned terms add to the keyword score and can push a request over the band", async () => {
  const text = "They got freaky and frisky after the party.";
  assert.equal(scoreContentPolicyText(text).score, 0);
  const learned = [
    { term: "freaky", weight: 5 },
    { term: "frisky", weight: 5 },
  ];
  const scored = scoreContentPolicyText(text, learned);
  assert.equal(scored.score, 10);
  assert.deepEqual(scored.learnedMatches.sort(), ["freaky", "frisky"]);

  const { guardrail, calls } = setup(BASE_POLICY, 0.9, { learned });
  const result = await guardrail.preCall(chat(text), keyCtx(null));
  assert.equal(calls.length, 0, "above the band → no moderator call");
  assert.equal(result.meta?.band, "above");
  assert.deepEqual((result.meta?.learnedMatches as string[]).sort(), ["freaky", "frisky"]);
});

test("a learned term that duplicates a built-in one is not counted twice", () => {
  assert.equal(scoreContentPolicyText("erotic", [{ term: "erotic", weight: 5 }]).score, 3);
});

test("validateDiscoveredTerms caps the list at 10 and accepts plain strings and CJK", () => {
  const text = Array.from({ length: 15 }, (_, i) => `slangword${i}`).join(" ") + " 骚货";
  const raw = [...Array.from({ length: 15 }, (_, i) => `slangword${i}`)];
  assert.equal(validateDiscoveredTerms(raw, text).length, 10);
  assert.deepEqual(validateDiscoveredTerms([{ term: "骚货", weight: 9 }], text), [
    { term: "骚货", weight: 5 },
  ]);
});

test("parseChatModeratorReply reads fenced JSON and clamps the score", () => {
  assert.deepEqual(
    parseChatModeratorReply(
      '```json\n{"sexual_score": 1.7, "terms": [{"term":"x","weight":3}]}\n```'
    ),
    { score: 1, terms: [{ term: "x", weight: 3 }] }
  );
  assert.deepEqual(parseChatModeratorReply('Sure: {"sexualScore": "0.25"}'), {
    score: 0.25,
    terms: [],
  });
  assert.equal(parseChatModeratorReply("I cannot help with that."), null);
  assert.equal(parseChatModeratorReply('{"terms": []}'), null);
});

test("isModerationApiModel tells moderation models from chat models", () => {
  assert.equal(isModerationApiModel("openai/omni-moderation-latest"), true);
  assert.equal(isModerationApiModel("omni-moderation-latest"), true);
  assert.equal(isModerationApiModel("mistral/mistral-moderation-latest"), true);
  assert.equal(isModerationApiModel("openai/gpt-4o-mini"), false);
  assert.equal(isModerationApiModel("combo/nsfw-judge"), false);
});

test("the header reports how many new terms were discovered, never the words", () => {
  const header = buildContentPolicyHeader([
    {
      guardrail: "content-policy",
      meta: {
        adult: true,
        stage: "moderator",
        action: "rerouted",
        keywordScore: 3,
        moderatorScore: 0.9,
        discoveredTerms: [{ term: "freaky", weight: 3 }],
      },
    },
  ]);
  assert.equal(
    header,
    "adult; stage=moderator; action=rerouted; score=3; moderator=0.900; discovered=1"
  );
});

test("defaultModerate: a chat moderator goes through the self-loop with the recursion guard", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_API_KEY = "sk-self-loop-test";
  clearModeratorCacheForTests();
  const seen: Array<{ url: string; headers: Record<string, string>; body: { model: string } }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: '{"sexual_score":0.8,"terms":[{"term":"freaky","weight":3}]}' } },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  try {
    const verdict = await defaultModerate({ model: "groq/llama-judge", text: "get freaky" });
    assert.deepEqual(verdict, {
      ok: true,
      sexualScore: 0.8,
      flagged: false,
      cached: false,
      kind: "chat",
      terms: [{ term: "freaky", weight: 3 }],
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /^http:\/\/localhost:\d+\/v1\/chat\/completions$/);
    assert.equal(seen[0].body.model, "groq/llama-judge");
    assert.equal(seen[0].headers.Authorization, "Bearer sk-self-loop-test");
    assert.match(seen[0].headers["x-omniroute-disabled-guardrails"], /content-policy/);
    assert.equal(seen[0].headers["x-omniroute-admission-bypass"], "internal");

    // Same text again: served from cache, no second call, marked cached (so it is not a new hit).
    const again = await defaultModerate({ model: "groq/llama-judge", text: "get freaky" });
    assert.equal(seen.length, 1);
    assert.equal(again.ok && again.cached, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousKey;
    clearModeratorCacheForTests();
  }
});

test("defaultModerate: an unparseable chat reply fails open as moderator_unparseable", async () => {
  const previousFetch = globalThis.fetch;
  clearModeratorCacheForTests();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "I can't help." } }] }), {
      status: 200,
    })) as typeof fetch;
  try {
    const verdict = await defaultModerate({ model: "groq/llama-judge", text: "x" });
    assert.deepEqual(verdict, { ok: false, reason: "moderator_unparseable" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
