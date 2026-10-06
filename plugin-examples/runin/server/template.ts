import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createInput, type CreateInput } from "../shared/contracts";
import type { Ssh } from "./remote";
import { isRemoteRejection, readRunin } from "./ssh";

export const templateVersion = "0.10.3-agents-20261006-v2";
export const paseoCliVersion = "0.10.3";
export const githubCliVersion = "2.102.0";
export const codexVersion = "0.159.3";
export const claudeCodeVersion = "2.1.287";
export const piVersion = "1.0.4";
export const grokVersion = "1.0.46";
export const goVersion = "1.27.1";
export const bunVersion = "1.4.2";

const template = z.object({
  name: z.string(),
  version: z.string(),
  state: z.enum(["building", "ready", "failed"]),
  golden_state: z.enum(["none", "capturing", "ready", "failed"]).default("none"),
  golden_shapes: z.array(z.string()).default([]),
  volume_size_bytes: z.number().int().nonnegative().optional(),
  error: z.string().nullable().optional(),
});
const shapes = { small: "2x4096", medium: "4x8192", large: "8x16384" };

// Paseo updates itself with `npm install -g` as runin, so it must live under a
// prefix runin owns. /usr/local/bin/paseo follows npm's bin link.
export const installPaseo = String.raw`set -eu
printf 'prefix=/home/runin/.npm-global\n' > /home/runin/.npmrc
chown runin:runin /home/runin/.npmrc
runuser -u runin -- env HOME=/home/runin npm install --global @getpaseo/cli@${paseoCliVersion}
rm -rf /home/runin/.npm
ln -sf /home/runin/.npm-global/bin/paseo /usr/local/bin/paseo
/usr/local/bin/paseo --version`;

// The agents update themselves too, so they also install as runin: npm agents
// into the prefix installPaseo configures, Grok into /home/runin/.grok.
export const installAgents = String.raw`set -eu
as_runin() { runuser -u runin -- env HOME=/home/runin "$@"; }
as_runin npm install --global @openai/codex@${codexVersion} @anthropic-ai/claude-code@${claudeCodeVersion}
as_runin npm install --global --ignore-scripts @earendil-works/pi-coding-agent@${piVersion}
rm -rf /home/runin/.npm
curl --fail --silent --show-error --location --max-time 30 https://x.ai/cli/install.sh -o /tmp/grok-install.sh
as_runin bash /tmp/grok-install.sh ${grokVersion}
rm -f /tmp/grok-install.sh
for bin in codex claude pi; do
  ln -sf "/home/runin/.npm-global/bin/$bin" "/usr/local/bin/$bin"
done
ln -sf /home/runin/.grok/bin/grok /usr/local/bin/grok
for bin in codex claude pi grok; do
  test -x "/usr/local/bin/$bin"
done`;

export const installGitHubCli = String.raw`set -eu
case "$(uname -m)" in
  x86_64)
    gh_arch=amd64
    gh_sha256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
    ;;
  aarch64|arm64)
    gh_arch=arm64
    gh_sha256=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
    ;;
  *) echo 'Unsupported GitHub CLI architecture' >&2; exit 1 ;;
esac
gh_tmp=$(mktemp -d)
trap 'rm -rf "$gh_tmp"' EXIT
gh_archive=gh_${githubCliVersion}_linux_$gh_arch.tar.gz
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  "https://github.com/cli/cli/releases/download/v${githubCliVersion}/$gh_archive" \
  -o "$gh_tmp/$gh_archive"
printf '%s  %s\n' "$gh_sha256" "$gh_tmp/$gh_archive" | sha256sum --check --strict
tar -xzf "$gh_tmp/$gh_archive" -C "$gh_tmp" "gh_${githubCliVersion}_linux_$gh_arch/bin/gh"
install -m 0755 "$gh_tmp/gh_${githubCliVersion}_linux_$gh_arch/bin/gh" /usr/local/bin/gh
/usr/local/bin/gh --version`;

