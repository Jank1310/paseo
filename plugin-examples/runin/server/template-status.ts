import type { TemplateStatus } from "../shared/contracts";
import type { Ssh } from "./remote";
import { createTemplatePreparation, readTemplateVersions, templateVersion } from "./template";

export function createTemplateManager(
  ssh: Ssh,
  signal: AbortSignal,
  resolveTemplateName: () => Promise<string>,
) {
  const prepare = createTemplatePreparation(ssh, signal, resolveTemplateName);
  let running: Promise<void> | undefined;
  let updateError: string | null = null;
  let cached: Promise<Omit<TemplateStatus, "updating">> | undefined;
  let expiresAt = 0;

  async function inspect(): Promise<Omit<TemplateStatus, "updating">> {
    const name = await resolveTemplateName();
    const versions = await readTemplateVersions(ssh, signal, name);
    const current = versions.find((entry) => entry.version === templateVersion);
    let state: TemplateStatus["state"] = versions.length ? "outdated" : "missing";
    let error: string | null = null;
    if (current) {
      if (current.state === "failed" || current.golden_state === "failed") {
        state = "failed";
        error =
          current.error ??
          "Template preparation failed. Inspect the version in runin before retrying.";
      } else if (current.state === "building") {
        state = "building";
      } else if (
        current.volume_size_bytes !== undefined &&
        current.volume_size_bytes !== 30 * 1024 ** 3
      ) {
        state = "failed";
        error =
          "The Template does not have the required 30 GiB disk. Inspect the version in runin.";
      } else {
        state =
          current.volume_size_bytes !== undefined &&
          current.golden_state === "ready" &&
          ["2x4096", "4x8192", "8x16384"].every((shape) => current.golden_shapes.includes(shape))
            ? "ready"
            : "preparing";
      }
    }
    return {
      name,
      expectedVersion: templateVersion,
      currentVersion: current?.version ?? versions[0]?.version ?? null,
      state,
      checkedAt: Date.now(),
      error,
    };
  }

  return {
    prepare,
    async status(): Promise<TemplateStatus> {
      if (!cached || Date.now() >= expiresAt) {
        // Share pending reads and failures across panes to respect SSH rate limits.
        expiresAt = Infinity;
        cached = inspect().finally(() => {
          expiresAt = Date.now() + (running ? 10_000 : 30_000);
        });
      }
      const snapshot = await cached;
      return { ...snapshot, updating: Boolean(running), error: updateError ?? snapshot.error };
    },
    update(): { updating: true } {
      if (signal.aborted) throw new Error("Template update was canceled.");
      if (!running) {
        updateError = null;
        expiresAt = 0;
        // Return immediately; the daemon owns the operation even after the pane closes.
        running = (async () => {
          for (const size of ["small", "medium", "large"] as const) await prepare(size);
        })()
          .catch((error: unknown) => {
            updateError = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            running = undefined;
            expiresAt = 0;
          });
      }
      return { updating: true };
    },
    async settle() {
      await running;
    },
  };
}
