# ClaimGate deployment runbook

This is a redacted, additive deployment procedure. It contains no public server address, login name, credential, private inventory, or resolved certificate path.

## Deployment boundary

| Resource | ClaimGate-only value |
| --- | --- |
| Public origin | `https://ds.zlbdh.top:8443` |
| Runtime listener | `127.0.0.1:18121` |
| Immutable releases | `/opt/claimgate/releases/<release-id>` |
| Active application | `/opt/claimgate/current` |
| Isolated Node runtime | `/opt/claimgate/runtime/current/bin/node` |
| SQLite state | `/var/lib/claimgate` |
| Ingress gate state | `/var/lib/claimgate-ingress-gate` |
| Ingress gate socket | `/run/claimgate-ingress-gate/gate.sock` |
| Private environment | `/etc/claimgate/claimgate.env` |
| Process identity | dedicated `claimgate` system user and group |
| Unit | `claimgate.service` |
| Ingress gate unit | `claimgate-ingress-gate.service` |
| Reverse proxy | new ClaimGate-only Nginx includes |

Treat this as a configuration template, not a statement of current server inventory. Production supports exactly the two dedicated systemd units plus the dedicated Nginx vhost. `docker-compose.example.yml` is only a local app-image and health-smoke aid; never combine it with the production vhost or treat it as a production alternative.

If inventory shows that the selected public TLS port is already shared by another hostname, add only a dedicated SNI vhost. In every topology, do not edit, stop, restart, rename, or reuse any existing vhost, unit, process, project directory, listener, certificate, VPN, or proxy resource.

## Pinned build input

The Dockerfile pins this reviewed tag and immutable manifest digest:

`node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e`

Treat the tag and digest as one input. A Node upgrade requires verifying the new official tag and digest, editing both together, rebuilding on Linux/amd64, rerunning all tests and runtime checks, regenerating the release archives and checksums, and reviewing systemd memory limits. Never float the tag, reuse an old digest with a new tag, or update the runtime independently of the application image.

The Git revision, immutable build context, image ID, official Node checksum, and transfer manifest establish provenance and integrity; they do not claim bit-for-bit reproducibility. Debian packages installed during the pinned base-image build can change at their configured repository snapshot. A reproducible-build claim would require separately pinned package repositories and byte-for-byte comparison evidence.

`npm run verify:deployment` is a mandatory release gate after the portable `npm run verify`; it intentionally remains separate because it requires Docker/Linux capabilities. It must pass on the exact reviewed checkout before creating release artifacts. Deployment also requires a target-host `systemd-analyze verify` of both rendered units and `nginx -t` of the rendered full template with its actual certificate paths; local synthetic behavior tests do not replace these host-specific checks.

## Linux-native release archives

`better-sqlite3` is native. Never upload Windows `node_modules`, extract and repack a release on Windows, or copy `/app` as a Windows host directory. Tar must run inside the Linux container so executable bits and symbolic links survive intact.

From a clean checkout, build the pinned image:

```sh
set -eu
sh scripts/prepare-release-artifacts.sh "$(pwd)/release-out"
```

The preparation script requires a completely clean Git checkout, records the full 40-character HEAD in `CLAIMGATE_REVISION`, and takes an owner-token output lock. It creates a Git archive for that revision inside the lock and builds from the immutable tar stream, never from mutable `.`; it exports by Docker's immutable image ID rather than a tag. It verifies the official Node SHA, parses each digest as exactly 64 lowercase hex characters, and emits four canonical manifest rows itself. Cleanup removes a lock only when its owner token still matches, preventing ABA deletion of a successor lock; concurrent or stale-locked preparation fails closed.

Only the two opaque tar files, validator, `CLAIMGATE_REVISION`, and `SHA256SUMS.txt` cross the host boundary. The release directory name must exactly equal that revision. Do not extract either archive on Windows or before upload. Create both the upload root and its revision child as `root:root 0700`, and every `/opt`/ClaimGate release/runtime parent as exact `root:root 0755`. None may be a symlink. Require each uploaded file to be a non-symlink regular file owned `root:root 0600`.

