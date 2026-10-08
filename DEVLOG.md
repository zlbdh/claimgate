# ClaimGate Development Log

## 2026-08-26 [Task 1: Project foundation and WebMCP compatibility probe]

### Engineering baseline

- Operator: Codex.
- Started from baseline commit `0333e08462d3f5fe1e61af4bf30ca0d0d727fbdd` and established the Next.js 16, React 19, TypeScript, Vitest, and Playwright toolchain.
- Production CSP uses a per-request nonce. Development adds only the `unsafe-eval` required by Next.js; production permits neither `unsafe-inline` nor `unsafe-eval`.
- WebMCP uses only native `document.modelContext`, with no polyfill, deprecated `navigator.modelContext`, or cross-origin exposure.
- Real WebMCP discovery, execution, and unregistration require verification in a supported environment. Automated injection proves only fallback UI and lifecycle logic and cannot replace native acceptance.

### TDD and compatibility results

- The first `resolveModelContext` test was RED because the module did not exist. The minimal implementation made both feature-detection tests GREEN.
- The probe-tool tests first went RED because the module was absent. The minimal implementation made all five tests for name, read-only annotation, nonce return, and registration signal GREEN.
- Browser E2E first went RED because the `app` directory did not exist. Implementing the landing page, probe page, and per-request CSP made both production E2E tests GREEN.
- Playwright 1.62.1 installed its matching Chrome for Testing 151.0.7922.34. The official npm registry audit reported 0 production dependency vulnerabilities.
- The user's Chrome session did not expose `document.modelContext`, and the fallback UI worked. Separate Chrome 151 with the `WebMCPTesting` feature completed native discovery, exact-nonce execution, `toolchange`, and unregistration on navigation.

### Key decisions and lessons

- `output: standalone` cannot use `next start` for acceptance. E2E now copies static assets and launches `.next/standalone/server.js` directly.
- The local npm mirror did not implement the audit API, so the first audit returned 404. Temporarily specifying the official registry for the audit command produced 0 vulnerabilities without changing the user's global npm configuration.
- Installation initially pinned local mirror addresses in the lockfile. Before committing, only registry hosts were mechanically normalized to the official npm registry; `npm ci --dry-run` verified installation without changing versions or integrity values.
- Native `executeTool()` serializes object results as JSON strings. The acceptance script parses them before comparing structures. Abort-based unregistration propagates through asynchronous `toolchange`, so verification waits for conditions instead of using fixed sleeps as evidence of stability.
- Vitest's default discovery included `tests/e2e`. Explicitly excluding the Playwright directory kept unit and browser tests separate.

## 2026-08-26 [Task 2: Deterministic candidate matching from public fields]

- Decision: Matching accepts only category, time window/found time, coarse area, color, public tags, and public description. Category mismatches are rejected immediately; a score of at least 50 is required to become a candidate.
- Decision: Adjacent areas and color families use explicit constants. Reasons contain only stable public-field explanations, and result summaries contain no private evidence fields.
- Verification: Ran the missing-module matching tests to confirm RED, then passed all eight matching tests and strict TypeScript checking with the minimal implementation. The complete verify gate was still required before committing.
- Lesson: Component-score tests must isolate other fields, or time scores combine with area, color, and tag scores. Test factories therefore support public-field overrides.

## 2026-08-26 [Task 3: Domain states and purpose-separated keys]

### Changes

- Added pure Report, Item, and Claim state guards that reject self-transitions, skipped states, backward transitions, and departures from terminal states. Services must short-circuit idempotent requests before invoking the guards.
- Added a closed `DomainError` code set with fixed safe JSON metadata. Serialized errors exclude stacks, causes, resource identifiers, and caller-supplied details.
- Added a purpose-separated keyring using Node `crypto.hkdfSync`, deriving four 32-byte subkeys for evidence, pickup-pass, candidate-handle, and database-key-check from `CLAIMGATE_HMAC_KEY`.

### Decisions and verification

