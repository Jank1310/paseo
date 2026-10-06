import { z } from "zod";
import type { Ssh } from "./remote";
import { readRunin } from "./ssh";

// Template names are global across runin, so a fixed name collides with other tenants.
export const templateNamePrefix = "paseo";
export const templateNameOverride = "PASEO_RUNIN_TEMPLATE_NAME";
const templateNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const identity = z.object({ tenant: z.string().min(1) });

export function toTemplateName(tenant: string): string {
  const slug = tenant
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const name = `${templateNamePrefix}-${slug}`;
  if (!templateNamePattern.test(name))
    throw new Error(
      `Tenant "${tenant}" does not produce a usable Template name. Set ${templateNameOverride} to a name matching ${templateNamePattern}.`,
    );
  return name;
}

export function createTemplateNaming(ssh: Ssh, signal: AbortSignal): () => Promise<string> {
  let resolved: Promise<string> | undefined;
  async function resolve(): Promise<string> {
    const override = process.env[templateNameOverride]?.trim();
    if (override) {
      if (!templateNamePattern.test(override))
        throw new Error(`${templateNameOverride} must match ${templateNamePattern}.`);
      return override;
    }
    const response = await readRunin(ssh, "whoami --json", signal);
    return toTemplateName(identity.parse(JSON.parse(response)).tenant);
  }
  return () => {
    if (!resolved) {
      resolved = resolve();
      resolved.catch(() => {
        resolved = undefined; // Resolve again on the next attempt instead of caching a failure.
      });
    }
    return resolved;
  };
}
