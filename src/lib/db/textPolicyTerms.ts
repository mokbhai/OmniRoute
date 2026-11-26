/**
 * Database module: text_policy_terms — the self-growing lexicons of the text-policy
 * engine (`src/lib/textPolicy/`), partitioned by policy id.
 *
 * Status lifecycle (per policy, per term):
 *   pending  → stored, not scored (new terms, and every term in "review" learn mode)
 *   active   → scored together with the policy's seed terms
 *   rejected → turned down by an operator; learning keeps counting hits but never re-activates
 *
 * Sources: "moderator" (reported in a flagged request), "manual" (added by an operator),
 * "translation" (an equivalent of an accepted term in another language; starts pending
 * with 0 hits and is learned like a moderator term).
 *
 * @module db/textPolicyTerms
 */

import { getDbInstance } from "./core";

export const TEXT_POLICY_TERM_STATUSES = ["pending", "active", "rejected"] as const;
export type TextPolicyTermStatus = (typeof TEXT_POLICY_TERM_STATUSES)[number];

export const TEXT_POLICY_TERM_SOURCES = ["moderator", "manual", "translation"] as const;
export type TextPolicyTermSource = (typeof TEXT_POLICY_TERM_SOURCES)[number];

export interface TextPolicyTermEntry {
  policy: string;
  term: string;
  weight: number;
  status: TextPolicyTermStatus;
  source: TextPolicyTermSource;
  hits: number;
  /** ISO 639-1 code, when known. */
  language: string | null;
  /** Short English meaning, when known. */
  meaning: string | null;
  /** Moderator category ("explicit", "slang", ...), when known. */
  category: string | null;
  /** Source "translation": the accepted term this one translates. */
  sourceTerm: string | null;
  /** When this term's translations were requested (once per term). */
  translatedAt: string | null;
  lastModeratorModel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

interface TermRow {
  policy: string;
  term: string;
  weight: number;
  status: string;
  source: string;
  hits: number;
  last_moderator_model: string | null;
  language: string | null;
  meaning: string | null;
  category: string | null;
  source_term: string | null;
  translated_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
}

export interface TermInput {
  term: string;
  weight: number;
  language?: string | null;
  meaning?: string | null;
  category?: string | null;
}

export interface RecordTermsOptions {
  /** Promote a pending term to active once its hits reach `minHits`. */
  autoActivate: boolean;
  minHits: number;
  moderatorModel?: string | null;
}

export interface RecordTermsResult {
  /** Terms stored for the first time. */
  added: string[];
  /** Terms that became active in this call. */
  activated: string[];
}

const TERM_MAX_LENGTH = 48;

/** Canonical key: NFKC, lowercase, single spaces, trimmed. Empty string when unusable. */
export function normalizeTextPolicyTerm(value: unknown): string {
  if (typeof value !== "string") return "";
  const term = value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return term.length > 0 && term.length <= TERM_MAX_LENGTH ? term : "";
}

export function clampTextPolicyWeight(value: unknown): number {
  const weight = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 1;
  return Math.min(5, Math.max(1, weight));
}

function isStatus(value: unknown): value is TextPolicyTermStatus {
  return (TEXT_POLICY_TERM_STATUSES as readonly string[]).includes(value as string);
}

function toEntry(row: TermRow): TextPolicyTermEntry {
  return {
    policy: row.policy,
    term: row.term,
    weight: row.weight,
    status: isStatus(row.status) ? row.status : "pending",
    source: (TEXT_POLICY_TERM_SOURCES as readonly string[]).includes(row.source)
      ? (row.source as TextPolicyTermSource)
      : "moderator",
    hits: row.hits,
    language: row.language ?? null,
    meaning: row.meaning ?? null,
    category: row.category ?? null,
    sourceTerm: row.source_term ?? null,
    translatedAt: row.translated_at ?? null,
    lastModeratorModel: row.last_moderator_model,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

function selectOne(policy: string, term: string): TermRow | undefined {
  return getDbInstance()
    .prepare("SELECT * FROM text_policy_terms WHERE policy = ? AND term = ?")
    .get(policy, term) as TermRow | undefined;
}

export function listTextPolicyTerms(
  policy: string,
  status?: TextPolicyTermStatus
): TextPolicyTermEntry[] {
  const db = getDbInstance();
  const rows = (
    status
      ? db
          .prepare(
            "SELECT * FROM text_policy_terms WHERE policy = ? AND status = ? ORDER BY hits DESC, term"
          )
          .all(policy, status)
      : db
          .prepare(
            "SELECT * FROM text_policy_terms WHERE policy = ? ORDER BY status, hits DESC, term"
          )
          .all(policy)
  ) as TermRow[];
  return rows.map(toEntry);
}

/** Term counts per status for one policy. */
export function countTextPolicyTerms(policy: string): Record<TextPolicyTermStatus, number> {
  const rows = getDbInstance()
    .prepare(
      "SELECT status, COUNT(*) AS cnt FROM text_policy_terms WHERE policy = ? GROUP BY status"
    )
    .all(policy) as Array<{ status: string; cnt: number }>;
  const counts: Record<TextPolicyTermStatus, number> = { pending: 0, active: 0, rejected: 0 };
  for (const row of rows) if (isStatus(row.status)) counts[row.status] = Number(row.cnt);
  return counts;
}

/** Active learned terms of one policy, for the keyword scorer. */
export function getActiveTextPolicyTerms(policy: string): TermInput[] {
  const rows = getDbInstance()
    .prepare("SELECT term, weight FROM text_policy_terms WHERE policy = ? AND status = 'active'")
    .all(policy) as Array<{ term: string; weight: number }>;
  return rows.map((row) => ({ term: row.term, weight: row.weight }));
}

/**
 * Record the terms a moderator reported for one violation. Each term gets one hit;
 * its weight is the highest reported so far. Rejected rows are counted but never
 * re-activated; manual rows keep their operator-set weight.
 */
export function recordTextPolicyTerms(
  policy: string,
  terms: TermInput[],
  options: RecordTermsOptions
): RecordTermsResult {
  const result: RecordTermsResult = { added: [], activated: [] };
  const unique = new Map<string, TermInput>();
  for (const entry of terms) {
    const term = normalizeTextPolicyTerm(entry?.term);
    if (!term) continue;
    const weight = clampTextPolicyWeight(entry.weight);
    const previous = unique.get(term);
    if (!previous || weight > previous.weight) unique.set(term, { ...entry, term, weight });
  }
  if (unique.size === 0) return result;

  const db = getDbInstance();
  const now = new Date().toISOString();
  const minHits = Math.max(1, Math.floor(options.minHits));
  const insert = db.prepare(
    `INSERT INTO text_policy_terms
       (policy, term, weight, status, source, hits, last_moderator_model,
        language, meaning, category, first_seen_at, last_seen_at, updated_at)
     VALUES (@policy, @term, @weight, @status, 'moderator', 1, @model,
        @language, @meaning, @category, @now, @now, @now)`
  );
  // Language / meaning / category: the first known value is kept.
  const update = db.prepare(
    `UPDATE text_policy_terms
        SET hits = @hits, weight = @weight, status = @status,
            last_moderator_model = @model, last_seen_at = @now, updated_at = @now,
            language = COALESCE(language, @language), meaning = COALESCE(meaning, @meaning),
            category = COALESCE(category, @category)
      WHERE policy = @policy AND term = @term`
  );

  const tx = db.transaction(() => {
    for (const [term, entry] of unique) {
      const weight = entry.weight;
      const about = {
        language: entry.language ?? null,
        meaning: entry.meaning ?? null,
        category: entry.category ?? null,
      };
      const row = selectOne(policy, term);
      if (!row) {
        const status = options.autoActivate && minHits <= 1 ? "active" : "pending";
        insert.run({
          policy,
          term,
          weight,
          status,
          model: options.moderatorModel ?? null,
          now,
          ...about,
        });
        result.added.push(term);
        if (status === "active") result.activated.push(term);
        continue;
      }
      const hits = row.hits + 1;
      let status = isStatus(row.status) ? row.status : "pending";
      if (status === "pending" && options.autoActivate && hits >= minHits) {
        status = "active";
        result.activated.push(term);
      }
      update.run({
        policy,
        term,
        hits,
        weight: row.source === "manual" ? row.weight : Math.max(row.weight, weight),
        status,
        model: options.moderatorModel ?? row.last_moderator_model,
        now,
        ...about,
      });
    }
  });
  tx();
  return result;
}

/** Operator add/edit. Creates the term when missing (source "manual", default active, weight 3). */
export function upsertTextPolicyTerm(
  policy: string,
  input: { term: string; weight?: number; status?: TextPolicyTermStatus }
): TextPolicyTermEntry | null {
  const term = normalizeTextPolicyTerm(input.term);
  if (!term) return null;
  const db = getDbInstance();
  const now = new Date().toISOString();
  const existing = selectOne(policy, term);
  if (!existing) {
    db.prepare(
      `INSERT INTO text_policy_terms
         (policy, term, weight, status, source, hits, last_moderator_model, first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 0, NULL, ?, ?, ?)`
    ).run(
      policy,
      term,
      clampTextPolicyWeight(input.weight ?? 3),
      input.status ?? "active",
      now,
      now,
      now
    );
  } else {
    db.prepare(
      "UPDATE text_policy_terms SET weight = ?, status = ?, updated_at = ? WHERE policy = ? AND term = ?"
    ).run(
      input.weight === undefined ? existing.weight : clampTextPolicyWeight(input.weight),
      input.status ?? existing.status,
      now,
      policy,
      term
    );
  }
  const row = selectOne(policy, term);
  return row ? toEntry(row) : null;
}

export function deleteTextPolicyTerm(policy: string, term: string): boolean {
  const key = normalizeTextPolicyTerm(term);
  if (!key) return false;
  const info = getDbInstance()
    .prepare("DELETE FROM text_policy_terms WHERE policy = ? AND term = ?")
    .run(policy, key);
  return Number(info?.changes ?? 0) > 0;
}

/**
 * Claim one term for translation: marks it so its translations are requested at most once.
 * Returns the term when this call claimed it; null when it is missing, already claimed,
 * not active, or itself a translation (translations are never translated again).
 */
export function claimTextPolicyTermTranslation(
  policy: string,
  term: string
): TextPolicyTermEntry | null {
  const key = normalizeTextPolicyTerm(term);
  if (!key) return null;
  const info = getDbInstance()
    .prepare(
      `UPDATE text_policy_terms SET translated_at = ?
        WHERE policy = ? AND term = ? AND status = 'active'
          AND translated_at IS NULL AND source_term IS NULL AND source != 'translation'`
    )
    .run(new Date().toISOString(), policy, key);
  if (Number(info?.changes ?? 0) === 0) return null;
  const row = selectOne(policy, key);
  return row ? toEntry(row) : null;
}

export interface TranslationInput {
  term: string;
  language: string;
  meaning?: string | null;
}

/**
 * Store a term's translations as pending terms with 0 hits (source "translation"). A
 * translation that is already a known term (any status) is left untouched.
 * Returns the terms that were stored.
 */
export function addTextPolicyTranslations(
  policy: string,
  sourceTerm: string,
  translations: TranslationInput[],
  options: { weight: number; category?: string | null; moderatorModel?: string | null }
): string[] {
  const source = normalizeTextPolicyTerm(sourceTerm);
  if (!source) return [];
  const db = getDbInstance();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO text_policy_terms
       (policy, term, weight, status, source, hits, last_moderator_model,
        language, meaning, category, source_term, first_seen_at, last_seen_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'translation', 0, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const added: string[] = [];
  const tx = db.transaction(() => {
    for (const entry of translations) {
      const term = normalizeTextPolicyTerm(entry.term);
      if (!term || term === source) continue;
      const info = insert.run(
        policy,
        term,
        clampTextPolicyWeight(options.weight),
        options.moderatorModel ?? null,
        entry.language,
        entry.meaning ?? null,
        options.category ?? null,
        source,
        now,
        now,
        now
      );
      if (Number(info?.changes ?? 0) > 0) added.push(term);
    }
  });
  tx();
  return added;
}
