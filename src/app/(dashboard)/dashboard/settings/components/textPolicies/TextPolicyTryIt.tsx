"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Badge, Button, Card, Input, Select, Textarea } from "@/shared/components";

import { evaluateText, type ApiKeyOption, type EvaluateResult } from "./textPoliciesApi";

interface TextPolicyTryItProps {
  policyId: string;
  apiKeys: ApiKeyOption[];
}

/**
 * Part 5: paste text and see the verdict. Dry run: evaluates even when the policy is
 * disabled and never stores learned terms. It can still call the moderator (middle band).
 */
export default function TextPolicyTryIt({ policyId, apiKeys }: TextPolicyTryItProps) {
  const t = useTranslations("settings");
  const [text, setText] = useState("");
  const [apiKeyId, setApiKeyId] = useState("");
  const [requestedModel, setRequestedModel] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<EvaluateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!text.trim()) return;
    setRunning(true);
    setError(null);
    try {
      setResult(
        await evaluateText(policyId, {
          text,
          apiKeyId: apiKeyId || undefined,
          requestedModel: requestedModel.trim() || undefined,
        })
      );
    } catch {
      setError(t("textPolicyTryError"));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const decision = result?.decision ?? null;

  return (
    <Card title={t("textPolicyTryTitle")} subtitle={t("textPolicyTryDesc")} icon="science">
      <div className="space-y-4" data-testid="text-policy-try">
        <Textarea
          rows={5}
          label={t("textPolicyTryText")}
          value={text}
          data-testid="text-policy-try-text"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Select
            label={t("textPolicyTryAsKey")}
            value={apiKeyId}
            options={[
              { value: "", label: t("textPolicyTryNoKey") },
              ...apiKeys.map((key) => ({ value: key.id, label: key.name })),
            ]}
            onChange={(event) => setApiKeyId(event.target.value)}
          />
          <Input
            label={t("textPolicyTryModel")}
            placeholder="claude/claude-sonnet-4-5"
            value={requestedModel}
            onChange={(event) => setRequestedModel(event.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button
            icon="play_arrow"
            loading={running}
            disabled={!text.trim()}
            data-testid="text-policy-try-run"
            onClick={() => void run()}
          >
            {t("textPolicyTryRun")}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}

        {decision && (
          <div
            className="space-y-3 rounded-md border border-border p-3"
            data-testid="text-policy-try-result"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={decision.violation ? "error" : "success"}>
                {decision.violation ? t("textPolicyTryViolation") : t("textPolicyTryClean")}
              </Badge>
              <Badge variant="default">{t(`textPolicyBand_${decision.band}`)}</Badge>
              {result?.plan && (
                <Badge variant="info">{t(`textPolicyAction_${result.plan.action}`)}</Badge>
              )}
              {!result?.enabled && (
                <span className="text-xs text-text-muted">{t("textPolicyTryDisabledNote")}</span>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <Row label={t("textPolicyTryScore")} value={String(decision.keywordScore)} />
              <Row label={t("textPolicyTryStage")} value={t(`textPolicyStage_${decision.stage}`)} />
              {decision.moderatorScore !== undefined && (
                <Row
                  label={t("textPolicyTryModeratorScore")}
                  value={decision.moderatorScore.toFixed(3)}
                />
              )}
              {decision.moderatorError && (
                <Row label={t("textPolicyTryModeratorError")} value={decision.moderatorError} />
              )}
              {result?.plan?.toModel && (
                <Row label={t("textPolicyTryTarget")} value={result.plan.toModel} />
              )}
            </dl>
            <TermList label={t("textPolicyTryMatched")} terms={decision.matchedTerms} />
            {decision.discoveredTerms && decision.discoveredTerms.length > 0 && (
              <TermList
                label={t("textPolicyTryDiscovered")}
                terms={decision.discoveredTerms.map((entry) => `${entry.term} (${entry.weight})`)}
              />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </div>
  );
}

function TermList({ label, terms }: { label: string; terms: string[] }) {
  if (terms.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-text-muted">{label}</p>
      <div className="flex flex-wrap gap-1">
        {terms.map((term) => (
          <Badge key={term} size="sm" variant="default">
            {term}
          </Badge>
        ))}
      </div>
    </div>
  );
}
