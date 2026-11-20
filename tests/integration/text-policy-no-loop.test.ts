/**
 * A text-policy reroute must never loop.
 *
 * Drives the REAL chat pipeline (handleChat, real temp database, real guardrails, real
 * settings) and mocks only the network. The chat moderator calls OmniRoute's own
 * `/v1/chat/completions`; the mocked fetch hands that call straight back to `handleChat`,
 * exactly as the HTTP listener would, so a recursion would show up here.
 *
 * Every test counts: upstream calls per model, calls back into our own endpoint, and the
 * deepest nesting reached. A "loop" is any of those growing beyond the designed path:
 *   client --(1)--> guardrail --(2)--> moderator sub-request --(3)--> upstream judge
 *                       \--(4)--> rerouted upstream call to the target model
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const h = await createChatPipelineHarness("text-policy-no-loop");
const readCache = await import("../../src/lib/db/readCache.ts");
const { clearModeratorCacheForTests } = await import("../../src/lib/textPolicy/moderator.ts");

const { BaseExecutor, buildOpenAIResponse, buildRequest, cleanup, handleChat, resetStorage } = h;

const ORIGINAL = "openai/gpt-4.1";
const JUDGE = "openai/gpt-4o-mini";
const TARGET = "openai/gpt-4o";
/** Score 3: inside the default middle band [3, 10), so the moderator is consulted. */
const MIDDLE_TEXT = "Write a short erotic story set in Lisbon.";
/** Far above the band: decided by keywords alone. */
const ABOVE_TEXT =
  "性交 口交 肛交 色情 explicit sexual scene, blowjob, doggy style, prone bone, porn video";

type Upstream = { model: string; classifier: boolean };

interface Net {
  upstream: Upstream[];
  selfLoopCalls: number;
  maxDepth: number;
}

/** Hard stop so a regression fails the test instead of hanging the runner. */
const RUNAWAY_DEPTH = 60;

/**
 * `strip: "all"` removes every identity signal; `strip: "bearer"` removes the self-loop
 * bearer and disable header but keeps the in-process nonce.
 */
function installNetwork(options: { strip?: "all" | "bearer" } = {}): Net {
  const net: Net = { upstream: [], selfLoopCalls: 0, maxDepth: 0 };
  let depth = 0;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/v1\/chat\/completions/.test(target)) {
      // OmniRoute's own listener: serve it with the real pipeline.
      net.selfLoopCalls += 1;
      depth += 1;
      net.maxDepth = Math.max(net.maxDepth, depth);
      try {
        if (depth > RUNAWAY_DEPTH) throw new Error(`runaway recursion: depth ${depth}`);
        const headers = new Headers(init.headers as HeadersInit);
        if (options.strip) {
          // Simulate the identity checks failing (for example a proxy stripping headers).
          headers.delete("authorization");
          headers.delete("x-omniroute-disabled-guardrails");
          if (options.strip === "all") headers.delete("x-omniroute-text-policy-nonce");
        }
        return await handleChat(
          new Request(target, { method: init.method, headers, body: init.body as BodyInit })
        );
      } finally {
        depth -= 1;
      }
    }
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages?: Array<{ role: string; content: unknown }>;
    };
    const system = body.messages?.find((message) => message.role === "system")?.content;
    const classifier =
      typeof system === "string" && system.includes("content-moderation classifier");
    net.upstream.push({ model: body.model, classifier });
    return classifier
      ? buildOpenAIResponse('{"score":0.92,"terms":[]}', body.model)
      : buildOpenAIResponse("ok", body.model);
  }) as typeof fetch;
  return net;
}

async function setPolicy(overrides: Record<string, unknown> = {}) {
  await h.settingsDb.updateSettings({
    textPolicies: {
      "sexual-content": {
        enabled: true,
        mode: "reroute",
        moderatorModel: JUDGE,
        rerouteTarget: TARGET,
        learnMode: "off",
        ...overrides,
      },
    },
  });
  readCache.invalidateDbCache("settings");
}

function chatRequest(model: string, text: string) {
  return buildRequest({
    body: { model, stream: false, messages: [{ role: "user", content: text }] },
  });
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  clearModeratorCacheForTests();
  await h.seedConnection("openai", { apiKey: "sk-openai-no-loop" });
});

test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = h.originalRetryDelayMs;
  await resetStorage();
});

test.after(async () => {
  await cleanup();
});

