/**
 * The three safeguards that keep the chat moderator from looping
 * (see the "Loop safety" notes in src/lib/textPolicy/moderator.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_MODERATOR_TIMEOUT_MS,
  MAX_IN_FLIGHT_CHAT_MODERATOR_CALLS,
  MODERATOR_NONCE_HEADER,
  clearModeratorCacheForTests,
  defaultModerate,
  inFlightChatModeratorCalls,
  isOwnModeratorRequest,
} from "../../../src/lib/textPolicy/moderator.ts";
import { TextPolicyGuardrail } from "../../../src/lib/guardrails/textPolicy.ts";

const POLICY = {
  id: "sexual-content",
  moderationCategory: "sexual",
  classifierInstruction: "how sexual the TEXT is",
};

const REPLY = JSON.stringify({ choices: [{ message: { content: '{"score":0.4,"terms":[]}' } }] });

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  clearModeratorCacheForTests();
});

test("a nonce is recognised only while its own call is in flight", async () => {
  let seenDuring: boolean | null = null;
  let nonce = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers as HeadersInit);
    nonce = headers.get(MODERATOR_NONCE_HEADER) ?? "";
    seenDuring = isOwnModeratorRequest(headers);
    return new Response(REPLY, { status: 200 });
  }) as typeof fetch;

  const verdict = await defaultModerate({ policy: POLICY, model: "groq/judge", text: "a" });

  assert.equal(verdict.ok, true);
  assert.ok(nonce.length >= 32, "a long random value");
  assert.equal(seenDuring, true);
  assert.equal(isOwnModeratorRequest(new Headers({ [MODERATOR_NONCE_HEADER]: nonce })), false);
  assert.equal(inFlightChatModeratorCalls(), 0);
});

test("a forged or missing nonce is never accepted", () => {
  assert.equal(isOwnModeratorRequest(new Headers({ [MODERATOR_NONCE_HEADER]: "forged" })), false);
  assert.equal(isOwnModeratorRequest({ [MODERATOR_NONCE_HEADER]: "forged" }), false);
  assert.equal(isOwnModeratorRequest(new Headers()), false);
  assert.equal(isOwnModeratorRequest(null), false);
});

test("a client sending a made-up nonce is still evaluated by the policy", async () => {
  const guardrail = new TextPolicyGuardrail(
    {},
    {
      getSettings: async () => ({
        textPolicies: { "sexual-content": { enabled: true, rerouteTarget: "combo/nsfw-ok" } },
      }),
      loadLearnedTerms: async () => [],
    }
  );
  const result = await guardrail.preCall(
    { model: "claude/x", messages: [{ role: "user", content: "porn blowjob 口交 色情" }] },
    { headers: new Headers({ [MODERATOR_NONCE_HEADER]: "i-made-this-up" }) }
  );
  assert.equal((result.modifiedPayload as { model: string }).model, "combo/nsfw-ok");
});

test("the cap bounds in-flight moderator calls; the next one fails open as moderator_busy", async () => {
  const release: Array<() => void> = [];
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      release.push(() => resolve(new Response(REPLY, { status: 200 })));
    })) as typeof fetch;

  const pending = Array.from({ length: MAX_IN_FLIGHT_CHAT_MODERATOR_CALLS }, (_, i) =>
    defaultModerate({ policy: POLICY, model: "groq/judge", text: `text ${i}` })
  );
  while (release.length < MAX_IN_FLIGHT_CHAT_MODERATOR_CALLS) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(inFlightChatModeratorCalls(), MAX_IN_FLIGHT_CHAT_MODERATOR_CALLS);

  const overflow = await defaultModerate({ policy: POLICY, model: "groq/judge", text: "one more" });
  assert.deepEqual(overflow, { ok: false, reason: "moderator_busy" });
  assert.equal(release.length, MAX_IN_FLIGHT_CHAT_MODERATOR_CALLS, "no extra upstream call");

  release.forEach((fn) => fn());
  const results = await Promise.all(pending);
  assert.ok(results.every((result) => result.ok));
  assert.equal(inFlightChatModeratorCalls(), 0, "every slot is released");
});

test("a failed or timed-out call releases its slot and fails open", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;
  assert.deepEqual(await defaultModerate({ policy: POLICY, model: "groq/judge", text: "b" }), {
    ok: false,
    reason: "moderator_error",
  });
  assert.equal(inFlightChatModeratorCalls(), 0);

  globalThis.fetch = (async () => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }) as typeof fetch;
  assert.deepEqual(await defaultModerate({ policy: POLICY, model: "groq/judge", text: "c" }), {
    ok: false,
    reason: "moderator_timeout",
  });
  assert.equal(inFlightChatModeratorCalls(), 0);
});

test("the moderator call carries a timeout signal", async () => {
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    signal = init.signal;
    return new Response(REPLY, { status: 200 });
  }) as typeof fetch;
  await defaultModerate({ policy: POLICY, model: "groq/judge", text: "d" });
  assert.ok(signal, "a signal is passed to fetch");
  assert.equal(signal?.aborted, false);
  assert.ok(CHAT_MODERATOR_TIMEOUT_MS > 0 && CHAT_MODERATOR_TIMEOUT_MS <= 60_000);
});
