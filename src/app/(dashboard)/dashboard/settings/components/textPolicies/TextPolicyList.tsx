"use client";

import { useTranslations } from "next-intl";

import { Badge, Button, Card, Toggle } from "@/shared/components";

import type { PolicySummary } from "./textPoliciesApi";

interface TextPolicyListProps {
  policies: PolicySummary[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (policyId: string) => void;
  onToggle: (policyId: string, enabled: boolean) => void;
  onCreate: () => void;
}

/** Part 1: every policy with its on/off switch, mode and learned-term counts. */
export default function TextPolicyList({
  policies,
  selectedId,
  busy,
  onSelect,
  onToggle,
  onCreate,
}: TextPolicyListProps) {
  const t = useTranslations("settings");
  return (
    <Card
      title={t("textPolicyListTitle")}
      subtitle={t("textPolicyListDesc")}
      icon="policy"
      action={
        <Button size="sm" variant="outline" icon="add" onClick={onCreate}>
          {t("textPolicyNew")}
        </Button>
      }
    >
      <ul className="divide-y divide-border" data-testid="text-policy-list">
        {policies.map((policy) => {
          const selected = policy.id === selectedId;
          return (
            <li
              key={policy.id}
              className={`flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between ${
                selected ? "bg-muted/40" : ""
              }`}
            >
              {/* kit-exception: two-line selectable row (name, badges, counts); the kit Button is single-line. */}
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
                aria-pressed={selected}
                data-testid={`text-policy-row-${policy.id}`}
                onClick={() => onSelect(policy.id)}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{policy.label}</span>
                  <code className="text-xs text-text-muted">{policy.id}</code>
                  <Badge size="sm" variant={policy.builtIn ? "info" : "default"}>
                    {policy.builtIn ? t("textPolicyBuiltIn") : t("textPolicyCustom")}
                  </Badge>
                  <Badge size="sm" variant={modeVariant(policy.config.mode)}>
                    {t(`textPolicyMode_${policy.config.mode}`)}
                  </Badge>
                </span>
                <span className="text-xs text-text-muted">
                  {t("textPolicyCounts", {
                    seed: policy.seedTermCount,
                    active: policy.learnedTerms.active,
                    pending: policy.learnedTerms.pending,
                  })}
                </span>
              </button>
              <Toggle
                checked={policy.config.enabled}
                disabled={busy}
                ariaLabel={t("textPolicyEnableAria", { policy: policy.label })}
                onChange={(checked) => onToggle(policy.id, checked)}
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function modeVariant(mode: PolicySummary["config"]["mode"]): "warning" | "error" | "default" {
  if (mode === "block") return "error";
  if (mode === "reroute") return "warning";
  return "default";
}
