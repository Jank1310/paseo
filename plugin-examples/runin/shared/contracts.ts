import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const createInput = z.object({
  requestId: z.string().regex(/^[a-z0-9-]{8,64}$/),
  name: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 -]{0,39}$/),
  size: z.enum(["small", "medium", "large"]),
});
export type CreateInput = z.infer<typeof createInput>;
export const jobSchema = createInput.extend({
  machineId: z
    .string()
    .regex(/^m-[a-z0-9]+$/)
    .nullable(),
  creationSubmitted: z.boolean(),
  removalRequested: z.boolean().optional(),
  removed: z.boolean().optional(),
  phase: z.enum(["template", "creating", "starting", "installing", "ready", "failed"]),
  error: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const createMachine = defineRpc({
  name: "machine.create",
  input: createInput,
  output: jobSchema,
});
export const listJobs = defineRpc({
  name: "jobs.list",
  input: z.object({}),
  output: z.array(jobSchema),
});
export const listMachineStates = defineRpc({
  name: "machines.status",
  input: z.object({}),
  output: z.object({
    checkedAt: z.number().nullable(),
    states: z.array(
      z.object({
        machineId: jobSchema.shape.machineId.unwrap(),
        phase: z.string(),
      }),
    ),
  }),
});
export const retrySetup = defineRpc({
  name: "machine.retry",
  input: z.object({ requestId: createInput.shape.requestId }),
  output: jobSchema,
});
export const removeMachine = defineRpc({
  name: "machine.remove",
  input: z.object({ requestId: createInput.shape.requestId }),
  output: z.object({ requestId: createInput.shape.requestId }),
});
