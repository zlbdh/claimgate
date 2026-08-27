#!/bin/sh
set -eu

deployment_host=${1:?usage: deploy-release-over-ssh.sh HOST PORT USER RELEASE_ID}
deployment_port=${2:?missing deployment port}
deployment_user=${3:?missing deployment user}
release_id=${4:?missing release id}
ssh_command=${CLAIMGATE_SSH:-ssh}
git_command=${CLAIMGATE_GIT:-git}
script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
project_root=$(dirname "$script_dir")
artifact_dir=${CLAIMGATE_ARTIFACT_DIR:-"$project_root/release-out"}

case "$deployment_host$deployment_user$release_id" in *'
'*) exit 1;; esac
case "$deployment_host" in
  ''|.*|*..*|*.|-*|*[!A-Za-z0-9.-]*) exit 1;;
esac
if [ "${#deployment_host}" -gt 253 ]; then exit 1; fi
case "$deployment_port" in ''|*[!0-9]*) exit 1;; esac
if [ "${#deployment_port}" -gt 5 ]; then exit 1; fi
if [ "$deployment_port" -lt 1 ] || [ "$deployment_port" -gt 65535 ]; then exit 1; fi
case "$deployment_user" in ''|*[!a-z0-9_-]*) exit 1;; esac
case "$deployment_user" in [a-z_]*) ;; *) exit 1;; esac
if [ "${#deployment_user}" -gt 32 ]; then exit 1; fi
case "$release_id" in ''|*[!0-9a-f]*|.*|*.) exit 1;; esac
if [ "${#release_id}" -ne 40 ]; then exit 1; fi
if [ ! -f "$artifact_dir/CLAIMGATE_REVISION" ] || [ -L "$artifact_dir/CLAIMGATE_REVISION" ]; then exit 1; fi
if [ "$(cat "$artifact_dir/CLAIMGATE_REVISION")" != "$release_id" ]; then exit 1; fi
if ! "$git_command" -C "$project_root" diff --quiet; then exit 1; fi
if ! "$git_command" -C "$project_root" diff --cached --quiet; then exit 1; fi
untracked=$("$git_command" -C "$project_root" ls-files --others --exclude-standard) || exit 1
if [ -n "$untracked" ]; then exit 1; fi
if [ "$("$git_command" -C "$project_root" rev-parse --verify HEAD)" != "$release_id" ]; then exit 1; fi

upload_dir="/var/lib/claimgate-release-upload/$release_id"
app_dir="/opt/claimgate/releases/$release_id"
runtime_dir="/opt/claimgate/runtime/releases/$release_id"

# OpenSSH joins remote command arguments for a remote shell. Every variable below is
# allowlisted above; the command words and controller bytes are fixed locally.
"$ssh_command" -l "$deployment_user" -p "$deployment_port" "$deployment_host" sh -s -- \
  "$upload_dir" "$release_id" "$app_dir" "$runtime_dir" \
  < "$script_dir/verify-release-artifacts.sh"
