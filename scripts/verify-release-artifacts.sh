#!/bin/sh
set -eu

upload_dir=${1:?usage: verify-release-artifacts.sh UPLOAD_DIR RELEASE_ID APP_DIR RUNTIME_DIR}
release_id=${2:?missing release id}
app_dir=${3:?missing app release directory}
runtime_dir=${4:?missing runtime release directory}
release_root=${CLAIMGATE_RELEASE_ROOT:-/opt/claimgate}
upload_root=${CLAIMGATE_UPLOAD_ROOT:-/var/lib/claimgate-release-upload}
node_archive=node-v22.20.0-linux-x64.tar.gz
node_sha=eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29
stat_command=${CLAIMGATE_STAT:-stat}
sha_command=${CLAIMGATE_SHA256SUM:-sha256sum}
systemd_run=${CLAIMGATE_SYSTEMD_RUN:-systemd-run}
install_command=${CLAIMGATE_INSTALL:-install}
tar_command=${CLAIMGATE_TAR:-tar}
realpath_command=${CLAIMGATE_REALPATH:-realpath}
runuser_command=${CLAIMGATE_RUNUSER:-runuser}
deploy_lock_root=${CLAIMGATE_DEPLOY_LOCK_ROOT:-/run/claimgate-release-deploy}

fail() { exit 1; }
case "$release_id" in ''|*[!0-9a-f]*|.*|*.) fail;; esac
if [ "${#release_id}" -ne 40 ]; then fail; fi
if [ ! -d "$deploy_lock_root" ] || [ -L "$deploy_lock_root" ]; then fail; fi
if [ "$("$realpath_command" -- "$deploy_lock_root")" != "$deploy_lock_root" ]; then fail; fi
if [ "$("$stat_command" -c '%U:%G %a' -- "$deploy_lock_root")" != 'root:root 700' ]; then fail; fi
deploy_lock="$deploy_lock_root/active"
if ! mkdir "$deploy_lock"; then fail; fi
deploy_token=${CLAIMGATE_DEPLOY_LOCK_TOKEN:-"$$.$(date +%s)"}
printf '%s\n' "$deploy_token" > "$deploy_lock/owner"
cleanup_lock() {
  if [ -f "$deploy_lock/owner" ]; then
    if [ "$(cat "$deploy_lock/owner")" = "$deploy_token" ]; then
      rm -f "$deploy_lock/owner"
      rmdir "$deploy_lock" 2>/dev/null || :
    fi
  fi
}
on_signal() { trap - HUP INT TERM; exit 1; }
trap cleanup_lock 0
trap on_signal HUP INT TERM

if [ "$(basename -- "$app_dir")" != "$release_id" ]; then fail; fi
if [ "$(basename -- "$runtime_dir")" != "$release_id" ]; then fail; fi
if [ "$(dirname -- "$app_dir")" != "$release_root/releases" ]; then fail; fi
if [ "$(dirname -- "$runtime_dir")" != "$release_root/runtime/releases" ]; then fail; fi
if [ "$(dirname -- "$upload_dir")" != "$upload_root" ]; then fail; fi
for directory in "$(dirname -- "$release_root")" "$release_root" "$release_root/releases" "$release_root/runtime" \
  "$release_root/runtime/releases" "$(dirname -- "$upload_root")" "$upload_root" "$upload_dir"; do
  if [ ! -d "$directory" ] || [ -L "$directory" ]; then fail; fi
  if [ "$("$realpath_command" -- "$directory")" != "$directory" ]; then fail; fi
  metadata=$("$stat_command" -c '%U:%G %a' -- "$directory")
  expected_mode=755
  if [ "$directory" = "$upload_root" ] || [ "$directory" = "$upload_dir" ]; then expected_mode=700; fi
  if [ "$metadata" != "root:root $expected_mode" ]; then fail; fi
