// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TextPoliciesManager from "@/app/(dashboard)/dashboard/settings/components/textPolicies/TextPoliciesManager";
import SettingsTextPoliciesPage from "@/app/(dashboard)/dashboard/settings/text-policies/page";
import { getSectionItems, SIDEBAR_SECTIONS } from "@/shared/constants/sidebarVisibility";

// A stable translator, like next-intl's: effects must not re-run because `t` changed.
const translate = vi.hoisted(() =>
  Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key,
    { has: () => true }
  )
);
vi.mock("next-intl", () => ({ useTranslations: () => translate }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/dashboard/settings/text-policies",
}));

type Call = { url: string; method: string; body: unknown };

const CONFIG = {
  enabled: false,
  mode: "reroute",
  lowThreshold: 3,
  highThreshold: 10,
  moderatorModel: null,
  moderationScoreThreshold: 0.5,
  rerouteTarget: null,
  learnMode: "auto",
  learnMinHits: 2,
};

function setupApi() {
  const calls: Call[] = [];
  const state = {
    stored: {
      "sexual-content": { keyOverrides: { k1: { enabled: true } } },
    } as Record<string, unknown>,
    terms: [
      {
        term: "freaky",
        weight: 3,
        status: "pending",
        source: "moderator",
        hits: 1,
        lastModeratorModel: "groq/judge",
        lastSeenAt: "2026-11-19T00:00:00Z",
      },
    ],
  };
  const respond = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/api/text-policies") {
      return respond({
        policies: [
          {
            id: "sexual-content",
            label: "Sexual / adult content",
            description: null,
            builtIn: true,
            priority: 100,
            moderationCategory: "sexual",
            classifierInstruction: "how sexual the TEXT is",
            seedTermCount: 120,
            config: CONFIG,
            learnedTerms: { pending: 1, active: 0, rejected: 0 },
          },
        ],
      });
    }
    if (url === "/api/settings" && method === "GET") return respond({ textPolicies: state.stored });
    if (url === "/api/settings" && method === "PATCH") {
      state.stored = (body as { textPolicies: Record<string, unknown> }).textPolicies;
      return respond({ ok: true });
    }
    if (url === "/api/keys") return respond({ keys: [{ id: "k1", name: "Tenant A" }] });
    if (url.endsWith("/terms") && method === "GET") return respond({ terms: state.terms });
    if (url.endsWith("/terms")) return respond({ ok: true });
    if (url.endsWith("/evaluate")) {
      return respond({
        enabled: false,
        decision: {
          violation: true,
          stage: "keyword",
          band: "above",
          keywordScore: 13,
          matchedTerms: ["porn", "blowjob"],
          scope: "global",
        },
        plan: { action: "no_reroute_target", block: false },
      });
    }
    return respond({ models: [] });
  }) as typeof fetch;
  return { calls, state };
}

