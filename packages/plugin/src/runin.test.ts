import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Provisioning } from "../../../plugin-examples/runin/server/provisioning";
import contribute from "../../../plugin-examples/runin/index.server";

const folders: string[] = [];
const pluginCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of pluginCleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(install: () => Promise<void> = async () => {}) {
  const folder = mkdtempSync(join(tmpdir(), "paseo-runin-"));
  folders.push(folder);
  const path = join(folder, "jobs.json");
  const machines = new Map<string, string>();
  const installations: string[] = [];
  const remote = {
    async prepare() {},
    async create(name: string) {
      machines.set(name, "m-example");
      return "m-example";
    },
    async find(name: string) {
      return machines.get(name) ?? null;
    },
    async wait() {},
    async install(id: string) {
      installations.push(id);
      await install();
    },
    async remove(_id: string) {},
  };
  return { path, machines, installations, remote };
}
function pluginHome() {
  const h = setup();
  const home = join(h.path, "..", "home");
  vi.stubEnv("PASEO_HOME", home);
  return {
    home,
    journal: join(home, "runin", "runin", "jobs.json"),
  };
}

function server(handle: () => void = () => {}) {
  return {
    handle,
    registerProvider() {},
    registerSettings() {
      throw new Error("Unexpected settings registration");
    },
    on() {
      throw new Error("Unexpected lifecycle registration");
    },
    before() {
      throw new Error("Unexpected lifecycle registration");
    },
  };
}

function startPlugin() {
  const cleanup = contribute(server());
  pluginCleanups.push(cleanup);
  return cleanup;
}

const input = { requestId: "request-1234", name: "My project", size: "small" as const };