- Master keys accept only strict standard padded Base64: length must be a multiple of four, re-encoding must match, and decoding must produce at least 32 bytes. This prevents Node's permissive decoding from silently accepting malformed deployment configuration.
- HKDF uses the fixed UTF-8 salt `ClaimGate/keyring/v1` and UTF-8 info containing purpose and version, preventing reuse of one subkey across security purposes.
- TDD: Missing domain modules produced the expected RED state. The minimal implementation made 39 targeted tests GREEN. Full `npm run verify` passed, including 55 unit tests, lint, typecheck, file-length checks, and production build.

## 2026-08-26 [Task 3 review fix round 1: Runtime immutability boundaries]

### Fixes

- `DomainError` now validates the closed code set at runtime, stores the trusted code privately, and freezes instances and the public code set. `toJSON` maps only the private code to fixed safe messages.
- Report, Item, and Claim transition tables and every nested array are frozen. Public `KEY_PURPOSES` is also frozen so callers cannot add purposes or change the graph.
- State tests now cover every ordered state pair: 16 for Report, 9 for Item, and 49 for Claim. Only edges listed in the design addendum pass, including checks for all self-transitions and departures from terminal states.

### TDD and verification

- New tests first went RED: invalid codes were accepted, and errors, state tables, and purpose sets were not frozen. Full-graph tests then explicitly verified existing allowed edges.
- The first GREEN attempt hit a TypeScript syntax error from a missing closing parenthesis in the freeze wrapper. After correction, all 85 targeted tests and typecheck passed.
- Full `npm run verify` passed: file lengths, lint, typecheck, 101 tests across six files, and the production build.

## 2026-08-26 [Task 4 review fix round 2: Database v2 migration decision]

- Advanced the schema to v2. Opening a v1 file must first verify the configured key using its v1 metadata authenticator, then upgrade within the same `BEGIN IMMEDIATE` transaction.
- ClaimGate was not yet deployed, and business data consisted only of disposable two-hour demos. The v1→v2 migration therefore drops and recreates business tables in dependency order without copying old demo rows. It preserves the database UUID and key-check salt, writing the v2 authenticator only after creating the v2 schema and passing `foreign_key_check`.
- Any failure rolls back all DDL, business rows, and metadata. Wrong keys, unknown versions, and incomplete schemas fail closed without automatically taking over the database.

## 2026-08-27 [Task 9: Nine dynamic WebMCP tools and read-only APIs]

- **Record:** 2026-08-27 19:59 by Codex — Recorded interim Chrome 151 compatibility, state-tool teardown, and output-budget conclusions to prevent Task 10/11 regressions.
- **Changes:** Expanded four tools to nine. Added four authenticated GET endpoints for claim status, pickup instructions, Staff queue, and review summary. Claimant/Staff pages register tools dynamically by role, page, and state. The activity stream shows start/end times for the latest 20 tools.
- **Decision:** Publication, archiving, private evidence, approval/rejection/unlock, pass issuance/reissuance, role switching, and handoff remain manual actions with no WebMCP tools.
- **Compatibility:** Chrome 151 unregistration may still affect executing tools. Write tools return canonical results before navigating or refreshing in the next macrotask. Page-generation guards protect all candidate, navigation, refresh, and activity side effects.
- **Security boundary:** Tools strict-parse inputs again at runtime. Nested JSON Schemas reject extra fields. Each actually serialized tool result is limited to 1,500 characters. HTTP reads stream at most 65,536 bytes and cancel on overflow. Public descriptions, timelines, and report lists return only minimal allowlisted summaries.
- **Lesson:** Filtering 50 complete reports only on the client let valid UTF-8 responses exceed the read limit. Server-side canonical `status/limit` filtering now returns summaries only. Failed candidate refreshes previously left stale `stage_claim_candidate` tools; failure paths now clear results with generation protection and refresh by state.
- **Verification:** Commit `4ffc6dca8f2362d7e2cc23c58802e9a9e85d3fb1`; full `verify` passed twice consecutively (103 files / 921 tests), production Playwright 4/4, and native Chrome 151 completed all nine tools across 13 stages with exact annotations and final Home `[]`. Unconfigured production APIs returned a canonical 93-byte 500 without leaks. Independent server and WebMCP reviews both passed.

## 2026-08-27 [Task 10: System-wide security regressions and secret gates]

