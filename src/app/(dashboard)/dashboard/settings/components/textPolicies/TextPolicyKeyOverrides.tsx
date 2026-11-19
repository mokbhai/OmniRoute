"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { Badge, Button, Card, Input, Select } from "@/shared/components";

import type { ApiKeyOption, PolicyConfigView } from "./textPoliciesApi";
import { parseOptionalNumber } from "./textPolicyForm";

interface TextPolicyKeyOverridesProps {
  policyLabel: string;
  global: PolicyConfigView;
  overrides: Record<string, Record<string, unknown>>;
  apiKeys: ApiKeyOption[];
  saving: boolean;
  onSave: (apiKeyId: string, override: Record<string, unknown> | null) => Promise<boolean>;
}

const INHERIT = "";

type OverrideForm = Record<
  | "enabled"
  | "mode"
  | "lowThreshold"
  | "highThreshold"
  | "moderatorModel"
  | "moderationScoreThreshold"
  | "rerouteTarget"
  | "learnMode"
  | "learnMinHits",
  string
>;

function toForm(override: Record<string, unknown> | undefined): OverrideForm {
  const read = (key: string) => {
    const value = override?.[key];
    if (typeof value === "boolean") return value ? "true" : "false";
    return typeof value === "string" || typeof value === "number" ? String(value) : INHERIT;
  };
  return {
    enabled: read("enabled"),
    mode: read("mode"),
    lowThreshold: read("lowThreshold"),
    highThreshold: read("highThreshold"),
    moderatorModel: read("moderatorModel"),
    moderationScoreThreshold: read("moderationScoreThreshold"),
    rerouteTarget: read("rerouteTarget"),
    learnMode: read("learnMode"),
    learnMinHits: read("learnMinHits"),
  };
}

function fromForm(form: OverrideForm): Record<string, unknown> {
  return {
    enabled: form.enabled === INHERIT ? undefined : form.enabled === "true",
    mode: form.mode || undefined,
    lowThreshold: parseOptionalNumber(form.lowThreshold),
    highThreshold: parseOptionalNumber(form.highThreshold),
    moderatorModel: form.moderatorModel || undefined,
    moderationScoreThreshold: parseOptionalNumber(form.moderationScoreThreshold),
    rerouteTarget: form.rerouteTarget || undefined,
    learnMode: form.learnMode || undefined,
    learnMinHits: parseOptionalNumber(form.learnMinHits),
  };
}

