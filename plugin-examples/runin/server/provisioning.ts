import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInput, jobSchema, type CreateInput, type Job } from "../shared/contracts";

export interface Remote {
  prepare(size: CreateInput["size"]): Promise<void>;
  create(name: string, size: CreateInput["size"]): Promise<string>;
  find(name: string, includeDestroyed?: boolean): Promise<string | null>;
  wait(machineId: string): Promise<void>;
  install(machineId: string): Promise<void>;
  remove(machineId: string): Promise<void>;
}

export class Provisioning {
  private readonly jobs: Map<string, Job>;
  private readonly running = new Map<string, Promise<void>>();
  private readonly removing = new Map<string, Promise<{ requestId: string }>>();

  constructor(
    private readonly path: string,
    private readonly remote: Remote,
  ) {
    const saved = existsSync(path)
      ? jobSchema.array().parse(JSON.parse(readFileSync(path, "utf8")))
      : [];
    this.jobs = new Map(saved.map((job) => [job.requestId, job]));
    for (const job of this.jobs.values()) {
      if (job.removed) continue;
      if (job.removalRequested && job.error === null) {
        this.jobs.set(job.requestId, {
          ...job,
          phase: "failed",
          error: "Removal was interrupted. Remove again to confirm deletion of the same Machine.",
        });
      } else if (job.phase !== "ready" && job.phase !== "failed") {
        this.jobs.set(job.requestId, {
          ...job,
          phase: "failed",
          error: "Setup was interrupted. Retry setup to continue with the same Machine.",
        });
      }
    }
    this.save();
  }

  list(): Job[] {
    return [...this.jobs.values()].filter((job) => !job.removed).toReversed();
  }

  create(value: CreateInput): Job {
    const input = createInput.parse(value);
    const existing = this.jobs.get(input.requestId);
    if (existing) {
      if (existing.name !== input.name || existing.size !== input.size)
        throw new Error("This request ID already belongs to a different Machine.");
      if (existing.removalRequested || existing.removed)
        throw new Error(
          "This Machine was marked for removal. Create a new request to create another Machine.",
        );
      return existing;
    }
    const job: Job = {
      ...input,
      machineId: null,
      creationSubmitted: false,
      phase: "template",
      error: null,
    };
    this.jobs.set(job.requestId, job);
    try {
      this.save();
    } catch (error) {
      this.fail(job.requestId, error);
      throw error;
    }
    this.launch(job);
    return job;
  }

  retry(requestId: string): Job {
    const job = this.jobs.get(requestId);
    if (!job) throw new Error("Unknown setup operation.");
    if (job.removalRequested || job.removed)
      throw new Error("This Machine was marked for removal. Remove again to finish deletion.");
    if (this.running.has(requestId) || job.phase === "ready") return job;
    try {
      const pending = this.update(job, { phase: "starting", error: null });
      this.launch(pending);
      return pending;
    } catch (error) {
      this.fail(requestId, error);
      throw error;
    }
  }

  async settle(): Promise<void> {
    await Promise.all(this.running.values());
    await Promise.allSettled(this.removing.values());
  }

  remove(requestId: string): Promise<{ requestId: string }> {
    const job = this.jobs.get(requestId);
    if (!job) return Promise.reject(new Error("Unknown setup operation."));
    const running = this.removing.get(requestId);
    if (running) return running;
    if (job.removed) return Promise.resolve({ requestId });
    if (this.running.has(requestId))
      return Promise.reject(
        new Error("Setup is still running. Wait for it to finish before removing this Machine."),
      );
    try {
      this.update(job, { removalRequested: true, error: null });
    } catch (error) {
      this.fail(requestId, error);
      return Promise.reject(error);
    }
    const operation = this.removeJob(requestId).finally(() => this.removing.delete(requestId));
    this.removing.set(requestId, operation);
    return operation;
  }

  private async removeJob(requestId: string): Promise<{ requestId: string }> {
    try {
      let job = this.jobs.get(requestId);
      if (!job) throw new Error("Unknown setup operation.");
      let machineId = job.machineId;
      if (machineId === null && job.creationSubmitted) {
        const creationName = `paseo-${requestId}`;
        machineId = await this.remote.find(creationName, true);
        if (machineId === null)
          throw new Error(
            `No Machine found for ${creationName}. Creation may still be pending; check runin and Remove again. This record will remain visible until deletion can be confirmed.`,
          );
        job = this.update(job, { machineId });
      }
      if (machineId !== null) await this.remote.remove(machineId);
      this.update(job, { removed: true, error: null });
      return { requestId };
    } catch (error) {
      // A deletion with no confirmed journal save must remain visible and retryable.
      const current = this.jobs.get(requestId);
      if (current) this.jobs.set(requestId, { ...current, removed: false });
      this.fail(requestId, error);
      throw error;
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify([...this.jobs.values()]), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }

  private update(job: Job, change: Partial<Job>): Job {
    const next = jobSchema.parse({ ...this.jobs.get(job.requestId), ...change });
    this.jobs.set(job.requestId, next);
    this.save();
    return next;
  }

  private launch(job: Job): void {
    const operation = this.provision(job).finally(() => this.running.delete(job.requestId));
    this.running.set(job.requestId, operation);
  }

  private fail(requestId: string, error: unknown): void {
    // A failed save may have advanced memory beyond the last awaited step.
    const failed = jobSchema.parse({
      ...this.jobs.get(requestId),
      phase: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    this.jobs.set(requestId, failed);
    try {
      this.save();
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      const operation = failed.removalRequested ? "Removal" : "Setup";
      failed.error = `${failed.error} ${operation} status could not be saved: ${message}`;
      console.error(`[Runin] ${operation} ${requestId} status could not be saved`, saveError);
    }
  }

  private async provision(initial: Job): Promise<void> {
    let job = initial;
    try {
      const creationName = `paseo-${job.requestId}`;
      let machineId = job.machineId;
      if (machineId === null) {
        if (job.creationSubmitted) {
          machineId = await this.remote.find(creationName);
        } else {
          job = this.update(job, { phase: "template" });
          await this.remote.prepare(job.size);
          job = this.update(job, { phase: "creating", creationSubmitted: true });
          machineId = await this.remote.create(creationName, job.size);
        }
      }
      if (machineId === null)
        throw new Error(
          `No Machine found for ${creationName}. Creation may still be pending; retry after checking runin. This operation will not submit another creation.`,
        );
      job = this.update(job, { machineId, phase: "starting", error: null });
      await this.remote.wait(machineId);
      job = this.update(job, { phase: "installing" });
      await this.remote.install(machineId);
      this.update(job, { phase: "ready" });
    } catch (error) {
      this.fail(initial.requestId, error);
    }
  }
}
