/**
 * Database module: content_policy_terms — the self-growing lexicon of the
 * content-policy guardrail (`src/lib/guardrails/contentPolicy/`).
 *
 * A chat-model moderator reports the sexual terms it found in a middle-band
 * request. Every adult verdict that reports a term adds one hit. Learning never
 * touches a `rejected` row, so an operator's "no" sticks.
 *
 * Status lifecycle:
 *   pending  → stored, not scored (new terms, and every term in "review" learn mode)
 *   active   → scored together with the built-in lexicon
 *   rejected → turned down by an operator; learning keeps counting hits but never re-activates
 *
 * @module db/contentPolicyTerms
 */

import { getDbInstance } from "./core";

export const CONTENT_POLICY_TERM_STATUSES = ["pending", "active", "rejected"] as const;
export type ContentPolicyTermStatus = (typeof CONTENT_POLICY_TERM_STATUSES)[number];

export interface ContentPolicyTermEntry {
  term: string;
  weight: number;
  status: ContentPolicyTermStatus;
  source: "moderator" | "manual";
  hits: number;
  lastModeratorModel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

interface TermRow {
  term: string;
  weight: number;
  status: string;
  source: string;
  hits: number;
  last_moderator_model: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
}

export interface DiscoveredTermInput {
  term: string;
  weight: number;
}

export interface RecordDiscoveredTermsOptions {
  /** Promote a pending term to active once its hits reach `minHits`. */
  autoActivate: boolean;
  minHits: number;
  moderatorModel?: string | null;
}

export interface RecordDiscoveredTermsResult {
  /** Terms stored for the first time. */
  added: string[];
  /** Terms that became active in this call. */
  activated: string[];
}

const TERM_MAX_LENGTH = 48;

/** Canonical key: NFKC, lowercase, single spaces, trimmed. Empty string when unusable. */
export function normalizeContentPolicyTerm(value: unknown): string {
  if (typeof value !== "string") return "";
  const term = value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return term.length > 0 && term.length <= TERM_MAX_LENGTH ? term : "";
}

export function clampContentPolicyWeight(value: unknown): number {
  const weight = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 1;
  return Math.min(5, Math.max(1, weight));
}

function isStatus(value: unknown): value is ContentPolicyTermStatus {
  return (CONTENT_POLICY_TERM_STATUSES as readonly string[]).includes(value as string);
}

function toEntry(row: TermRow): ContentPolicyTermEntry {
  return {
    term: row.term,
    weight: row.weight,
    status: isStatus(row.status) ? row.status : "pending",
    source: row.source === "manual" ? "manual" : "moderator",
    hits: row.hits,
    lastModeratorModel: row.last_moderator_model,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

export function listContentPolicyTerms(status?: ContentPolicyTermStatus): ContentPolicyTermEntry[] {
  const db = getDbInstance();
  const rows = (
    status
      ? db
          .prepare("SELECT * FROM content_policy_terms WHERE status = ? ORDER BY hits DESC, term")
          .all(status)
      : db.prepare("SELECT * FROM content_policy_terms ORDER BY status, hits DESC, term").all()
  ) as TermRow[];
  return rows.map(toEntry);
}

/** Active learned terms as `{ term, weight }`, for the keyword scorer. */
export function getActiveContentPolicyTerms(): DiscoveredTermInput[] {
  const rows = getDbInstance()
    .prepare("SELECT term, weight FROM content_policy_terms WHERE status = 'active'")
    .all() as Array<{ term: string; weight: number }>;
  return rows.map((row) => ({ term: row.term, weight: row.weight }));
}

/**
 * Record the terms a moderator reported for one adult verdict. Each term gets one
 * hit; its weight is the highest reported so far. Rejected rows are counted but
 * never re-activated; manual rows keep their operator-set weight.
 */
export function recordDiscoveredContentPolicyTerms(
  terms: DiscoveredTermInput[],
  options: RecordDiscoveredTermsOptions
): RecordDiscoveredTermsResult {
  const result: RecordDiscoveredTermsResult = { added: [], activated: [] };
  const unique = new Map<string, number>();
  for (const entry of terms) {
    const term = normalizeContentPolicyTerm(entry?.term);
    if (!term) continue;
    unique.set(term, Math.max(unique.get(term) ?? 0, clampContentPolicyWeight(entry.weight)));
  }
  if (unique.size === 0) return result;

  const db = getDbInstance();
  const now = new Date().toISOString();
  const minHits = Math.max(1, Math.floor(options.minHits));
  const select = db.prepare("SELECT * FROM content_policy_terms WHERE term = ?");
  const insert = db.prepare(
    `INSERT INTO content_policy_terms
       (term, weight, status, source, hits, last_moderator_model, first_seen_at, last_seen_at, updated_at)
     VALUES (@term, @weight, @status, 'moderator', 1, @model, @now, @now, @now)`
  );
  const update = db.prepare(
    `UPDATE content_policy_terms
        SET hits = @hits, weight = @weight, status = @status,
            last_moderator_model = @model, last_seen_at = @now, updated_at = @now
      WHERE term = @term`
  );

  const tx = db.transaction(() => {
    for (const [term, weight] of unique) {
      const row = select.get(term) as TermRow | undefined;
      if (!row) {
        const status = options.autoActivate && minHits <= 1 ? "active" : "pending";
        insert.run({ term, weight, status, model: options.moderatorModel ?? null, now });
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
        term,
        hits,
        weight: row.source === "manual" ? row.weight : Math.max(row.weight, weight),
        status,
        model: options.moderatorModel ?? row.last_moderator_model,
        now,
      });
    }
  });
  tx();
  return result;
}

/** Operator add/edit. Creates the term when missing (source "manual"). */
export function upsertContentPolicyTerm(input: {
  term: string;
  weight?: number;
  status?: ContentPolicyTermStatus;
}): ContentPolicyTermEntry | null {
  const term = normalizeContentPolicyTerm(input.term);
  if (!term) return null;
  const db = getDbInstance();
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT * FROM content_policy_terms WHERE term = ?").get(term) as
    TermRow | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO content_policy_terms
         (term, weight, status, source, hits, last_moderator_model, first_seen_at, last_seen_at, updated_at)
       VALUES (?, ?, ?, 'manual', 0, NULL, ?, ?, ?)`
    ).run(
      term,
      clampContentPolicyWeight(input.weight ?? 3),
      input.status ?? "active",
      now,
      now,
      now
    );
  } else {
    db.prepare(
      "UPDATE content_policy_terms SET weight = ?, status = ?, updated_at = ? WHERE term = ?"
    ).run(
      input.weight === undefined ? existing.weight : clampContentPolicyWeight(input.weight),
      input.status ?? existing.status,
      now,
      term
    );
  }
  const row = db.prepare("SELECT * FROM content_policy_terms WHERE term = ?").get(term) as TermRow;
  return toEntry(row);
}

export function deleteContentPolicyTerm(term: string): boolean {
  const key = normalizeContentPolicyTerm(term);
  if (!key) return false;
  const info = getDbInstance().prepare("DELETE FROM content_policy_terms WHERE term = ?").run(key);
  return Number(info?.changes ?? 0) > 0;
}
