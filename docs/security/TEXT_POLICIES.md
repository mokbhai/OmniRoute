---
title: "Text Policies"
version: 3.8.54
lastUpdated: 2026-11-19
---

# Text Policies

> **Source of truth:** `src/lib/textPolicy/`

A **text policy** detects one kind of content in text, such as sexual content,
violence, or a customer's banned topics, and tells the caller what to do about it.
Every policy runs on the same engine:

1. **Keyword score** (local, no network) from the policy's seed terms plus its
   active learned terms.
2. **Moderator**, only when the score falls in the middle band.
3. **Action plan**: allow, reroute to another model, block, or flag.

The engine is shared code. The chat guardrail (`src/lib/guardrails/textPolicy.ts`)
and the HTTP evaluate route are thin callers of it, and any other process can call it
the same way.

## Layout

| File                                        | Role                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `src/lib/textPolicy/index.ts`               | Public surface. Import from `@/lib/textPolicy`.                         |
| `src/lib/textPolicy/engine.ts`              | `evaluateTextPolicy`, `evaluateTextPoliciesFor`, `planTextPolicyAction` |
| `src/lib/textPolicy/catalog.ts`             | Which policies exist: `registerTextPolicy`, settings-defined policies   |
| `src/lib/textPolicy/config.ts`              | Per-request config: per-key override → global → default                 |
| `src/lib/textPolicy/lexicon.ts`             | Keyword scoring and bands                                               |
| `src/lib/textPolicy/moderator.ts`           | Moderation-model and chat-model moderators                              |
| `src/lib/textPolicy/learning.ts`            | Self-growing lexicon: term validation, cached active terms              |
| `src/lib/textPolicy/extract.ts`             | Text extraction from chat / Responses / Claude / prompt bodies          |
| `src/lib/textPolicy/header.ts`              | `x-omniroute-text-policy` response header                               |
| `src/lib/textPolicy/policies/`              | Built-in definitions (`sexualContent.ts`)                               |
| `src/lib/db/textPolicyTerms.ts`             | Learned terms, table `text_policy_terms`, partitioned by policy         |
| `src/shared/validation/textPolicySchema.ts` | Zod schema for the `textPolicies` setting                               |

## Definition and config

A policy has two halves.

**Definition: what it detects** (`TextPolicyDefinition` in `types.ts`):

| Field                   | Meaning                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | `[a-z0-9-]`, max 48. Settings key, learned-terms partition, API path segment.                                                 |
| `label`, `description`  | Display text.                                                                                                                 |
| `seedTerms`             | Built-in lexicon `{ term, weight }`. Weight 1 weak, 3 strong, 5 unambiguous. A trailing `*` on a Latin term matches a prefix. |
| `moderationCategory`    | Category prefix read from a moderation-model response (`sexual`, `violence`, `self-harm`, `hate`, `harassment`).              |
| `classifierInstruction` | What a chat-model moderator rates, completing "score: …".                                                                     |
| `stopWords`             | Words that must never be learned for this policy.                                                                             |
| `priority`              | Lower runs first when several policies are enabled.                                                                           |

**Config: how it runs** (`TextPolicyConfig`), resolved for each request:

| Field                      | Default   | Meaning                                                                      |
| -------------------------- | --------- | ---------------------------------------------------------------------------- |
| `enabled`                  | `false`   | Policy runs at all.                                                          |
| `mode`                     | `reroute` | `reroute`, `block` or `flag` on a violation.                                 |
| `lowThreshold`             | `3`       | Score below this: no violation, moderator not called.                        |
| `highThreshold`            | `10`      | Score at or above this: violation, moderator not called.                     |
| `moderatorModel`           | none      | Moderator for the middle band (see below). None: the middle band fails open. |
| `moderationScoreThreshold` | `0.5`     | Moderator score at or above this is a violation.                             |
| `rerouteTarget`            | none      | Model or combo for `reroute`.                                                |
| `learnMode`                | `auto`    | Self-growing lexicon: `auto`, `review` or `off`.                             |
| `learnMinHits`             | `2`       | In `auto`, fresh violations before a learned term becomes active.            |

