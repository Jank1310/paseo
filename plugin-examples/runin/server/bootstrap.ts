// Start only on a cloned Machine, so Golden captures never contain a daemon identity.
export const bootstrap = String.raw`set -eu
mkdir -p "$HOME/.paseo"
log="$HOME/.paseo/runin-setup.log"
exec 3>&1
exec >"$log" 2>&1
trap 'code=$?; if [ "$code" -ne 0 ]; then tail -n 30 "$log" >&3; fi' EXIT
export PATH="/usr/local/bin:/usr/bin:/bin"
export PASEO_LISTEN=127.0.0.1:6767
export PASEO_RELAY_ENABLED=false
sudo -n systemctl enable --now paseo.service
attempt=0
while [ "$attempt" -lt 30 ]; do
  if paseo daemon status --json > "$HOME/.paseo/runin-status.json" && node -e 'const fs = require("node:fs"); const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(status.connectedDaemon === "reachable" ? 0 : 1)' "$HOME/.paseo/runin-status.json"; then
    cat "$HOME/.paseo/runin-status.json" >&3
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
sudo -n journalctl -u paseo.service -n 30 --no-pager
exit 1
`;
