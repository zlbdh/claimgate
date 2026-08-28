# ClaimGate

ClaimGate is a privacy-first lost-property claim workflow built for the OpenAI WebMCP Challenge. A browser Agent can prepare a report, search public descriptors, and stage a claim. People still publish the report, submit private evidence, make the staff decision, issue the pickup pass, and confirm the handoff.

The public demo is intended only for fictional, non-identifying inputs. There is
no dedicated contact field, but `publicDescription` is free text and is stored
in SQLite. Do not enter real names, contact details, or real lost-property data.

## Publication status

The public artifacts below have been verified independently. Their presence does
not by itself claim that the Devpost entry has been formally submitted.

| Artifact | Current value |
| --- | --- |
| Live demo | <https://ds.zlbdh.top:8443> |
| Public repository | <https://github.com/zlbdh/claimgate> |
| Public video | <https://youtu.be/v3siwO314Aw> |

This README does not claim that the project has been submitted yet.

The final repository must expose the complete source and required assets on its
default branch, and its public About panel must recognize this repository's MIT
license.

## The problem

A normal lost-property search has two competing needs. A claimant must provide enough detail to prove ownership, while the property desk must avoid publishing the same details to anyone who wants to guess them. Giving an Agent every field would turn the private proof into search material.

ClaimGate separates public matching from private proof. The Agent works with broad descriptors and bounded status summaries. Private evidence follows a separate manual path and is reduced to an aggregate eligibility result.

## What the demo does

1. A Claimant starts an isolated two-hour demo instance.
2. The Agent creates and updates a private lost-report draft through WebMCP.
3. The Claimant publishes the report with a manual, same-origin form.
4. The Agent finds at most three candidates using public fields and stages one claim.
5. The Claimant enters private evidence in password controls. The values do not enter a WebMCP input or result.
6. Staff reads a redacted review summary, then manually approves or rejects the claim.
7. The Claimant manually issues a short-lived, one-time pickup pass.
8. Staff manually confirms the handoff. The claim, item, and report close in one transaction.

A browser without WebMCP can complete the same human workflow through the normal UI.

## Why WebMCP fits

ClaimGate registers tools with the native `document.modelContext.registerTool()` imperative API. Registration follows the current page, role, and server-backed state. An `AbortController` removes the previous tool generation when the page or state changes.

The nine approved tools are:

| Tool | Purpose |
| --- | --- |
| `create_lost_report_draft` | Create a private draft from public descriptors. |
| `update_lost_report_draft` | Update public fields while the report is still a draft. |
| `list_my_reports` | List bounded summaries owned by the current Claimant. |
| `find_candidate_matches` | Return up to three privacy-safe candidates. |
| `stage_claim_candidate` | Stage a current opaque candidate for private proof. |
| `get_claim_status` | Read aggregate claim state and the next safe step. |
| `get_pickup_instructions` | Read desk, hours, readiness, and expiry without returning a pass. |
| `list_pending_claims` | List a bounded Staff review queue. |
| `get_claim_review_summary` | Read evidence eligibility, conflicts, and a redacted timeline. |

There is no WebMCP tool for publishing, private evidence, approving or rejecting, issuing a pass, or completing a handoff. Tool visibility helps the Agent choose an action, but the server still checks the session, role, ownership, state, version, and rate limit on every request.

## Matching and privacy boundaries

Candidate matching is deterministic. Category must match exactly. Time, campus area, color, and public tags contribute fixed scores. Only the top three candidates at or above the threshold are returned, with a confidence band and public reasons. The Agent never decides ownership.

Private evidence is normalized and compared on the server against independently
salted HMAC digests. Eligibility is a pure two-of-three rule: any two correct
slots are enough, even when the third submitted slot is wrong. The response does
not reveal which field matched or how many were correct. The third insufficient
attempt returns the aggregate state `LOCKED`; one manual Staff unlock is allowed.

The issue or reissue response is the only server response that returns the full
pickup credential. The current Claimant page keeps it in memory and offers
**Reveal credential**, **Mask credential**, and **Copy credential** controls.
Leaving or refreshing the page clears it and cannot recover it. The server stores
only a digest; the credential expires after ten minutes and becomes invalid after
use or reissue. It is excluded from WebMCP results, server-rendered HTML, URLs,
logs, and audit records.

