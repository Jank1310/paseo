import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemplateManager } from "../../../plugin-examples/runin/server/template-status";
import { templateVersion } from "../../../plugin-examples/runin/server/template";
import { getTemplateStatus } from "../../../plugin-examples/runin/shared/contracts";
import type { Ssh } from "../../../plugin-examples/runin/server/remote";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

const ready = {
  name: "paseo-example",
  version: templateVersion,
  state: "ready",
  golden_state: "ready",
  golden_shapes: ["2x4096", "4x8192", "8x16384"],
  volume_size_bytes: 30 * 1024 ** 3,
};
const manager = (ssh: Ssh, signal = new AbortController().signal) =>
  createTemplateManager(ssh, signal, async () => "paseo-example");

afterEach(() => vi.useRealTimers());

describe("runin Template version checks and updates", () => {
  it.each([
    [[], "missing", null],
    [[{ ...ready, version: "old-version" }], "outdated", "old-version"],
    [[ready], "ready", templateVersion],
    [[{ ...ready, state: "building" }], "building", templateVersion],
    [[{ ...ready, golden_shapes: ["2x4096"] }], "preparing", templateVersion],
    [[{ ...ready, volume_size_bytes: undefined }], "preparing", templateVersion],
    [[{ ...ready, state: "failed", error: "Disk full" }], "failed", templateVersion],
    [[{ ...ready, volume_size_bytes: 10 * 1024 ** 3 }], "failed", templateVersion],
  ])(
    "reports availability without submitting a build: %s",
    async (entries, state, currentVersion) => {
      const commands: string[] = [];
      const templates = manager(async (_target, command) => {
        commands.push(command);
        return JSON.stringify(entries);
      });
      expect(getTemplateStatus.output.parse(await templates.status())).toMatchObject({
        name: "paseo-example",
        expectedVersion: templateVersion,
        currentVersion,
        state,
        updating: false,
      });
      expect(
        commands.every(
          (command) =>
            command === "template ls --json" ||
            command === "template versions paseo-example --json",
        ),
      ).toBe(true);
    },
  );

  it("finds the bundled version even when another version is listed first", async () => {
    const templates = manager(async (_target, command) =>
      JSON.stringify(
        command === "template ls --json" ? [{ ...ready, version: "another-version" }] : [ready],
      ),
    );
    expect(await templates.status()).toMatchObject({
      state: "ready",
      currentVersion: templateVersion,
    });
  });

  it("shares cached reads, expires them, and rejects failed reads instead of claiming readiness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    let reads = 0;
    const templates = manager(async () => {
      if (++reads > 1) throw new Error("SSH unavailable");
      return JSON.stringify([ready]);
    });
    const statuses = await Promise.all([templates.status(), templates.status()]);
    expect(statuses[0]).toEqual(statuses[1]);
    expect(reads).toBe(1);
    vi.setSystemTime(31_001);
    await expect(templates.status()).rejects.toThrow("SSH unavailable");
    await expect(templates.status()).rejects.toThrow("SSH unavailable");
    expect(reads).toBe(2);
  });

  it("shares preparation with Machine creation and repeated update clicks without creating a Machine", async () => {
    const commands: string[] = [];
    let built = false;
    const templates = manager(async (_target, command) => {
      commands.push(command);
      if (command.startsWith("template build")) {
        built = true;
        return "{}";
      }
      if (command === "template ls --json") return JSON.stringify(built ? [ready] : []);
      throw new Error(`Unexpected command: ${command}`);
    });
    expect((await templates.status()).state).toBe("missing");
    expect(templates.update()).toEqual({ updating: true });
    expect(templates.update()).toEqual({ updating: true });
    await Promise.all([templates.prepare("small"), templates.settle()]);
    expect(commands.filter((command) => command.startsWith("template build"))).toHaveLength(1);
    expect(await templates.status()).toMatchObject({
      state: "ready",
      updating: false,
      error: null,
    });
  });

  it("prepares every standard size before reporting the update complete", async () => {
    const goldenShapes = ["2x4096"];
    const prepared: string[] = [];
    const templates = manager(async (_target, command) => {
      if (command === "template ls --json")
        return JSON.stringify([{ ...ready, golden_shapes: [...goldenShapes] }]);
      if (command.includes("--size medium")) {
        prepared.push("medium");
        goldenShapes.push("4x8192");
      } else if (command.includes("--size large")) {
        prepared.push("large");
        goldenShapes.push("8x16384");
      } else throw new Error(`Unexpected command: ${command}`);
      return "{}";
    });
    templates.update();
    await templates.settle();
    expect(prepared).toEqual(["medium", "large"]);
    expect(await templates.status()).toMatchObject({ state: "ready", updating: false });
  });

  it("retains an uncertain build error and never resubmits it on retry", async () => {
    let builds = 0;
    const templates = manager(async (_target, command) => {
      if (command.startsWith("template build")) {
        builds++;
        throw new Error("SSH disconnected");
      }
      return "[]";
    });
    templates.update();
    await templates.settle();
    expect(await templates.status()).toMatchObject({ updating: false, error: "SSH disconnected" });
    templates.update();
    await templates.settle();
    expect(builds).toBe(1);
    expect((await templates.status()).error).toContain("will not resubmit");
  });

  it("does not accept an update after plugin cleanup", () => {
    const lifetime = new AbortController();
    const templates = manager(async () => "[]", lifetime.signal);
    lifetime.abort();
    expect(() => templates.update()).toThrow("canceled");
  });
});
