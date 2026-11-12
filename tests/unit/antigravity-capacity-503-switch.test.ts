// Antigravity answers 503 "No capacity available for model X on the server"
// (ErrorInfo reason MODEL_CAPACITY_EXHAUSTED, RetryInfo up to ~60s) when Google has no
// capacity for that model on that account. Production (2026-11-12): the executor waited
// out that delay on the same account up to 3 times, so requests took 11-76s while a second
// account served the same model without a single 503.
//
// The fix stays inside the existing machinery:
// - antigravity429Engine classifies it as model capacity -> the existing
//   "short_cooldown_switch_auth" decision, so the executor stops retrying that account;
// - chat.ts skips its one same-account transport retry for it (like the Antigravity 504);
// - markAccountUnavailable records the existing model-only lockout and selection picks the
//   next account; with no other account, the cooldown-aware retry waits and retries;
// - model capacity is not a provider outage, so it never counts against the provider breaker.
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("antigravity-capacity-503-switch");
const providersDb = await import("../../src/lib/db/providers.ts");
const { clearAllModelLockouts, getModelLockoutInfo } =
  await import("../../open-sse/services/accountFallback.ts");
const { classify429, decide429 } = await import("../../open-sse/services/antigravity429Engine.ts");
const { isModelCapacityOverloadError, getCircuitBreaker, resetAllCircuitBreakers } =
  await import("../../src/shared/utils/circuitBreaker.ts");
const { shouldTripProviderBreakerForResult } =
  await import("../../src/sse/handlers/chatPredicates.ts");
const { shouldRetrySameAccountTransport } =
  await import("../../src/sse/services/sameAccountTransportRetry.ts");
const { seedAntigravityIdeVersionCache, seedAntigravityCliVersionCache } =
  await import("../../open-sse/services/antigravityVersion.ts");
const { BaseExecutor, buildRequest, handleChat, resetStorage, settingsDb } = harness;

const MODEL = "gemini-3.1-flash-lite";
const CAPACITY_MESSAGE = `No capacity available for model ${MODEL} on the server`;
// What chat.ts sees as the error text once the executor has wrapped Google's body.
const WRAPPED_CAPACITY_ERROR = `[503]: Antigravity upstream error (503): ${CAPACITY_MESSAGE}`;

function capacity503(retryDelay: string | null = "59s", headers: Record<string, string> = {}) {
  const details: unknown[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "MODEL_CAPACITY_EXHAUSTED",
      domain: "cloudcode-pa.googleapis.com",
      metadata: { model: MODEL },
    },
  ];
  if (retryDelay) {
    details.push({ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay });
  }
  return new Response(
    JSON.stringify({
      error: { code: 503, message: CAPACITY_MESSAGE, status: "UNAVAILABLE", details },
    }),
    { status: 503, headers: { "Content-Type": "application/json", ...headers } }
  );
}

function okSSE(text: string) {
  return new Response(
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":"${text}"}]},"finishReason":"STOP"}]}}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  process.env.ANTIGRAVITY_CREDITS = "off";
  await resetStorage();
  clearAllModelLockouts();
  resetAllCircuitBreakers();
  seedAntigravityIdeVersionCache("2026.11.13-capacity-test");
  seedAntigravityCliVersionCache("2026.11.13-capacity-test");
  // Production defaults: cooldown-aware retry on. A 1s connection cooldown keeps the
  // single-account wait short.
  await settingsDb.updateSettings({
    requestRetry: 3,
    maxRetryIntervalSec: 30,
    resilienceSettings: { connectionCooldown: { oauth: { baseCooldownMs: 1000 } } },
  });
});

test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
  delete process.env.ANTIGRAVITY_CREDITS;
  clearAllModelLockouts();
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

