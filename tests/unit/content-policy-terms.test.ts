/**
 * Self-growing content-policy lexicon: persistence (src/lib/db/contentPolicyTerms.ts),
 * the cached active-term loader, and the management route /api/content-policy/terms.
 *
 * Self-isolating: DATA_DIR points at a fresh temp dir BEFORE any `@/lib/db/*`
 * module loads, so this file never touches ~/.omniroute.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-content-policy-terms-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const terms = await import("../../src/lib/db/contentPolicyTerms.ts");
const learning = await import("../../src/lib/guardrails/contentPolicy/learning.ts");
const route = await import("../../src/app/api/content-policy/terms/route.ts");

const AUTO = { autoActivate: true, minHits: 2, moderatorModel: "groq/llama-judge" };

test.beforeEach(() => {
  core.getDbInstance().prepare("DELETE FROM content_policy_terms").run();
  learning.invalidateLearnedTermsCache();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("auto mode: a new term is pending, and becomes active at learnMinHits", () => {
  const first = terms.recordDiscoveredContentPolicyTerms([{ term: "Freaky", weight: 3 }], AUTO);
  assert.deepEqual(first, { added: ["freaky"], activated: [] });
  assert.equal(terms.listContentPolicyTerms("pending")[0]?.hits, 1);
  assert.deepEqual(terms.getActiveContentPolicyTerms(), []);

  const second = terms.recordDiscoveredContentPolicyTerms([{ term: "freaky", weight: 5 }], AUTO);
  assert.deepEqual(second, { added: [], activated: ["freaky"] });
  const [row] = terms.listContentPolicyTerms("active");
  assert.equal(row.hits, 2);
  assert.equal(row.weight, 5, "weight is the highest reported");
  assert.equal(row.lastModeratorModel, "groq/llama-judge");
  assert.deepEqual(terms.getActiveContentPolicyTerms(), [{ term: "freaky", weight: 5 }]);
});

test("learnMinHits 1 activates on the first adult verdict", () => {
  const result = terms.recordDiscoveredContentPolicyTerms([{ term: "frisky", weight: 1 }], {
    ...AUTO,
    minHits: 1,
  });
  assert.deepEqual(result.activated, ["frisky"]);
});

test("review mode never auto-activates", () => {
  const review = { ...AUTO, autoActivate: false };
  for (let i = 0; i < 5; i++) {
    terms.recordDiscoveredContentPolicyTerms([{ term: "freaky", weight: 3 }], review);
  }
  const [row] = terms.listContentPolicyTerms();
  assert.equal(row.status, "pending");
  assert.equal(row.hits, 5);
});

test("a rejected term keeps counting hits but learning never re-activates it", () => {
  terms.upsertContentPolicyTerm({ term: "spicy", status: "rejected" });
  terms.recordDiscoveredContentPolicyTerms([{ term: "spicy", weight: 5 }], AUTO);
  terms.recordDiscoveredContentPolicyTerms([{ term: "spicy", weight: 5 }], AUTO);
  const [row] = terms.listContentPolicyTerms();
  assert.equal(row.status, "rejected");
  assert.equal(row.hits, 2);
});

test("a manual term keeps its operator weight when the moderator reports it again", () => {
  terms.upsertContentPolicyTerm({ term: "thirst trap", weight: 1 });
  terms.recordDiscoveredContentPolicyTerms([{ term: "thirst trap", weight: 5 }], AUTO);
  const [row] = terms.listContentPolicyTerms();
  assert.equal(row.source, "manual");
  assert.equal(row.status, "active");
  assert.equal(row.weight, 1);
});

test("weights are clamped to 1..5 and unusable terms are skipped", () => {
  terms.recordDiscoveredContentPolicyTerms(
    [
      { term: "  big   tease ", weight: 99 },
      { term: "", weight: 3 },
      { term: "x".repeat(60), weight: 3 },
    ],
    AUTO
  );
  const rows = terms.listContentPolicyTerms();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].term, "big tease");
  assert.equal(rows[0].weight, 5);
});

test("the cached loader sees a term once it is activated through learning", async () => {
  assert.deepEqual(await learning.loadActiveLearnedTerms(), []);
  await learning.recordLearnedTerms([{ term: "frisky", weight: 3 }], { ...AUTO, minHits: 1 });
  assert.deepEqual(await learning.loadActiveLearnedTerms(), [{ term: "frisky", weight: 3 }]);
});

// ─── /api/content-policy/terms ───────────────────────────────────────────────

function jsonRequest(method: string, body: unknown) {
  return new Request("http://localhost/api/content-policy/terms", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("route: PUT adds or edits a term, GET lists and filters, DELETE removes", async () => {
  const added = await route.PUT(jsonRequest("PUT", { term: "Freaky", weight: 3 }));
  assert.equal(added.status, 200);
  assert.equal((await added.json()).term.status, "active");

  terms.recordDiscoveredContentPolicyTerms([{ term: "frisky", weight: 1 }], AUTO);

  const all = await route.GET(new Request("http://localhost/api/content-policy/terms"));
  assert.deepEqual((await all.json()).terms.map((t: { term: string }) => t.term).sort(), [
    "freaky",
    "frisky",
  ]);

  const pending = await route.GET(
    new Request("http://localhost/api/content-policy/terms?status=pending")
  );
  assert.deepEqual(
    (await pending.json()).terms.map((t: { term: string }) => t.term),
    ["frisky"]
  );

  const activated = await route.PUT(jsonRequest("PUT", { term: "frisky", status: "active" }));
  assert.equal((await activated.json()).term.status, "active");
  assert.equal(terms.getActiveContentPolicyTerms().length, 2);

  const removed = await route.DELETE(jsonRequest("DELETE", { term: "freaky" }));
  assert.deepEqual(await removed.json(), { ok: true, deleted: true });
  assert.equal(terms.listContentPolicyTerms().length, 1);
});

test("route: rejects invalid bodies and filters", async () => {
  assert.equal((await route.PUT(jsonRequest("PUT", { term: "x", weight: 9 }))).status, 400);
  assert.equal((await route.PUT(jsonRequest("PUT", { term: "x", bogus: true }))).status, 400);
  assert.equal(
    (await route.GET(new Request("http://localhost/api/content-policy/terms?status=nope"))).status,
    400
  );
  const badJson = new Request("http://localhost/api/content-policy/terms", {
    method: "DELETE",
    body: "{nope",
  });
  assert.equal((await route.DELETE(badJson)).status, 400);
});