describe("runin removal", () => {
  it("keeps the card visible until confirmed deletion, coalesces calls and blocks stale setup requests", async () => {
    const h = setup();
    let confirmDeletion: (() => void) | undefined;
    const deletion = new Promise<void>((resolve) => {
      confirmDeletion = resolve;
    });
    h.remote.remove = vi.fn(async () => deletion);
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    const first = jobs.remove(input.requestId);
    const second = jobs.remove(input.requestId);
    expect(first).toBe(second);
    expect(h.remote.remove).toHaveBeenCalledExactlyOnceWith("m-example");
    expect(jobs.list()[0]).toMatchObject({ removalRequested: true, error: null });
    expect(JSON.parse(readFileSync(h.path, "utf8"))[0].removalRequested).toBe(true);
    expect(() => jobs.retry(input.requestId)).toThrow("marked for removal");
    expect(() => jobs.create(input)).toThrow("marked for removal");
    if (!confirmDeletion) throw new Error("Missing deletion confirmation");
    confirmDeletion();
    await expect(first).resolves.toEqual({ requestId: input.requestId });
    expect(jobs.list()).toEqual([]);
    const reloaded = new Provisioning(h.path, h.remote);
    expect(reloaded.list()).toEqual([]);
    expect(() => reloaded.create(input)).toThrow("marked for removal");
    expect(() => reloaded.retry(input.requestId)).toThrow("marked for removal");
    await expect(reloaded.remove(input.requestId)).resolves.toEqual({ requestId: input.requestId });
    expect(h.remote.remove).toHaveBeenCalledTimes(1);
    expect(h.installations).toEqual(["m-example"]);
  });

  it("keeps a failed removal visible across reload and permits only removal to retry", async () => {
    const h = setup();
    const failure = new Error("runin could not delete the Machine");
    h.remote.remove = vi.fn(async () => {
      throw failure;
    });
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    await expect(jobs.remove(input.requestId)).rejects.toBe(failure);
    expect(jobs.list()[0]).toMatchObject({
      machineId: "m-example",
      removalRequested: true,
      removed: false,
      phase: "failed",
      error: failure.message,
    });
    const reloaded = new Provisioning(h.path, h.remote);
    expect(reloaded.list()).toEqual(jobs.list());
    expect(() => reloaded.retry(input.requestId)).toThrow("marked for removal");
    h.remote.remove = vi.fn(async () => {});
    await reloaded.remove(input.requestId);
    expect(h.remote.remove).toHaveBeenCalledExactlyOnceWith("m-example");
    expect(reloaded.list()).toEqual([]);
  });

  it("rejects removal while setup or retry is active without persisting removal intent", async () => {
    const h = setup();
    let continuePrepare: (() => void) | undefined;
    h.remote.prepare = async () =>
      new Promise<void>((resolve) => {
        continuePrepare = resolve;
      });
    h.remote.remove = vi.fn(async () => {});
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await expect(jobs.remove(input.requestId)).rejects.toThrow("Setup is still running");
    expect(jobs.list()[0].removalRequested).toBeUndefined();
    if (!continuePrepare) throw new Error("Template preparation did not start");
    continuePrepare();
    h.remote.install = async () => {
      throw new Error("Install failed");
    };
    await jobs.settle();
    let continueInstall: (() => void) | undefined;
    h.remote.install = async () =>
      new Promise<void>((resolve) => {
        continueInstall = resolve;
      });
    jobs.retry(input.requestId);
    await expect(jobs.remove(input.requestId)).rejects.toThrow("Setup is still running");
    await vi.waitFor(() => expect(continueInstall).toBeDefined());
    if (!continueInstall) throw new Error("Retry did not start");
    continueInstall();
    await jobs.settle();
    expect(jobs.list()[0].removalRequested).toBeUndefined();
    expect(h.remote.remove).not.toHaveBeenCalled();
  });

  it("recovers an interrupted removal without resuming setup or losing the saved Machine", async () => {
    const h = setup();
    writeFileSync(
      h.path,
      JSON.stringify([
        {
          ...input,
          machineId: "m-existing",
          creationSubmitted: true,
          phase: "ready",
          error: null,
          removalRequested: true,
        },
      ]),
    );
    h.remote.remove = vi.fn(async () => {});
    const jobs = new Provisioning(h.path, h.remote);
    expect(jobs.list()[0]).toMatchObject({ removalRequested: true, phase: "failed" });
    expect(jobs.list()[0].error).toContain("Removal was interrupted");
    expect(h.remote.remove).not.toHaveBeenCalled();
    expect(() => jobs.retry(input.requestId)).toThrow("marked for removal");
    await jobs.remove(input.requestId);
    expect(h.remote.remove).toHaveBeenCalledExactlyOnceWith("m-existing");
    expect(h.installations).toEqual([]);
  });

  it("reconciles an ambiguous submitted creation before deletion and never forgets an unresolved creation", async () => {
    const h = setup();
    const find = vi.spyOn(h.remote, "find");
    h.remote.create = async () => {
      throw new Error("SSH response lost");
    };
    h.remote.remove = vi.fn(async () => {});
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    await expect(jobs.remove(input.requestId)).rejects.toThrow("Creation may still be pending");
    expect(find).toHaveBeenCalledExactlyOnceWith(`paseo-${input.requestId}`, true);
    expect(jobs.list()[0]).toMatchObject({
      machineId: null,
      removalRequested: true,
      removed: false,
    });
    expect(h.remote.remove).not.toHaveBeenCalled();
    h.machines.set(`paseo-${input.requestId}`, "m-recovered");
    const reloaded = new Provisioning(h.path, h.remote);
    await reloaded.remove(input.requestId);
    expect(h.remote.remove).toHaveBeenCalledExactlyOnceWith("m-recovered");
    expect(JSON.parse(readFileSync(h.path, "utf8"))[0].machineId).toBe("m-recovered");
    expect(reloaded.list()).toEqual([]);
  });

  it("removes a failed setup before any creation was submitted without deleting a VM", async () => {
    const h = setup();
    h.remote.prepare = async () => {
      throw new Error("Template unavailable");
    };
    h.remote.find = vi.fn(async () => null);
    h.remote.remove = vi.fn(async () => {});
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    await jobs.remove(input.requestId);
    expect(jobs.list()).toEqual([]);
    expect(h.remote.find).not.toHaveBeenCalled();
    expect(h.remote.remove).not.toHaveBeenCalled();
    expect(() => new Provisioning(h.path, h.remote).create(input)).toThrow("marked for removal");
  });

  it("retains a visible removal intent after deletion succeeds but the tombstone cannot be saved", async () => {
    const h = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    h.remote.remove = vi.fn(async () => {
      mkdirSync(`${h.path}.tmp`);
    });
    await expect(jobs.remove(input.requestId)).rejects.toThrow();
    expect(h.remote.remove).toHaveBeenCalledExactlyOnceWith("m-example");
    expect(jobs.list()[0]).toMatchObject({
      removalRequested: true,
      removed: false,
      phase: "failed",
    });
    expect(jobs.list()[0].error).toContain("could not be saved");
    expect(JSON.parse(readFileSync(h.path, "utf8"))[0]).toMatchObject({ removalRequested: true });
    rmSync(`${h.path}.tmp`, { recursive: true });
    const reloaded = new Provisioning(h.path, h.remote);
    expect(reloaded.list()[0]).toMatchObject({ removalRequested: true, machineId: "m-example" });
    expect(() => reloaded.retry(input.requestId)).toThrow("marked for removal");
    h.remote.remove = vi.fn(async () => {});
    await reloaded.remove(input.requestId);
    expect(h.remote.remove).toHaveBeenCalledExactlyOnceWith("m-example");
    expect(reloaded.list()).toEqual([]);
  });

  it("does not delete before removal intent can be saved", async () => {
    const h = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.remote.remove = vi.fn(async () => {});
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    mkdirSync(`${h.path}.tmp`);
    await expect(jobs.remove(input.requestId)).rejects.toThrow();
    expect(h.remote.remove).not.toHaveBeenCalled();
    expect(jobs.list()[0]).toMatchObject({ removalRequested: true, phase: "failed" });
    expect(() => jobs.retry(input.requestId)).toThrow("marked for removal");
    rmSync(`${h.path}.tmp`, { recursive: true });
    await jobs.remove(input.requestId);
    expect(h.remote.remove).toHaveBeenCalledTimes(1);
    expect(jobs.list()).toEqual([]);
  });
});