async function seedAccount(name: string, token: string, priority: number) {
  const connection = await providersDb.createProviderConnection({
    provider: "antigravity",
    authType: "oauth",
    name,
    email: `${name}@example.test`,
    accessToken: token,
    refreshToken: `refresh-${token}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    isActive: true,
    testStatus: "active",
    priority,
    providerSpecificData: { projectId: `project-${name}` },
  });
  return (connection as { id: string }).id;
}

/** Fake Cloud Code: each account token answers from its own queue (last entry repeats). */
function stubCloudCode(byToken: Record<string, Array<() => Response>>) {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (
      new URL(request.url).hostname === "daily-cloudcode-pa.googleapis.com" &&
      /generatecontent/i.test(request.url)
    ) {
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      calls.push(token);
      const queue = byToken[token] ?? [];
      const sent = calls.filter((t) => t === token).length;
      const next = queue[Math.min(sent - 1, queue.length - 1)];
      if (!next) throw new Error(`no stubbed response for ${token}`);
      return next();
    }
    if (request.url.includes(":loadCodeAssist")) {
      return new Response(JSON.stringify({ cloudaicompanionProject: "projects/stub" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

function chatRequest() {
  return buildRequest({
    body: {
      model: `antigravity/${MODEL}`,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    },
  });
}

// ── Pure classification ────────────────────────────────────────────────────────

test("engine: a capacity 503 is model capacity and switches account", () => {
  // The executor classifies Google's message plus its ErrorInfo reasons.
  const category = classify429(`${CAPACITY_MESSAGE} MODEL_CAPACITY_EXHAUSTED`);
  assert.equal(category, "model_capacity");
  assert.equal(classify429("MODEL_CAPACITY_EXHAUSTED"), "model_capacity");
  const decision = decide429(category, 59_000);
  assert.equal(decision.kind, "short_cooldown_switch_auth");
  assert.equal(decision.retryAfterMs, 59_000);
  // Quota wording keeps its own category.
  assert.equal(classify429("You have exhausted your capacity on this model."), "quota_exhausted");
});

test("breaker: Antigravity model capacity is not a provider failure; other 503s still are", () => {
  assert.equal(isModelCapacityOverloadError(WRAPPED_CAPACITY_ERROR), true);
  assert.equal(
    shouldTripProviderBreakerForResult(
      { status: 503, error: WRAPPED_CAPACITY_ERROR },
      false,
      false
    ),
    false
  );
  assert.equal(
    shouldTripProviderBreakerForResult(
      { status: 503, error: "[503]: Antigravity upstream error (503): Service Unavailable" },
      false,
      false
    ),
    true
  );
});

test("same-account retry: skipped for an Antigravity capacity 503 only", () => {
  const base = { status: 503, attempt: 0 };
  for (const provider of ["antigravity", "agy"]) {
    assert.equal(
      shouldRetrySameAccountTransport({ ...base, provider, errorText: WRAPPED_CAPACITY_ERROR }),
      false
    );
  }
  // Other Antigravity 503s and other providers keep the existing one retry.
  assert.equal(
    shouldRetrySameAccountTransport({
      ...base,
      provider: "antigravity",
      errorText: "[503]: Antigravity upstream error (503): Service Unavailable",
    }),
    true
  );
  assert.equal(
    shouldRetrySameAccountTransport({
      ...base,
      provider: "codex",
      errorText: WRAPPED_CAPACITY_ERROR,
    }),
    true
  );
});

// ── Through handleChat ─────────────────────────────────────────────────────────

test("two accounts: a capacity 503 moves the request to the other account at once", async () => {
  const accountA = await seedAccount("cap-a", "token-a", 1);
  await seedAccount("cap-b", "token-b", 2);
  const upstream = stubCloudCode({
    "token-a": [() => capacity503("59s")],
    "token-b": [() => okSSE("ok from B")],
  });
  try {
    const started = Date.now();
    const response = await handleChat(chatRequest());
    const elapsedMs = Date.now() - started;

    assert.equal(response.status, 200);
    assert.match(await response.text(), /ok from B/);
    assert.deepEqual(upstream.calls, ["token-a", "token-b"], "A once, then B — no waiting on A");
    assert.ok(elapsedMs < 10_000, `took ${elapsedMs}ms; must not wait out Google's 59s delay`);
    // The existing model-only lockout: A is benched for this model, not as an account.
    assert.ok(getModelLockoutInfo("antigravity", accountA, MODEL), "A is locked for this model");
    const a = await providersDb.getProviderConnectionById(accountA);
    assert.ok(!a?.rateLimitedUntil || Number(new Date(a.rateLimitedUntil)) <= Date.now());
    assert.equal(getCircuitBreaker("antigravity").getStatus().failureCount, 0);
  } finally {
    upstream.restore();
  }
});

test("two accounts: a capacity 503 with a Retry-After header still moves at once", async () => {
  await seedAccount("cap-hdr-a", "token-a", 1);
  await seedAccount("cap-hdr-b", "token-b", 2);
  const upstream = stubCloudCode({
    "token-a": [() => capacity503(null, { "Retry-After": "30" })],
    "token-b": [() => okSSE("ok from B")],
  });
  try {
    const response = await handleChat(chatRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(upstream.calls, ["token-a", "token-b"]);
  } finally {
    upstream.restore();
  }
});

test("one account: a capacity 503 waits for the cooldown and retries, without a breaker failure", async () => {
  await seedAccount("cap-solo", "token-solo", 1);
  const upstream = stubCloudCode({
    "token-solo": [() => capacity503(null), () => okSSE("ok after wait")],
  });
  try {
    const response = await handleChat(chatRequest());
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ok after wait/);
    assert.deepEqual(upstream.calls, ["token-solo", "token-solo"]);
    assert.equal(getCircuitBreaker("antigravity").getStatus().failureCount, 0);
  } finally {
    upstream.restore();
  }
});

test("other Antigravity 503s keep the executor's existing same-account retry", async () => {
  await seedAccount("busy-a", "token-a", 1);
  await seedAccount("busy-b", "token-b", 2);
  const highTraffic = () =>
    new Response(
      JSON.stringify({
        error: { code: 503, message: "High traffic, please retry", status: "UNAVAILABLE" },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  const upstream = stubCloudCode({
    "token-a": [highTraffic, () => okSSE("ok from A")],
    "token-b": [() => okSSE("ok from B")],
  });
  try {
    const response = await handleChat(chatRequest());
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ok from A/);
    assert.deepEqual(upstream.calls, ["token-a", "token-a"]);
  } finally {
    upstream.restore();
  }
});

test("one account, retries off: the capacity 503 reaches the client without a breaker failure", async () => {
  await settingsDb.updateSettings({ requestRetry: 0, maxRetryIntervalSec: 0 });
  await seedAccount("cap-giveup", "token-giveup", 1);
  const upstream = stubCloudCode({ "token-giveup": [() => capacity503(null)] });
  try {
    const response = await handleChat(chatRequest());
    assert.equal(response.status, 503);
    assert.deepEqual(upstream.calls, ["token-giveup"]);
    // Ten of these in 15 minutes would otherwise block every Antigravity account for 5 min.
    assert.equal(getCircuitBreaker("antigravity").getStatus().failureCount, 0);
  } finally {
    upstream.restore();
  }
});
