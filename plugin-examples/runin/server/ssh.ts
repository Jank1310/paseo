import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Ssh } from "./remote";

export async function readRunin(ssh: Ssh, command: string, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error("runin status check was canceled.");
    try {
      return await ssh("runin.eu", command);
    } catch (error) {
      const rateLimited =
        error instanceof Error &&
        /runin\.eu: too many commands from this key; try again in [\d.hms]+(?:\n|$)/.test(
          error.message,
        );
      if (!rateLimited || attempt >= 2) throw error;
      await delay(10_000, undefined, { signal });
    }
  }
}

const sshTransportExitCode = 255;

/** True when the remote command itself exited non-zero, so runin definitely rejected it. */
export function isRemoteRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause as { code?: unknown; killed?: unknown; signal?: unknown } | undefined;
  if (!cause || typeof cause.code !== "number") return false;
  if (cause.killed === true || cause.signal) return false;
  return cause.code !== 0 && cause.code !== sshTransportExitCode;
}

export function createSsh(signal: AbortSignal): Ssh {
  return (target, command, stdin) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "ssh",
        [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ForwardAgent=no",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
          target,
          command,
        ],
        { signal, timeout: stdin ? 900_000 : 30_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error) {
            const detail = (stderr || stdout || error.message).trim().slice(-4000);
            reject(new Error(`SSH setup failed: ${detail}`, { cause: error }));
          } else resolve(stdout);
        },
      );
      child.stdin?.on("error", () => {}); // execFile reports an early remote exit through its callback.
      child.stdin?.end(stdin);
    });
}