/** Part 3: per-API-key overrides. Every blank field inherits the global value. */
export default function TextPolicyKeyOverrides({
  policyLabel,
  global,
  overrides,
  apiKeys,
  saving,
  onSave,
}: TextPolicyKeyOverridesProps) {
  const t = useTranslations("settings");
  const keyName = useMemo(
    () => new Map(apiKeys.map((key) => [key.id, key.name] as const)),
    [apiKeys]
  );
  const overriddenIds = Object.keys(overrides);
  const [selectedKey, setSelectedKey] = useState<string>(overriddenIds[0] ?? "");
  const [form, setForm] = useState<OverrideForm>(() => toForm(overrides[selectedKey]));
  const [error, setError] = useState<string | null>(null);

  const selectKey = (apiKeyId: string) => {
    setSelectedKey(apiKeyId);
    setForm(toForm(overrides[apiKeyId]));
    setError(null);
  };

  const set = (patch: Partial<OverrideForm>) => setForm((previous) => ({ ...previous, ...patch }));
  const inheritLabel = (value: string) => t("textPolicyInherit", { value });
  const yesNo = (value: boolean) => (value ? t("textPolicyOn") : t("textPolicyOff"));

  const keyOptions = [
    { value: "", label: t("textPolicyPickKey") },
    ...apiKeys.map((key) => ({
      value: key.id,
      label: overrides[key.id] ? `${key.name} • ${t("textPolicyHasOverride")}` : key.name,
    })),
  ];

  const save = async (clear: boolean) => {
    if (!selectedKey) return;
    const override = clear ? null : fromForm(form);
    const low = override?.lowThreshold as number | undefined;
    const high = override?.highThreshold as number | undefined;
    if ((low ?? global.lowThreshold) >= (high ?? global.highThreshold)) {
      setError(t("textPolicyErrorBand"));
      return;
    }
    setError(null);
    const ok = await onSave(selectedKey, override);
    if (!ok) setError(t("textPolicyErrorSave"));
  };

  return (
    <Card
      title={t("textPolicyOverridesTitle")}
      subtitle={t("textPolicyOverridesDesc", { policy: policyLabel })}
      icon="key"
    >
      <div className="space-y-4" data-testid="text-policy-overrides">
        {overriddenIds.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {overriddenIds.map((id) => (
              <button key={id} type="button" onClick={() => selectKey(id)}>
                <Badge variant={id === selectedKey ? "primary" : "default"}>
                  {keyName.get(id) ?? id}
                </Badge>
              </button>
            ))}
          </div>
        )}

        <Select
          label={t("textPolicyApiKey")}
          value={selectedKey}
          options={keyOptions}
          data-testid="text-policy-override-key"
          onChange={(event) => selectKey(event.target.value)}
        />

        {selectedKey && (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Select
                label={t("textPolicyEnabled")}
                value={form.enabled}
                options={[
                  { value: INHERIT, label: inheritLabel(yesNo(global.enabled)) },
                  { value: "true", label: t("textPolicyOn") },
                  { value: "false", label: t("textPolicyOff") },
                ]}
                data-testid="text-policy-override-enabled"
                onChange={(event) => set({ enabled: event.target.value })}
              />
              <Select
                label={t("textPolicyMode")}
                value={form.mode}
                options={[
                  { value: INHERIT, label: inheritLabel(t(`textPolicyMode_${global.mode}`)) },
                  ...["reroute", "block", "flag"].map((value) => ({
                    value,
                    label: t(`textPolicyMode_${value}`),
                  })),
                ]}
                onChange={(event) => set({ mode: event.target.value })}
              />
              <Input
                type="number"
                label={t("textPolicyLowThreshold")}
                placeholder={inheritLabel(String(global.lowThreshold))}
                value={form.lowThreshold}
                onChange={(event) => set({ lowThreshold: event.target.value })}
              />
              <Input
                type="number"
                label={t("textPolicyHighThreshold")}
                placeholder={inheritLabel(String(global.highThreshold))}
                value={form.highThreshold}
                onChange={(event) => set({ highThreshold: event.target.value })}
              />
              <Input
                label={t("textPolicyModerator")}
                placeholder={inheritLabel(global.moderatorModel ?? t("textPolicyNone"))}
                value={form.moderatorModel}
                onChange={(event) => set({ moderatorModel: event.target.value })}
              />
              <Input
                type="number"
                step={0.05}
                label={t("textPolicyModeratorThreshold")}
                placeholder={inheritLabel(String(global.moderationScoreThreshold))}
                value={form.moderationScoreThreshold}
                onChange={(event) => set({ moderationScoreThreshold: event.target.value })}
              />
              <Input
                label={t("textPolicyRerouteTarget")}
                placeholder={inheritLabel(global.rerouteTarget ?? t("textPolicyNone"))}
                value={form.rerouteTarget}
                data-testid="text-policy-override-target"
                onChange={(event) => set({ rerouteTarget: event.target.value })}
              />
              <Select
                label={t("textPolicyLearnMode")}
                value={form.learnMode}
                options={[
                  {
                    value: INHERIT,
                    label: inheritLabel(t(`textPolicyLearn_${global.learnMode}`)),
                  },
                  ...["auto", "review", "off"].map((value) => ({
                    value,
                    label: t(`textPolicyLearn_${value}`),
                  })),
                ]}
                onChange={(event) => set({ learnMode: event.target.value })}
              />
              <Input
                type="number"
                label={t("textPolicyLearnMinHits")}
                placeholder={inheritLabel(String(global.learnMinHits))}
                value={form.learnMinHits}
                onChange={(event) => set({ learnMinHits: event.target.value })}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              {overrides[selectedKey] && (
                <Button variant="outline" icon="restart_alt" onClick={() => void save(true)}>
                  {t("textPolicyClearOverride")}
                </Button>
              )}
              <Button
                variant="primary"
                icon="save"
                loading={saving}
                data-testid="text-policy-override-save"
                onClick={() => void save(false)}
              >
                {t("textPolicySaveOverride")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