The repository intentionally contains readable fictional evidence answers in
`src/server/db/private-evidence-seed.ts` so anyone can run the demo. The privacy
claim applies to runtime, client bundles, pages, APIs, WebMCP results, logs, and
stored raw evidence. It does not protect those fictional answers from a public
repository reader.

See [the architecture and threat model](docs/submission/architecture.md) for the full boundary map.

## Technology

- Next.js 16 App Router, React 19, and strict TypeScript
- SQLite with `better-sqlite3`
- Native WebMCP imperative API
- Zod schemas at tool and HTTP boundaries
- Vitest, Testing Library, and Playwright
- A standalone Node.js deployment behind an isolated Nginx vhost

No separate model API is used. The Agent comes from the browser session running the demo.

## Run locally

Requirements:

- Node.js `>=22.13.0 <23`
- npm
- PowerShell for the setup block below

From an existing checkout:

```powershell
npm ci
$root = (Resolve-Path .).Path
$dataDirectory = Join-Path -Path $root -ChildPath "data"
$databasePath = Join-Path -Path $dataDirectory -ChildPath "claimgate.db"
New-Item -ItemType Directory -Force $dataDirectory | Out-Null
$hmac = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
$session = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
$csrf = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
@"
CLAIMGATE_HMAC_KEY=$hmac
CLAIMGATE_SESSION_KEY=$session
CLAIMGATE_CSRF_KEY=$csrf
CLAIMGATE_DATABASE_PATH=$databasePath
CLAIMGATE_APP_ORIGIN=http://127.0.0.1:3000
"@ | Set-Content -Encoding utf8 .env.local
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000`. Keep the three keys independent and stable for the life of the database. `.env.local` and database files are ignored by Git.

## Test and verify

Run the portable release gate:

```powershell
npm run verify
npm run test:e2e
```

Run the Linux deployment integration gate when Docker with Linux containers is available:

```powershell
npm run verify:deployment
```

Run the native nine-tool acceptance three times from a clean checkout:

```powershell
npm run accept:native:3:clean
```

The clean native run recorded on August 27, 2026 used one production build, three independent processes, three fresh SQLite databases, and three fresh demo instances. Every run exercised all nine tools and all five human-only transitions, then observed an empty tool set on the home page. The evidence and hashes are in [docs/submission/testing.md](docs/submission/testing.md).

The visible navigation suite also passed all 14 Playwright scenarios after the
cross-role claim resume flow was added in commit `04c618d`.

## Deployment

The production design uses a dedicated system account, immutable application and Node.js releases, a loopback-only listener, an isolated SQLite data directory, a separate ingress gate for demo-start quotas, and a ClaimGate-only Nginx vhost. It is additive and does not reuse or stop unrelated services.

The redacted procedure is in [docs/submission/deployment.md](docs/submission/deployment.md). It is a runbook, not proof that the public URL is live. Public status stays pending until loopback, HTTPS, in-app-browser, and unrelated-service regression checks all pass.

## Competition work

The repository history records the competition work beginning on August 26, 2026. It includes the approved design, deterministic domain rules, isolated demo storage, WebMCP integration, security hardening, native-browser evidence, and deployment assets. No award, user count, production adoption, or judging result is claimed.

## Known limits

- Demo identities are fixed fictional roles, not a production identity system.
- SQLite and the current deployment target a single application instance.
- WebMCP is an evolving browser API. The checked native evidence records Chrome for Testing 151 rather than claiming compatibility with every browser.
- The human-only boundary removes structured WebMCP tools for sensitive transitions. It does not claim to stop a separate system with general computer-control access from clicking the UI.
- Final URL DNS resolution is a public-artifact check only. It does not claim to prevent DNS rebinding after validation.
- The seeded workflow is a competition demo, not a city-scale property network.
- Fictional evidence answers are readable in the public source. Runtime
  redaction does not claim secrecy from repository readers.
- Free-text public descriptions are persisted. Demo users must keep all input
  fictional and non-identifying.

## License

ClaimGate is available under the [MIT License](LICENSE).
