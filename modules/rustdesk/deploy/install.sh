#!/usr/bin/env bash
# Install the unmodified official server; run only after host/backup checks.
set -euo pipefail
test "$(id -u)" = 0
: "${ATB_RUSTDESK_ARCHIVE:?Path to official 1.1.16 linux-amd64 zip}"
: "${ATB_RELAY_SERVER:?Public relay host:port}"
ATB_CURRENT="${ATB_CURRENT:-/opt/freecamera/current}"
ATB_SERVICE="${ATB_SERVICE:-freecamera.service}"
[[ "$ATB_CURRENT" =~ ^/[a-zA-Z0-9_./-]+$ && "$ATB_CURRENT" != *..* ]]
[[ "$ATB_SERVICE" =~ ^[a-zA-Z0-9_-]+\.service$ ]]
[[ "$ATB_RELAY_SERVER" =~ ^[a-zA-Z0-9.-]+:[0-9]{1,5}$ ]]
test -f "$ATB_CURRENT/modules/rustdesk/module.json"
printf '%s  %s\n' '0565c41affe6c3f409b0bddfaf5a24ccbf3f64f5f8e3fec250b69a0d5f6bdbcf' "$ATB_RUSTDESK_ARCHIVE" | sha256sum -c -
base=/opt/atb-modules/rustdesk/1.1.16
state=/var/lib/atb-rustdesk
if ! id atb-rustdesk >/dev/null 2>&1; then
  useradd --system --home-dir "$state" --shell /usr/sbin/nologin atb-rustdesk
fi
test "$(id -u atb-rustdesk)" != 0
install -d -m 755 "$base" /etc/atb-modules
install -d -o atb-rustdesk -g atb-rustdesk -m 700 "$state"
python3 - "$ATB_RUSTDESK_ARCHIVE" "$base" <<'PY'
import pathlib, shutil, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    for name in ('hbbs', 'hbbr'):
        target = pathlib.Path(sys.argv[2]) / name
        with z.open('amd64/' + name) as source, target.open('wb') as output:
            shutil.copyfileobj(source, output)
        target.chmod(0o755)
PY
"$base/hbbs" --version
"$base/hbbr" --version
umask 077
printf 'RELAY_SERVER=%s\nALWAYS_USE_RELAY=N\n' "$ATB_RELAY_SERVER" > /etc/atb-modules/rustdesk.env
chmod 600 /etc/atb-modules/rustdesk.env
for daemon in hbbs hbbr; do
  if [ "$daemon" = hbbs ]; then
    command="$base/hbbs -p 21116 -r \${RELAY_SERVER} -k _"
    after="network-online.target $ATB_SERVICE"
    pre=''
  else
    command="$base/hbbr -p 21117 -k _"
    after="network-online.target $ATB_SERVICE atb-rustdesk-hbbs.service"
    pre="ExecStartPre=/usr/bin/test -s $state/id_ed25519"
  fi
  cat > "/etc/systemd/system/atb-rustdesk-$daemon.service" <<EOF
[Unit]
Description=ATB RustDesk $daemon (official 1.1.16)
After=$after
PartOf=$ATB_SERVICE
ConditionPathExists=$ATB_CURRENT/modules/rustdesk/module.json

[Service]
Type=simple
User=atb-rustdesk
Group=atb-rustdesk
WorkingDirectory=$state
EnvironmentFile=/etc/atb-modules/rustdesk.env
$pre
ExecStart=$command
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$state
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
MemoryMax=256M
TasksMax=128
LimitNOFILE=4096
StandardOutput=journal
StandardError=journal
EOF
done
install -d -m 755 "/etc/systemd/system/$ATB_SERVICE.d"
cat > "/etc/systemd/system/$ATB_SERVICE.d/rustdesk.conf" <<'EOF'
[Unit]
Wants=atb-rustdesk-hbbs.service atb-rustdesk-hbbr.service
EOF
systemd-analyze verify /etc/systemd/system/atb-rustdesk-hbbs.service /etc/systemd/system/atb-rustdesk-hbbr.service
systemctl daemon-reload
systemctl start atb-rustdesk-hbbs.service
for attempt in $(seq 1 30); do
  test -s "$state/id_ed25519.pub" && break
  sleep 0.2
done
test -s "$state/id_ed25519" && test -s "$state/id_ed25519.pub"
chmod 600 "$state/id_ed25519" "$state/id_ed25519.pub"
systemctl start atb-rustdesk-hbbr.service
systemctl is-active --quiet atb-rustdesk-hbbs.service atb-rustdesk-hbbr.service
printf 'RUSTDESK_INSTALL_PASS\n'
