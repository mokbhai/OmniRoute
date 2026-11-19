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

import type { KeywordTerm, TextPolicyDefinition } from "../types";

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

export const SEXUAL_CONTENT_POLICY: TextPolicyDefinition = Object.freeze({
  id: "sexual-content",
  label: "Sexual / adult content",
  description: "Sexually explicit or adult requests (porn, sex acts, nudity).",
  moderationCategory: "sexual",
  classifierInstruction:
    "how sexually explicit or adult the TEXT is (0 = not at all, 1 = explicit pornography)",
  seedTerms: SEXUAL_CONTENT_TERMS,
  stopWords: ["woman", "man", "women", "men", "girl", "boy", "bed", "body", "love", "kiss"],
  priority: 100,
  builtIn: true,
});
