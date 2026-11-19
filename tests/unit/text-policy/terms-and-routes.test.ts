/**
 * Text-policy learned terms (src/lib/db/textPolicyTerms.ts), the cached loader, and the
 * management routes /api/text-policies, /api/text-policies/<id>/terms, /<id>/evaluate.
 *
 * Self-isolating: DATA_DIR points at a fresh temp dir BEFORE any `@/lib/db/*` module loads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-text-policy-terms-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const readCache = await import("../../../src/lib/db/readCache.ts");
const terms = await import("../../../src/lib/db/textPolicyTerms.ts");
const learning = await import("../../../src/lib/textPolicy/learning.ts");
const listRoute = await import("../../../src/app/api/text-policies/route.ts");
const termsRoute = await import("../../../src/app/api/text-policies/[policyId]/terms/route.ts");
const evaluateRoute =
  await import("../../../src/app/api/text-policies/[policyId]/evaluate/route.ts");

const AUTO = { autoActivate: true, minHits: 2, moderatorModel: "groq/judge" };
const SEX = "sexual-content";

async function setPolicies(textPolicies: Record<string, unknown>) {
  await settingsDb.updateSettings({ textPolicies });
  readCache.invalidateDbCache?.("settings");
}

test.beforeEach(async () => {
  core.getDbInstance().prepare("DELETE FROM text_policy_terms").run();
  learning.invalidateLearnedTermsCache();
  await setPolicies({});
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── Storage ─────────────────────────────────────────────────────────────────

test("auto mode: pending at first, active at learnMinHits, highest weight kept", () => {
  assert.deepEqual(terms.recordTextPolicyTerms(SEX, [{ term: "Freaky", weight: 3 }], AUTO), {
    added: ["freaky"],
    activated: [],
  });
  assert.deepEqual(terms.getActiveTextPolicyTerms(SEX), []);
  assert.deepEqual(terms.recordTextPolicyTerms(SEX, [{ term: "freaky", weight: 5 }], AUTO), {
    added: [],
    activated: ["freaky"],
  });
  assert.deepEqual(terms.getActiveTextPolicyTerms(SEX), [{ term: "freaky", weight: 5 }]);
});

test("terms are partitioned by policy", () => {
  terms.recordTextPolicyTerms(SEX, [{ term: "freaky", weight: 3 }], { ...AUTO, minHits: 1 });
  terms.recordTextPolicyTerms("violence", [{ term: "carnage", weight: 3 }], {
    ...AUTO,
    minHits: 1,
  });
  assert.deepEqual(terms.getActiveTextPolicyTerms(SEX), [{ term: "freaky", weight: 3 }]);
  assert.deepEqual(terms.getActiveTextPolicyTerms("violence"), [{ term: "carnage", weight: 3 }]);
  assert.deepEqual(terms.countTextPolicyTerms("violence"), { pending: 0, active: 1, rejected: 0 });
});

test("review mode never auto-activates; rejected terms never come back; manual weights stick", () => {
  for (let i = 0; i < 4; i++) {
    terms.recordTextPolicyTerms(SEX, [{ term: "freaky", weight: 3 }], {
      ...AUTO,
      autoActivate: false,
    });
  }
  assert.equal(terms.listTextPolicyTerms(SEX, "pending")[0]?.hits, 4);

  terms.upsertTextPolicyTerm(SEX, { term: "spicy", status: "rejected" });
  terms.recordTextPolicyTerms(SEX, [{ term: "spicy", weight: 5 }], AUTO);
  terms.recordTextPolicyTerms(SEX, [{ term: "spicy", weight: 5 }], AUTO);
  assert.equal(terms.listTextPolicyTerms(SEX, "rejected")[0]?.hits, 2);

  terms.upsertTextPolicyTerm(SEX, { term: "thirst trap", weight: 1 });
  terms.recordTextPolicyTerms(SEX, [{ term: "thirst trap", weight: 5 }], AUTO);
  const manual = terms.listTextPolicyTerms(SEX).find((row) => row.term === "thirst trap");
  assert.equal(manual?.weight, 1);
  assert.equal(manual?.source, "manual");
});

test("the cached loader picks up a term as soon as learning activates it", async () => {
  assert.deepEqual(await learning.loadActiveLearnedTerms(SEX), []);
  await learning.recordLearnedTerms(SEX, [{ term: "frisky", weight: 3 }], { ...AUTO, minHits: 1 });
  assert.deepEqual(await learning.loadActiveLearnedTerms(SEX), [{ term: "frisky", weight: 3 }]);
});

// ─── Routes ──────────────────────────────────────────────────────────────────

const params = (policyId: string) => ({ params: Promise.resolve({ policyId }) });
const json = (method: string, body: unknown, url = "http://localhost/api/text-policies/x") =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /api/text-policies lists built-in and settings-defined policies with config and counts", async () => {
  await setPolicies({
    "sexual-content": { enabled: true, rerouteTarget: "combo/x" },
    violence: {
      classifierInstruction: "how violent the TEXT is",
      seedTerms: [{ term: "gore", weight: 3 }],
    },
  });
  terms.upsertTextPolicyTerm("violence", { term: "carnage" });
  const res = await listRoute.GET(new Request("http://localhost/api/text-policies"));
  const body = await res.json();
  type PolicyRow = {
    id: string;
    builtIn: boolean;
    seedTermCount: number;
    config: { enabled: boolean; rerouteTarget: string | null };
    learnedTerms: Record<string, number>;
  };
  const byId: Record<string, PolicyRow> = Object.fromEntries(
    (body.policies as PolicyRow[]).map((p) => [p.id, p])
  );
  assert.equal(byId["sexual-content"].builtIn, true);
  assert.equal(byId["sexual-content"].config.enabled, true);
  assert.equal(byId["sexual-content"].config.rerouteTarget, "combo/x");
  assert.equal(byId.violence.builtIn, false);
  assert.equal(byId.violence.seedTermCount, 1);
  assert.deepEqual(byId.violence.learnedTerms, { pending: 0, active: 1, rejected: 0 });
});

test("terms route: PUT / GET / DELETE per policy; unknown policy is 404", async () => {
  const added = await termsRoute.PUT(json("PUT", { term: "Freaky", weight: 3 }), params(SEX));
  assert.equal((await added.json()).term.status, "active");
  terms.recordTextPolicyTerms(SEX, [{ term: "frisky", weight: 1 }], AUTO);

  const pending = await termsRoute.GET(
    new Request("http://localhost/api/text-policies/sexual-content/terms?status=pending"),
    params(SEX)
  );
  assert.deepEqual(
    (await pending.json()).terms.map((t: { term: string }) => t.term),
    ["frisky"]
  );

  await termsRoute.PUT(json("PUT", { term: "frisky", status: "active" }), params(SEX));
  assert.equal(terms.getActiveTextPolicyTerms(SEX).length, 2);

  const removed = await termsRoute.DELETE(json("DELETE", { term: "freaky" }), params(SEX));
  assert.deepEqual(await removed.json(), { ok: true, deleted: true });

  assert.equal(
    (await termsRoute.GET(new Request("http://localhost/x"), params("nope"))).status,
    404
  );
  assert.equal(
    (await termsRoute.GET(new Request("http://localhost/x"), params("Bad Id"))).status,
    400
  );
  assert.equal(
    (await termsRoute.PUT(json("PUT", { term: "x", weight: 9 }), params(SEX))).status,
    400
  );
});

test("evaluate route: returns decision + plan without acting; disabled unless ignoreEnabled", async () => {
  const off = await evaluateRoute.POST(json("POST", { text: "porn, blowjob" }), params(SEX));
  assert.deepEqual(await off.json(), { policy: SEX, enabled: false, decision: null });

  const probe = await evaluateRoute.POST(
    json("POST", { text: "porn, blowjob", ignoreEnabled: true }),
    params(SEX)
  );
  const probeBody = await probe.json();
  assert.equal(probeBody.decision.violation, true);
  assert.equal(probeBody.plan.action, "no_reroute_target");

  await setPolicies({ "sexual-content": { enabled: true, mode: "block" } });
  const blocked = await evaluateRoute.POST(
    json("POST", { text: "porn, blowjob", requestedModel: "claude/x" }),
    params(SEX)
  );
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.enabled, true);
  assert.equal(blockedBody.plan.block, true);

  assert.equal((await evaluateRoute.POST(json("POST", {}), params(SEX))).status, 400);
  assert.equal(
    (await evaluateRoute.POST(json("POST", { text: "x" }), params("unknown"))).status,
    404
  );
});
