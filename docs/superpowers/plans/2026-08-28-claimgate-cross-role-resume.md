# ClaimGate contextual role-resume implementation plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the complete ClaimGate demo reachable through visible controls by switching fictional roles from a claim page and resuming the same authorized claim.

**Architecture:** The role-switch form gains one optional opaque claim ID, never a URL. The authenticated route validates the claim inside the existing nonce/rate/session transaction and derives a role-specific relative path. Both claim pages reuse one CSRF helper and the existing role bar.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, SQLite, Vitest, Testing Library, Playwright.

**Design:** `docs/superpowers/specs/2026-08-28-claimgate-cross-role-resume-design.md`

---

## Chunk 0: Failing visible-workflow acceptance

### Task 0: Prove the current UI cannot resume the claim

**Files:**
- Create: `tests/e2e/role-resume-navigation.spec.ts`
- Reuse: `tests/e2e/claim-gate-harness.ts`

- [ ] **Step 0: Isolate the existing Task 13 WIP**

After this reviewed plan is committed, stash all current uncommitted README,
LICENSE, submission-document, validator, package, and DEVLOG work under the
explicit name `task13-public-package-wip` with:

`git stash push --include-untracked -m task13-public-package-wip`

Record the resulting stash object/ref, verify its inventory includes the
untracked public files, and verify a clean tree before writing the navigation
test. Do not drop the stash.

- [ ] **Step 1: Write the failing production E2E before implementation**

Reach the first claim through the real stage response. From that point onward,
the test code must not call `page.goto()` at all. Use only visible links, forms,
desk entries, and role-switch buttons. Add a source-level guard that rejects
any later `goto` call in this spec.

The intended path is:

1. return home and switch to Staff;
2. open Staff desk and the visible queue item;
3. approve manually;
4. switch contextually to the same Claimant claim;
5. issue the pass and click the visible **Copy credential** control;
6. switch contextually to Staff, focus the credential input, and paste with the
   real browser shortcut without reading or logging clipboard contents;
7. confirm handoff, reach `COLLECTED`, and return home.

Grant only the clipboard permission required for the visible copy/paste path.
Never intercept the issuance response or read the token into test output.

- [ ] **Step 2: Run the spec and verify RED**

Run: `npm run test:e2e -- tests/e2e/role-resume-navigation.spec.ts`

Expected: FAIL because the claim pages do not render contextual role switching.

## Chunk 1: Closed server contract

### Task 1: Share role-switch CSRF and render contextual form data

**Files:**
- Create: `src/server/http/role-switch-csrf.ts`
- Test: `src/server/http/role-switch-csrf.test.ts`
- Modify: `src/server/http/home-session.ts`
- Modify: `src/components/demo-role-bar.tsx`
- Test: `src/components/demo-role-bar.test.tsx`

- [ ] **Step 1: Write failing helper and component tests**

Assert one exported helper mints a token bound to `sessionId`, method `POST`,
route `api.demo.switch-role`, action `role_switch`, one-time use, and the lesser
of session expiry or ten minutes. Assert `DemoRoleBar` omits the optional input
on home and emits exactly one `resumeClaimId` input on a claim page.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- src/components/demo-role-bar.test.tsx src/server/http/role-switch-csrf.test.ts`

Expected: FAIL because the helper and optional prop do not exist.

- [ ] **Step 3: Implement the narrow helper and optional hidden input**

Keep the current home behavior unchanged. The component accepts only an opaque
claim ID string; it never accepts a path or URL.

- [ ] **Step 4: Run target tests and typecheck**

Run: `npm test -- src/components/demo-role-bar.test.tsx src/server/http/role-switch-csrf.test.ts`
Run: `npm run typecheck`

Expected: PASS.

### Task 2: Validate resume and rotate in one transaction

**Files:**
- Modify: `src/app/api/demo/switch-role/route.ts`
- Modify: `src/app/api/demo/route-response.ts`
- Test: `tests/integration/api-authorization.test.ts`
- Test: `tests/integration/request-body-boundary-review.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover:

