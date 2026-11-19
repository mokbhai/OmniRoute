"use client";

import { useTranslations } from "next-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";

import TextPoliciesManager from "../components/textPolicies/TextPoliciesManager";

export default function SettingsTextPoliciesPage() {
  const tSidebar = useTranslations("sidebar");
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsTextPolicies")}
        description={tSidebar("settingsTextPoliciesSubtitle")}
      />
      <TextPoliciesManager />
    </div>
  );
}
