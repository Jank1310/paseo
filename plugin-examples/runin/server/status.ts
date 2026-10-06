import type { RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import { jobSchema, type Job, listMachineStates } from "../shared/contracts";
import type { Ssh } from "./remote";
import { readRunin } from "./ssh";

const machinesSchema = z.array(
  z.object({
    id: jobSchema.shape.machineId.unwrap(),
    phase: z.string().min(1),
  }),
);

interface Snapshot {
  checkedAt: number;
  phases: Map<string, string>;
}

export function createMachineStatus(ssh: Ssh, signal: AbortSignal, listJobs: () => Job[]) {
  let cached: Promise<Snapshot> | undefined;
  let expiresAt = 0;

  return async (): Promise<RpcOutput<typeof listMachineStates>> => {
    const machineIds = [
      ...new Set(listJobs().flatMap((job) => (job.machineId ? [job.machineId] : []))),
    ];
    if (machineIds.length === 0) return { checkedAt: null, states: [] };

    if (!cached || Date.now() >= expiresAt) {
      // Pending reads and failures are shared, so every pane uses the same rate limit budget.
      expiresAt = Infinity;
      cached = (async () => {
        try {
          const raw = await readRunin(ssh, "ls --all --json", signal);
          const machines = machinesSchema.parse(JSON.parse(raw));
          return {
            checkedAt: Date.now(),
            phases: new Map(machines.map((machine) => [machine.id, machine.phase])),
          };
        } finally {
          expiresAt = Date.now() + 30_000;
        }
      })();
    }

    const snapshot = await cached;
    return {
      checkedAt: snapshot.checkedAt,
      states: machineIds.map((machineId) => ({
        machineId,
        phase: snapshot.phases.get(machineId) ?? "not_found",
      })),
    };
  };
}
