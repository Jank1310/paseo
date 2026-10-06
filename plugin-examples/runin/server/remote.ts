import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Remote } from "./provisioning";
import { createInput } from "../shared/contracts";
import { bootstrap } from "./bootstrap";
import { templateVersion } from "./template";
import { createTemplateManager } from "./template-status";
import { createTemplateNaming } from "./template-name";
import { readRunin } from "./ssh";

const machineId = z.string().regex(/^m-[a-z0-9]+$/);
const machine = z.object({
  id: machineId,
  phase: z.string(),
  metadata: z.object({ name: z.string().optional() }).optional(),
});
const creationName = z.string().regex(/^[a-z0-9-]{1,80}$/);
export type Ssh = (target: string, command: string, stdin?: string) => Promise<string>;

export function createRemote(
  ssh: Ssh,
  signal: AbortSignal,
): Remote & {
  templates: ReturnType<typeof createTemplateManager>;
} {
  const resolveTemplateName = createTemplateNaming(ssh, signal);
  const templates = createTemplateManager(ssh, signal, resolveTemplateName);
  return {
    templates,
    prepare: templates.prepare,
    async create(name, size) {
      creationName.parse(name);
      createInput.shape.size.parse(size);
      const templateName = await resolveTemplateName();
      const response = await ssh(
        "runin.eu",
        `new --name ${name} --size ${size} --template ${templateName} --version ${templateVersion} --wait 0 --json`,
      );
      return machine.parse(JSON.parse(response)).id;
    },
    async find(name, includeDestroyed = false) {
      creationName.parse(name);
      const response = await readRunin(ssh, "ls --all --json", signal);
      const matches = machine
        .array()
        .parse(JSON.parse(response))
        .filter((entry) => entry.metadata?.name === name);
      if (matches.length > 1)
        throw new Error(
          "More than one Machine has this operation name. Inspect runin before continuing.",
        );
      const found = matches[0];
      if (!found) return null;
      if (found.phase === "destroyed" && !includeDestroyed)
        throw new Error(
          `Machine ${found.id} was destroyed. Start a new operation to create a replacement.`,
        );
      return found.id;
    },
    async remove(id) {
      machineId.parse(id);
      const deadline = Date.now() + 20_000;
      const readMachine = async () => {
        const response = await readRunin(ssh, "ls --all --json", signal);
        const matches = machine
          .array()
          .parse(JSON.parse(response))
          .filter((entry) => entry.id === id);
        if (matches.length > 1)
          throw new Error(
            `More than one Machine has ID ${id}. Inspect runin before retrying removal.`,
          );
        return matches[0];
      };
      const checkDeadline = () => {
        if (signal.aborted) throw new Error("runin removal was canceled.");
        if (Date.now() >= deadline)
          throw new Error(
            `Machine ${id} removal is not confirmed yet. Retry removal to check it again.`,
          );
      };
      const current = await readMachine();
      if (signal.aborted) throw new Error("runin removal was canceled.");
      if (!current || current.phase === "destroyed") return;
      checkDeadline();
      // A lost rm reply can leave destruction in progress. Always inspect before resubmitting.
      if (current.phase !== "destroying") {
        await ssh("runin.eu", `rm ${id} --wait 0 --json`);
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        checkDeadline();
        const updated = await readMachine();
        if (signal.aborted) throw new Error("runin removal was canceled.");
        if (!updated || updated.phase === "destroyed") return;
        if (attempt < 3) await delay(5000, undefined, { signal });
      }
      throw new Error(
        `Machine ${id} removal is not confirmed yet. Retry removal to check it again.`,
      );
    },
    async wait(id) {
      machineId.parse(id);
      const deadline = Date.now() + 180_000;
      for (let attempt = 0; attempt < 36; attempt++) {
        if (Date.now() >= deadline) break;
        const response = await readRunin(ssh, `inspect ${id} --json`, signal);
        const current = machine.parse(JSON.parse(response));
        if (current.id !== id)
          throw new Error(
            `runin returned status for ${current.id} while checking ${id}. Inspect the Machine before retrying.`,
          );
        if (current.phase === "running") return;
        if (["failed", "destroyed", "paused", "interrupted"].includes(current.phase)) {
          throw new Error(
            `Machine ${id} is ${current.phase}. Resolve its state in runin, then retry setup.`,
          );
        }
        await delay(5000, undefined, { signal });
      }
      throw new Error(`Machine ${id} is still starting. Retry setup to check it again.`);
    },
    async install(id) {
      machineId.parse(id);
      const response = await ssh(`${id}@runin.eu`, "sh -se", bootstrap);
      let value: unknown;
      try {
        value = JSON.parse(response);
      } catch (error) {
        throw new Error(
          `Paseo returned invalid status JSON on ${id}. Check ~/.paseo/runin-setup.log on the Machine and retry setup.`,
          { cause: error },
        );
      }
      const status = z.object({ connectedDaemon: z.literal("reachable") }).safeParse(value);
      if (!status.success)
        throw new Error(
          `Paseo is not reachable on ${id}. Check ~/.paseo/runin-setup.log on the Machine and retry setup.`,
        );
    },
  };
}
