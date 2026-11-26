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

| File                                        | Role                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `src/lib/textPolicy/index.ts`               | Public surface. Import from `@/lib/textPolicy`.                          |
| `src/lib/textPolicy/engine.ts`              | `evaluateTextPolicy`, `evaluateTextPoliciesFor`, `planTextPolicyAction`  |
| `src/lib/textPolicy/catalog.ts`             | Which policies exist: `registerTextPolicy`, settings-defined policies    |
| `src/lib/textPolicy/config.ts`              | Per-request config: per-key override → global → default                  |
| `src/lib/textPolicy/lexicon.ts`             | Keyword scoring and bands                                                |
| `src/lib/textPolicy/moderator.ts`           | Moderation-model and chat-model moderators                               |
| `src/lib/textPolicy/learning.ts`            | Self-growing lexicon: term validation, cached active terms, translations |
| `src/lib/textPolicy/categories.ts`          | Word categories (set learned weights) and default translation languages  |
| `src/lib/textPolicy/extract.ts`             | Text extraction from chat / Responses / Claude / prompt bodies           |
| `src/lib/textPolicy/header.ts`              | `x-omniroute-text-policy` response header                                |
| `src/lib/textPolicy/policies/`              | Built-in definitions (`sexualContent.ts`)                                |
| `src/lib/db/textPolicyTerms.ts`             | Learned terms, table `text_policy_terms`, partitioned by policy          |
| `src/shared/validation/textPolicySchema.ts` | Zod schema for the `textPolicies` setting                                |

## Definition and config

A policy has two halves.

**Definition: what it detects** (`TextPolicyDefinition` in `types.ts`):

| Field                   | Meaning                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | `[a-z0-9-]`, max 48. Settings key, learned-terms partition, API path segment.                                                                                                            |
| `label`, `description`  | Display text.                                                                                                                                                                            |
| `seedTerms`             | Built-in lexicon `{ term, weight }`. Weight 1 weak, 3 strong, 5 unambiguous. A trailing `*` on a Latin term matches a prefix.                                                            |
| `moderationCategory`    | Category prefix read from a moderation-model response (`sexual`, `violence`, `self-harm`, `hate`, `harassment`).                                                                         |
| `classifierInstruction` | What a chat-model moderator rates, completing "score: …".                                                                                                                                |
| `stopWords`             | Words that must never be learned for this policy.                                                                                                                                        |
| `termCategories`        | Categories the chat moderator sorts reported words into, each with the weight a learned word gets (0 = never learned). Code only; default: `core` 5, `strong` 3, `context` 0, `other` 0. |
| `termExamples`          | Worked examples for the moderator prompt (`term`, `lang`, `meaning`, `category`). Code only.                                                                                             |
| `priority`              | Lower runs first when several policies are enabled.                                                                                                                                      |

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
| `learnMinModeratorScore`   | `0.85`    | A verdict teaches only when the moderator score is at least this.            |
| `translateLanguages`       | 15 codes  | Languages an accepted word is translated into (`[]` = none). See below.      |

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
  guard) with a prompt built from `classifierInstruction` and the policy's
  `termCategories` / `termExamples`. It must reply with
  `{"score": 0..1, "terms": [{"term", "lang", "meaning", "category"}]}`. The prompt
  gives a calibrated score scale (0.2 = neutral, medical or news mention, 0.5 =
  suggestive, 0.8 = clearly matches, 1 = explicit), says that the text can be in any
  language, and asks for terms copied exactly as written (never translated). This kind
  also feeds the self-growing lexicon.

Verdicts are cached for 10 minutes by (policy, model, text). Any failure fails open
and `decision.moderatorError` says why: `no_moderator_model`, `no_credentials`,
`moderator_http_error`, `moderator_unparseable`, `no_category_score` or
`moderator_error`.

## Self-growing lexicon

Terms a chat-model moderator reports come back in `decision.discoveredTerms`
(`[{ term, weight, language, meaning, category }]`). Every language is learned the
same way. A term is kept only if it:

- normalizes to 2–48 characters and at most 4 words, with a letter;
- contains only letters, digits, spaces, `-` and `'`;
- **appears in the text**;
- is not one of the policy's seed terms, its `stopWords`, or the shared default stop
  words;
- has a category with a weight above 0.

**Rating.** The category sets the weight, not the moderator. For `sexual-content`:
`explicit` and `slang` 5, `nudity` and `fetish` 3. Words in `context` (everyday words
that are sexual only because of the rest of the text), `identity` (sexual orientation
and gender identity), `minor` (anything about children) and `other` (violence, hate,
non-sexual profanity), or with no known category, are never learned: they come back in
`decision.ignoredTerms` (`[{ term, category }]`) so you can see them in **Try it**.

At most 10 terms are kept per verdict. Only a **fresh, confident violation** adds a
hit: clean verdicts, verdicts scored below `learnMinModeratorScore`
(`skipped: "low_confidence"`), cached verdicts and dry runs (`learn: false`) report
terms without storing them. `learnMode`:

- `auto`: the term becomes active once its hits reach `learnMinHits`.
- `review`: the term stays `pending` for an operator.
- `off`: terms are only reported.