The current Linux release-candidate measurement was: application 1,871 members, 76,899,929 member bytes, longest path 108 bytes, largest file 18,387,016 bytes, compressed tar 28,606,009 bytes; official Node runtime 6,195 members, 197,421,696 member bytes, longest path 136 bytes, largest file 123,183,528 bytes, compressed tar 56,645,685 bytes. The validator caps each archive at 10,000 members, 512-byte paths, 160 MiB per member, 320 MiB total members, 384 MiB decompressed stream, and 128 MiB compressed input. Re-measure the final built image with the same member/path/size procedure; any cap breach stops release and requires an explicit reviewed limit change.

Node runtime archive risk: never create a runtime tar from the image's `/usr/local`; that tree contains absolute symlinks whose meaning changes under an isolated release root. Use only the official `node-v22.20.0-linux-x64.tar.gz`, whose fixed SHA-256 above was verified against the official release checksum list. The official archive includes its own package-manager tooling, so the final release owner must still accept that shipped surface or approve a different official artifact in a separate review.

On the server, require Python 3.11.x exactly; the validator deliberately rejects other minor versions because it hardens Python 3.11 tar parsing internals. Review and retest before any Python minor upgrade. Do not upload or execute a self-verified controller. Send the reviewed local controller bytes through the authenticated SSH channel as stdin:

```sh
set -eu
sh scripts/deploy-release-over-ssh.sh \
  REPLACE_WITH_DEPLOYMENT_HOST REPLACE_WITH_DEPLOYMENT_PORT \
  REPLACE_WITH_DEPLOYMENT_USER REPLACE_WITH_RELEASE_ID
```

The local controller accepts only a full lowercase 40-hex Git revision as release ID, requires it to match the prepared provenance, then uses `-l USER -p PORT HOST` exactly. OpenSSH constructs a remote-shell command rather than preserving argv, so every variable is narrowly allowlisted and command words are fixed. The remote script verifies canonical parents, exact revision paths, four manifest rows, the fixed Node SHA, and the transfer manifest before sandboxed validation.

The validator reads metadata only and fails closed on absolute/traversal paths, unsafe symbolic or hard links, special files, duplicate/non-directory ancestors, malformed PAX/GNU extensions, invalid checksums, truncation, trailing data, or size/member limits. It never extracts content or prints a rejected member name.

The script extracts only after both validators pass, disables stored owner/permission restoration, strips the official Node archive's one top-level directory, and verifies Node version/platform/architecture plus a real application `better-sqlite3` open/query/close. Only after the script returns zero may the runtime/application symlinks move. Create `.next/cache` under the new application release, owned by the service identity; keep every other release file read-only.

The Compose file is a local app-image/health smoke only. It is incomplete for production ingress enforcement and must never be paired with the production Nginx vhost. Its strict local probe is:

```sh
docker compose -f deploy/docker-compose.example.yml up -d --build
docker compose -f deploy/docker-compose.example.yml exec app \
  node scripts/healthcheck.mjs http://127.0.0.1:3000
```

## Private environment

Before any extraction, create the `claimgate` system group and non-login service account. The verifier fixes extraction `umask 022` and runs the final Node/native SQLite smoke through that identity, so a root caller's inherited `umask 077` cannot hide unreadable artifacts.

```sh
set -eu
getent group claimgate >/dev/null 2>&1 || groupadd --system claimgate
id claimgate >/dev/null 2>&1 || useradd --system --gid claimgate --home-dir /nonexistent --shell /usr/sbin/nologin claimgate
install -d -o root -g root -m 0755 /opt/claimgate /opt/claimgate/releases /opt/claimgate/runtime /opt/claimgate/runtime/releases
install -d -o root -g root -m 0700 /run/claimgate-release-deploy /var/lib/claimgate-release-upload
```