// Use /usr/local/bin so SSH sessions and the daemon can find these tools.
export const installDevelopmentTools = String.raw`set -eu
case "$(uname -m)" in
  x86_64)
    go_arch=amd64
    go_sha256=63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445
    ;;
  aarch64|arm64)
    go_arch=arm64
    go_sha256=3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec
    ;;
  *) echo 'Unsupported Go architecture' >&2; exit 1 ;;
esac
go_tmp=$(mktemp -d)
trap 'rm -rf "$go_tmp"' EXIT
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  "https://go.dev/dl/go${goVersion}.linux-$go_arch.tar.gz" -o "$go_tmp/go.tar.gz"
printf '%s  %s\n' "$go_sha256" "$go_tmp/go.tar.gz" | sha256sum --check --strict
tar -xzf "$go_tmp/go.tar.gz" -C /usr/local
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
go version

runuser -u runin -- env HOME=/home/runin npm install --global bun@${bunVersion}
rm -rf /home/runin/.npm
for bin in bun bunx; do
  ln -sf "/home/runin/.npm-global/bin/$bin" "/usr/local/bin/$bin"
done
runuser -u runin -- /usr/local/bin/bun --version

install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
  https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n' \
  "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
rm -rf /var/lib/apt/lists/*
usermod -aG docker runin
systemctl enable docker.service containerd.service
docker --version
docker compose version
docker buildx version`;

const configureService = String.raw`set -eu
cat > /etc/systemd/system/paseo.service <<'UNIT'
[Unit]
Description=Paseo coding agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=runin
WorkingDirectory=/home/runin
Environment=HOME=/home/runin
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PASEO_LISTEN=127.0.0.1:6767
Environment=PASEO_RELAY_ENABLED=false
ExecStart=/usr/local/bin/paseo daemon run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
# Keep this disabled until the cloned Machine's setup starts it.
systemctl disable paseo.service
for timer in apt-daily.timer apt-daily-upgrade.timer motd-news.timer dpkg-db-backup.timer e2scrub_all.timer; do
  ln -sf /dev/null "/etc/systemd/system/$timer"
done
systemctl enable fstrim.timer`;

export const templateDockerfile = String.raw`FROM node:22.20.0-bookworm@sha256:915acd9e9b885ead0c620e27e37c81b74c226e0e1c8177f37a60217b6eabb0d7
RUN export DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get install -y --no-install-recommends systemd systemd-sysv dbus udev util-linux openssh-server sudo python3 iproute2 ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash --user-group runin \
    && printf 'runin ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runin \
    && chmod 0440 /etc/sudoers.d/runin
RUN rm -f /etc/ssh/ssh_host_* \
    && ssh-keygen -q -t ed25519 -N '' -C runin-template -f /etc/ssh/ssh_host_ed25519_key \
    && install -d -m 0755 /etc/ssh/sshd_config.d \
    && printf 'HostKey /etc/ssh/ssh_host_ed25519_key\n' > /etc/ssh/sshd_config.d/20-runin-hostkeys.conf
RUN ${JSON.stringify(["/bin/sh", "-c", installPaseo])}
RUN ${JSON.stringify(["/bin/sh", "-c", installAgents])}
RUN ${JSON.stringify(["/bin/sh", "-c", installGitHubCli])}
RUN ${JSON.stringify(["/bin/sh", "-c", installDevelopmentTools])}
RUN ${JSON.stringify(["/bin/sh", "-c", configureService])}
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 DEBIAN_FRONTEND=
ENTRYPOINT []
CMD []
WORKDIR /home/runin
`;

