import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createRemote } from "../../../plugin-examples/runin/server/remote";
import { bootstrap } from "../../../plugin-examples/runin/server/bootstrap";
import { templateVersion } from "../../../plugin-examples/runin/server/template";

const whoami = JSON.stringify({ tenant: "Example Tenant" });

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

describe("runin remote boundary", () => {
  it("creates a Machine using the exact prepared Template version and validates its returned ID", async () => {
    const calls: unknown[] = [];
    const remote = createRemote(async (target, command) => {
      calls.push({ target, command });
      if (command === "whoami --json") return whoami;
      return JSON.stringify({ id: "m-example", phase: "starting" });
    }, new AbortController().signal);
    await expect(remote.create("paseo-request-1234", "small")).resolves.toBe("m-example");
    expect(calls).toEqual([
      { target: "runin.eu", command: "whoami --json" },
      {
        target: "runin.eu",
        command: `new --name paseo-request-1234 --size small --template paseo-example-tenant --version ${templateVersion} --wait 0 --json`,
      },
    ]);
    await expect(remote.create("bad;whoami", "small")).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("rejects malformed Machine IDs before using them as SSH destinations", async () => {
    const calls: string[] = [];
    const remote = createRemote(async (target, command) => {
      if (command === "whoami --json") return whoami;
      calls.push(target);
      return JSON.stringify({ id: "-oProxyCommand=bad" });
    }, new AbortController().signal);
    await expect(remote.create("paseo-request-1234", "small")).rejects.toThrow();
    await expect(remote.install("evil@other-host")).rejects.toThrow();
    await expect(remote.wait("-oProxyCommand=bad")).rejects.toThrow();
    await expect(remote.remove("m-example; rm other")).rejects.toThrow();
    expect(calls).toEqual(["runin.eu"]);
  });

  it("finds only the exact creation name and refuses destroyed Machines", async () => {
    const remote = createRemote(
      async () =>
        JSON.stringify([
          { id: "m-other", phase: "running", metadata: { name: "other" } },
          { id: "m-found", phase: "destroyed", metadata: { name: "paseo-request-1234" } },
        ]),
      new AbortController().signal,
    );
    await expect(remote.find("missing-name")).resolves.toBeNull();
    await expect(remote.find("paseo-request-1234")).rejects.toThrow("destroyed");
    await expect(remote.find("paseo-request-1234", true)).resolves.toBe("m-found");
  });

  it("refuses an ambiguous creation name rather than choosing a Machine", async () => {
    const remote = createRemote(
      async () =>
        JSON.stringify([
          { id: "m-first", phase: "running", metadata: { name: "paseo-request-1234" } },
          { id: "m-second", phase: "running", metadata: { name: "paseo-request-1234" } },
        ]),
      new AbortController().signal,
    );
    await expect(remote.find("paseo-request-1234")).rejects.toThrow("More than one Machine");
  });

  it("does not treat a failed Machine as ready", async () => {
    const remote = createRemote(
      async () => JSON.stringify({ id: "m-example", phase: "failed" }),
      new AbortController().signal,
    );
    await expect(remote.wait("m-example")).rejects.toThrow("is failed");
  });

  it("rejects status for a different Machine", async () => {
    const remote = createRemote(
      async () => JSON.stringify({ id: "m-other", phase: "running" }),
      new AbortController().signal,
    );
    await expect(remote.wait("m-example")).rejects.toThrow("while checking m-example");
  });

  it("starts the baked daemon and accepts verified reachability", async () => {
    const calls: unknown[] = [];
    const remote = createRemote(async (target, command, stdin) => {
      calls.push({ target, command, stdin });
      return JSON.stringify({ localDaemon: "running", connectedDaemon: "reachable" });
    }, new AbortController().signal);
    await expect(remote.install("m-example")).resolves.toBeUndefined();
    expect(calls).toEqual([{ target: "m-example@runin.eu", command: "sh -se", stdin: bootstrap }]);
  });

  it.each(["unreachable", "not_probed", "auth_required"])(
    "rejects a running process whose daemon status is %s",
    async (connectedDaemon) => {
      const remote = createRemote(
        async () => JSON.stringify({ localDaemon: "running", connectedDaemon }),
        new AbortController().signal,
      );
      await expect(remote.install("m-example")).rejects.toThrow("not reachable");
    },
  );

  it("reports invalid daemon JSON with the Machine's setup log", async () => {
    const remote = createRemote(async () => "service enabled\n", new AbortController().signal);
    await expect(remote.install("m-example")).rejects.toThrow("invalid status JSON on m-example");
  });

  it("polls Machine startup below the management key command limit", async () => {
    vi.mocked(delay).mockClear();
    let reads = 0;
    const remote = createRemote(async () => {
      reads++;
      return JSON.stringify({ id: "m-example", phase: reads === 1 ? "starting" : "running" });
    }, new AbortController().signal);
    await remote.wait("m-example");
    expect(vi.mocked(delay).mock.calls.map(([milliseconds]) => milliseconds)).toEqual([5000]);
  });

  it("retries only explicit rate limits for Machine discovery", async () => {
    let reads = 0;
    const remote = createRemote(async () => {
      reads++;
      if (reads === 1)
        throw new Error("runin.eu: too many commands from this key; try again in 0s");
      return JSON.stringify([
        { id: "m-example", phase: "running", metadata: { name: "paseo-request-1234" } },
      ]);
    }, new AbortController().signal);
    await expect(remote.find("paseo-request-1234")).resolves.toBe("m-example");
    expect(reads).toBe(2);
  });

  it("never replays Machine creation when runin rate limits the command", async () => {
    let creations = 0;
    const rejection = new Error("runin.eu: too many commands from this key; try again in 0s");
    const remote = createRemote(async (_target, command) => {
      if (command === "whoami --json") return whoami;
      creations++;
      throw rejection;
    }, new AbortController().signal);
    await expect(remote.create("paseo-request-1234", "small")).rejects.toBe(rejection);
    expect(creations).toBe(1);
  });
});

describe("runin Machine removal", () => {
  it("checks the exact ID and confirms destruction after a single submission", async () => {
    const ssh = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          { id: "m-other", phase: "running", metadata: { name: "same-name" } },
          { id: "m-example", phase: "running", metadata: { name: "same-name" } },
        ]),
      )
      .mockResolvedValueOnce('{"accepted":true}')
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "destroying" }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "destroyed" }]));
    const remote = createRemote(ssh, new AbortController().signal);
    await expect(remote.remove("m-example")).resolves.toBeUndefined();
    expect(ssh.mock.calls).toEqual([
      ["runin.eu", "ls --all --json"],
      ["runin.eu", "rm m-example --wait 0 --json"],
      ["runin.eu", "ls --all --json"],
      ["runin.eu", "ls --all --json"],
    ]);
  });

  it.each([{ machines: [] }, { machines: [{ id: "m-example", phase: "destroyed" }] }])(
    "does not submit removal when a successful list already confirms deletion: $machines",
    async ({ machines }) => {
      const ssh = vi.fn().mockResolvedValue(JSON.stringify(machines));
      await expect(
        createRemote(ssh, new AbortController().signal).remove("m-example"),
      ).resolves.toBeUndefined();
      expect(ssh).toHaveBeenCalledTimes(1);
    },
  );

  it("confirms absence only after a successfully parsed account list", async () => {
    const ssh = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockResolvedValueOnce('{"accepted":true}')
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-other", phase: "running" }]));
    await expect(
      createRemote(ssh, new AbortController().signal).remove("m-example"),
    ).resolves.toBeUndefined();
    expect(ssh).toHaveBeenCalledTimes(3);
  });

  it("checks state on retry and does not resubmit a deletion already in progress", async () => {
    const lostReply = new Error("SSH connection lost after submission");
    const ssh = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockRejectedValueOnce(lostReply)
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "destroying" }]))
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "destroyed" }]));
    const remote = createRemote(ssh, new AbortController().signal);
    await expect(remote.remove("m-example")).rejects.toBe(lostReply);
    await expect(remote.remove("m-example")).resolves.toBeUndefined();
    expect(ssh.mock.calls.filter(([, command]) => command.startsWith("rm "))).toHaveLength(1);
  });

  it.each(["not JSON", "null", '{"machines":[]}', '[{"id":"m-example"}]'])(
    "rejects an invalid initial account list without submitting deletion: %s",
    async (response) => {
      const ssh = vi.fn().mockResolvedValue(response);
      await expect(
        createRemote(ssh, new AbortController().signal).remove("m-example"),
      ).rejects.toThrow();
      expect(ssh).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects ambiguous duplicate IDs without submitting deletion", async () => {
    const ssh = vi.fn().mockResolvedValue(
      JSON.stringify([
        { id: "m-example", phase: "running" },
        { id: "m-example", phase: "destroyed" },
      ]),
    );
    await expect(
      createRemote(ssh, new AbortController().signal).remove("m-example"),
    ).rejects.toThrow("More than one");
    expect(ssh).toHaveBeenCalledTimes(1);
  });

  it("does not treat a failed confirmation read as absence or replay the mutation", async () => {
    const failure = new Error("account status unavailable");
    const ssh = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockResolvedValueOnce('{"accepted":true}')
      .mockRejectedValueOnce(failure);
    await expect(createRemote(ssh, new AbortController().signal).remove("m-example")).rejects.toBe(
      failure,
    );
    expect(ssh.mock.calls.filter(([, command]) => command.startsWith("rm "))).toHaveLength(1);
  });

  it("rejects malformed confirmation JSON rather than accepting the removal response", async () => {
    const ssh = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockResolvedValueOnce('{"accepted":true}')
      .mockResolvedValueOnce("not JSON");
    await expect(
      createRemote(ssh, new AbortController().signal).remove("m-example"),
    ).rejects.toThrow();
  });

  it("keeps unconfirmed destruction retryable after a bounded number of status checks", async () => {
    vi.mocked(delay).mockClear();
    const ssh = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{ id: "m-example", phase: "destroying" }]));
    await expect(
      createRemote(ssh, new AbortController().signal).remove("m-example"),
    ).rejects.toThrow("Retry removal");
    expect(ssh).toHaveBeenCalledTimes(5);
    expect(vi.mocked(delay).mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      5000, 5000, 5000,
    ]);
  });

  it("does not submit deletion if cancellation arrives during the initial state read", async () => {
    const lifetime = new AbortController();
    const ssh = vi.fn(async () => {
      lifetime.abort();
      return JSON.stringify([{ id: "m-example", phase: "running" }]);
    });
    await expect(createRemote(ssh, lifetime.signal).remove("m-example")).rejects.toThrow();
    expect(ssh).toHaveBeenCalledTimes(1);
  });

  it("does not submit deletion after a failed initial state read", async () => {
    const failure = new Error("account status unavailable");
    const ssh = vi.fn().mockRejectedValue(failure);
    await expect(createRemote(ssh, new AbortController().signal).remove("m-example")).rejects.toBe(
      failure,
    );
    expect(ssh).toHaveBeenCalledTimes(1);
  });

  it("retries an explicit read rate limit and submits deletion only once", async () => {
    const rateLimit = new Error("runin.eu: too many commands from this key; try again in 0s");
    const ssh = vi
      .fn()
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockResolvedValueOnce('{"accepted":true}')
      .mockResolvedValueOnce("[]");
    await expect(
      createRemote(ssh, new AbortController().signal).remove("m-example"),
    ).resolves.toBeUndefined();
    expect(ssh.mock.calls.map(([, command]) => command)).toEqual([
      "ls --all --json",
      "ls --all --json",
      "rm m-example --wait 0 --json",
      "ls --all --json",
    ]);
  });

  it("does not replay a rate-limited deletion command", async () => {
    const rateLimit = new Error("runin.eu: too many commands from this key; try again in 0s");
    const ssh = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: "m-example", phase: "running" }]))
      .mockRejectedValueOnce(rateLimit);
    await expect(createRemote(ssh, new AbortController().signal).remove("m-example")).rejects.toBe(
      rateLimit,
    );
    expect(ssh).toHaveBeenCalledTimes(2);
  });

  it("does not submit deletion if the polling deadline expires during the initial read", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const ssh = vi.fn(async () => {
      now.mockReturnValue(20_000);
      return JSON.stringify([{ id: "m-example", phase: "running" }]);
    });
    try {
      await expect(
        createRemote(ssh, new AbortController().signal).remove("m-example"),
      ).rejects.toThrow("Retry removal");
      expect(ssh).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });
});
