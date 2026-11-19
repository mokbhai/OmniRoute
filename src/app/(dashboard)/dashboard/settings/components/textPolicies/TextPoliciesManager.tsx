"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { CardSkeleton, EmptyState } from "@/shared/components";

import NewTextPolicyModal from "./NewTextPolicyModal";
import TextPolicyEditor from "./TextPolicyEditor";
import TextPolicyKeyOverrides from "./TextPolicyKeyOverrides";
import TextPolicyList from "./TextPolicyList";
import TextPolicyTerms from "./TextPolicyTerms";
import TextPolicyTryIt from "./TextPolicyTryIt";
import {
  fetchApiKeys,
  fetchPolicies,
  fetchStoredPolicies,
  saveStoredPolicies,
  type ApiKeyOption,
  type PolicySummary,
} from "./textPoliciesApi";
import {
  getKeyOverrides,
  removePolicy,
  setKeyOverride,
  setPolicyEnabled,
  setPolicyGlobalFields,
  validatePolicies,
  type StoredPolicies,
} from "./textPolicyForm";

const NO_FIELDS: Record<string, unknown> = Object.freeze({});

/**
 * Text Policies settings page: list (1), editor (2), per-key overrides (3),
 * learned terms (4), try it (5) and new custom policy (6). Settings are written as one
 * `textPolicies` object through PATCH /api/settings; learned terms and evaluation use
 * the /api/text-policies routes.
 */
export default function TextPoliciesManager() {
  const t = useTranslations("settings");
  const [policies, setPolicies] = useState<PolicySummary[] | null>(null);
  const [stored, setStored] = useState<StoredPolicies>({});
  const [apiKeys, setApiKeys] = useState<ApiKeyOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  /** Bumped on every load; editors are keyed by it so they reset to the saved values. */
  const [revision, setRevision] = useState(0);

  const applyLoaded = useCallback((nextPolicies: PolicySummary[], nextStored: StoredPolicies) => {
    setPolicies(nextPolicies);
    setStored(nextStored);
    setLoadError(false);
    setRevision((value) => value + 1);
    setSelectedId((current) =>
      current && nextPolicies.some((policy) => policy.id === current)
        ? current
        : (nextPolicies[0]?.id ?? null)
    );
  }, []);

  const loadAll = (signal?: AbortSignal) =>
    Promise.all([fetchPolicies(signal), fetchStoredPolicies(signal)]);

  const reload = useCallback(async () => {
    try {
      const [nextPolicies, nextStored] = await loadAll();
      applyLoaded(nextPolicies, nextStored);
    } catch {
      setLoadError(true);
    }
  }, [applyLoaded]);

  useEffect(() => {
    const controller = new AbortController();
    loadAll(controller.signal)
      .then(([nextPolicies, nextStored]) => {
        if (!controller.signal.aborted) applyLoaded(nextPolicies, nextStored);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    fetchApiKeys(controller.signal)
      .then((keys) => {
        if (!controller.signal.aborted) setApiKeys(keys);
      })
      .catch(() => {
        // Keys are optional: the overrides card then shows an empty key list.
      });
    return () => controller.abort();
  }, [applyLoaded]);

  /** Validate, write the whole `textPolicies` object, reload. Returns success. */
  const persist = useCallback(
    async (next: StoredPolicies): Promise<boolean> => {
      const invalid = validatePolicies(next);
      if (invalid) {
        setNotice({ tone: "error", text: t("textPolicyErrorInvalid", { detail: invalid }) });
        return false;
      }
      setSaving(true);
      try {
        await saveStoredPolicies(next);
        await reload();
        setNotice({ tone: "ok", text: t("textPolicySaved") });
        return true;
      } catch (error) {
        setNotice({
          tone: "error",
          text: t("textPolicyErrorInvalid", {
            detail: error instanceof Error ? error.message : String(error),
          }),
        });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [reload, t]
  );

  const selected = policies?.find((policy) => policy.id === selectedId) ?? null;
  const selectedStored = (selectedId && stored[selectedId]) || NO_FIELDS;
  const overrides = useMemo(
    () => (selectedId ? getKeyOverrides(stored, selectedId) : {}),
    [stored, selectedId]
  );

  if (loadError) {
    return (
      <EmptyState
        icon="error"
        title={t("textPolicyLoadError")}
        actionLabel={t("textPolicyRetry")}
        onAction={() => void reload()}
      />
    );
  }
  if (!policies) return <CardSkeleton />;

  return (
    <div className="space-y-4" data-testid="tpol-manager">
      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`text-sm ${notice.tone === "error" ? "text-error" : "text-text-muted"}`}
          data-testid="tpol-notice"
        >
          {notice.text}
        </p>
      )}

      <TextPolicyList
        policies={policies}
        selectedId={selectedId}
        busy={saving}
        onSelect={setSelectedId}
        onToggle={(policyId, enabled) => void persist(setPolicyEnabled(stored, policyId, enabled))}
        onCreate={() => setCreating(true)}
      />

      {selected && (
        <>
          <TextPolicyEditor
            key={`editor:${selected.id}:${revision}`}
            policy={selected}
            stored={selectedStored}
            saving={saving}
            onSave={(fields) => persist(setPolicyGlobalFields(stored, selected.id, fields))}
            onDelete={async () => {
              if (await persist(removePolicy(stored, selected.id))) setSelectedId(null);
            }}
          />
          <TextPolicyKeyOverrides
            key={`overrides:${selected.id}:${revision}`}
            policyLabel={selected.label}
            global={selected.config}
            overrides={overrides}
            apiKeys={apiKeys}
            saving={saving}
            onSave={(apiKeyId, override) =>
              persist(setKeyOverride(stored, selected.id, apiKeyId, override))
            }
          />
          <TextPolicyTerms
            key={`terms:${selected.id}`}
            policyId={selected.id}
            onChanged={() => void reload()}
          />
          <TextPolicyTryIt policyId={selected.id} apiKeys={apiKeys} />
        </>
      )}

      <NewTextPolicyModal
        isOpen={creating}
        existingIds={policies.map((policy) => policy.id)}
        saving={saving}
        onClose={() => setCreating(false)}
        onCreate={async (policyId, fields) => {
          const ok = await persist(setPolicyGlobalFields(stored, policyId, fields));
          if (ok) setSelectedId(policyId);
          return ok;
        }}
      />
    </div>
  );
}
