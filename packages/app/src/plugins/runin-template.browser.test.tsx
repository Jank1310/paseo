import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ui from "@/components/settings";
import { TemplateSection } from "../../../../plugin-examples/runin/client/template-section";
import {
  getTemplateStatus,
  updateTemplate,
  type TemplateStatus,
} from "../../../../plugin-examples/runin/shared/contracts";

beforeEach(() => vi.stubGlobal("React", React));
const mounted: { root: Root; container: HTMLDivElement; query: QueryClient }[] = [];
afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.query.clear();
    entry.container.remove();
  }
  vi.unstubAllGlobals();
});

function backend(overrides: Partial<TemplateStatus>) {
  const server = {
    status: {
      name: "paseo-example",
      expectedVersion: "required-version",
      currentVersion: "older-version",
      state: "outdated",
      checkedAt: Date.now(),
      updating: false,
      error: null,
      ...overrides,
    } as TemplateStatus,
    error: null as string | null,
    updates: 0,
  };
  const invoke = async (method: string) => {
    if (method === getTemplateStatus.name) {
      if (server.error) throw new Error(server.error);
      return server.status;
    }
    if (method === updateTemplate.name) {
      server.updates++;
      server.status = { ...server.status, updating: true };
      return { updating: true };
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  return { server, invoke };
}

function mount(overrides: Partial<TemplateStatus> = {}) {
  const { server, invoke } = backend(overrides);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={query}>
        <PluginRpcProvider invoke={invoke}>
          <TemplateSection ui={ui} hostId="managing-host" />
        </PluginRpcProvider>
      </QueryClientProvider>,
    ),
  );
  mounted.push({ root, container, query });
  return {
    server,
    refresh: () => query.invalidateQueries({ queryKey: ["runin-template", "managing-host"] }),
  };
}

describe("Runin template updates", () => {
  it("shows both versions and updates in the background until readiness is confirmed", async () => {
    const { server, refresh } = mount();
    await expect.element(page.getByText("older-version", { exact: true })).toBeVisible();
    await expect.element(page.getByText("required-version", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Update template", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Updating template...", exact: true }))
      .toBeDisabled();
    expect(server.updates).toBe(1);
    server.status = {
      ...server.status,
      state: "ready",
      currentVersion: "required-version",
      updating: false,
    };
    await refresh();
    await expect.element(page.getByText("Template up to date", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Update template", exact: true }))
      .not.toBeInTheDocument();
  });

  it("offers an initial build when no template exists", async () => {
    mount({ state: "missing", currentVersion: null });
    await expect
      .element(page.getByRole("button", { name: "Build template", exact: true }))
      .toBeEnabled();
    await expect.element(page.getByText("No template yet", { exact: true })).toBeVisible();
  });

  it("shows an ongoing update when the pane is opened again", async () => {
    const { server } = mount({ state: "building", updating: true });
    await expect
      .element(page.getByRole("button", { name: "Updating template...", exact: true }))
      .toBeDisabled();
    expect(server.updates).toBe(0);
  });

  it("replaces stale readiness with an unavailable message after a failed check", async () => {
    const { server, refresh } = mount({ state: "ready", currentVersion: "required-version" });
    await expect.element(page.getByText("Template up to date", { exact: true })).toBeVisible();
    server.error = "SSH unavailable";
    await refresh();
    await expect.element(page.getByText("SSH unavailable", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Template up to date", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Check again", exact: true }))
      .toBeEnabled();
  });

  it("shows a background error and allows retrying the update", async () => {
    const { server, refresh } = mount();
    await page.getByRole("button", { name: "Update template", exact: true }).click();
    server.status = { ...server.status, updating: false, error: "SSH disconnected" };
    await refresh();
    await expect.element(page.getByText("SSH disconnected", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Retry update", exact: true }))
      .toBeEnabled();
  });
});