done
if [ ! -d "$upload_dir" ]; then fail; fi
if [ -L "$upload_dir" ]; then fail; fi
if [ "$("$stat_command" -c '%U:%G %a' -- "$upload_dir")" != 'root:root 700' ]; then fail; fi
case "$app_dir" in "$release_root/releases/$release_id") ;; *) exit 1;; esac
case "$runtime_dir" in "$release_root/runtime/releases/$release_id") ;; *) exit 1;; esac
if [ -e "$app_dir" ]; then fail; fi
if [ -L "$app_dir" ]; then fail; fi
if [ -e "$runtime_dir" ]; then fail; fi
if [ -L "$runtime_dir" ]; then fail; fi
cd "$upload_dir"
for file in SHA256SUMS.txt claimgate-app-linux-amd64.tar.gz "$node_archive" validate-release-archive.py CLAIMGATE_REVISION; do
  if [ ! -f "$file" ]; then fail; fi
  if [ -L "$file" ]; then fail; fi
  if [ "$("$stat_command" -c '%U:%G %a' -- "$file")" != 'root:root 600' ]; then fail; fi
done

manifest_count=0
seen_app=0
seen_node=0
seen_validator=0
seen_revision=0
while IFS= read -r line; do
  manifest_count=$((manifest_count + 1))
  hash=${line%%  *}
  name=${line#*  }
  if [ "$line" != "$hash  $name" ]; then fail; fi
  if [ "${#hash}" -ne 64 ]; then fail; fi
  case "$hash" in *[!0-9a-f]*) fail;; esac
  case "$name" in
    claimgate-app-linux-amd64.tar.gz) seen_app=$((seen_app + 1));;
    node-v22.20.0-linux-x64.tar.gz) seen_node=$((seen_node + 1));;
    validate-release-archive.py) seen_validator=$((seen_validator + 1));;
    CLAIMGATE_REVISION) seen_revision=$((seen_revision + 1));;
    *) fail;;
  esac
done < SHA256SUMS.txt
if [ "$manifest_count" -ne 4 ]; then fail; fi
if [ "$seen_app" -ne 1 ]; then fail; fi
if [ "$seen_node" -ne 1 ]; then fail; fi
if [ "$seen_validator" -ne 1 ]; then fail; fi
if [ "$seen_revision" -ne 1 ]; then fail; fi
if [ "$(cat CLAIMGATE_REVISION)" != "$release_id" ]; then fail; fi

node_output=$("$sha_command" "$node_archive") || fail
set -- $node_output
if [ "$#" -lt 1 ] || [ "$1" != "$node_sha" ]; then fail; fi
"$sha_command" -c SHA256SUMS.txt

common_properties='--property=NoNewPrivileges=yes --property=PrivateNetwork=yes --property=ProtectSystem=strict --property=ProtectHome=yes --property=PrivateDevices=yes --property=PrivateTmp=yes --property=RuntimeMaxSec=30s --property=UMask=0077 --property=MemoryMax=192M --property=CPUQuota=50% --property=TasksMax=8 --property=CapabilityBoundingSet= --property=RestrictAddressFamilies=AF_UNIX'
# Word splitting is intentional for the fixed, non-input property list above.
# shellcheck disable=SC2086
"$systemd_run" --quiet --wait --pipe --collect --uid=root \
  --unit="claimgate-archive-app-$release_id" --working-directory="$upload_dir" \
  $common_properties --property="ReadOnlyPaths=$upload_dir" \
  /usr/bin/python3 ./validate-release-archive.py claimgate-app-linux-amd64.tar.gz 0
# shellcheck disable=SC2086
"$systemd_run" --quiet --wait --pipe --collect --uid=root \
  --unit="claimgate-archive-node-$release_id" --working-directory="$upload_dir" \
  $common_properties --property="ReadOnlyPaths=$upload_dir" \
  /usr/bin/python3 ./validate-release-archive.py "$node_archive" 1

umask 022
"$install_command" -d -o root -g root -m 0755 "$app_dir" "$runtime_dir"
"$tar_command" -xzf claimgate-app-linux-amd64.tar.gz -C "$app_dir" \
  --no-same-owner --no-same-permissions
"$tar_command" -xzf "$node_archive" -C "$runtime_dir" \
  --strip-components=1 --no-same-owner --no-same-permissions

"$runuser_command" -u claimgate -- "$runtime_dir/bin/node" -e "
if(process.version!=='v22.20.0'||process.platform!=='linux'||process.arch!=='x64')process.exit(2);
const Database=require(process.argv[1]+'/node_modules/better-sqlite3');
const database=new Database(':memory:');
const row=database.prepare('SELECT 1 AS value').get();
database.close();
if(row.value!==1)process.exit(3);
" "$app_dir"
cleanup_lock
trap - HUP INT TERM
trap - 0