## Configuration (settings)

All policies live under one settings key, `textPolicies`, written with
`PATCH /api/settings`. The whole `textPolicies` object is replaced on each write.

```json
{
  "textPolicies": {
    "sexual-content": {
      "enabled": true,
      "mode": "reroute",
      "moderatorModel": "groq/llama-3.3-70b-versatile",
      "rerouteTarget": "combo/nsfw-ok",
      "seedTerms": [{ "term": "onlyfans", "weight": 3 }],
      "keyOverrides": {
        "<apiKeyId>": { "enabled": false }
      }
    },
    "competitor-mentions": {
      "label": "Competitor mentions",
      "enabled": true,
      "mode": "flag",
      "seedTerms": [{ "term": "acme corp", "weight": 5 }],
      "classifierInstruction": "how much the TEXT promotes a competitor product (0 = not at all, 1 = clearly)",
      "moderatorModel": "groq/llama-3.3-70b-versatile"
    }
  }
}
```

- **Built-in policy** (`sexual-content`): config fields override the defaults.
  Definition fields extend it: `seedTerms` and `stopWords` are **added** to the
  built-in ones, while `label`, `description`, `moderationCategory`,
  `classifierInstruction` and `priority` **replace** them.
- **Custom policy**: an id that is not built in becomes a policy once it sets
  `classifierInstruction` or `seedTerms`. `moderationCategory` then defaults to the
  id. No code change is needed.
- **Scope**: every config field can also be set per API key under `keyOverrides`.
  Precedence is per field: per-key → global → default. A field missing from the key's
  entry inherits the global value (the same rule as the API key `codexServiceMode`).
  Definition fields are global only.
- `lowThreshold` must be lower than `highThreshold`. At most 50 policies.

## The moderator

`moderatorModel` picks the kind (`isModerationApiModel()`):

- **Moderation model** (`openai/omni-moderation-latest`,
  `openai/text-moderation-latest`, `mistral/mistral-moderation-latest`): goes through
  the same code as `POST /v1/moderations` with the provider's configured connection.
  It returns a score only: the highest `category_scores` entry whose name starts with
  the policy's `moderationCategory`.
- **Chat model** (any other configured model or combo): called through OmniRoute's
  own `/v1/chat/completions` (self-loop bearer, admission bypass, and
  `x-omniroute-disabled-guardrails: text-policy,prompt-injection` as the recursion
  guard) with a prompt built from `classifierInstruction`. It must reply with
  `{"score": 0..1, "terms": [{"term", "weight"}]}`. This kind also feeds the
  self-growing lexicon.

Verdicts are cached for 10 minutes by (policy, model, text). Any failure fails open
and `decision.moderatorError` says why: `no_moderator_model`, `no_credentials`,
`moderator_http_error`, `moderator_unparseable`, `no_category_score` or
`moderator_error`.

## Self-growing lexicon

Terms a chat-model moderator reports come back in `decision.discoveredTerms`
(`[{ term, weight }]`). A term is kept only if it:

- normalizes to 2–48 characters and at most 4 words, with a letter;
- contains only letters, digits, spaces, `-` and `'`;
- **appears in the text**;
- is not one of the policy's seed terms, its `stopWords`, or the shared default stop
  words.

At most 10 terms are kept per verdict. Only a **fresh violation** adds a hit: clean
verdicts, cached verdicts and dry runs (`learn: false`) report terms without storing
them. `learnMode`:

- `auto`: the term becomes active once its hits reach `learnMinHits`.
- `review`: the term stays `pending` for an operator.
- `off`: terms are only reported.

`decision.learning` records the outcome. Rows live in `text_policy_terms`, keyed by
(policy, term), with status `pending`, `active` or `rejected`. Learning never
re-activates a `rejected` term, and a manually added term keeps its weight. Active
terms are read through a 30 s cache per policy.