The remote verifier atomically owns `/run/claimgate-release-deploy/active` from pre-verification through both archive validators, extraction, and the service-identity smoke. A second deployment and any stale lock fail closed. Recover a stale lock only after proving no verifier process is alive, preserving its owner token in the incident record, and removing only that ClaimGate lock directory.

Create both environment files as `root:root 0600` outside the repository before inserting any value. The systemd manager reads `EnvironmentFile` before dropping privileges, so neither service identity nor Nginx needs direct file access.

```sh
install -o root -g root -m 0600 /dev/null /etc/claimgate/claimgate.env
install -o root -g root -m 0600 /dev/null /etc/claimgate/ingress-gate.env
stat -c '%U:%G %a' /etc/claimgate/claimgate.env /etc/claimgate/ingress-gate.env
```

Require exactly `root:root 600` from both `stat` rows before enabling either unit; abort on symlinks, other owners, or broader modes. Generate three independent, stable application Base64 keys of at least 32 decoded bytes. Never reuse, print, or commit them.

```dotenv
CLAIMGATE_HMAC_KEY=<independent-stable-base64-key>
CLAIMGATE_SESSION_KEY=<independent-stable-base64-key>
CLAIMGATE_CSRF_KEY=<independent-stable-base64-key>
CLAIMGATE_DATABASE_PATH=/var/lib/claimgate/claimgate.db
CLAIMGATE_APP_ORIGIN=https://ds.zlbdh.top:8443
```

Keep these values stable across normal restarts and version rollbacks. The supported health command is `node scripts/healthcheck.mjs <origin>`; it enforces the exact status, content type, cache policy, bounded body, and body schema. A generic success-status probe is not sufficient.

Create a separate `/etc/claimgate/ingress-gate.env`, read by systemd but not the application process or Nginx worker. Its master key is independent and stable across restart/rollback:

```dotenv
CLAIMGATE_INGRESS_KEY=<independent-stable-base64-key>
```

The database path is deliberately fixed at `/var/lib/claimgate-ingress-gate/ingress-gate.db`, not configurable through environment. Never place `CLAIMGATE_INGRESS_KEY` in the application environment, Nginx config, repository, command line, or logs. Changing it while the gate database exists fails startup rather than silently resetting source quotas.

## Read-only preflight

Save these results in a private location outside the repository before mutation:

1. Active listeners and owners, especially ports `80`, `8443`, and `18121`.
2. Existing Nginx includes plus complete `nginx -T` and `nginx -t` results.
3. Existing units, processes/containers, disk, and memory.
4. Health baselines for every existing application, VPN, and proxy lifeline.
5. Checksums or copies of the exact surrounding Nginx include state.
6. ClaimGate DNS readiness and the absence of every proposed ClaimGate-only path/name, including the ingress socket, state directory, user, and unit.

Stop if any ClaimGate port, path, unit, identity, zone name, or vhost filename belongs to another resource. Never free a resource by stopping its owner.

## HTTP-only ACME bootstrap

Certificate issuance is a separate first phase. Create the dedicated `/var/www/claimgate-acme` webroot and install a private rendered copy of `deploy/nginx-claimgate-acme-bootstrap.conf.example`. It contains only the port-80 server and ACME location. Do not install the 8443 block before its certificate files exist.

Run `nginx -t`, then gracefully reload once to activate only that new bootstrap include. Request a dedicated certificate in cert-only webroot mode:

```sh
certbot certonly --webroot --webroot-path /var/www/claimgate-acme \
  --domain ds.zlbdh.top --cert-name REPLACE_WITH_DEDICATED_CERTIFICATE_NAME
```

Do not use an Nginx installer plugin, shared-config editor, deploy hook, or automatic reload. Those modes may rewrite or reload unrelated vhosts. After issuance, render the full ClaimGate example with only the dedicated certificate-name placeholder replaced. Replace the bootstrap include with the full ClaimGate include, run `nginx -t`, and only then perform one deliberate graceful reload.

