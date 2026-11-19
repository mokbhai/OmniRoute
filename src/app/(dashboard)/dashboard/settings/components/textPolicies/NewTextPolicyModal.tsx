"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, Modal, Textarea } from "@/shared/components";

import { parseTermLines, validateNewPolicyId } from "./textPolicyForm";

interface NewTextPolicyModalProps {
  isOpen: boolean;
  existingIds: string[];
  saving: boolean;
  onClose: () => void;
  /** Receives the stored settings block for the new policy (created disabled). */
  onCreate: (policyId: string, fields: Record<string, unknown>) => Promise<boolean>;
}

const EMPTY = { id: "", label: "", instruction: "", category: "", terms: "" };

/** Part 6: define a custom policy (no code). It starts disabled so it can be tested first. */
export default function NewTextPolicyModal({
  isOpen,
  existingIds,
  saving,
  onClose,
  onCreate,
}: NewTextPolicyModalProps) {
  const t = useTranslations("settings");
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof EMPTY>) => setForm((previous) => ({ ...previous, ...patch }));

  const close = () => {
    setForm(EMPTY);
    setError(null);
    onClose();
  };

  const submit = async () => {
    const id = form.id.trim();
    const idError = validateNewPolicyId(id, existingIds);
    if (idError) {
      setError(t(`textPolicyError_${idError}`));
      return;
    }
    const { terms, invalid } = parseTermLines(form.terms);
    if (invalid.length > 0) {
      setError(t("textPolicyErrorTerms", { lines: invalid.slice(0, 3).join(", ") }));
      return;
    }
    if (terms.length === 0 && form.instruction.trim().length < 10) {
      setError(t("textPolicyError_missingDefinition"));
      return;
    }
    setError(null);
    const ok = await onCreate(id, {
      enabled: false,
      label: form.label.trim() || undefined,
      classifierInstruction: form.instruction.trim() || undefined,
      moderationCategory: form.category.trim() || undefined,
      seedTerms: terms.length > 0 ? terms : undefined,
    });
    if (ok) close();
    else setError(t("textPolicyErrorSave"));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={t("textPolicyNewTitle")}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t("textPolicyCancel")}
          </Button>
          <Button
            variant="primary"
            icon="add"
            loading={saving}
            data-testid="text-policy-new-submit"
            onClick={() => void submit()}
          >
            {t("textPolicyCreate")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4" data-testid="text-policy-new-modal">
        <p className="text-sm text-text-muted">{t("textPolicyNewDesc")}</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            label={t("textPolicyId")}
            hint={t("textPolicyIdHint")}
            placeholder="competitor-mentions"
            value={form.id}
            data-testid="text-policy-new-id"
            onChange={(event) => set({ id: event.target.value.toLowerCase() })}
          />
          <Input
            label={t("textPolicyLabel")}
            placeholder={t("textPolicyNewLabelPlaceholder")}
            value={form.label}
            onChange={(event) => set({ label: event.target.value })}
          />
        </div>
        <Textarea
          rows={2}
          label={t("textPolicyInstruction")}
          hint={t("textPolicyInstructionHint")}
          placeholder={t("textPolicyNewInstructionPlaceholder")}
          value={form.instruction}
          data-testid="text-policy-new-instruction"
          onChange={(event) => set({ instruction: event.target.value })}
        />
        <Input
          label={t("textPolicyCategory")}
          hint={t("textPolicyCategoryHint")}
          placeholder="harassment"
          value={form.category}
          onChange={(event) => set({ category: event.target.value })}
        />
        <Textarea
          rows={5}
          label={t("textPolicySeedTerms")}
          hint={t("textPolicySeedTermsHint")}
          placeholder={"acme corp:5\nacme:3"}
          value={form.terms}
          data-testid="text-policy-new-terms"
          onChange={(event) => set({ terms: event.target.value })}
        />
        {error && (
          <p role="alert" className="text-sm text-error" data-testid="text-policy-new-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
