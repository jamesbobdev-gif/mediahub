#!/usr/bin/env bash
# Media Hub installer for Raspberry Pi OS (64-bit) / Debian / Ubuntu.
# Installs Node 22 and git, clones the hub into ~/mediahub, installs a systemd service and starts it.
# Usage:  curl -fsSL https://raw.githubusercontent.com/jamesbobdev-gif/mediahub/main/deploy/install-pi.sh | bash
set -euo pipefail

REPO="${MEDIAHUB_REPO:-https://github.com/jamesbobdev-gif/mediahub.git}"
DIR="${MEDIAHUB_DIR:-$HOME/mediahub}"
USER_NAME="$(id -un)"

echo "== Media Hub installer =="
if [ "$(uname -m)" != "aarch64" ] && [ "$(uname -m)" != "x86_64" ]; then
  echo "This OS is not 64-bit ($(uname -m)). Node 22 needs 64-bit Raspberry Pi OS. Re-flash and try again." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "-- Installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v git >/dev/null 2>&1 || sudo apt-get install -y git
echo "-- Node $(node --version)"

if [ -d "$DIR/.git" ]; then
  echo "-- Updating existing checkout in $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "-- Cloning into $DIR"
  git clone "$REPO" "$DIR"
fi

echo "-- Installing systemd service (user: $USER_NAME)"
sed -e "s#^User=.*#User=$USER_NAME#" -e "s#^WorkingDirectory=.*#WorkingDirectory=$DIR#" -e "s#^ExecStart=.*#ExecStart=$(command -v node) server/index.js#" \
  "$DIR/deploy/mediahub.service" | sudo tee /etc/systemd/system/mediahub.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now mediahub
sleep 2
if systemctl is-active --quiet mediahub; then
  IP="$(hostname -I | awk '{print $1}')"
  echo
  echo "== Media Hub is running =="
  echo "Open this on the TV's browser:   http://$IP:8787"
  echo "Allow only your TV:              nano $DIR/config/access.json"
  echo "Add real sources:                nano $DIR/config/sources.json"
  echo "Logs:                            journalctl -u mediahub -f"
else
  echo "Service failed to start. Details:" >&2
  journalctl -u mediahub -n 30 --no-pager >&2
  exit 1
fi
