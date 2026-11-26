/**
 * Multilingual learning for text policies: the categorised moderator prompt, the
 * category-based rating, the minimum moderator score to learn, and translations of
 * accepted words (src/lib/textPolicy/{categories,learning,moderator,engine}.ts,
 * src/lib/db/textPolicyTerms.ts, the terms route).
 *
 * Self-isolating: DATA_DIR points at a fresh temp dir BEFORE any `@/lib/db/*` module loads.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-text-policy-i18n-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const readCache = await import("../../../src/lib/db/readCache.ts");
const terms = await import("../../../src/lib/db/textPolicyTerms.ts");
const learning = await import("../../../src/lib/textPolicy/learning.ts");
const moderator = await import("../../../src/lib/textPolicy/moderator.ts");
const { evaluateTextPolicy } = await import("../../../src/lib/textPolicy/engine.ts");
const { DEFAULT_TEXT_POLICY_CONFIG, resolveTextPolicyConfig } =
  await import("../../../src/lib/textPolicy/config.ts");
const { DEFAULT_TERM_CATEGORIES, DEFAULT_TRANSLATE_LANGUAGES, categoryWeight } =
  await import("../../../src/lib/textPolicy/categories.ts");
const { SEXUAL_CONTENT_POLICY } =
  await import("../../../src/lib/textPolicy/policies/sexualContent.ts");
const { textPolicySettingsSchema } =
  await import("../../../src/shared/validation/textPolicySchema.ts");
const form =
  await import("../../../src/app/(dashboard)/dashboard/settings/components/textPolicies/textPolicyForm.ts");
const termsRoute = await import("../../../src/app/api/text-policies/[policyId]/terms/route.ts");

import type { TextPolicyConfig } from "../../../src/lib/textPolicy/types.ts";
import type { TranslateFn } from "../../../src/lib/textPolicy/moderator.ts";

const SEX = "sexual-content";
const AUTO = { autoActivate: true, minHits: 2, moderatorModel: "groq/judge" };
const realFetch = globalThis.fetch;

const config = (overrides: Partial<TextPolicyConfig> = {}): TextPolicyConfig => ({
  ...DEFAULT_TEXT_POLICY_CONFIG,
  enabled: true,
  moderatorModel: "groq/judge",
  rerouteTarget: "combo/nsfw-ok",
  ...overrides,
});

async function setPolicies(textPolicies: Record<string, unknown>) {
  await settingsDb.updateSettings({ textPolicies });
  readCache.invalidateDbCache?.("settings");
}

function row(term: string) {
  return terms.listTextPolicyTerms(SEX).find((entry) => entry.term === term);
}

test.beforeEach(async () => {
  core.getDbInstance().prepare("DELETE FROM text_policy_terms").run();
  learning.invalidateLearnedTermsCache();
  moderator.clearModeratorCacheForTests();
  await setPolicies({});
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── Prompt ──────────────────────────────────────────────────────────────────

test("the moderator prompt asks for language, meaning and a category, in any language", () => {
  const prompt = moderator.buildChatModeratorPrompt(SEXUAL_CONTENT_POLICY);
  assert.match(prompt, /content-moderation classifier/, "identity phrase kept");
  assert.match(prompt, /any language/);
  assert.match(prompt, /never translated/);
  assert.match(prompt, /"lang": "<ISO 639-1>", "meaning": "<English>", "category": "<id>"/);
  // Learnable and never-learned categories are both described.
  for (const id of ["explicit", "slang", "nudity", "fetish", "context", "identity", "minor"]) {
    assert.match(prompt, new RegExp(`\\b${id}: `), id);
  }
  // A calibrated score scale and multilingual examples.
  assert.match(prompt, /0\.2 = mentions the topic only in a neutral/);
  assert.match(prompt, /"做爱" \(zh, "to have sex"\) -> explicit/);
  assert.match(prompt, /"直播" \(zh, "livestream"\) -> context/);
  // The policy's own instruction is still the thing being rated.
  assert.ok(prompt.includes(SEXUAL_CONTENT_POLICY.classifierInstruction));
});

test("a policy without categories gets the generic ones", () => {
  const prompt = moderator.buildChatModeratorPrompt({
    id: "violence",
    moderationCategory: "violence",
    classifierInstruction: "how violent the TEXT is",
  });
  for (const category of DEFAULT_TERM_CATEGORIES) assert.ok(prompt.includes(`${category.id}: `));
  assert.ok(!prompt.includes("- examples:"));
});

test("category weights: learnable ones are 3-5, identity / minors / context are never learned", () => {
  const categories = SEXUAL_CONTENT_POLICY.termCategories ?? [];
  assert.equal(categoryWeight(categories, "explicit"), 5);
  assert.equal(categoryWeight(categories, "SLANG"), 5);
  assert.equal(categoryWeight(categories, "nudity"), 3);
  assert.equal(categoryWeight(categories, "fetish"), 3);
  for (const never of ["context", "identity", "minor", "other", "made-up", undefined]) {
    assert.equal(categoryWeight(categories, never), 0, String(never));
  }
});

// ─── Rating ──────────────────────────────────────────────────────────────────

test("reported words in any language are learned with the category's weight", () => {
  const text = "Ela ficou sem roupa e eles começaram a foder. 他们啪啪啪。 Il fait chaud. gay bar.";
  const { terms: learned, ignored } = learning.classifyDiscoveredTerms(
    [
      { term: "sem roupa", lang: "pt", meaning: "naked", category: "nudity", weight: 5 },
      { term: "foder", lang: "pt-BR", meaning: "to fuck", category: "slang", weight: 1 },
      { term: "啪啪啪", lang: "zh", meaning: "sex (slang)", category: "slang" },
      { term: "chaud", lang: "fr", meaning: "hot", category: "context" },
      { term: "gay", lang: "en", meaning: "gay", category: "identity" },
      { term: "sem roupa", category: "explicit" }, // same word, higher category wins
    ],
    text,
    SEXUAL_CONTENT_POLICY
  );
  assert.deepEqual(learned, [
    { term: "sem roupa", weight: 5, category: "explicit" },
    { term: "foder", weight: 5, category: "slang", language: "pt", meaning: "to fuck" },
    { term: "啪啪啪", weight: 5, category: "slang", language: "zh", meaning: "sex (slang)" },
  ]);
  assert.deepEqual(ignored, [
    { term: "chaud", category: "context" },
    { term: "gay", category: "identity" },
  ]);
});

test("everyday words seen in production are stop words, whatever the moderator says", () => {
  const text = "直播 真空 遛狗 wet release";
  const reported = ["直播", "真空", "遛狗", "wet", "release"].map((term) => ({
    term,
    category: "explicit",
  }));
  assert.deepEqual(learning.validateDiscoveredTerms(reported, text, SEXUAL_CONTENT_POLICY), []);
});

test("an unsure violation is reported but does not teach", async () => {
  const recorded: unknown[] = [];
  const decision = await evaluateTextPolicy(
    {
      policy: SEXUAL_CONTENT_POLICY,
      config: config({ learnMinModeratorScore: 0.9 }),
      text: "Write a short erotic story where they get freaky.",
    },
    {
      loadLearnedTerms: async () => [],
      moderate: async () => ({
        ok: true,
        score: 0.8,
        cached: false,
        kind: "chat",
        terms: [{ term: "freaky", category: "slang" }],
      }),
      recordLearnedTerms: async (...args) => {
        recorded.push(args);
        return { added: [], activated: [] };
      },
    }
  );
  assert.equal(decision.violation, true);
  assert.equal(decision.learning?.skipped, "low_confidence");
  assert.equal(recorded.length, 0);
});

// ─── Config ──────────────────────────────────────────────────────────────────

test("config: learn score and translation languages default, override and can be emptied", () => {
  const base = resolveTextPolicyConfig({}, SEX, null).config;
  assert.equal(base.learnMinModeratorScore, 0.85);
  assert.deepEqual(base.translateLanguages, [...DEFAULT_TRANSLATE_LANGUAGES]);
  const stored = {
    textPolicies: {
      [SEX]: {
        learnMinModeratorScore: 0.95,
        translateLanguages: ["es", "es", "zh"],
        keyOverrides: { k1: { translateLanguages: [] } },
      },
    },
  };
  const global = resolveTextPolicyConfig(stored, SEX, null).config;
  assert.equal(global.learnMinModeratorScore, 0.95);
  assert.deepEqual(global.translateLanguages, ["es", "zh"]);
  assert.deepEqual(resolveTextPolicyConfig(stored, SEX, "k1").config.translateLanguages, []);

  assert.ok(textPolicySettingsSchema.safeParse({ translateLanguages: ["ES", "pt"] }).success);
  assert.ok(!textPolicySettingsSchema.safeParse({ translateLanguages: ["english"] }).success);
  assert.ok(!textPolicySettingsSchema.safeParse({ learnMinModeratorScore: 1.5 }).success);
});

test("settings form: language list parsing, and an empty list is saved as 'no translations'", () => {
  assert.deepEqual(form.parseLanguageList("es, pt-BR\nZH  es, english, x"), {
    languages: ["es", "pt", "zh"],
    invalid: ["english", "x"],
  });
  const next = form.setPolicyGlobalFields({}, SEX, {
    translateLanguages: [],
    learnMinModeratorScore: 0.9,
  });
  assert.deepEqual(next[SEX], { translateLanguages: [], learnMinModeratorScore: 0.9 });
});

// ─── Storage ─────────────────────────────────────────────────────────────────

test("language, meaning and category are stored; the first known value is kept", () => {
  terms.recordTextPolicyTerms(
    SEX,
    [{ term: "Pelada", weight: 3, language: "pt", meaning: "naked", category: "nudity" }],
    AUTO
  );
  terms.recordTextPolicyTerms(
    SEX,
    [{ term: "pelada", weight: 3, language: "es", meaning: "bald", category: "context" }],
    AUTO
  );
  const entry = row("pelada");
  assert.equal(entry?.status, "active");
  assert.equal(entry?.hits, 2);
  assert.equal(entry?.language, "pt");
  assert.equal(entry?.meaning, "naked");
  assert.equal(entry?.category, "nudity");
  assert.equal(entry?.source, "moderator");
});

test("translations are claimed once, only for active non-translation terms", () => {
  terms.recordTextPolicyTerms(SEX, [{ term: "pelada", weight: 3 }], AUTO); // pending
  assert.equal(terms.claimTextPolicyTermTranslation(SEX, "pelada"), null, "pending");
  terms.recordTextPolicyTerms(SEX, [{ term: "pelada", weight: 3 }], AUTO); // active
  assert.equal(terms.claimTextPolicyTermTranslation(SEX, "pelada")?.term, "pelada");
  assert.equal(terms.claimTextPolicyTermTranslation(SEX, "pelada"), null, "already claimed");

  const added = terms.addTextPolicyTranslations(
    SEX,
    "pelada",
    [
      { term: "Naked", language: "en", meaning: "naked" },
      { term: "pelada", language: "es" }, // the source itself
      { term: "desnuda", language: "es", meaning: "naked" },
    ],
    { weight: 3, category: "nudity", moderatorModel: "groq/judge" }
  );
  assert.deepEqual(added, ["naked", "desnuda"]);
  const naked = row("naked");
  assert.equal(naked?.status, "pending");
  assert.equal(naked?.hits, 0);
  assert.equal(naked?.source, "translation");
  assert.equal(naked?.sourceTerm, "pelada");
  assert.equal(naked?.language, "en");
  assert.equal(naked?.weight, 3);
  // Activating a translation never starts another round of translations.
  terms.upsertTextPolicyTerm(SEX, { term: "naked", status: "active" });
  assert.equal(terms.claimTextPolicyTermTranslation(SEX, "naked"), null);
  // An existing term (any status) is never overwritten by a translation.
  terms.upsertTextPolicyTerm(SEX, { term: "nackt", status: "rejected" });
  assert.deepEqual(
    terms.addTextPolicyTranslations(SEX, "pelada", [{ term: "nackt", language: "de" }], {
      weight: 3,
    }),
    []
  );
  assert.equal(row("nackt")?.status, "rejected");
});

test("a translation is learned the same way: hits from flagged requests activate it", () => {
  terms.recordTextPolicyTerms(SEX, [{ term: "pelada", weight: 3 }], { ...AUTO, minHits: 1 });
  terms.addTextPolicyTranslations(SEX, "pelada", [{ term: "desnuda", language: "es" }], {
    weight: 3,
  });
  assert.deepEqual(terms.recordTextPolicyTerms(SEX, [{ term: "desnuda", weight: 3 }], AUTO), {
    added: [],
    activated: [],
  });
  assert.equal(row("desnuda")?.hits, 1);
  assert.deepEqual(terms.recordTextPolicyTerms(SEX, [{ term: "desnuda", weight: 3 }], AUTO), {
    added: [],
    activated: ["desnuda"],
  });
  assert.equal(row("desnuda")?.source, "translation");
});

// ─── Translation flow ────────────────────────────────────────────────────────

test("validateTranslations keeps safe words in the requested languages, at most 2 each", () => {
  const kept = learning.validateTranslations(
    [
      { term: "en cueros", lang: "es", meaning: "naked" },
      { term: "encuerada", lang: "es-MX", meaning: "naked (slang)" },
      { term: "en pelotas", lang: "es" }, // third for "es" → dropped
      { term: "toute nue", lang: "fr", meaning: "naked" }, // language not requested
      { term: "光着身子", lang: "zh", meaning: "naked" },
      { term: "sem roupa", lang: "zh" }, // the source term
      { term: "porn", lang: "zh" }, // already a seed term
      { term: "<b>x</b>", lang: "zh" }, // markup
      { term: "word", lang: "klingon" },
      "nackt",
    ],
    SEXUAL_CONTENT_POLICY,
    { sourceTerm: "sem roupa", languages: ["es", "zh"] }
  );
  assert.deepEqual(kept, [
    { term: "en cueros", language: "es", meaning: "naked" },
    { term: "encuerada", language: "es", meaning: "naked (slang)" },
    { term: "光着身子", language: "zh", meaning: "naked" },
  ]);
});

test("translateAcceptedTerms asks once per term, skips the term's own language, stores pending", async () => {
  terms.recordTextPolicyTerms(
    SEX,
    [{ term: "pelada", weight: 3, language: "pt", meaning: "naked", category: "nudity" }],
    { ...AUTO, minHits: 1 }
  );
  const calls: Array<Parameters<TranslateFn>[0]> = [];
  const translate: TranslateFn = async (input) => {
    calls.push(input);
    return {
      ok: true,
      translations: [
        { term: "en cueros", lang: "es", meaning: "naked" },
        { term: "nackig", lang: "de", meaning: "naked" },
      ],
    };
  };
  const cfg = config({ translateLanguages: ["pt", "es", "de"] });
  const stored = await learning.translateAcceptedTerms(SEXUAL_CONTENT_POLICY, ["pelada"], cfg, {
    translate,
  });
  assert.deepEqual(stored, { pelada: ["en cueros", "nackig"] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].languages, ["es", "de"], "the source language is skipped");
  assert.equal(calls[0].language, "pt");
  assert.equal(calls[0].meaning, "naked");
  assert.equal(row("nackig")?.category, "nudity");

  await learning.translateAcceptedTerms(SEXUAL_CONTENT_POLICY, ["pelada"], cfg, { translate });
  assert.equal(calls.length, 1, "never asked twice for the same term");
});

test("no translations when learning is off, without languages or moderator, or for never-learned categories", async () => {
  let calls = 0;
  const translate: TranslateFn = async () => {
    calls += 1;
    return { ok: true, translations: [] };
  };
  terms.recordTextPolicyTerms(SEX, [{ term: "pelada", weight: 3 }], { ...AUTO, minHits: 1 });
  for (const cfg of [
    config({ learnMode: "off" }),
    config({ translateLanguages: [] }),
    config({ moderatorModel: null }),
  ]) {
    await learning.translateAcceptedTerms(SEXUAL_CONTENT_POLICY, ["pelada"], cfg, { translate });
  }
  assert.equal(calls, 0);
  // A term an operator approved although its category is never learned is not translated.
  terms.recordTextPolicyTerms(SEX, [{ term: "gay", weight: 1, category: "identity" }], {
    ...AUTO,
    minHits: 1,
  });
  await learning.translateAcceptedTerms(SEXUAL_CONTENT_POLICY, ["gay"], config(), { translate });
  assert.equal(calls, 0);
});

test("the engine requests translations for newly activated terms, without waiting for them", async () => {
  const requested: Array<{ terms: string[]; languages: string[] }> = [];
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decision = await evaluateTextPolicy(
    {
      policy: SEXUAL_CONTENT_POLICY,
      config: config({ translateLanguages: ["es"] }),
      text: "Write a short erotic story where they get freaky.",
    },
    {
      loadLearnedTerms: async () => [],
      moderate: async () => ({
        ok: true,
        score: 0.95,
        cached: false,
        kind: "chat",
        terms: [{ term: "freaky", lang: "en", category: "slang" }],
      }),
      recordLearnedTerms: async () => ({ added: ["freaky"], activated: ["freaky"] }),
      translateTerms: async (_policy, activated, cfg) => {
        requested.push({ terms: activated, languages: cfg.translateLanguages });
        await pending; // a slow translation must not hold the request
      },
    }
  );
  assert.deepEqual(decision.learning?.translating, ["freaky"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, [{ terms: ["freaky"], languages: ["es"] }]);
  release();
});

test("defaultTranslate sends the term through the guarded self-call and parses the reply", async () => {
  let body: { messages: Array<{ role: string; content: string }>; max_tokens: number } | null =
    null;
  let nonce: string | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    nonce = new Headers(init.headers).get(moderator.MODERATOR_NONCE_HEADER);
    const content = '```json\n{"translations":[{"term":"desnuda","lang":"es"}]}\n```';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
  const result = await moderator.defaultTranslate({
    policy: SEXUAL_CONTENT_POLICY,
    model: "groq/judge",
    term: "pelada",
    language: "pt",
    meaning: "naked",
    languages: ["es", "fr"],
  });
  assert.deepEqual(result, { ok: true, translations: [{ term: "desnuda", lang: "es" }] });
  assert.ok(nonce, "carries the loop-safety nonce");
  assert.match(body!.messages[0].content, /For each of these languages: es, fr/);
  assert.match(body!.messages[0].content, /Never give words about children or minors/);
  assert.equal(body!.messages[1].content, 'TERM: "pelada" (language: pt, meaning: naked)');
  assert.equal(moderator.inFlightChatModeratorCalls(), 0);

  assert.deepEqual(
    await moderator.defaultTranslate({
      policy: SEXUAL_CONTENT_POLICY,
      model: "openai/omni-moderation-latest",
      term: "pelada",
      languages: ["es"],
    }),
    { ok: false, reason: "unsupported_moderator" }
  );
});

// ─── Route ───────────────────────────────────────────────────────────────────

test("approving a word in the dashboard translates it once; translations show as pending", async () => {
  await setPolicies({
    [SEX]: { moderatorModel: "groq/judge", learnMode: "review", translateLanguages: ["es"] },
  });
  terms.recordTextPolicyTerms(
    SEX,
    [{ term: "pelada", weight: 3, language: "pt", meaning: "naked", category: "nudity" }],
    { ...AUTO, autoActivate: false }
  );
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const content = '{"translations":[{"term":"en cueros","lang":"es","meaning":"naked"}]}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;

  const put = (body: unknown) =>
    termsRoute.PUT(
      new Request("http://localhost/api/text-policies/sexual-content/terms", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ policyId: SEX }) }
    );
  const response = await put({ term: "pelada", status: "active" });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { translating: boolean }).translating, true);

  for (let i = 0; i < 50 && !row("en cueros"); i++) await new Promise((r) => setTimeout(r, 10));
  const translated = row("en cueros");
  assert.equal(translated?.status, "pending");
  assert.equal(translated?.sourceTerm, "pelada");
  assert.equal(translated?.meaning, "naked");

  const list = await termsRoute.GET(
    new Request("http://localhost/api/text-policies/sexual-content/terms?status=pending"),
    { params: Promise.resolve({ policyId: SEX }) }
  );
  const listed = ((await list.json()) as { terms: Array<Record<string, unknown>> }).terms;
  assert.deepEqual(
    listed.map((entry) => [entry.term, entry.language, entry.source, entry.sourceTerm]),
    [["en cueros", "es", "translation", "pelada"]]
  );

  // Re-approving (or reweighting) never translates again.
  await put({ term: "pelada", status: "active", weight: 5 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
});
