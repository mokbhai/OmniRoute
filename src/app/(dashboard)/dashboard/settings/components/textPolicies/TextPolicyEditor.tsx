"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import {
  Button,
  Card,
  Collapsible,
  ConfirmModal,
  Input,
  ModelSelectField,
  Select,
  Textarea,
  Toggle,
} from "@/shared/components";

import type { PolicySummary } from "./textPoliciesApi";
import {
  formatTermLines,
  formatWordLines,
  parseOptionalNumber,
  parseTermLines,
  parseWordLines,
} from "./textPolicyForm";

interface TextPolicyEditorProps {
  policy: PolicySummary;
  /** The raw stored settings block for this policy (definition fields live here). */
  stored: Record<string, unknown>;
  saving: boolean;
  onSave: (fields: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => Promise<void>;
}

interface FormState {
  enabled: boolean;
  mode: string;
  lowThreshold: string;
  highThreshold: string;
  moderatorModel: string;
  moderationScoreThreshold: string;
  rerouteTarget: string;
  learnMode: string;
  learnMinHits: string;
  label: string;
  description: string;
  moderationCategory: string;
  classifierInstruction: string;
  seedTerms: string;
  stopWords: string;
  priority: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function initialForm(policy: PolicySummary, stored: Record<string, unknown>): FormState {
  const c = policy.config;
  return {
    enabled: c.enabled,
    mode: c.mode,
    lowThreshold: String(c.lowThreshold),
    highThreshold: String(c.highThreshold),
    moderatorModel: c.moderatorModel ?? "",
    moderationScoreThreshold: String(c.moderationScoreThreshold),
    rerouteTarget: c.rerouteTarget ?? "",
    learnMode: c.learnMode,
    learnMinHits: String(c.learnMinHits),
    label: str(stored.label),
    description: str(stored.description),
    moderationCategory: str(stored.moderationCategory),
    classifierInstruction: str(stored.classifierInstruction),
    seedTerms: formatTermLines(stored.seedTerms),
    stopWords: formatWordLines(stored.stopWords),
    priority: str(stored.priority),
  };
}

/**
 * Part 2: thresholds, moderator, target, learning and the definition of one policy.
 * The parent keys this component by policy and load revision, so a reload resets the form.
 */
export default function TextPolicyEditor({
  policy,
  stored,
  saving,
  onSave,
  onDelete,
}: TextPolicyEditorProps) {
  const t = useTranslations("settings");
  const [form, setForm] = useState<FormState>(() => initialForm(policy, stored));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (patch: Partial<FormState>) => setForm((previous) => ({ ...previous, ...patch }));
  const seed = useMemo(() => parseTermLines(form.seedTerms), [form.seedTerms]);

  const modeOptions = ["reroute", "block", "flag"].map((value) => ({
    value,
    label: t(`textPolicyMode_${value}`),
  }));
  const learnOptions = ["auto", "review", "off"].map((value) => ({
    value,
    label: t(`textPolicyLearn_${value}`),
  }));

  const handleSave = async () => {
    const low = parseOptionalNumber(form.lowThreshold);
    const high = parseOptionalNumber(form.highThreshold);
    if (low !== undefined && high !== undefined && !(low < high)) {
      setError(t("textPolicyErrorBand"));
      return;
    }
    if (seed.invalid.length > 0) {
      setError(t("textPolicyErrorTerms", { lines: seed.invalid.slice(0, 3).join(", ") }));
      return;
    }
    if (!policy.builtIn && seed.terms.length === 0 && !form.classifierInstruction.trim()) {
      setError(t("textPolicyErrorDefinition"));
      return;
    }
    setError(null);
    const ok = await onSave({
      enabled: form.enabled,
      mode: form.mode,
      lowThreshold: low,
      highThreshold: high,
      moderatorModel: form.moderatorModel,
      moderationScoreThreshold: parseOptionalNumber(form.moderationScoreThreshold),
      rerouteTarget: form.rerouteTarget,
      learnMode: form.learnMode,
      learnMinHits: parseOptionalNumber(form.learnMinHits),
      label: form.label,
      description: form.description,
      moderationCategory: form.moderationCategory,
      classifierInstruction: form.classifierInstruction,
      seedTerms: seed.terms,
      stopWords: parseWordLines(form.stopWords),
      priority: parseOptionalNumber(form.priority),
    });
    if (!ok) setError(t("textPolicyErrorSave"));
  };

  return (
    <Card
      title={t("textPolicyEditorTitle", { policy: policy.label })}
      subtitle={policy.description ?? t("textPolicyEditorDesc")}
      icon="tune"
    >
      <div className="space-y-5" data-testid="tpol-editor">
        <Toggle
          checked={form.enabled}
          onChange={(checked) => set({ enabled: checked })}
          label={t("textPolicyEnabled")}
          description={t("textPolicyEnabledDesc")}
        />

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Select
            label={t("textPolicyMode")}
            hint={t("textPolicyModeHint")}
            value={form.mode}
            options={modeOptions}
            onChange={(event) => set({ mode: event.target.value })}
          />
          <ModelSelectField
            label={t("textPolicyRerouteTarget")}
            placeholder={t("textPolicyRerouteTargetNone")}
            value={form.rerouteTarget}
            allowEmpty
            allowCustomInput
            testId="tpol-reroute-target"
            onChange={(value) => set({ rerouteTarget: value })}
          />
        </section>

        <section className="space-y-2">
          <h3 className="text-sm">{t("textPolicyBandTitle")}</h3>
          <p className="text-xs text-text-muted">{t("textPolicyBandDesc")}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              type="number"
              min={0}
              max={1000}
              label={t("textPolicyLowThreshold")}
              hint={t("textPolicyLowThresholdHint")}
              value={form.lowThreshold}
              data-testid="tpol-low"
              onChange={(event) => set({ lowThreshold: event.target.value })}
            />
            <Input
              type="number"
              min={0}
              max={1000}
              label={t("textPolicyHighThreshold")}
              hint={t("textPolicyHighThresholdHint")}
              value={form.highThreshold}
              data-testid="tpol-high"
              onChange={(event) => set({ highThreshold: event.target.value })}
            />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ModelSelectField
            label={t("textPolicyModerator")}
            placeholder={t("textPolicyModeratorNone")}
            value={form.moderatorModel}
            allowEmpty
            allowCustomInput
            testId="tpol-moderator"
            onChange={(value) => set({ moderatorModel: value })}
          />
          <Input
            type="number"
            min={0}
            max={1}
            step={0.05}
            label={t("textPolicyModeratorThreshold")}
            hint={t("textPolicyModeratorThresholdHint")}
            value={form.moderationScoreThreshold}
            onChange={(event) => set({ moderationScoreThreshold: event.target.value })}
          />
          <p className="text-xs text-text-muted md:col-span-2">{t("textPolicyModeratorHint")}</p>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Select
            label={t("textPolicyLearnMode")}
            hint={t("textPolicyLearnModeHint")}
            value={form.learnMode}
            options={learnOptions}
            onChange={(event) => set({ learnMode: event.target.value })}
          />
          <Input
            type="number"
            min={1}
            max={100}
            label={t("textPolicyLearnMinHits")}
            hint={t("textPolicyLearnMinHitsHint")}
            value={form.learnMinHits}
            disabled={form.learnMode !== "auto"}
            onChange={(event) => set({ learnMinHits: event.target.value })}
          />
        </section>

        <Collapsible
          title={t("textPolicyDefinitionTitle")}
          subtitle={policy.builtIn ? t("textPolicyDefinitionBuiltInDesc") : undefined}
          icon="menu_book"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label={t("textPolicyLabel")}
              placeholder={policy.label}
              value={form.label}
              onChange={(event) => set({ label: event.target.value })}
            />
            <Input
              label={t("textPolicyCategory")}
              hint={t("textPolicyCategoryHint")}
              placeholder={policy.moderationCategory}
              value={form.moderationCategory}
              onChange={(event) => set({ moderationCategory: event.target.value })}
            />
            <Input
              className="md:col-span-2"
              label={t("textPolicyDescription")}
              value={form.description}
              onChange={(event) => set({ description: event.target.value })}
            />
            <Textarea
              fieldClassName="md:col-span-2"
              rows={2}
              label={t("textPolicyInstruction")}
              hint={t("textPolicyInstructionHint")}
              placeholder={policy.classifierInstruction}
              value={form.classifierInstruction}
              onChange={(event) => set({ classifierInstruction: event.target.value })}
            />
            <Textarea
              rows={6}
              label={t("textPolicySeedTerms")}
              hint={
                policy.builtIn
                  ? t("textPolicySeedTermsBuiltInHint", { count: policy.seedTermCount })
                  : t("textPolicySeedTermsHint")
              }
              placeholder={"onlyfans:3\nacme corp:5"}
              value={form.seedTerms}
              data-testid="tpol-seed-terms"
              onChange={(event) => set({ seedTerms: event.target.value })}
            />
            <Textarea
              rows={6}
              label={t("textPolicyStopWords")}
              hint={t("textPolicyStopWordsHint")}
              value={form.stopWords}
              onChange={(event) => set({ stopWords: event.target.value })}
            />
            <Input
              type="number"
              min={0}
              max={1000}
              label={t("textPolicyPriority")}
              hint={t("textPolicyPriorityHint")}
              placeholder={String(policy.priority)}
              value={form.priority}
              onChange={(event) => set({ priority: event.target.value })}
            />
          </div>
        </Collapsible>

        {error && (
          <p role="alert" className="text-sm text-error" data-testid="tpol-error">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          {!policy.builtIn ? (
            <Button variant="danger" icon="delete" onClick={() => setConfirmDelete(true)}>
              {t("textPolicyDelete")}
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="primary"
            icon="save"
            loading={saving}
            data-testid="tpol-save"
            onClick={() => void handleSave()}
          >
            {t("textPolicySave")}
          </Button>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          await onDelete();
        }}
        title={t("textPolicyDeleteTitle")}
        message={t("textPolicyDeleteMessage", { policy: policy.label })}
        confirmText={t("textPolicyDelete")}
        variant="danger"
      />
    </Card>
  );
}
