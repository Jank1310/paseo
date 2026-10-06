import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createMachine,
  getTemplateStatus,
  listJobs,
  listMachineStates,
  removeMachine,
  retrySetup,
  updateTemplate,
} from "./shared/contracts";
import { Provisioning } from "./server/provisioning";
import { createRemote } from "./server/remote";
import { createSsh } from "./server/ssh";
import { createMachineStatus } from "./server/status";

export default function contribute(server: PluginServerContext) {
  const lifetime = new AbortController();
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const directory = join(home, "runin", "runin");
  try {
    const ssh = createSsh(lifetime.signal);
    const remote = createRemote(ssh, lifetime.signal);
    const jobs = new Provisioning(join(directory, "jobs.json"), remote);
    server.handle(getTemplateStatus, () => remote.templates.status());
    server.handle(updateTemplate, () => remote.templates.update());
    server.handle(createMachine, (input) => jobs.create(input));
    server.handle(listJobs, () => jobs.list());
    server.handle(
      listMachineStates,
      createMachineStatus(ssh, lifetime.signal, () => jobs.list()),
    );
    server.handle(retrySetup, ({ requestId }) => jobs.retry(requestId));
    server.handle(removeMachine, ({ requestId }) => jobs.remove(requestId));
    return async () => {
      lifetime.abort();
      await jobs.settle();
      await remote.templates.settle();
    };
  } catch (error) {
    lifetime.abort();
    throw error;
  }
}