export async function readTemplateVersions(ssh: Ssh, signal: AbortSignal, templateName: string) {
  const response = await readRunin(ssh, "template ls --json", signal);
  let entries = template.array().parse(JSON.parse(response));
  const hasName = entries.some((entry) => entry.name === templateName);
  const hasVersion = entries.some(
    (entry) => entry.name === templateName && entry.version === templateVersion,
  );
  if (hasName && !hasVersion) {
    const versions = await readRunin(ssh, `template versions ${templateName} --json`, signal);
    entries = template.array().parse(JSON.parse(versions));
  }
  entries = entries.filter((entry) => entry.name === templateName);
  if (entries.filter((entry) => entry.version === templateVersion).length > 1)
    throw new Error(
      `runin returned duplicate versions of Template ${templateName}@${templateVersion}. Inspect the Template before retrying.`,
    );
  return entries;
}

export function createTemplatePreparation(
  ssh: Ssh,
  signal: AbortSignal,
  resolveTemplateName: () => Promise<string>,
) {
  let queue = Promise.resolve();
  let buildSubmitted = false;

  async function inspect(templateName: string) {
    const entries = await readTemplateVersions(ssh, signal, templateName);
    return entries.find((entry) => entry.version === templateVersion);
  }

  async function submitBuild(templateName: string) {
    // SSH may disconnect after runin accepted the build. Never resubmit an uncertain build in this process.
    buildSubmitted = true;
    try {
      await ssh(
        "runin.eu",
        `template build --name ${templateName} --version ${templateVersion} --size-gib 30 --file - --wait 0 --json`,
        templateDockerfile,
      );
    } catch (error) {
      // runin answered with a clear rejection, so nothing was accepted and a retry may submit again.
      if (isRemoteRejection(error)) buildSubmitted = false;
      throw error;
    }
  }

  async function prepare(size: CreateInput["size"]) {
    const templateName = await resolveTemplateName();
    let current = await inspect(templateName);
    if (!current && !buildSubmitted) await submitBuild(templateName);
    let preparationSubmitted = false;
    const deadline = Date.now() + 40 * 60_000;
    const missingDeadline = Date.now() + 30_000;
    for (let attempt = 0; attempt < 240; attempt++) {
      if (signal.aborted) throw new Error("Template preparation was canceled.");
      if (Date.now() >= deadline) break;
      const missingExpired = attempt >= 3 || Date.now() >= missingDeadline;
      if (!current && missingExpired) {
        throw new Error(
          `No Template ${templateName}@${templateVersion} is visible after the build submission. Check runin build status and account limits before retrying; setup will not resubmit an uncertain build.`,
        );
      }
      if (current) {
        const buildFailed = current.state === "failed";
        const goldenFailed = current.golden_state === "failed";
        if (buildFailed || goldenFailed) {
          const detail = (
            current.error ?? "Inspect the Template's build and preparation logs in runin."
          )
            .split("\n")[0]
            .slice(0, 1200);
          throw new Error(
            `Template ${templateName}@${templateVersion} failed: ${detail} Resolve the failed version before retrying; setup will not rebuild it.`,
          );
        }
        if (current.state === "ready" && current.volume_size_bytes !== undefined) {
          if (current.volume_size_bytes !== 30 * 1024 ** 3)
            throw new Error(
              `Template ${templateName}@${templateVersion} does not have the required 30 GiB disk. Inspect the version in runin before retrying.`,
            );
          if (current.golden_state === "ready" && current.golden_shapes.includes(shapes[size]))
            return;
          const captureActive = current.golden_state === "capturing";
          if (!preparationSubmitted && !captureActive) {
            preparationSubmitted = true;
            await ssh(
              "runin.eu",
              `template prepare ${templateName} --version ${templateVersion} --size ${size} --wait 0 --json`,
            );
          }
        }
      }
      await delay(10_000, undefined, { signal });
      current = await inspect(templateName);
    }
    throw new Error(
      `Template ${templateName}@${templateVersion} is still preparing. Retry setup to check the existing version again.`,
    );
  }

  return (size: CreateInput["size"]): Promise<void> => {
    createInput.shape.size.parse(size);
    const operation = queue.then(() => prepare(size));
    queue = operation.catch(() => {});
    return operation;
  };
}