- the original two-field form still redirects to `/`;
- Claimant to Staff derives `/staff/claims/<id>`;
- Staff to Claimant derives `/claimant/claims/<id>`;
- malformed, duplicate, extra, missing, cross-instance, and non-owned IDs fail;
- no user string can become a URL, query, fragment, scheme, or host;
- an invalid resume has no `Set-Cookie` or `Location`;
- the same one-time token can then submit a valid resume and receive 303;
- invalid resume leaves nonce and rate counts unchanged;
- concurrent replay still produces only one successful switch.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/integration/api-authorization.test.ts tests/integration/request-body-boundary-review.test.ts`

Expected: FAIL because the strict form accepts only two fields and redirects home.

- [ ] **Step 3: Implement the closed transaction**

Strict-parse either the original two keys or those keys plus one bounded claim
ID. Inside `executeAuthorizedMutation`, load by signed `demoInstanceId`, enforce
the target Claimant owner, rotate the session, and return the derived relative
path. Any throw rolls back nonce and rate writes. Extend the redirect helper
with an optional server-derived relative location; callers cannot pass raw form
data to it.

- [ ] **Step 4: Run authorization, body, concurrency, and secret tests**

Run: `npm test -- tests/integration/api-authorization.test.ts tests/integration/request-body-boundary-review.test.ts src/server/http/request-context-hardening.test.ts tests/integration/no-secret-leak.test.ts`
Run: `npm run typecheck`

Expected: PASS.

## Chunk 2: Visible end-to-end navigation

### Task 3: Wire both claim pages to the contextual switch

**Files:**
- Modify: `src/app/claimant/claims/[claimId]/page.tsx`
- Modify: `src/app/staff/claims/[claimId]/page.tsx`
- Modify: `src/server/http/claimant-page-session.ts` only if helper routing requires it
- Modify: `src/server/http/staff-page-session.ts` only if helper routing requires it
- Test: `tests/integration/claim-review-page-contract.test.ts`

- [ ] **Step 1: Write failing page-contract tests**

Assert both authenticated claim pages mint the shared role-switch token, render
the role bar, and bind the current claim ID. Non-claim pages retain current
behavior.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/integration/claim-review-page-contract.test.ts src/components/demo-role-bar.test.tsx`

- [ ] **Step 3: Add the existing role bar to both pages**

Do not add a WebMCP tool, a generic redirect, or a new claim DTO.

- [ ] **Step 4: Run page and tool lifecycle tests**

Run: `npm test -- tests/integration/claim-review-page-contract.test.ts tests/webmcp/nine-tool-contracts.test.ts tests/webmcp/nine-tool-lifecycle.test.tsx`

Expected: PASS with the exact nine-tool registry unchanged.

### Task 4: Make the prewritten visible-workflow acceptance pass

- [ ] **Step 1: Fix only navigation/selectors exposed by the existing RED test**

Do not weaken role, state, CSRF, expected-version, or credential boundaries.

- [ ] **Step 2: Run the new spec and full E2E**

Run: `npm run test:e2e -- tests/e2e/role-resume-navigation.spec.ts`
Run: `npm run test:e2e`

Expected: PASS.

- [ ] **Step 3: Review and commit the navigation code**

Run independent specification and code-quality reviews. Stage the navigation,
unit/integration tests, and production E2E only, then commit with a Chinese
message. Any pre-existing Task 13 document/validator work must remain in the
named WIP stash created before implementation. Confirm the working tree is
fully clean after the navigation commit.

- [ ] **Step 4: Re-run clean native WebMCP acceptance**

Run: `npm run accept:native:3:clean`

Expected: three new runs against the navigation commit, all nine tools, all
manual transitions, final home `getTools() = []`, cleanup, and new hashes.
Update the canonical English `docs/submission/testing.md` and native evidence
to the new base revision, review them, and commit that evidence separately.

- [ ] **Step 5: Restore the Task 13 WIP package**

Restore the named stash only after navigation and native evidence commits are
clean. Resolve against the new canonical `testing.md`; do not overwrite the new
evidence with the stashed older file.

## Chunk 3: Submission truth and closeout

### Task 5: Correct the public materials against real behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/submission/architecture.md`
- Modify: `docs/submission/demo-script.md`
- Modify: `docs/submission/devpost.md`
- Modify: `docs/submission/testing.md`
- Modify: `docs/submission/deployment.md` only if its existing English evidence changes

- [ ] **Step 1: Fix factual claims**

Document pure two-of-three evidence eligibility, aggregate `LOCKED`, the exact
tool lifecycle states, free-text storage boundaries, public fictional seed
visibility, and the in-page lifetime of an issued pickup credential.

- [ ] **Step 2: Rewrite and retime the demo**

Use the visible queue path for the first Staff switch and contextual resume for
the two later switches. Split find and stage prompts. Use a fixed 2026 UTC time
range, exact UI button labels, and keep the demonstrated runtime below 3:00.

- [ ] **Step 3: Complete judge-facing fields and English evidence**

Add explicit `Why WebMCP`, `Better experience`, and `Before and after` answers;
list thumbnail and user-attested form/legal fields without storing identity
answers. Convert the canonical `testing.md` evidence to English and keep the
already-English canonical `deployment.md`; do not create duplicate `.en` files.

- [ ] **Step 4: Review and commit the public submission package**

Run independent specification and code-quality reviews. Stage only reviewed
README, LICENSE, public submission materials, and validator files. Commit with
a Chinese message.

- [ ] **Step 5: Run the final prepublication gate on final HEAD**

Run: `node scripts/validate-submission.mjs --prepublish`
Run: `npm run verify`
Run: `npm run verify:deployment`
Run: `npm run test:e2e`

Expected: all PASS against the final committed HEAD; public URLs remain the
four controlled prepublication placeholders. Do not push or publish based on
earlier green output.
