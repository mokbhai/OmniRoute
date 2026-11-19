import assert from "node:assert/strict";
import test from "node:test";

import {
  TextPolicyGuardrail,
  isSelfLoopGuardrailRequest,
} from "../../../src/lib/guardrails/textPolicy.ts";
import { GuardrailRegistry } from "../../../src/lib/guardrails/registry.ts";
import type { ModerateFn } from "../../../src/lib/textPolicy/moderator.ts";

const ABOVE =
  "AI 审核摘要：本模版适用成人色情成片要求，口交、肛交、性交，explicit sexual scene, doggy style.";
const MIDDLE = "Write a short erotic story set in Lisbon.";
const CLEAN = "Summarize this report.";

const chat = (text: string, model = "claude/claude-sonnet-4-5") => ({
  model,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});
type Evaluation = Record<string, unknown>;
const evaluationsOf = (meta: Record<string, unknown> | null | undefined) =>
  (meta?.evaluations ?? []) as Evaluation[];

const ctx = (id: string | null = null) => ({
  apiKeyInfo: id ? { id } : null,
  model: "claude/claude-sonnet-4-5",
});

const POLICY = {
  enabled: true,
  rerouteTarget: "combo/nsfw-ok",
  moderatorModel: "openai/omni-moderation-latest",
};

function guardrail(
  textPolicies: Record<string, unknown>,
  options: { score?: number; selfLoop?: boolean } = {}
) {
  const calls: string[] = [];
  const moderate: ModerateFn = async ({ policy }) => {
    calls.push(policy.id);
    return { ok: true, score: options.score ?? 0.9, cached: false, kind: "moderation" };
  };
  return {
    calls,
    guardrail: new TextPolicyGuardrail(
      {},
      {
        getSettings: async () => ({ textPolicies }),
        moderate,
        loadLearnedTerms: async () => [],
        recordLearnedTerms: async () => ({ added: [], activated: [] }),
        isSelfLoopRequest: () => options.selfLoop === true,
      }
    ),
  };
}

test("no enabled policy: the guardrail is a no-op", async () => {
  const { guardrail: g, calls } = guardrail({});
  assert.deepEqual(await g.preCall(chat(ABOVE), ctx()), { block: false });
  assert.equal(calls.length, 0);
});

test("below band passes, above band reroutes, middle band asks the moderator", async () => {
  const { guardrail: g, calls } = guardrail({ "sexual-content": POLICY });
  const clean = await g.preCall(chat(CLEAN), ctx());
  assert.equal(clean.modifiedPayload, undefined);
  assert.equal(evaluationsOf(clean.meta)[0].action, "allowed");

  const above = await g.preCall(chat(ABOVE), ctx());
  assert.equal((above.modifiedPayload as { model: string }).model, "combo/nsfw-ok");
  assert.equal(calls.length, 0);

  const middle = await g.preCall(chat(MIDDLE), ctx());
  assert.deepEqual(calls, ["sexual-content"]);
  const evaluation = evaluationsOf(middle.meta)[0];
  assert.equal(evaluation.stage, "moderator");
  assert.equal(evaluation.action, "rerouted");
  assert.equal(evaluation.toModel, "combo/nsfw-ok");
});

test("block mode rejects with the policy id; flag mode passes", async () => {
  const blocked = await guardrail({
    "sexual-content": { ...POLICY, mode: "block" },
  }).guardrail.preCall(chat(ABOVE), ctx());
  assert.equal(blocked.block, true);
  assert.equal(blocked.message, "Request rejected by text policy: sexual-content");
  const flagged = await guardrail({
    "sexual-content": { ...POLICY, mode: "flag" },
  }).guardrail.preCall(chat(ABOVE), ctx());
  assert.equal(flagged.block, false);
  assert.equal(flagged.modifiedPayload, undefined);
});

test("per-key scope: enabled for one key while off globally", async () => {
  const { guardrail: g } = guardrail({
    "sexual-content": { ...POLICY, enabled: false, keyOverrides: { tenant: { enabled: true } } },
  });
  const tenant = await g.preCall(chat(ABOVE), ctx("tenant"));
  assert.equal((tenant.modifiedPayload as { model: string }).model, "combo/nsfw-ok");
  assert.equal(evaluationsOf(tenant.meta)[0].scope, "key");
  assert.deepEqual(await g.preCall(chat(ABOVE), ctx("other")), { block: false });
});

test("several policies: a settings-defined custom policy runs next to the built-in", async () => {
  const { guardrail: g } = guardrail({
    "sexual-content": { ...POLICY, mode: "flag" },
    "competitor-mentions": {
      enabled: true,
      mode: "block",
      seedTerms: [{ term: "acme corp", weight: 5 }],
      highThreshold: 5,
      classifierInstruction: "how much the TEXT promotes a competitor",
    },
  });
  const result = await g.preCall(chat(`${ABOVE} buy from Acme Corp`), ctx());
  assert.equal(result.block, true);
  assert.equal(result.message, "Request rejected by text policy: competitor-mentions");
});

test("registry: clients cannot disable the guardrail; the self-loop can", async () => {
  const client = new GuardrailRegistry();
  client.register(guardrail({ "sexual-content": POLICY }).guardrail);
  const forced = await client.runPreCallHooks(chat(ABOVE), {
    ...ctx(),
    disabledGuardrails: ["text-policy"],
  });
  assert.equal((forced.payload as { model: string }).model, "combo/nsfw-ok");

  const internal = new GuardrailRegistry();
  internal.register(guardrail({ "sexual-content": POLICY }, { selfLoop: true }).guardrail);
  const skipped = await internal.runPreCallHooks(chat(ABOVE), {
    ...ctx(),
    disabledGuardrails: ["text-policy"],
  });
  assert.equal((skipped.payload as { model: string }).model, "claude/claude-sonnet-4-5");
  assert.equal(skipped.results[0]?.skipped, true);
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
      isSelfLoopGuardrailRequest({ headers: new Headers({ Authorization: "Bearer sk-x" }) }),
      false
    );
    assert.equal(isSelfLoopGuardrailRequest({ headers: null }), false);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previous;
  }
});