`decision.learning` records the outcome. Rows live in `text_policy_terms`, keyed by
(policy, term), with status `pending`, `active` or `rejected`. Learning never
re-activates a `rejected` term, and a manually added term keeps its weight. Active
terms are read through a 30 s cache per policy.

Each row also stores the term's `language`, English `meaning` and `category` (the first
values reported are kept), shown in the review list.

**Translations.** When a term is accepted (activated in `auto` mode, or approved in the
dashboard), the chat moderator is asked **once** for the same word in each of
`translateLanguages`, except the term's own language: at most 2 per language, only
direct equivalents, never everyday words with other meanings, never words about minors.
Each answer passes the same shape checks and is stored as `pending` with 0 hits,
`source: "translation"` and `sourceTerm` set. A translation is then learned like any
other word: in `auto` mode it becomes active once the moderator reports it in
`learnMinHits` fresh violations; in `review` mode an operator approves it. Translations
are never translated again, terms in a weight-0 category are never translated, an
existing term (any status) is never overwritten, and nothing is translated when
`learnMode` is `off` or the moderator is a moderation model. The call runs in the
background with the same loop safeguards as the moderator, so it never delays the
request.

Risk: in `auto` mode, a client that keeps sending violating text containing an
ordinary word can get that word learned. `learnMinHits`, `learnMinModeratorScore`, the
category rule, the appears-in-text check and stop words limit this. Use `review` to
approve every term.

## Dashboard

**Settings → Text Policies** (`/dashboard/settings/text-policies`) edits everything on
this page without the API. Sources live in
`src/app/(dashboard)/dashboard/settings/components/textPolicies/`.

1. **Policy list:** every built-in and custom policy, with an on/off switch, its
   mode, and seed / learned / pending counts.
2. **Editor:**
   - mode and reroute target;
   - low and high thresholds;
   - moderator model and moderator score threshold;
   - learn mode, minimum hits, the moderator certainty needed to learn, and the
     languages accepted words are translated into (empty = no translations), plus the
     policy's word categories and their weights;
   - under "What this policy looks for": name, description, moderation category,
     moderator instruction, seed terms (`term:weight`, one per line), stop words and
     priority. For a built-in policy, blank fields keep the built-in value, and seed
     terms and stop words are added to the built-in ones.
3. **Per API key:** pick a key and set only the fields that differ. Blank fields
   show, and inherit, the global value. "Remove override" deletes the key's entry.
4. **Learned words:** Pending, Active and Rejected tabs, with approve, reject,
   change-weight and delete actions, plus adding a word by hand (active right away).
   Each word shows its language, English meaning and category, and a translation
   shows the word it translates.
5. **Try it:** paste text, optionally choose a key whose settings to use and a
   requested model, and see the verdict, band, scores, matched and discovered words,
   the words found but never learned (with their category), and the action. It is a dry run (`ignoreEnabled: true`, `learn: false`), but text
   in the middle band still calls the moderator.
6. **New policy:** id, name, moderator instruction, moderation category and seed
   terms. A new policy starts **disabled** so it can be tried first.

The page writes the whole `textPolicies` object with `PATCH /api/settings`,
validated with the same Zod schema as the API. Learned words and Try it use the
`/api/text-policies` routes.

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

## Loop safety

A policy never re-evaluates its own output, so a rerouted request cannot loop:

- The guardrails run **once per incoming request**, in `handleChat()`, before combo resolution.
  Combo targets and retries do not re-enter them.
- A reroute is a **fixed point**: a request already on the reroute target is left alone
  (`already_target`), so applying the policy to its own output changes nothing.
- The only call a policy makes into OmniRoute is the chat moderator's sub-request to
  `/v1/chat/completions`. It is never evaluated again, because its prompt is built from the
  policy's own wording and would otherwise match it. Three independent safeguards (in
  `src/lib/textPolicy/moderator.ts`):
  1. a one-time **nonce** header that is valid only while that call is in flight, so a request
     carrying it is provably this process's own moderator call (a client cannot guess one);
  2. the **self-loop bearer** and disable header. Across worker processes this only holds when
     `OMNIROUTE_API_KEY` (or `ROUTER_API_KEY`) is set, because the generated self-loop secret is
     per process, like the nonce;
  3. a hard cap of **32 moderator calls in flight** per process. If both identity checks ever
     failed, nesting would stop at the cap and the policy would fail open
     (`moderator_error=moderator_busy`, plus a warning in the server log).
- The moderator call has a **30 second timeout** and fails open (`moderator_timeout`).

Regression guard: `tests/integration/text-policy-no-loop.test.ts` runs the real pipeline, hands the
moderator's call back to `handleChat()` like the HTTP listener does, and counts every upstream and
self-loop call, including a run with all identity checks stripped.

## Limits

- Requests only: the check runs before the upstream call, so an answer that turns
  explicit is not caught.
- Guardrails, text policies included, run only inside `handleChat()`. When the optional Bifrost fast
  path (`/api/v1/relay/chat/completions`) answers a request itself, that request never reaches
  them.
- If the vision bridge already rerouted an image request and a text policy then
  reroutes it, the text-policy target wins. Pick a vision-capable target if that
  traffic carries images.

Regression guards: `tests/unit/text-policy/` (engine, catalog and moderator,
guardrail, terms and routes, form helpers) and `tests/unit/ui/text-policies-page.test.tsx`
(the dashboard page).
