import assert from "node:assert/strict";
import test from "node:test";

import {
  compactFields,
  formatTermLines,
  getKeyOverrides,
  parseOptionalNumber,
  parseTermLines,
  parseWordLines,
  readStoredPolicies,
  removePolicy,
  setKeyOverride,
  setPolicyEnabled,
  setPolicyGlobalFields,
  validateNewPolicyId,
  validatePolicies,
} from "../../../src/app/(dashboard)/dashboard/settings/components/textPolicies/textPolicyForm.ts";

const BASE = {
  "sexual-content": {
    enabled: true,
    rerouteTarget: "combo/x",
    keyOverrides: { k1: { enabled: false } },
  },
};

test("readStoredPolicies keeps only object entries", () => {
  assert.deepEqual(readStoredPolicies({ textPolicies: { a: { enabled: true }, b: 3 } }), {
    a: { enabled: true },
  });
  assert.deepEqual(readStoredPolicies({}), {});
  assert.deepEqual(readStoredPolicies(null), {});
});

test("setPolicyGlobalFields replaces global fields, drops blanks, keeps key overrides", () => {
  const next = setPolicyGlobalFields(BASE, "sexual-content", {
    enabled: false,
    mode: "block",
    rerouteTarget: "",
    lowThreshold: undefined,
    seedTerms: [],
    label: "  Adult  ",
  });
  assert.deepEqual(next["sexual-content"], {
    enabled: false,
    mode: "block",
    label: "Adult",
    keyOverrides: { k1: { enabled: false } },
  });
  assert.equal(BASE["sexual-content"].rerouteTarget, "combo/x", "input not mutated");
});

test("setPolicyEnabled only flips enabled", () => {
  const next = setPolicyEnabled(BASE, "sexual-content", false);
  assert.equal(next["sexual-content"].enabled, false);
  assert.equal(next["sexual-content"].rerouteTarget, "combo/x");
  assert.deepEqual(setPolicyEnabled({}, "violence", true), { violence: { enabled: true } });
});

test("setKeyOverride adds, replaces and removes per-key entries", () => {
  const added = setKeyOverride(BASE, "sexual-content", "k2", {
    rerouteTarget: "grok/grok-4",
    lowThreshold: undefined,
  });
  assert.deepEqual(getKeyOverrides(added, "sexual-content"), {
    k1: { enabled: false },
    k2: { rerouteTarget: "grok/grok-4" },
  });
  const cleared = setKeyOverride(added, "sexual-content", "k1", null);
  assert.deepEqual(Object.keys(getKeyOverrides(cleared, "sexual-content")), ["k2"]);
  const emptied = setKeyOverride(cleared, "sexual-content", "k2", { mode: "" });
  assert.equal(emptied["sexual-content"].keyOverrides, undefined, "no empty map left behind");
});

test("removePolicy deletes the entry", () => {
  assert.deepEqual(removePolicy(BASE, "sexual-content"), {});
});

test("term lines: term or term:weight, invalid lines reported, duplicates dropped", () => {
  assert.deepEqual(parseTermLines("acme corp:5\nacme\n\nAcme\nbad:9\nfoo:bar:2"), {
    terms: [
      { term: "acme corp", weight: 5 },
      { term: "acme", weight: 3 },
      { term: "foo:bar", weight: 2 },
    ],
    invalid: ["bad:9"],
  });
  assert.equal(
    formatTermLines([
      { term: "x", weight: 1 },
      { term: "y z", weight: 5 },
    ]),
    "x:1\ny z:5"
  );
  assert.deepEqual(parseWordLines("couch\nbed, couch\n\n"), ["couch", "bed"]);
});

test("numbers and compaction", () => {
  assert.equal(parseOptionalNumber(""), undefined);
  assert.equal(parseOptionalNumber(" 4 "), 4);
  assert.ok(Number.isNaN(parseOptionalNumber("abc")));
  assert.deepEqual(compactFields({ a: "", b: null, c: Number.NaN, d: [], e: 0, f: false }), {
    e: 0,
    f: false,
  });
});

test("new policy id validation and whole-object validation", () => {
  assert.equal(validateNewPolicyId("competitor-mentions", ["sexual-content"]), null);
  assert.equal(validateNewPolicyId("Bad Id", []), "invalidId");
  assert.equal(validateNewPolicyId("sexual-content", ["sexual-content"]), "duplicateId");
  assert.equal(validatePolicies(BASE), null);
  assert.match(
    validatePolicies({ "sexual-content": { lowThreshold: 10, highThreshold: 2 } }) ?? "",
    /lowThreshold must be lower/
  );
});