## Additive deployment

1. Create the dedicated `claimgate` and `claimgate-gate` system identities without interactive login and only the ClaimGate directories listed above. The gate uses group `www-data` solely to expose its protected Unix socket to Nginx; its state directory remains mode `0700`.
2. Verify `SHA256SUMS.txt` on the server, inspect both archives, and extract into new immutable release/runtime directories.
3. Verify Node version/platform/architecture and load the native SQLite module before switching either active symlink.
4. Install private rendered copies of `deploy/claimgate.service.example` and `deploy/claimgate-ingress-gate.service.example`; run `systemd-analyze verify` on both.
5. Point both `current` symlinks at the verified versions and reload only the systemd manager.
6. First run `systemctl enable --now claimgate-ingress-gate.service`. Require `is-enabled` and `is-active`, then verify the socket is owned by the dedicated gate identity/group and is not accessible to other users.
7. Run `systemctl enable --now claimgate.service`; require both `systemctl is-enabled claimgate.service` and `systemctl is-active claimgate.service`.
8. Run the strict server-loopback health command shown below. Inspect only bounded, source-free ClaimGate journal output on failure.
9. Complete the HTTP-only ACME bootstrap and cert-only issuance procedure. Install the full vhost only while the gate is active; run `nginx -t`, then reload gracefully.
10. Run the rolling-window gate acceptance and all three verification layers, then compare every existing-service baseline.

The Nginx vhost hardcodes the canonical external origin in its redirect, `Host`, and `X-Forwarded-Host` headers and disables proxy caching. It does not reflect an untrusted request host.

## Demo-start ingress limiter

Nginx `limit_req` is a leaky bucket whose rate is expressed only in `r/s` or `r/m`; it cannot enforce an exact five-event rolling ten-minute window. ClaimGate therefore uses Nginx's compiled `auth_request` module and the dedicated `claimgate-ingress-gate.service`.

For exact `POST /api/demo/start`, Nginx sends a bodyless internal subrequest over `/run/claimgate-ingress-gate/gate.sock`. Request-header forwarding is disabled. HTTP-level maps use anchored, case-sensitive regexes with escaped hostname dots to compare the incoming Origin and Fetch Metadata, then reduce each to a fixed `0` or `1`; Nginx supplies only fixed Host/Content-Length/Connection plus overwritten `X-ClaimGate-Source`, `X-ClaimGate-Origin-Policy`, and `X-ClaimGate-Fetch-Policy`. Cookie, Authorization, raw Origin/Fetch strings, client forwarding headers, and all other headers never reach the helper.

Before deriving a source pseudonym or consuming quota, the helper requires both policy bits to equal `1`. Nginx uses `$realip_remote_addr`, preserving the direct edge peer even if a parent enables real-IP rewriting; forwarding headers are never the quota source. This assumes clients connect directly to this edge. Adding a trusted proxy or IPv6 listener requires review; dotted and hexadecimal IPv4-mapped IPv6 are normalized to IPv4, while native IPv6 `/64` policy remains undecided. SQLite uses zero busy wait in both constructor and PRAGMA, well below the Nginx 1 s deadline. Lock contention returns 500 immediately without consumption. A disconnect after commit may still spend that source's quota because the helper cannot transactionally observe the downstream connection.

This gate is a quota prefilter, not the final HTTP authorization boundary. Stock Nginx 1.22 collapses repeated same-value Origin fields when exposing `$http_origin`; such a request can consume its source/shared-NAT ingress quota. The original request headers still reach the application, whose Task 5 exact Origin/Fetch checks reject duplicate or malformed values before instance creation. This known availability boundary does not justify adding njs/lua or another front proxy.

The helper validates the source, normalizes it in memory, and immediately derives a 32-byte HMAC-SHA-256 pseudonym with the dedicated key. SQLite never persists the raw source IP, header, request body, cookie, or application identifier—only the pseudonym, up to five event times, monotonic high-water time, and fixed schema metadata.

