import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobSchema, listMachineStates } from "../../../plugin-examples/runin/shared/contracts";
import { createMachineStatus } from "../../../plugin-examples/runin/server/status";

function job(machineId: string | null) {
  return jobSchema.parse({
    requestId: "request-1234",
    name: "Example",
    size: "small",
    machineId,
    creationSubmitted: true,
    phase: machineId ? "ready" : "creating",
    error: null,
  });
}

describe("runin Machine status", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
  });
  afterEach(() => vi.useRealTimers());

  it("does not read runin when there are no known Machine IDs", async () => {
    const ssh = vi.fn(async () => "[]");
    const status = createMachineStatus(ssh, new AbortController().signal, () => [job(null)]);
    expect(listMachineStates.output.parse(await status())).toEqual({ checkedAt: null, states: [] });
    expect(ssh).not.toHaveBeenCalled();
  });

  it("reports current phases only for known Machines and marks missing Machines", async () => {
    const ssh = vi.fn(async () =>
      JSON.stringify([
        { id: "m-running", phase: "running", metadata: { name: "Renamed" } },
        { id: "m-paused", phase: "paused" },
        { id: "m-destroyed", phase: "destroyed" },
        { id: "m-unrelated", phase: "running" },
      ]),
    );
    const status = createMachineStatus(ssh, new AbortController().signal, () =>
      ["m-running", "m-paused", "m-destroyed", "m-missing", "m-running"].map(job),
    );
    expect(listMachineStates.output.parse(await status())).toEqual({
      checkedAt: 1_000,
      states: [
        { machineId: "m-running", phase: "running" },
        { machineId: "m-paused", phase: "paused" },
        { machineId: "m-destroyed", phase: "destroyed" },
        { machineId: "m-missing", phase: "not_found" },
      ],
    });
    expect(ssh.mock.calls).toEqual([["runin.eu", "ls --all --json"]]);
  });

  it("caches successful account reads for 30 seconds and refreshes phases afterward", async () => {
    const ssh = vi
      .fn(async () => JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "paused" }]));
    const status = createMachineStatus(ssh, new AbortController().signal, () => [job("m-example")]);
    const first = await status();
    vi.setSystemTime(30_999);
    expect(await status()).toEqual(first);
    expect(ssh).toHaveBeenCalledTimes(1);
    vi.setSystemTime(31_000);
    expect(await status()).toEqual({
      checkedAt: 31_000,
      states: [{ machineId: "m-example", phase: "running" }],
    });
    expect(ssh).toHaveBeenCalledTimes(2);
  });

  it("coalesces pending reads even when the read lasts longer than the cache duration", async () => {
    let resolveRead: ((raw: string) => void) | undefined;
    const ssh = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const status = createMachineStatus(ssh, new AbortController().signal, () => [job("m-example")]);
    const first = status();
    vi.setSystemTime(61_000);
    const second = status();
    expect(ssh).toHaveBeenCalledTimes(1);
    if (!resolveRead) throw new Error("SSH read did not start");
    resolveRead(JSON.stringify([{ id: "m-example", phase: "starting" }]));
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].checkedAt).toBe(61_000);
    vi.setSystemTime(90_999);
    expect(await status()).toEqual(results[0]);
    expect(ssh).toHaveBeenCalledTimes(1);
  });

  it("filters the cached account snapshot against the current jobs on every call", async () => {
    let jobs = [job("m-first")];
    const ssh = vi.fn(async () =>
      JSON.stringify([
        { id: "m-first", phase: "running" },
        { id: "m-second", phase: "paused" },
      ]),
    );
    const status = createMachineStatus(ssh, new AbortController().signal, () => jobs);
    await status();
    jobs = [job("m-second")];
    expect(await status()).toEqual({
      checkedAt: 1_000,
      states: [{ machineId: "m-second", phase: "paused" }],
    });
    jobs = [];
    expect(await status()).toEqual({ checkedAt: null, states: [] });
    expect(ssh).toHaveBeenCalledTimes(1);
  });

  it("caches failed reads without returning stale success and recovers after 30 seconds", async () => {
    const failure = new Error("SSH connection failed");
    const ssh = vi
      .fn(async () => JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockRejectedValueOnce(failure);
    const status = createMachineStatus(ssh, new AbortController().signal, () => [job("m-example")]);
    await status();
    vi.setSystemTime(31_000);
    await expect(status()).rejects.toBe(failure);
    vi.setSystemTime(60_999);
    await expect(status()).rejects.toBe(failure);
    expect(ssh).toHaveBeenCalledTimes(2);
    vi.setSystemTime(61_000);
    expect((await status()).checkedAt).toBe(61_000);
    expect(ssh).toHaveBeenCalledTimes(3);
  });

  it.each([
    "not JSON",
    JSON.stringify({ machines: [] }),
    JSON.stringify([{ id: "evil@other-host", phase: "running" }]),
    JSON.stringify([{ id: "m-example", phase: 42 }]),
    JSON.stringify([{ id: "m-example", phase: "" }]),
  ])("rejects malformed account status and caches the rejection: %s", async (raw) => {
    const ssh = vi.fn(async () => raw);
    const status = createMachineStatus(ssh, new AbortController().signal, () => [job("m-example")]);
    await expect(status()).rejects.toThrow();
    await expect(status()).rejects.toThrow();
    expect(ssh).toHaveBeenCalledTimes(1);
  });

  it("does not start an SSH read after plugin cleanup", async () => {
    const lifetime = new AbortController();
    lifetime.abort();
    const ssh = vi.fn(async () => "[]");
    const status = createMachineStatus(ssh, lifetime.signal, () => [job("m-example")]);
    await expect(status()).rejects.toThrow("canceled");
    expect(ssh).not.toHaveBeenCalled();
  });
});
