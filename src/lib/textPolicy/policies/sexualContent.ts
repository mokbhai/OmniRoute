/**
 * Built-in text policy: sexual / adult content.
 *
 * The first policy built on the generic text-policy engine (`../engine.ts`). Every
 * value here is a default: operators can extend the lexicon (`seedTerms`), change
 * the moderator instruction or the moderation category, and set thresholds, the
 * moderator, the action and learning per key under `textPolicies["sexual-content"]`.
 *
 * Weights: 5 = unambiguous sexual act / porn term, 3 = strong signal (nudity, sex
 * positions, fetish), 1 = weak signal that is common in ordinary text too ("sexy",
 * "penetration" as in pen-testing). Weak terms alone stay in the middle band at
 * most, so the moderator settles them. Covers EN / PT / ES / ZH (simplified and
 * traditional) and some JA.
 */

import type { KeywordTerm, TermCategory, TermExample, TextPolicyDefinition } from "../types";

const SEXUAL_CONTENT_TERMS: readonly KeywordTerm[] = [
  // ── weight 5: explicit acts / porn ───────────────────────────────────────
  ...[
    "porn",
    "porno",
    "pornographic",
    "pornography",
    "hardcore sex",
    "explicit sex",
    "explicit sexual",
    "sexual intercourse",
    "vaginal sex",
    "anal sex",
    "oral sex",
    "blowjob",
    "handjob",
    "titjob",
    "footjob",
    "cumshot",
    "creampie",
    "deepthroat",
    "gangbang",
    "bukkake",
    "cum in mouth",
    "cum on face",
    "facial cumshot",
    "squirting",
    // pt / es
    "pornô",
    "sexo explícito",
    "cena sexual explícita",
    "escena sexual explícita",
    "boquete",
    "felação",
    "mamada",
    // zh (simplified + traditional)
    "色情",
    "性交",
    "口交",
    "肛交",
    "乳交",
    "手交",
    "足交",
    "内射",
    "內射",
    "颜射",
    "顏射",
    "射精",
    "潮吹",
    "轮奸",
    "輪奸",
    "群交",
    "深喉",
    "口爆",
    "吞精",
    "成人影片",
    "黄片",
    "黃片",
    "做爱",
    "做愛",
    // ja
    "セックス",
    "フェラ",
    "中出し",
  ].map((term) => ({ term, weight: 5 })),

  // ── weight 3: strong signal ──────────────────────────────────────────────
  ...[
    "nsfw",
    "xxx",
    "nude",
    "nudes",
    "naked",
    "nudity",
    "erotic",
    "erotica",
    "orgasm*",
    "masturbat*",
    "dildo",
    "doggy style",
    "doggystyle",
    "prone bone",
    "missionary position",
    "reverse cowgirl",
    "cowgirl position",
    "threesome",
    "orgy",
    "bdsm",
    "fetish",
    "sex scene",
    "sex video",
    "sex toy",
    "sex toys",
    "adult content",
    "adult video",
    "nua",
    "pelada",
    "desnuda",
    "desnudo",
    "transando",
    "sexo",
    "裸体",
    "裸體",
    "自慰",
    "后入",
    "後入",
    "女上位",
    "传教士体位",
    "傳教士體位",
    "成人色情",
    "调教",
    "調教",
    "乱交",
    "亂交",
    "3p",
  ].map((term) => ({ term, weight: 3 })),

  // ── weight 1: weak signal (common in ordinary text) ──────────────────────
  ...[
    "sexy",
    "sexual",
    "lingerie",
    "seductive",
    "busty",
    "boobs",
    "penetrat*",
    "intimate",
    "vibrator",
    "性感",
    "巨乳",
    "高潮",
    "內衣",
    "内衣",
  ].map((term) => ({ term, weight: 1 })),
];

/**
 * Everyday words the moderator has reported in real traffic that must never be learned:
 * they are sexual only because of the rest of the text. Any language.
 */
const SEXUAL_CONTENT_STOP_WORDS: readonly string[] = [
  "woman",
  "man",
  "women",
  "men",
  "girl",
  "boy",
  "bed",
  "body",
  "love",
  "kiss",
  "wet",
  "hard",
  "release",
  "dom",
  "直播",
  "真空",
  "遛狗",
  "身体",
  "床",
];

/**
 * Category → learned weight. Only words that are sexual on their own are learned. Identity
 * words are never learned (they are not adult content), and words about minors are never
 * learned or translated: that content needs a block policy, not a growing word list.
 */
const SEXUAL_CONTENT_CATEGORIES: readonly TermCategory[] = [
  {
    id: "explicit",
    description: "an explicit sexual act, sexual body part, or pornography term",
    weight: 5,
  },
  {
    id: "slang",
    description: "vulgar slang or a euphemism used for a sexual act or sexual body part",
    weight: 5,
  },
  {
    id: "nudity",
    description: "nudity, undressing, or sexualized exposure of the body",
    weight: 3,
  },
  { id: "fetish", description: "a fetish, BDSM, or kink term", weight: 3 },
  {
    id: "context",
    description:
      "an everyday word with ordinary meanings that is sexual only because of the rest of the TEXT (wet, hard, release, bed, livestream)",
    weight: 0,
  },
  {
    id: "identity",
    description: "a sexual orientation or gender identity word (gay, lesbian, bisexual, trans)",
    weight: 0,
  },
  { id: "minor", description: "any word about children, teenagers, or minors", weight: 0 },
  {
    id: "other",
    description: "violence, hate, slurs, profanity that is not sexual, or anything else",
    weight: 0,
  },
];

const SEXUAL_CONTENT_EXAMPLES: readonly TermExample[] = [
  { term: "blowjob", lang: "en", meaning: "oral sex", category: "explicit" },
  { term: "做爱", lang: "zh", meaning: "to have sex", category: "explicit" },
  { term: "follar", lang: "es", meaning: "to have sex (vulgar)", category: "slang" },
  { term: "pelada", lang: "pt", meaning: "naked", category: "nudity" },
  { term: "緊縛", lang: "ja", meaning: "rope bondage", category: "fetish" },
  { term: "wet", lang: "en", meaning: "wet", category: "context" },
  { term: "直播", lang: "zh", meaning: "livestream", category: "context" },
  { term: "gay", lang: "en", meaning: "gay", category: "identity" },
];

export const SEXUAL_CONTENT_POLICY: TextPolicyDefinition = Object.freeze({
  id: "sexual-content",
  label: "Sexual / adult content",
  description: "Sexually explicit or adult requests (porn, sex acts, nudity).",
  moderationCategory: "sexual",
  classifierInstruction:
    "how sexually explicit or adult the TEXT is (0 = not at all, 1 = explicit pornography)",
  seedTerms: SEXUAL_CONTENT_TERMS,
  stopWords: SEXUAL_CONTENT_STOP_WORDS,
  termCategories: SEXUAL_CONTENT_CATEGORIES,
  termExamples: SEXUAL_CONTENT_EXAMPLES,
  priority: 100,
  builtIn: true,
});
