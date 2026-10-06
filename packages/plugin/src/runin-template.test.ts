import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  createTemplatePreparation as createPreparation,
  installAgents,
  installPaseo,
  templateDockerfile,
  templateVersion,
} from "../../../plugin-examples/runin/server/template";
import type { Ssh } from "../../../plugin-examples/runin/server/remote";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

const templateName = "paseo-example";
const createTemplatePreparation = (ssh: Ssh, signal: AbortSignal) =>
  createPreparation(ssh, signal, async () => templateName);

const ready = {
  name: templateName,
  version: templateVersion,
  state: "ready",
  golden_state: "ready",
  golden_shapes: ["2x4096", "4x8192", "8x16384"],
  volume_size_bytes: 30 * 1024 ** 3,
};

describe("runin Template preparation", () => {
  it("uses Dockerfile instructions accepted by runin's older Podman parser and valid shell scripts", () => {
    const logicalLines = templateDockerfile
      .replace(/\\\n/g, "")
      .split("\n")
      .filter((line) => line.trim());
    const instructions = logicalLines.map((line) => line.split(" ", 1)[0]);
    expect(instructions).toEqual([
      "FROM",
      "RUN",
      "RUN",
      "RUN",
      "RUN",
      "RUN",
      "RUN",
      "RUN",
      "RUN",
      "ENV",
      "ENTRYPOINT",
      "CMD",
      "WORKDIR",
    ]);
    const scripts = logicalLines.filter((line) => line.startsWith("RUN ["));
    expect(scripts).toHaveLength(5);
    for (const line of scripts) {
      const [, , script] = z
        .tuple([z.literal("/bin/sh"), z.literal("-c"), z.string()])
        .parse(JSON.parse(line.slice(4)));
      expect(() => execFileSync("sh", ["-n"], { input: script })).not.toThrow();
    }
  });
  it("installs Paseo under a prefix the daemon user can update", () => {
    const rootInstalls = templateDockerfile
      .split("\n")
      .filter((line) => line.startsWith("RUN [") && !line.includes("runuser -u runin"));
    expect(rootInstalls.join("\n")).not.toContain("@getpaseo/cli");
    expect(installPaseo).toContain("prefix=/home/runin/.npm-global");
    expect(installPaseo).toMatch(/runuser -u runin -- .*npm install --global @getpaseo\/cli@/);
    expect(templateDockerfile).toContain("ExecStart=/usr/local/bin/paseo daemon run");
    expect(installPaseo).toContain("ln -sf /home/runin/.npm-global/bin/paseo /usr/local/bin/paseo");
  });
  it("installs agents as the daemon user so they can update themselves", () => {
    const installs = installAgents
      .split("\n")
      .filter((line) => line.includes("npm install") || line.includes("grok-install.sh 1."));
    expect(installs).toHaveLength(3);
    for (const line of installs) expect(line).toMatch(/^as_runin /);
    expect(installAgents).toContain("--ignore-scripts @earendil-works/pi-coding-agent@");
    expect(installAgents).toContain("for bin in codex claude pi; do");
    expect(installAgents).toContain(
      'ln -sf "/home/runin/.npm-global/bin/$bin" "/usr/local/bin/$bin"',
    );
    expect(installAgents).toContain("ln -sf /home/runin/.grok/bin/grok /usr/local/bin/grok");
    // installAgents relies on the npm prefix installPaseo writes.
    expect(templateDockerfile.indexOf("prefix=/home/runin/.npm-global")).toBeLessThan(
      templateDockerfile.indexOf("@openai/codex@"),
    );
  });
  it("stops before extracting or installing GitHub CLI when archive verification fails", () => {
    const scriptLine = templateDockerfile
      .split("\n")
      .find((line) => line.startsWith("RUN [") && line.includes("github.com/cli/cli"));
    expect(scriptLine).toBeDefined();
    const [, , script] = z
      .tuple([z.literal("/bin/sh"), z.literal("-c"), z.string()])
      .parse(JSON.parse(String(scriptLine).slice(4)));
    const folder = mkdtempSync(join(tmpdir(), "paseo-gh-checksum-"));
    const marker = join(folder, "installed");
    const commands = {
      uname: "printf 'x86_64\\n'",
      curl: "exit 0",
      sha256sum: "exit 1",
      tar: `touch '${marker}'`,
      install: `touch '${marker}'`,
    };
    try {
      for (const [name, body] of Object.entries(commands)) {
        const path = join(folder, name);
        writeFileSync(path, `#!/bin/sh\n${body}\n`);
        chmodSync(path, 0o755);
      }
      expect(() =>
        execFileSync("sh", ["-se"], {
          input: script,
          env: { ...process.env, PATH: `${folder}:/usr/bin:/bin` },
          stdio: "pipe",
        }),
      ).toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("reuses the ready exact version without building or preparing it", async () => {
    const commands: string[] = [];
    const prepare = createTemplatePreparation(async (_target, command) => {
      commands.push(command);
      return JSON.stringify([ready]);
    }, new AbortController().signal);
    await prepare("medium");
    expect(commands).toEqual(["template ls --json"]);
  });

  it("waits for a ready Template's disk report before accepting it or preparing a shape", async () => {
    const commands: string[] = [];
    let reads = 0;
    const prepare = createTemplatePreparation(async (_target, command) => {
      commands.push(command);
      reads++;
      if (reads === 1)
        return JSON.stringify([
          { name: templateName, version: templateVersion, state: "ready", golden_state: "none" },
        ]);
      return JSON.stringify([ready]);
    }, new AbortController().signal);
    await expect(prepare("small")).resolves.toBeUndefined();
    expect(commands).toEqual(["template ls --json", "template ls --json"]);
  });

  it("looks through versions when a newer version hides the pinned one", async () => {
    const commands: string[] = [];
    const prepare = createTemplatePreparation(async (_target, command) => {
      commands.push(command);
      if (command === "template ls --json")
        return JSON.stringify([{ ...ready, version: "future-version" }]);
      return JSON.stringify([ready]);
    }, new AbortController().signal);
    await prepare("small");
    expect(commands).toEqual(["template ls --json", `template versions ${templateName} --json`]);
  });

  it("builds a missing version once across concurrent requests and waits for Golden readiness", async () => {
    const calls: Array<{ command: string; stdin: string | undefined }> = [];
    let lists = 0;
    const prepare = createTemplatePreparation(async (_target, command, stdin) => {
      calls.push({ command, stdin });
      if (command === "template ls --json") {
        lists++;
        if (lists === 1) return "[]";
        if (lists === 2)
          return JSON.stringify([
            { name: templateName, version: templateVersion, state: "building" },
          ]);
        if (lists === 3)
          return JSON.stringify([{ ...ready, golden_state: "capturing", golden_shapes: [] }]);
        return JSON.stringify([ready]);
      }
      return "{}";
    }, new AbortController().signal);
    await Promise.all([prepare("small"), prepare("medium")]);
    const builds = calls.filter((call) => call.command.startsWith("template build"));
    expect(builds).toEqual([
      {
        command: `template build --name ${templateName} --version ${templateVersion} --size-gib 30 --file - --wait 0 --json`,
        stdin: templateDockerfile,
      },
    ]);
    expect(calls.filter((call) => call.command.startsWith("template prepare"))).toHaveLength(0);
    expect(lists).toBe(5);
  });

  it("prepares a missing requested shape and polls instead of trusting acceptance", async () => {
    const commands: string[] = [];
    let lists = 0;
    const prepare = createTemplatePreparation(async (_target, command) => {
      commands.push(command);
      if (command.startsWith("template prepare")) return "{}";
      lists++;
      if (lists < 3) return JSON.stringify([{ ...ready, golden_shapes: ["2x4096"] }]);
      return JSON.stringify([ready]);
    }, new AbortController().signal);
    await prepare("large");
    expect(commands).toEqual([
      "template ls --json",
      `template prepare ${templateName} --version ${templateVersion} --size large --wait 0 --json`,
      "template ls --json",
      "template ls --json",
    ]);
  });

  it.each(["state", "golden_state"])("surfaces failed %s without rebuilding", async (field) => {
    const commands: string[] = [];
    const prepare = createTemplatePreparation(async (_target, command) => {
      commands.push(command);
      return JSON.stringify([{ ...ready, [field]: "failed", error: "build disk full" }]);
    }, new AbortController().signal);
    await expect(prepare("small")).rejects.toThrow("build disk full");
    expect(commands).toEqual(["template ls --json"]);
  });

  it("reconciles an accepted build after SSH disconnects without submitting another", async () => {
    const commands: string[] = [];
    let built = false;
    const prepare = createTemplatePreparation(async (_target, command) => {
      commands.push(command);
      if (command.startsWith("template build")) {
        built = true;
        throw new Error("SSH disconnected");
      }
      return JSON.stringify(built ? [ready] : []);
    }, new AbortController().signal);
    await expect(prepare("small")).rejects.toThrow("SSH disconnected");
    await prepare("small");
    expect(commands.filter((command) => command.startsWith("template build"))).toHaveLength(1);
  });

  it("rejects malformed Template data and a wrong disk size before creating Machines", async () => {
    const malformed = createTemplatePreparation(
      async () => JSON.stringify([{ ...ready, golden_shapes: "small" }]),
      new AbortController().signal,
    );
    await expect(malformed("small")).rejects.toThrow();
    const wrongDisk = createTemplatePreparation(
      async () => JSON.stringify([{ ...ready, volume_size_bytes: 10 * 1024 ** 3 }]),
      new AbortController().signal,
    );
    await expect(wrongDisk("small")).rejects.toThrow("30 GiB");
  });

  it("reports a build rejected before a version appeared without resubmitting it", async () => {
    let builds = 0;
    const prepare = createTemplatePreparation(async (_target, command) => {
      if (command.startsWith("template build")) {
        builds++;
        throw new Error("build limit exceeded");
      }
      return "[]";
    }, new AbortController().signal);
    await expect(prepare("small")).rejects.toThrow("build limit exceeded");
    await expect(prepare("small")).rejects.toThrow("account limits");
    expect(builds).toBe(1);
  });

  it.each([
    { exit: 1, builds: 2 },
    { exit: 255, builds: 1 },
  ])(
    "resubmits a build only after runin definitely rejected it (exit $exit)",
    async ({ exit, builds }) => {
      let submitted = 0;
      const prepare = createTemplatePreparation(async (_target, command) => {
        if (command.startsWith("template build")) {
          submitted++;
          throw new Error("build failed", { cause: { code: exit } });
        }
        return "[]";
      }, new AbortController().signal);
      await expect(prepare("small")).rejects.toThrow("build failed");
      await prepare("small").catch(() => {});
      expect(submitted).toBe(builds);
    },
  );

  it("surfaces a failed build before disk capacity is available", async () => {
    const prepare = createTemplatePreparation(
      async () =>
        JSON.stringify([
          {
            name: templateName,
            version: templateVersion,
            state: "failed",
            error: "npm install failed",
          },
        ]),
      new AbortController().signal,
    );
    await expect(prepare("small")).rejects.toThrow("npm install failed");
  });

  it("stops polling when the plugin unloads", async () => {
    const controller = new AbortController();
    controller.abort();
    const prepare = createTemplatePreparation(
      async () => JSON.stringify([{ ...ready, state: "building" }]),
      controller.signal,
    );
    await expect(prepare("small")).rejects.toThrow();
  });

  it("waits between Template reads and recovers an explicit key rate limit", async () => {
    vi.mocked(delay).mockClear();
    let reads = 0;
    const prepare = createTemplatePreparation(async () => {
      reads++;
      if (reads === 1)
        throw new Error(
          "SSH setup failed: runin.eu: too many commands from this key; try again in 0s",
        );
      if (reads === 2)
        return JSON.stringify([{ ...ready, golden_state: "capturing", golden_shapes: [] }]);
      return JSON.stringify([ready]);
    }, new AbortController().signal);
    await prepare("small");
    expect(reads).toBe(3);
    expect(vi.mocked(delay).mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      10_000, 10_000,
    ]);
  });

  it("bounds rate-limit retries and leaves other SSH failures untouched", async () => {
    let reads = 0;
    const rejection = new Error("runin.eu: too many commands from this key; try again in 0s");
    const limited = createTemplatePreparation(async () => {
      reads++;
      throw rejection;
    }, new AbortController().signal);
    await expect(limited("small")).rejects.toBe(rejection);
    expect(reads).toBe(3);
    reads = 0;
    const authentication = new Error("Permission denied (publickey)");
    const denied = createTemplatePreparation(async () => {
      reads++;
      throw authentication;
    }, new AbortController().signal);
    await expect(denied("small")).rejects.toBe(authentication);
    expect(reads).toBe(1);
  });

  it("never replays a build mutation rejected by the key rate limit", async () => {
    let builds = 0;
    const rejection = new Error("runin.eu: too many commands from this key; try again in 0s");
    const prepare = createTemplatePreparation(async (_target, command) => {
      if (command === "template ls --json") return "[]";
      builds++;
      throw rejection;
    }, new AbortController().signal);
    await expect(prepare("small")).rejects.toBe(rejection);
    expect(builds).toBe(1);
  });
});