- **Record:** 2026-08-27 20:39 by Codex — Recorded end-to-end canaries, build-artifact gates, and native cleanup policy to prevent treating partial security tests as full acceptance during deployment or demos.
- **Changes:** Added a real evidence→approve→issue→handoff secret-canary flow, physical reject/unlock routes, expired-session coverage, strict JSON streaming, and 12 isolated runtime-environment subprocesses. Security headers explicitly set `Permissions-Policy: tools=(self)`; production CSP retains nonce + strict-dynamic.
- **Build gates:** After build, `verify` runs evidence, pickup, and sensitive-surface scans sequentially. Public static/public files prohibit private evidence, server-only markers, source maps, and sourceMappingURL. Standalone server maps prohibit `sourcesContent`.
- **Lesson:** Parallel build/native runs caused false EBUSY/missing-file failures during `.next/standalone` cleanup. Final gates require exclusive sequential execution. Native cleanup must not skip server/temp cleanup if `browser.close()` fails; it now uses two-stage termination, confirms exit, and restricts deletion to system Temp.
- **Gate decision:** Matching tool names containing `issue/reissue/handoff` missed synonymous manual-write tools. Replaced this with an exact nine-tool allowlist and scans prohibiting ten manual-write path categories in WebMCP source: issue/reissue/evidence/approve/reject/unlock/handoff/publish/archive/switch-role.
- **Verification:** Commit `0480fbb`; full `verify` passed twice consecutively (110 files / 971 tests), production E2E 7/7, and native Chrome 151 passed all nine tools, runtime evidence/pickup transport canaries, and final teardown. Unconfigured APIs still returned a 93-byte generic 500. Three independent reviewers reported no remaining Critical/Important findings.

## 2026-08-27 [Task 11: Risk-path E2E and three clean native runs]

- **Record:** 2026-08-27 21:32 by Codex — Recorded the browser risk matrix, exact-13 contract, and atomic evidence publication so deployment can reuse the same acceptance path.
- **Additional browser evidence:** Two competing claims in one instance ended with exactly one winner and one loser. Two BrowserContexts and fresh sessions after clearing cookies were fully isolated. Correct evidence after one unlock returned to UNDER_REVIEW. Stale updates across two tabs displayed STATE_CHANGED without losing the winning data. Digest-valid expired passes returned exactly 403/FORBIDDEN. The 390px create→match→evidence flow had no overflow.
- **Final states:** Handoff responses from two tabs were exactly COLLECTED + ALREADY_COLLECTED. Staff, Claimant, and RESOLVED report views were read-only; terminal states retained only get_claim_status.
- **Native evidence:** Added a sequential three-process wrapper enforcing exactly 13 stages, each stage's tools/schema, exactly nine tools, one instance, absence of human-action tools, Home=[], cleanup, and runtime canaries. Artifacts and testing.md publish in one rollback-capable transaction with SHA-256 checksums.
- **Lesson:** Duplicating production HMAC in tests confused digest mismatch with expiration. An isolated react-server worker now reuses production keyring/pickup crypto directly. Evidence publication is committed only after both targets are swapped in; backup-cleanup failure must not trigger destructive rollback.
- **Verification:** Code commit `0f5d241`; full verify passed twice (114 files / 979 tests), with production E2E 13/13. Three strict runs then used a clean worktree, each at base commit `0f5d2413…`, with the same build, unique run IDs, 9/9 tools, exactly 13 stages, cleanup=true, matching SHAs, and zero Temp leftovers. Final evidence commit: `904cba3`.

## 2026-08-28 [Task 12: Isolated deployment asset hardening]

- **Release trust chain:** Release preparation requires clean Git, a full 40-character revision, an exclusive output lock, and an immutable Docker image ID. A four-entry canonical manifest binds the app, official Node distribution, validator, and revision. The SSH controller rechecks the clean checkout, HEAD, and artifact revision; the remote host validates real paths, owners, and permissions at each level.
- **Archives and identity:** The validator checks duplicates, ancestors, symlinks, and hardlinks after the actual strip 0/1 transformation. The fixed official Node archive SHA and strip1 behavior were tested. Extraction fixes umask at 022 even when root inherits 077. Final Node and native SQLite smoke tests must run as the service identity.
- **Ingress gate:** Quota-database busy timeout is now 0, so external write-lock conflicts fail immediately. Real 10-way concurrent HTTP verification returned before the Nginx deadline without late quota consumption. Source addresses use `$realip_remote_addr`, with IPv4-mapped IPv6 normalized to IPv4. The vhost explicitly disables inherited proxy error interception, keeping application 403 responses separate from quota 429 responses.
- **Repeatable verification:** Added `test:deployment:linux`, which builds a real Linux/amd64 image, parses local-only Compose, and checks Nginx 1.22 inheritance, umask/nonroot native SQLite, Unix socket 0660/group access, stale nonsocket handling, and SIGTERM cleanup. Compose is for local app/health smoke tests only; production supports only two systemd units plus Nginx.