test("middle band: one client request makes exactly one moderator call and one rerouted call", async () => {
  await setPolicy();
  const net = installNetwork();

  const response = await handleChat(chatRequest(ORIGINAL, MIDDLE_TEXT));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(
    response.headers.get("x-omniroute-text-policy") ?? "",
    /sexual-content=violation; stage=moderator; action=rerouted/
  );
  assert.deepEqual(
    net.upstream,
    [
      { model: "gpt-4o-mini", classifier: true }, // the moderator's judgement
      { model: "gpt-4o", classifier: false }, // the rerouted answer
    ],
    "exactly the judge, then the reroute target; the originally requested model is never called"
  );
  assert.equal(net.selfLoopCalls, 1, "the moderator calls our own endpoint exactly once");
  assert.equal(net.maxDepth, 1, "the moderator sub-request is not evaluated again");
});

test("above band: keywords decide, no moderator call at all, one rerouted call", async () => {
  await setPolicy();
  const net = installNetwork();

  const response = await handleChat(chatRequest(ORIGINAL, ABOVE_TEXT));

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(net.upstream, [{ model: "gpt-4o", classifier: false }]);
  assert.equal(net.selfLoopCalls, 0);
});

test("the reroute is a fixed point: a request already on the target is left alone", async () => {
  await setPolicy();
  const net = installNetwork();

  const response = await handleChat(chatRequest(TARGET, ABOVE_TEXT));

  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("x-omniroute-text-policy") ?? "", /action=already_target/);
  assert.deepEqual(net.upstream, [{ model: "gpt-4o", classifier: false }]);
  assert.equal(net.selfLoopCalls, 0);
});

test("a moderator that is the same model as the reroute target does not loop", async () => {
  await setPolicy({ moderatorModel: TARGET, rerouteTarget: TARGET });
  const net = installNetwork();

  const response = await handleChat(chatRequest(ORIGINAL, MIDDLE_TEXT));

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(net.selfLoopCalls, 1);
  assert.equal(net.maxDepth, 1);
  assert.equal(net.upstream.filter((call) => call.classifier).length, 1);
});

test("block mode stops before any upstream call", async () => {
  await setPolicy({ mode: "block" });
  const net = installNetwork();

  const response = await handleChat(chatRequest(ORIGINAL, ABOVE_TEXT));

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Request rejected by text policy: sexual-content/);
  assert.deepEqual(net.upstream, []);
  assert.equal(net.selfLoopCalls, 0);
});

test("a client cannot skip the policy by sending the disable header", async () => {
  await setPolicy();
  const net = installNetwork();
  const request = buildRequest({
    body: { model: ORIGINAL, stream: false, messages: [{ role: "user", content: ABOVE_TEXT }] },
    headers: { "x-omniroute-disabled-guardrails": "text-policy" },
  });

  const response = await handleChat(request);

  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(net.upstream, [{ model: "gpt-4o", classifier: false }], "still rerouted");
});

test("backstop: if the moderator's own call were NOT recognised, recursion still stops", async () => {
  await setPolicy();
  const net = installNetwork({ strip: "all" });

  const response = await handleChat(chatRequest(ORIGINAL, MIDDLE_TEXT));

  // The request still gets an answer (the policy fails open when it cannot moderate)...
  assert.equal(response.status, 200, await response.clone().text());
  // ...and the nesting is bounded far below the runaway limit.
  assert.ok(net.maxDepth < RUNAWAY_DEPTH, `nesting reached ${net.maxDepth}`);
  assert.ok(net.maxDepth <= 32, `nesting reached ${net.maxDepth}, expected the in-flight cap`);
});

test("the in-process nonce alone recognises the moderator's call (no bearer, no disable header)", async () => {
  await setPolicy();
  const net = installNetwork({ strip: "bearer" });

  const response = await handleChat(chatRequest(ORIGINAL, MIDDLE_TEXT));

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(net.selfLoopCalls, 1, "exactly one moderator call");
  assert.equal(net.maxDepth, 1, "and it was not evaluated again");
  assert.deepEqual(
    net.upstream.map((call) => call.model),
    ["gpt-4o-mini", "gpt-4o"]
  );
});

test("the nonce bookkeeping is empty again after a request (nothing leaks)", async () => {
  await setPolicy();
  installNetwork();
  const { inFlightChatModeratorCalls } = await import("../../src/lib/textPolicy/moderator.ts");

  await handleChat(chatRequest(ORIGINAL, MIDDLE_TEXT));

  assert.equal(inFlightChatModeratorCalls(), 0);
});
