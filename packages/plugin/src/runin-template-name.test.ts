import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTemplateNaming,
  templateNameOverride,
  toTemplateName,
} from "../../../plugin-examples/runin/server/template-name";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

describe("runin Template naming", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives a Template name from the tenant", () => {
    expect(toTemplateName("Example Tenant")).toBe("paseo-example-tenant");
    expect(toTemplateName("--Acme_GmbH--")).toBe("paseo-acme-gmbh");
    expect(() => toTemplateName("x".repeat(80))).toThrow(templateNameOverride);
  });

  it("prefers a valid override without asking runin", async () => {
    vi.stubEnv(templateNameOverride, " paseo-shared ");
    const ssh = vi.fn();
    await expect(createTemplateNaming(ssh, new AbortController().signal)()).resolves.toBe(
      "paseo-shared",
    );
    expect(ssh).not.toHaveBeenCalled();
  });

  it("rejects an invalid override", async () => {
    vi.stubEnv(templateNameOverride, "Bad Name");
    await expect(createTemplateNaming(vi.fn(), new AbortController().signal)()).rejects.toThrow(
      templateNameOverride,
    );
  });

  it("asks runin once and asks again after a failure", async () => {
    vi.stubEnv(templateNameOverride, "");
    const ssh = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue(JSON.stringify({ tenant: "Example" }));
    const resolve = createTemplateNaming(ssh, new AbortController().signal);
    await expect(resolve()).rejects.toThrow("connection lost");
    await expect(resolve()).resolves.toBe("paseo-example");
    await expect(resolve()).resolves.toBe("paseo-example");
    expect(ssh.mock.calls).toEqual([
      ["runin.eu", "whoami --json"],
      ["runin.eu", "whoami --json"],
    ]);
  });
});