### Lesson: Node ESM entry paths and systemd symlinks

- **Record:** [2026-08-28 03:35] by Codex — The first server launch exposed entry-point detection differences absent from local direct-path tests.
- **Symptom:** `claimgate-ingress-gate.service` exited normally with status 0 about 0.3 seconds after launch without creating its Unix socket.
- **Root cause:** Node ESM resolved `import.meta.url` to the real release path, while `process.argv[1]` retained the `/opt/claimgate/current` symlink path. String comparison incorrectly classified the script as not being the main entry point.
- **Fix:** Entry detection first normalizes the launch path with `realpathSync()`. Linux deployment tests now launch through the `current` symlink and verify the socket lifecycle.
- **Lesson:** When production units start through release symlinks, real Linux regression tests must use the same path form instead of testing only direct container paths.

## 2026-08-28 [Restoring claim context across roles]

### Lesson: Role switches should carry bounded domain identifiers, not generic return URLs

- **Record:** [2026-08-28 04:51] by Codex — Recorded the visible demo-flow break and transactional fix to prevent navigation convenience from becoming an open redirect or incorrectly consuming one-time tokens.
- **Symptom:** After Staff approval, Claimants could not find the same claim through visible navigation. After pass issuance, the claim also disappeared from the pending Staff queue, leaving manual claim-URL entry as the only way to complete handoff.
- **Root cause:** Role switching appeared only on Home and always redirected to `/`, while approval and issuance intentionally changed queue visibility. Navigation carried no authorized claim context.
- **Fix:** Forms add only an optional opaque `resumeClaimId` and strictly accept two or three fields. Claim lookup, target Claimant ownership, nonce, quota, and session rotation occur in one transaction. Redirect locations derive only from the database claim and target role. Both claim page types share the CSRF helper and role bar, and real Copy/Ctrl+V E2E covers the complete handoff.
- **Lesson:** When restoring business context across identities, pass only a bounded domain ID, authorize it in one transaction, then derive the internal path. Do not accept `returnTo`, URLs, query strings, or fragments, and do not consume retryable one-time capabilities on failed validation.

## 2026-08-28 [Task 13: Pre-submission local and external gates]

- **Record:** 2026-08-28 04:25 by Codex — Recorded public-candidate scanning, anonymous external verification, and Devpost draft evidence boundaries to avoid reporting a saved draft as submitted.
- **Local gate:** `--prepublish` checks Git's tracked and nonignored untracked candidates for eight submission documents, English README/architecture/demo/Devpost contracts, five controlled pending tokens, and environment files, databases, archives, unknown binaries, real addresses, local paths, SSH endpoints, private keys, and high-entropy secrets. Each candidate first passes lstat, realpath, and root-boundary checks.
- **External gate:** `--final` requires canonical public URLs and fully public A/AAAA resolution. It anonymously verifies live health, GitHub public/main/MIT and raw README/LICENSE, YouTube Public/<180 seconds/audio/video ID, and canonical Devpost JSON outside the repository, a thumbnail, and at least two bounded PNG/JPEG screenshots.
- **Boundary decision:** final is the Devpost pre-submission draft gate. Evidence must state `draftSaved=true` and `submitted=false`. A terminal state may be recorded separately only after the management page explicitly displays `Submitted`.
- **Verification:** Targeted TDD tests 114/114; full Vitest: 130 files passed, 1 skipped, 1,238 tests passed, 3 skipped. Lint, typecheck, file lengths, secret-surface, Node syntax, diff-check, and real `--prepublish` all passed. External final tests used mocks and were not presented as real public acceptance.
