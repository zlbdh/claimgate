#!/bin/sh
set -eu

output_dir=${1:?usage: prepare-release-artifacts.sh OUTPUT_DIRECTORY}
node_archive=node-v22.20.0-linux-x64.tar.gz
node_sha=eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29
docker_command=${CLAIMGATE_DOCKER:-docker}
curl_command=${CLAIMGATE_CURL:-curl}
sha_command=${CLAIMGATE_SHA256SUM:-sha256sum}
git_command=${CLAIMGATE_GIT:-git}

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)
project_root=$(dirname "$script_dir")
mkdir -p "$output_dir"
if [ -L "$output_dir" ]; then exit 1; fi
if [ ! -d "$output_dir" ]; then exit 1; fi
output_dir=$(CDPATH= cd -P "$output_dir" && pwd -P)
case "$output_dir" in /*) ;; *) exit 1;; esac
lock_dir="$output_dir/.prepare.lock"
if ! mkdir "$lock_dir"; then exit 1; fi
lock_token=${CLAIMGATE_LOCK_TOKEN:-"$$.$(date +%s)"}
printf '%s\n' "$lock_token" > "$lock_dir/owner"
manifest="$output_dir/SHA256SUMS.txt"
manifest_tmp="$output_dir/.SHA256SUMS.txt.$$"
image_id_file="$lock_dir/image-id"
context_tar="$lock_dir/context.tar"
rm -f "$manifest" "$manifest_tmp"
cleanup() {
  rm -f "$manifest_tmp"
  if [ -f "$lock_dir/owner" ] && [ "$(cat "$lock_dir/owner")" = "$lock_token" ]; then
    rm -f "$image_id_file" "$context_tar" "$lock_dir/owner"
    rmdir "$lock_dir" 2>/dev/null || :
  fi
}
on_signal() { trap - HUP INT TERM; exit 1; }
trap cleanup 0
trap on_signal HUP INT TERM
cd "$project_root"
if ! "$git_command" diff --quiet; then exit 1; fi
if ! "$git_command" diff --cached --quiet; then exit 1; fi
untracked=$("$git_command" ls-files --others --exclude-standard) || exit 1
if [ -n "$untracked" ]; then exit 1; fi
revision=$("$git_command" rev-parse --verify HEAD)
case "$revision" in ????????-*) exit 1;; esac
if [ "${#revision}" -ne 40 ]; then exit 1; fi
case "$revision" in *[!0-9a-f]*) exit 1;; esac

"$git_command" archive --format=tar --output="$context_tar" "$revision"
"$docker_command" build --platform linux/amd64 -f deploy/Dockerfile --iidfile "$image_id_file" - < "$context_tar"
image_id=$(sed -n '1p' "$image_id_file")
case "$image_id" in sha256:*) image_digest=${image_id#sha256:};; *) exit 1;; esac
if [ "${#image_digest}" -ne 64 ]; then exit 1; fi
case "$image_digest" in *[!0-9a-f]*) exit 1;; esac
"$docker_command" run --rm --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$output_dir,dst=/export" \
  --entrypoint sh "$image_id" -ceu '
    tar -C /app -czf /export/claimgate-app-linux-amd64.tar.gz .
    cp /app/scripts/validate-release-archive.py /export/validate-release-archive.py
  '
"$curl_command" --fail --location --proto '=https' --tlsv1.2 \
  --output "$output_dir/$node_archive" \
  "https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.gz"
node_output=$("$sha_command" "$output_dir/$node_archive") || exit 1
set -- $node_output
if [ "$#" -lt 1 ] || [ "$1" != "$node_sha" ]; then exit 1; fi
printf '%s\n' "$revision" > "$output_dir/CLAIMGATE_REVISION"

(
  cd "$output_dir"
  : > "$manifest_tmp"
  for file in claimgate-app-linux-amd64.tar.gz "$node_archive" validate-release-archive.py CLAIMGATE_REVISION; do
    sha_output=$("$sha_command" "$file") || exit 1
    set -- $sha_output
    if [ "$#" -lt 1 ]; then exit 1; fi
    digest=$1
    if [ "${#digest}" -ne 64 ]; then exit 1; fi
    case "$digest" in *[!0-9a-f]*) exit 1;; esac
    printf '%s  %s\n' "$digest" "$file" >> "$manifest_tmp"
  done
)
mv -f "$manifest_tmp" "$manifest"
cleanup
trap - HUP INT TERM
trap - 0