The transaction retains only events inside the rolling ten-minute window. The first five are allowed; every later event is rejected until the oldest expires. `BEGIN IMMEDIATE`, synchronous local SQLite state, key continuity checking, and monotonic high-water time make the gate atomic, restart-safe, and fail closed on key/schema/clock/database errors. Stale rows are pruned and active pseudonyms are capped at 4,096 so disk/cardinality remains bounded.

Nginx allows only the helper's 2xx result. Origin/Fetch policy failures use an internal bodyless 401 that Nginx maps to public 403 without `WWW-Authenticate`; quota denial uses internal 403 and becomes public 429 with bounded `Retry-After`. Unavailable or malformed helper responses remain 5xx and do not reach the application. Request handling emits no source or exception detail.

Verification uses `npm test -- scripts/ingress-gate.test.ts`: its controlled clock spaces five accepted events across eight minutes, rejects the sixth before ten minutes, then allows only after the oldest event expires. It also closes/reopens the database and checks that the raw source string is absent. Production acceptance sends five valid same-origin POSTs, restarts only `claimgate-ingress-gate.service`, and requires the sixth POST to return 429 before any app-global bucket exhaustion.

## Three-layer verification

### 1. Server loopback

```sh
/opt/claimgate/runtime/current/bin/node \
  /opt/claimgate/current/scripts/healthcheck.mjs \
  http://127.0.0.1:18121
```

Confirm the listener belongs to `claimgate.service` and is not public.

### 2. Public HTTPS

From the reviewed checkout, use the same strict client:

```sh
node scripts/healthcheck.mjs https://ds.zlbdh.top:8443
PLAYWRIGHT_BASE_URL=https://ds.zlbdh.top:8443 npm run test:e2e
```

Also verify the certificate hostname/chain, fixed HTTP redirect, security headers, home page, and a fresh isolated demo session.

### 3. In-app browser

Open `https://ds.zlbdh.top:8443`, start a fresh demo instance, discover the expected WebMCP tools, execute the approved smoke path, and confirm tool membership follows state changes.

After all three layers pass, repeat every preflight application/VPN/proxy check. Record services as unchanged only when before/after evidence agrees; ClaimGate health alone is not regression proof.

## Scoped rollback

Rollback is triggered by any unit, database, certificate, Nginx, HTTPS, browser, WebMCP, checksum, or unrelated-service regression failure.

### Version rollback

Leave both ClaimGate units enabled and keep the ingress key/database unchanged. Stop only the application and ingress-gate units, repoint the application/runtime symlinks to a previously verified pair that includes a compatible gate helper, start the ingress gate first and the application second, then run the strict health and rolling-window checks. Do not disable either unit or reset quotas during a version rollback.

### Complete removal

Only when intentionally removing the entire first-time ClaimGate deployment:

1. Remove only the ClaimGate full Nginx include/bootstrap enablement. Run `nginx -t`; only then reload gracefully so no public route depends on the gate.
2. Stop and disable only `claimgate.service` and `claimgate-ingress-gate.service`.
3. Re-run every preflight health check and prove unrelated services are unchanged.
4. Preserve both state directories, `/etc/claimgate`, failed releases, and the isolated runtime with restricted permissions.

Do not recursively delete ClaimGate data or configuration. Do not remove shared directories, certificates, listeners, Nginx files, projects, units, VPNs, or proxies.

## Primary references

- [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- [Official Next.js Docker example](https://github.com/vercel/next.js/tree/canary/examples/with-docker)
- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Official Node.js container images](https://github.com/nodejs/docker-node)
- [Node.js 22.20.0 release](https://nodejs.org/en/blog/release/v22.20.0)
- [Node.js 22.20.0 checksums](https://nodejs.org/dist/v22.20.0/SHASUMS256.txt)
- [Nginx request limiting](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
- [Nginx auth request](https://nginx.org/en/docs/http/ngx_http_auth_request_module.html)
- [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