Risk: in `auto` mode, a client that keeps sending violating text containing an
ordinary word can get that word learned. `learnMinHits`, the appears-in-text check
and stop words limit this. Use `review` to approve every term.

## Plugging in another process

### In-process (TypeScript)

Any route, handler, MCP tool, background job or batch step:

```ts
import { evaluateTextPoliciesFor, extractPolicyText } from "@/lib/textPolicy";

const evaluations = await evaluateTextPoliciesFor(prompt /* or extractPolicyText(body) */, {
  apiKeyId: apiKeyInfo?.id ?? null, // per-key config applies
  requestedModel: body.model, // only needed for reroute plans
  policyIds: ["sexual-content"], // optional: limit to some policies
  signal: request.signal,
});
const acting = evaluations.find((e) => e.plan.block || e.plan.action === "rerouted");
if (acting?.plan.block) return reject(`Rejected by ${acting.definition.id}`);
if (acting?.plan.toModel) body.model = acting.plan.toModel;
```

- `evaluateTextPoliciesFor` loads settings, resolves each enabled policy for the key,
  evaluates them in priority order and stops at the first block or reroute
  (`stopOnAction: false` evaluates all of them). Other options: `learn` (default
  true), `ignoreEnabled` for dry runs, and `log`.
- `evaluateTextPolicy({ policy, config, text })` is the pure pipeline for a caller
  that holds its own definition and config, with no settings involved.
- `planTextPolicyAction(decision, config, requestedModel)` turns a decision into a
  plan.
- Every external dependency is injectable through `TextPolicyEngineDeps`:
  `getSettings`, `moderate`, `loadLearnedTerms`, `recordLearnedTerms`.

### A new policy in code

```ts
import { registerTextPolicy } from "@/lib/textPolicy";

registerTextPolicy({
  id: "self-harm",
  label: "Self-harm",
  moderationCategory: "self-harm",
  classifierInstruction: "how much the TEXT encourages self-harm (0 = not at all, 1 = clearly)",
  seedTerms: [{ term: "kill myself", weight: 5 }],
  priority: 10,
  builtIn: true,
});
```

The policy is then listed, configurable under `textPolicies["self-harm"]`, evaluated
by the guardrail once enabled, and gets its own learned terms. Place the definition
next to `policies/sexualContent.ts` and register it in `catalog.ts` so it is
available everywhere.

### Out of process (HTTP)

Management auth (dashboard session or a `manage` API key):

| Method + path                                  | Purpose                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/text-policies`                       | Policies with effective global config and learned-term counts.                                                                                                |
| `POST /api/text-policies/<id>/evaluate`        | `{ text, apiKeyId?, requestedModel?, learn? = false, ignoreEnabled? = false }` returns `{ decision, plan }`. Nothing is rerouted or blocked; the caller acts. |
| `GET /api/text-policies/<id>/terms[?status=…]` | Learned terms of a policy.                                                                                                                                    |
| `PUT /api/text-policies/<id>/terms`            | `{ term, weight?, status? }`: add, activate, reject or reweight a term.                                                                                       |
| `DELETE /api/text-policies/<id>/terms`         | `{ term }`: remove (learning may add it again; reject to keep it out).                                                                                        |

## Transparency

The guardrail puts each evaluation (decision plus plan, no request text) in
`meta.evaluations` and on the response header:

```
x-omniroute-text-policy: sexual-content=violation; stage=moderator; action=rerouted; score=3; moderator=0.910; discovered=2
```

With several policies, entries are comma-separated. The header carries counts, never
words. Logs carry scores and actions, never request text.

## Limits

- Requests only: the check runs before the upstream call, so an answer that turns
  explicit is not caught.
- If the vision bridge already rerouted an image request and a text policy then
  reroutes it, the text-policy target wins. Pick a vision-capable target if that
  traffic carries images.

Regression guards: `tests/unit/text-policy/` (engine, catalog and moderator,
guardrail, terms and routes).
