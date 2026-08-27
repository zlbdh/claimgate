# ClaimGate contextual role-resume design

## Problem

The public demo changes between one fictional Claimant and one fictional Staff
identity. Role switching currently exists only on the home page and always
returns there. After Staff approves a claim, the Claimant desk cannot rediscover
that claim. After the Claimant issues a pickup pass, the claim is no longer in
the Staff review queue. A person who does not already know the claim URL cannot
complete the visible UI flow.

This is a navigation defect, not an authorization defect. The existing claim
pages already enforce the signed session role, demo instance, ownership, and
claim state.

## Goals

- Let a person switch fictional roles from an authenticated claim page and
  resume the same claim under the target role.
- Keep the home-page switch and normal desk navigation unchanged.
- Preserve the exact nine WebMCP tools and every human-only action boundary.
- Reject arbitrary redirects, cross-instance claims, malformed identifiers,
  extra form fields, and stale or replayed CSRF tokens.
- Make the complete demo reachable by visible controls without typing or
  directly navigating to a claim URL.

## Non-goals

- No production identity or impersonation system.
- No new WebMCP tool.
- No caller-supplied URL, query string, fragment, host, or external redirect.
- No broader Staff queue semantics and no new public claim-list DTO.
- No change to claim transitions, evidence, pickup credentials, or handoff.

## Options considered

### A. Contextual claim resume (selected)

Render the existing demo role bar on both claim pages. The form may include one
opaque `resumeClaimId`. The server validates the closed identifier syntax,
loads that claim inside the current demo instance, checks the target Claimant
ownership rule, and derives either `/claimant/claims/<id>` or
`/staff/claims/<id>` itself.

This changes the smallest surface and keeps authorization on the server.

### B. Add active-claim lists to both desks

This would make claims rediscoverable without a contextual switch, but it adds
new repository queries, DTOs, UI lists, and possibly changes the meaning of the
Staff pending-claims tool. It is larger than the demo needs.

### C. Accept a generic `returnTo` value

This is flexible but creates an open-redirect and path-authorization surface.
Even an internal-path allowlist would be harder to reason about than a single
validated claim identifier and a server-derived destination.

## Request and redirect contract

The role-switch form remains `application/x-www-form-urlencoded` and keeps the
one-time action-bound CSRF token. It accepts exactly:

- `csrfToken`;
- `targetRole`;
- optional `resumeClaimId`.

When `resumeClaimId` is absent, the existing redirect to `/` remains. When it is
present, it must match the closed claim-ID syntax already used by claim pages.
The route loads the claim by `(demoInstanceId, claimId)`. A target Claimant must
be the fixed claimant owner. Target Staff access remains instance-scoped.

Claim lookup, target-role ownership validation, nonce consumption, rate-limit
accounting, and session rotation must share one repository transaction. The
existing authorization primitive may stage nonce or rate writes before the
claim check, but any validation failure must roll back the whole transaction.
Persisted nonce and rate counts therefore remain unchanged. Invalid or missing
claims return a bounded error without a new session cookie or redirect.

## UI flow

The home page retains the current role bar. Claimant and Staff claim pages add
the same clearly labelled public-demo role bar with the current claim as resume
context.

The recorded path is:

1. Claimant stages the candidate and submits evidence on the claim page.
2. Claimant returns home, switches to Staff, opens the Staff desk, calls
   `list_pending_claims`, and opens the visible queue item.
3. Staff reads the review summary and approves manually.
4. Staff switches contextually to Claimant and lands on the same claim.
5. Claimant reads status and pickup instructions, then issues the pass manually.
6. Claimant clicks the visible copy control, switches contextually to Staff,
   lands on the same claim, and pastes the credential without logging or
   exposing it.
7. Staff confirms the handoff manually, reads `COLLECTED`, and returns home.

This keeps the queue tool visible while avoiding invisible URLs after approval
and pass issuance.

## Error and security behavior

- Form parsing remains closed and rejects duplicates or extra keys.
- Identifier validation happens before any repository lookup.
- Repository lookup remains scoped to the signed demo instance.
- The server derives the redirect. User input never becomes a raw location.
- A failed resume validation does not rotate the session or consume the
  one-time role-switch mutation.
- Existing CSP, cookie, same-origin, Fetch Metadata, body-size, rate-limit, and
  CSRF behavior remains unchanged.

## Verification

- Unit test the role bar with and without the optional claim context.
- Claim pages mint the existing one-time token through one shared helper bound
  to `sessionId`, `api.demo.switch-role`, and `role_switch`, then pass the
  current `resumeClaimId` to the role bar.
- Route tests cover the home redirect, both derived claim paths, malformed,
  duplicated, extra, missing, cross-instance, and non-owned identifiers.
- Submit one invalid resume and then a valid resume with the same token. The
  invalid response has no `Set-Cookie` or `Location`; nonce and rate counts do
  not increase; the valid retry returns 303. Concurrent replay still permits
  only one successful mutation.
- Add a production Playwright flow that uses visible links and buttons for every
  role switch and claim reopen. It must not call `page.goto()` with a claim URL.
- The Playwright flow clicks the real copy control and pastes from the browser
  clipboard after switching roles. The test must never read, print, snapshot,
  or intercept the credential value.
- Re-run the complete E2E suite, native WebMCP lifecycle tests, secret scans,
  portable verification, and Linux deployment verification.
