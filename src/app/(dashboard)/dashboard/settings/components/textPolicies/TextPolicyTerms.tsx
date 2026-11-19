"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger } from "@omniroute/ui-kit/tabs";

import { Badge, Button, Card, EmptyState, Input, Select } from "@/shared/components";

import {
  deleteTerm,
  fetchTerms,
  upsertTerm,
  type LearnedTerm,
  type TermStatus,
} from "./textPoliciesApi";

interface TextPolicyTermsProps {
  policyId: string;
  /** Called after any change so the policy list counts refresh. */
  onChanged: () => void;
}

const STATUSES: TermStatus[] = ["pending", "active", "rejected"];
const WEIGHTS = [1, 2, 3, 4, 5].map((weight) => ({ value: String(weight), label: String(weight) }));

/** Part 4: review learned words — approve, reject, reweight, delete, or add by hand. */
export default function TextPolicyTerms({ policyId, onChanged }: TextPolicyTermsProps) {
  const t = useTranslations("settings");
  const [status, setStatus] = useState<TermStatus>("pending");
  const [terms, setTerms] = useState<LearnedTerm[] | null>(null);
  // Error kinds, translated at render so effects never depend on `t`.
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [busyTerm, setBusyTerm] = useState<string | null>(null);
  const [newTerm, setNewTerm] = useState("");
  const [newWeight, setNewWeight] = useState("3");

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await fetchTerms(policyId, signal);
        if (!signal?.aborted) {
          setTerms(next);
          setError(null);
        }
      } catch {
        if (!signal?.aborted) setError("load");
      }
    },
    [policyId]
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchTerms(policyId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setTerms(next);
        setError(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("load");
      });
    return () => controller.abort();
  }, [policyId]);

  const run = async (term: string, action: () => Promise<void>) => {
    setBusyTerm(term);
    try {
      await action();
      await load();
      onChanged();
    } catch {
      setError("save");
    } finally {
      setBusyTerm(null);
    }
  };

  const addTerm = async () => {
    const term = newTerm.trim();
    if (!term) return;
    await run(term, () =>
      upsertTerm(policyId, { term, weight: Number(newWeight), status: "active" })
    );
    setNewTerm("");
  };

  const counts = Object.fromEntries(
    STATUSES.map((value) => [value, terms?.filter((term) => term.status === value).length ?? 0])
  ) as Record<TermStatus, number>;
  const visible = terms?.filter((term) => term.status === status) ?? [];

  return (
    <Card title={t("textPolicyTermsTitle")} subtitle={t("textPolicyTermsDesc")} icon="spellcheck">
      <div className="space-y-4" data-testid="text-policy-terms">
        <Tabs
          variant="underline"
          value={status}
          onValueChange={(next) => setStatus(next as TermStatus)}
        >
          <TabsList aria-label={t("textPolicyTermsTabsAria")}>
            {STATUSES.map((value) => (
              <TabsTrigger key={value} value={value} data-testid={`text-policy-terms-tab-${value}`}>
                {t(`textPolicyTermStatus_${value}`)} ({counts[value]})
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error === "load" ? t("textPolicyTermsLoadError") : t("textPolicyErrorSave")}
          </p>
        )}

        {terms !== null && visible.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={t(`textPolicyTermsEmpty_${status}`)}
            description={t("textPolicyTermsEmptyDesc")}
          />
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((term) => (
              <li
                key={term.term}
                className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between"
                data-testid={`text-policy-term-${term.term}`}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium break-all">{term.term}</span>
                  <Badge size="sm" variant={term.source === "manual" ? "info" : "default"}>
                    {t(`textPolicyTermSource_${term.source}`)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("textPolicyTermHits", { hits: term.hits })}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    compact
                    aria-label={t("textPolicyTermWeight")}
                    value={String(term.weight)}
                    options={WEIGHTS}
                    disabled={busyTerm === term.term}
                    onChange={(event) =>
                      void run(term.term, () =>
                        upsertTerm(policyId, {
                          term: term.term,
                          weight: Number(event.target.value),
                        })
                      )
                    }
                  />
                  {term.status !== "active" && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon="check"
                      disabled={busyTerm === term.term}
                      data-testid={`text-policy-term-approve-${term.term}`}
                      onClick={() =>
                        void run(term.term, () =>
                          upsertTerm(policyId, { term: term.term, status: "active" })
                        )
                      }
                    >
                      {t("textPolicyTermApprove")}
                    </Button>
                  )}
                  {term.status !== "rejected" && (
                    <Button
                      size="sm"
                      variant="outline"
                      icon="block"
                      disabled={busyTerm === term.term}
                      data-testid={`text-policy-term-reject-${term.term}`}
                      onClick={() =>
                        void run(term.term, () =>
                          upsertTerm(policyId, { term: term.term, status: "rejected" })
                        )
                      }
                    >
                      {t("textPolicyTermReject")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="delete"
                    aria-label={t("textPolicyTermDelete")}
                    disabled={busyTerm === term.term}
                    onClick={() => void run(term.term, () => deleteTerm(policyId, term.term))}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Input
            className="flex-1"
            label={t("textPolicyTermAdd")}
            placeholder={t("textPolicyTermAddPlaceholder")}
            value={newTerm}
            maxLength={48}
            data-testid="text-policy-term-new"
            onChange={(event) => setNewTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addTerm();
            }}
          />
          <Select
            label={t("textPolicyTermWeight")}
            value={newWeight}
            options={WEIGHTS}
            onChange={(event) => setNewWeight(event.target.value)}
          />
          <Button icon="add" disabled={!newTerm.trim()} onClick={() => void addTerm()}>
            {t("textPolicyTermAddButton")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("textPolicyTermsHint")}</p>
      </div>
    </Card>
  );
}