describe("runin provisioning", () => {
  it("persists a ready Machine and treats a repeated request as the same operation", async () => {
    const h = setup();
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    jobs.create(input);
    await vi.waitFor(() => expect(jobs.list()[0].phase).toBe("ready"));
    expect(h.machines.size).toBe(1);
    expect(h.installations).toEqual(["m-example"]);
    expect(JSON.parse(readFileSync(h.path, "utf8"))).toEqual([
      { ...input, machineId: "m-example", creationSubmitted: true, phase: "ready", error: null },
    ]);
  });

  it("recovers a creation whose SSH response was lost without creating another Machine", async () => {
    const h = setup();
    let creations = 0;
    h.remote.create = async (name) => {
      creations++;
      h.machines.set(name, "m-recovered");
      throw new Error("SSH disconnected");
    };
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    expect(jobs.list()[0].phase).toBe("failed");
    jobs.retry(input.requestId);
    await jobs.settle();
    expect(jobs.list()[0]).toEqual({
      ...input,
      machineId: "m-recovered",
      creationSubmitted: true,
      phase: "ready",
      error: null,
    });
    expect(creations).toBe(1);
    expect(h.installations).toEqual(["m-recovered"]);
  });

  it("retries installation after reload on the saved Machine", async () => {
    let fail = true;
    const h = setup(async () => {
      if (fail) throw new Error("Package download failed");
    });
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    expect(jobs.list()[0].error).toBe("Package download failed");
    fail = false;
    const reloaded = new Provisioning(h.path, h.remote);
    reloaded.retry(input.requestId);
    reloaded.retry(input.requestId);
    await reloaded.settle();
    expect(reloaded.list()[0].phase).toBe("ready");
    expect(h.machines.size).toBe(1);
    expect(h.installations).toEqual(["m-example", "m-example"]);
  });

  it("keeps ambiguous creation failed if reconciliation cannot find a Machine", async () => {
    const h = setup();
    let creations = 0;
    h.remote.create = async () => {
      creations++;
      throw new Error("SSH timeout");
    };
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    jobs.retry(input.requestId);
    await jobs.settle();
    expect(jobs.list()[0].phase).toBe("failed");
    expect(jobs.list()[0].error).toContain("will not submit another creation");
    expect(creations).toBe(1);
    expect(h.installations).toEqual([]);
  });

  it("rejects conflicting repeated requests and invalid form input before creating a Machine", async () => {
    const h = setup();
    const jobs = new Provisioning(h.path, h.remote);
    expect(() => jobs.create({ ...input, name: "$(whoami)" })).toThrow();
    expect(h.machines.size).toBe(0);
    jobs.create(input);
    expect(() => jobs.create({ ...input, size: "large" })).toThrow("different Machine");
    await jobs.settle();
  });

  it("allows a failed Template setup to retry before any Machine creation is submitted", async () => {
    const h = setup();
    let unavailable = true;
    h.remote.prepare = async () => {
      if (unavailable) throw new Error("Template build in progress");
    };
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    expect(jobs.list()[0]).toEqual({
      ...input,
      machineId: null,
      creationSubmitted: false,
      phase: "failed",
      error: "Template build in progress",
    });
    expect(h.machines.size).toBe(0);
    unavailable = false;
    jobs.retry(input.requestId);
    await jobs.settle();
    expect(jobs.list()[0].phase).toBe("ready");
    expect(h.machines.size).toBe(1);
  });

  it("recovers an interrupted installation and retains its Machine ID across restart", async () => {
    const h = setup();
    writeFileSync(
      h.path,
      JSON.stringify([
        {
          ...input,
          machineId: "m-existing",
          creationSubmitted: true,
          phase: "installing",
          error: null,
        },
      ]),
    );
    const jobs = new Provisioning(h.path, h.remote);
    expect(jobs.list()[0].phase).toBe("failed");
    expect(jobs.list()[0].error).toContain("interrupted");
    jobs.retry(input.requestId);
    await jobs.settle();
    expect(jobs.list()[0].phase).toBe("ready");
    expect(h.machines.size).toBe(0);
    expect(h.installations).toEqual(["m-existing"]);
  });

  it("retains a created Machine when saving its ID fails and handles the background rejection", async () => {
    const h = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let creations = 0;
    h.remote.create = async (name) => {
      creations++;
      h.machines.set(name, "m-created");
      mkdirSync(`${h.path}.tmp`);
      return "m-created";
    };
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await expect(jobs.settle()).resolves.toBeUndefined();
    expect(jobs.list()[0]).toMatchObject({
      machineId: "m-created",
      creationSubmitted: true,
      phase: "failed",
    });
    expect(jobs.list()[0].error).toContain("could not be saved");
    expect(logged).toHaveBeenCalled();
    expect(JSON.parse(readFileSync(h.path, "utf8"))[0].creationSubmitted).toBe(true);
    rmSync(`${h.path}.tmp`, { recursive: true });
    jobs.retry(input.requestId);
    await jobs.settle();
    expect(jobs.list()[0].phase).toBe("ready");
    expect(creations).toBe(1);
    expect(h.installations).toEqual(["m-created"]);
  });

  it("leaves an initial journal failure retryable without submitting a Machine creation", async () => {
    const h = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const jobs = new Provisioning(h.path, h.remote);
    mkdirSync(`${h.path}.tmp`);
    expect(() => jobs.create(input)).toThrow();
    await jobs.settle();
    expect(jobs.list()[0]).toMatchObject({
      phase: "failed",
      creationSubmitted: false,
      machineId: null,
    });
    expect(jobs.list()[0].error).toContain("could not be saved");
    expect(h.machines.size).toBe(0);
    expect(JSON.parse(readFileSync(h.path, "utf8"))).toEqual([]);
    rmSync(`${h.path}.tmp`, { recursive: true });
    jobs.retry(input.requestId);
    await jobs.settle();
    expect(jobs.list()[0].phase).toBe("ready");
    expect(h.machines.size).toBe(1);
    expect(h.installations).toEqual(["m-example"]);
  });

  it("keeps a retry journal failure failed and retries the existing Machine after repair", async () => {
    let unavailable = true;
    const h = setup(async () => {
      if (unavailable) throw new Error("Package download failed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await jobs.settle();
    mkdirSync(`${h.path}.tmp`);
    expect(() => jobs.retry(input.requestId)).toThrow();
    await jobs.settle();
    expect(jobs.list()[0]).toMatchObject({
      phase: "failed",
      creationSubmitted: true,
      machineId: "m-example",
    });
    expect(jobs.list()[0].error).toContain("could not be saved");
    expect(h.installations).toEqual(["m-example"]);
    rmSync(`${h.path}.tmp`, { recursive: true });
    unavailable = false;
    jobs.retry(input.requestId);
    await jobs.settle();
    expect(jobs.list()[0].phase).toBe("ready");
    expect(h.machines.size).toBe(1);
    expect(h.installations).toEqual(["m-example", "m-example"]);
  });

  it("keeps an installation failure visible when persisting the failure also fails", async () => {
    const h = setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.remote.install = async () => {
      mkdirSync(`${h.path}.tmp`);
      throw new Error("Package download failed");
    };
    const jobs = new Provisioning(h.path, h.remote);
    jobs.create(input);
    await expect(jobs.settle()).resolves.toBeUndefined();
    expect(jobs.list()[0].phase).toBe("failed");
    expect(jobs.list()[0].error).toContain("Package download failed");
    expect(jobs.list()[0].error).toContain("could not be saved");
    expect(logged).toHaveBeenCalled();
    rmSync(`${h.path}.tmp`, { recursive: true });
    h.remote.install = async () => {};
    const reloaded = new Provisioning(h.path, h.remote);
    reloaded.retry(input.requestId);
    await reloaded.settle();
    expect(reloaded.list()[0].phase).toBe("ready");
    expect(h.machines.size).toBe(1);
  });

  it("retains the existing runin installation's durable Machine record", async () => {
    const h = pluginHome();
    const existing = {
      ...input,
      machineId: "m-existing",
      creationSubmitted: true,
      phase: "ready",
      error: null,
    };
    mkdirSync(join(h.home, "runin", "runin"), { recursive: true });
    writeFileSync(h.journal, JSON.stringify([existing]));
    startPlugin();
    expect(JSON.parse(readFileSync(h.journal, "utf8"))).toEqual([existing]);
  });

  it("rejects a corrupt journal without overwriting it", async () => {
    const h = pluginHome();
    mkdirSync(join(h.home, "runin", "runin"), { recursive: true });
    writeFileSync(h.journal, "invalid JSON");
    expect(() => contribute(server())).toThrow();
    expect(readFileSync(h.journal, "utf8")).toBe("invalid JSON");
  });
});