const roots: Array<{ root: Root; el: HTMLDivElement }> = [];

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(node: React.ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  roots.push({ root, el });
  await flush();
  return el;
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const found = document.body.querySelector<T>(selector);
  if (!found) throw new Error(`not found: ${selector}`);
  return found;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

const field = (testId: string) =>
  q<HTMLInputElement>(`[data-testid="${testId}"]`).matches("input, textarea")
    ? q<HTMLInputElement>(`[data-testid="${testId}"]`)
    : q<HTMLInputElement>(`[data-testid="${testId}"] input, [data-testid="${testId}"] textarea`);

const lastPatch = (calls: Call[]) =>
  [...calls].reverse().find((call) => call.url === "/api/settings" && call.method === "PATCH")
    ?.body as { textPolicies: Record<string, Record<string, unknown>> } | undefined;

describe("Text Policies settings page", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    for (const { root, el } of roots.splice(0)) {
      act(() => root.unmount());
      el.remove();
    }
    document.body.innerHTML = "";
  });

  it("is reachable from the sidebar and renders its header", async () => {
    const ids = SIDEBAR_SECTIONS.flatMap((section) => getSectionItems(section)).map(
      (item) => item.id
    );
    expect(ids).toContain("settings-text-policies");
    setupApi();
    const el = await render(<SettingsTextPoliciesPage />);
    expect(el.textContent).toContain("settingsTextPolicies");
  });

  it("1 · lists policies and toggles one on", async () => {
    const { calls } = setupApi();
    await render(<TextPoliciesManager />);
    expect(q('[data-testid="text-policy-row-sexual-content"]').textContent).toContain(
      "Sexual / adult content"
    );
    await click(q('[data-testid="text-policy-list"] [role="switch"]'));
    const patch = lastPatch(calls);
    expect(patch?.textPolicies["sexual-content"].enabled).toBe(true);
    expect(patch?.textPolicies["sexual-content"].keyOverrides).toEqual({ k1: { enabled: true } });
  });

  it("2 · editor rejects an inverted band and saves valid fields", async () => {
    const { calls } = setupApi();
    await render(<TextPoliciesManager />);
    await act(async () => setValue(field("text-policy-low"), "12"));
    await click(q('[data-testid="text-policy-save"]'));
    expect(q('[data-testid="text-policy-error"]').textContent).toBe("textPolicyErrorBand");
    expect(lastPatch(calls)).toBeUndefined();

    await act(async () => setValue(field("text-policy-low"), "2"));
    await click(
      [...document.body.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("textPolicyDefinitionTitle")
      )!
    );
    await act(async () => setValue(field("text-policy-seed-terms"), "onlyfans:3\nthirst trap"));
    await click(q('[data-testid="text-policy-save"]'));
    const saved = lastPatch(calls)?.textPolicies["sexual-content"];
    expect(saved?.lowThreshold).toBe(2);
    expect(saved?.highThreshold).toBe(10);
    expect(saved?.seedTerms).toEqual([
      { term: "onlyfans", weight: 3 },
      { term: "thirst trap", weight: 3 },
    ]);
    expect(saved?.keyOverrides).toEqual({ k1: { enabled: true } });
  });

  it("3 · saves a per-key override and leaves blank fields inherited", async () => {
    const { calls } = setupApi();
    await render(<TextPoliciesManager />);
    await act(async () => setValue(field("text-policy-override-target"), "grok/grok-4"));
    await click(q('[data-testid="text-policy-override-save"]'));
    expect(lastPatch(calls)?.textPolicies["sexual-content"].keyOverrides).toEqual({
      k1: { enabled: true, rerouteTarget: "grok/grok-4" },
    });
  });

  it("4 · approves a pending learned word", async () => {
    const { calls } = setupApi();
    await render(<TextPoliciesManager />);
    expect(q('[data-testid="text-policy-term-freaky"]').textContent).toContain("freaky");
    await click(q('[data-testid="text-policy-term-approve-freaky"]'));
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe("/api/text-policies/sexual-content/terms");
    expect(put?.body).toEqual({ term: "freaky", status: "active" });
  });

  it("5 · try it runs a dry-run evaluation and shows the verdict", async () => {
    const { calls } = setupApi();
    await render(<TextPoliciesManager />);
    await act(async () => setValue(field("text-policy-try-text"), "porn, blowjob"));
    await click(q('[data-testid="text-policy-try-run"]'));
    const evaluate = calls.find((call) => call.url.endsWith("/evaluate"));
    expect(evaluate?.body).toMatchObject({
      text: "porn, blowjob",
      ignoreEnabled: true,
      learn: false,
    });
    const result = q('[data-testid="text-policy-try-result"]').textContent ?? "";
    expect(result).toContain("textPolicyTryViolation");
    expect(result).toContain("textPolicyBand_above");
    expect(result).toContain("blowjob");
  });

  it("6 · creates a custom policy, starting disabled, after validating the id", async () => {
    const { calls } = setupApi();
    await render(<TextPoliciesManager />);
    await click(
      [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "textPolicyNew"
      )!
    );
    await act(async () => setValue(field("text-policy-new-id"), "sexual-content"));
    await act(async () =>
      setValue(field("text-policy-new-instruction"), "how much the TEXT promotes a competitor")
    );
    await click(q('[data-testid="text-policy-new-submit"]'));
    expect(q('[data-testid="text-policy-new-error"]').textContent).toBe(
      "textPolicyError_duplicateId"
    );

    await act(async () => setValue(field("text-policy-new-id"), "competitor-mentions"));
    await act(async () => setValue(field("text-policy-new-terms"), "acme corp:5"));
    await click(q('[data-testid="text-policy-new-submit"]'));
    expect(lastPatch(calls)?.textPolicies["competitor-mentions"]).toEqual({
      enabled: false,
      classifierInstruction: "how much the TEXT promotes a competitor",
      seedTerms: [{ term: "acme corp", weight: 5 }],
    });
  });
});
