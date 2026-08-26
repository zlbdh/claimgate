# ClaimGate Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, verify, deploy, and submit a privacy-safe WebMCP lost-property claim workflow in which agents assist with matching while people retain publication, evidence, approval, pass issuance, and handoff authority.

**Architecture:** A single Next.js application contains isolated domain services for matching, blind evidence verification, claim state transitions, authorization, and audit. SQLite persists per-browser demo instances; server-validated sessions separate Claimant and Staff views. A thin WebMCP bridge dynamically exposes only safe domain operations and never duplicates business rules.

**Tech Stack:** Node.js 22, Next.js 16.3.x, React 19.2.x, TypeScript 5.9.x, Tailwind CSS 4, Zod 4, better-sqlite3 13, QRCode 1.5, Vitest 4, Testing Library, Playwright 1.62, native `document.modelContext` WebMCP API.

**Design spec:** `docs/superpowers/specs/2026-08-26-claimgate-design.md`

---

## File structure

```text
src/
  app/
    api/
      health/route.ts
      demo/start/route.ts
      demo/switch-role/route.ts
      reports/route.ts
      reports/[reportId]/publish/route.ts
      reports/[reportId]/archive/route.ts
      reports/[reportId]/matches/route.ts
      claims/route.ts
      claims/[claimId]/route.ts
      claims/[claimId]/evidence/route.ts
      claims/[claimId]/pickup-instructions/route.ts
      claims/[claimId]/pickup-pass/route.ts
      staff/claims/route.ts
      staff/claims/[claimId]/route.ts
      staff/claims/[claimId]/decision/route.ts
      staff/claims/[claimId]/handoff/route.ts
    claimant/page.tsx
    claimant/reports/[reportId]/page.tsx
    claimant/claims/[claimId]/page.tsx
    staff/page.tsx
    staff/claims/[claimId]/page.tsx
    globals.css
    layout.tsx
    page.tsx
  proxy.ts
  components/
    agent-activity.tsx
    candidate-card.tsx
    claim-stepper.tsx
    demo-role-bar.tsx
    evidence-form.tsx
    pickup-pass.tsx
    privacy-boundary.tsx
    staff-decision-form.tsx
    webmcp-provider.tsx
  features/
    audit/audit-service.ts
    auth/csrf.ts
    auth/demo-session.ts
    claims/claim-service.ts
    claims/claim-state.ts
    claims/pickup-pass.ts
    evidence/evidence-service.ts
    evidence/normalize.ts
    inventory/found-item.ts
    matching/candidate-handle.ts
    matching/match-service.ts
    matching/score-candidate.ts
    reports/report-service.ts
    webmcp/activity-store.ts
    webmcp/model-context.ts
    webmcp/tool-contracts.ts
    webmcp/tool-executor.ts
    webmcp/tool-registry.ts
    webmcp/use-claimgate-tools.ts
  server/
    db/connection.ts
    db/migrate.ts
    db/repository.ts
    db/schema.sql
    db/seed.ts
    http/api-error.ts
    http/request-context.ts
    security/keyring.ts
    security/rate-limit.ts
  shared/domain-error.ts
  test/
    factories.ts
    setup.ts
  types/webmcp.d.ts
tests/
  e2e/claimant-flow.spec.ts
  e2e/concurrent-claims.spec.ts
  e2e/demo-isolation.spec.ts
  e2e/risk-paths.spec.ts
  e2e/staff-handoff.spec.ts
  integration/api-authorization.test.ts
  integration/claim-transaction.test.ts
  integration/no-secret-leak.test.ts
  integration/tool-api-routes.test.ts
  webmcp/tool-lifecycle.test.ts
  webmcp/tool-selection.eval.test.ts
scripts/
  check-file-lengths.mjs
  healthcheck.mjs
  playwright-target.ts
  reset-expired-demo-instances.mjs
  validate-submission.mjs
deploy/
  Dockerfile
  claimgate.service.example
  docker-compose.example.yml
  nginx-claimgate.conf.example
docs/submission/
  architecture.md
  demo-script.md
  deployment.md
  devpost.md
  submitted.md
  testing.md
  webmcp-probe.md
```

Files remain responsibility-focused and should stay below 300 lines unless generated configuration requires otherwise.

## Chunk 0: Eligibility and delivery preflight

### Task 0: Confirm that a legal and technical submission path exists

**Files:** None. Store no identity facts, credentials, or raw account screenshots in the public repository.

- [ ] **Step 1: Re-read the live official rules and deadline**

Open `https://webmcp.devpost.com/rules` while logged in. Record only the current deadline and required artifacts in working notes. The user must personally attest any residence, age, identity, tax, or legal declaration; prior registration is not permission to invent or re-attest facts.

- [ ] **Step 2: Verify current Devpost participation state**

Confirm the account shows the challenge as joined and can open the submission-management flow. If Devpost asks for a new legal confirmation, pause for the user rather than clicking it autonomously.

- [ ] **Step 3: Verify publishing channels without changing them**

Run `gh auth status` and confirm the intended GitHub account can create a public repository. In the logged-in browser, verify YouTube upload access and DNS control for a dedicated subdomain. Check SSH connectivity read-only. Do not print or store tokens/passwords.

- [ ] **Step 4: Classify blockers**

CAPTCHA/2FA/legal attestations are user gates. Missing GitHub/YouTube/DNS sessions are delivery risks but do not block local development; report them immediately and continue the local track. Ineligible legal residence is a terminal contest blocker and must not be worked around.

## Chunk 1: Foundation and deterministic domain

### Task 1: Project foundation and native WebMCP compatibility probe

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `src/proxy.ts`
- Create: `postcss.config.mjs`
- Create: `eslint.config.mjs`
- Create: `vitest.config.mts`
- Create: `playwright.config.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `src/test/setup.ts`
- Create: `src/types/webmcp.d.ts`
- Create: `src/features/webmcp/model-context.ts`
- Create: `src/features/webmcp/probe-tool.ts`
- Create: `src/app/webmcp-probe/page.tsx`
- Create: `src/app/webmcp-probe/probe-client.tsx`
- Test: `src/features/webmcp/model-context.test.ts`
- Test: `tests/e2e/webmcp-probe.spec.ts`
- Create: `docs/submission/webmcp-probe.md`
- Create: `scripts/check-file-lengths.mjs`
- Create: `scripts/playwright-target.ts`

- [ ] **Step 1: Add the minimal package and toolchain configuration**

Pin Node-compatible versions and scripts:

```json
{
  "name": "claimgate",
  "private": true,
  "engines": { "node": ">=22.13.0 <23" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "check:files": "node scripts/check-file-lengths.mjs",
    "verify": "npm run check:files && npm run lint && npm run typecheck && npm run test && npm run build"
  }
}
```

Add Next standalone output, non-CSP security headers, `serverExternalPackages: ["better-sqlite3"]`, Vitest jsdom configuration, and Playwright local/external URL support. Implement the production CSP in `src/proxy.ts` with a fresh request nonce passed in the request header, `script-src 'self' 'nonce-<value>' 'strict-dynamic'`, and no production `unsafe-inline`/`unsafe-eval`; mark the app dynamic so Next can apply the nonce to hydration scripts. Development may add `unsafe-eval` only under `NODE_ENV=development`.

- [ ] **Step 2: Install dependencies and commit the generated lockfile**

Run: `npm install next@16.3.3 react@19.2.8 react-dom@19.2.8 zod@4.4.3 better-sqlite3@13.0.3 server-only@0.0.1 lucide-react@1.34.0 qrcode@1.5.4`
Run: `npm install -D typescript@5.9.3 @types/node@22.20.1 @types/react@19.2.17 @types/react-dom@19.2.3 @types/better-sqlite3@9.6.0 @types/qrcode@1.5.6 eslint@9.39.5 eslint-config-next@16.3.3 tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3 vitest@4.1.11 jsdom@29.1.1 @vitejs/plugin-react@6.1.0 vite-tsconfig-paths@6.1.1 @testing-library/react@16.3.2 @testing-library/jest-dom@7.0.1 @testing-library/user-event@14.6.6 @playwright/test@1.62.1 tsx@4.23.12`
Run on the Windows development host: `npx playwright install chromium`
Run in a fresh Linux/CI image when used: `npx playwright install --with-deps chromium`
Expected: `package-lock.json` exists, Playwright reports its matching Chromium installed, and `npm audit --omit=dev` reports no known high/critical production vulnerability—or any exception is documented before proceeding.

- [ ] **Step 3: Write a failing WebMCP compatibility test**

```ts
it("returns unavailable without document.modelContext", () => {
  expect(resolveModelContext(document)).toEqual({ supported: false });
});

it("returns the native document.modelContext implementation", () => {
  const registerTool = vi.fn();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { registerTool },
  });
  expect(resolveModelContext(document)).toMatchObject({
    supported: true,
    context: { registerTool },
  });
});
```

- [ ] **Step 4: Run the test and verify the expected failure**

Run: `npm test -- src/features/webmcp/model-context.test.ts`
Expected: FAIL because `resolveModelContext` does not exist.

- [ ] **Step 5: Implement only the narrow native API type and feature detection**

```ts
export function resolveModelContext(target: Document) {
  const context = target.modelContext;
  return context
    ? { supported: true as const, context }
    : { supported: false as const };
}
```

The declaration must model `registerTool(tool, { signal })` on `Document`; do not add deprecated `navigator.modelContext`, proprietary helpers, or a polyfill.

- [ ] **Step 6: Add the accessible landing shell, strict-CSP proxy, and unsupported-browser banner**

The page must work without WebMCP. The banner says that Agent collaboration needs ChatGPT's in-app browser or a supported Chrome test environment; it must not block manual use. Add a Playwright assertion that the page hydrates and an interactive control works under the production nonce CSP.

- [ ] **Step 7: Register and execute one real compatibility-probe tool**

The `/webmcp-probe` page registers one read-only `claimgate_compatibility_probe` tool through the native API and unregisters it with `AbortController` on teardown. It accepts a caller-supplied nonce and returns `{ ok: true, nonce, api: "document.modelContext" }`. It is isolated from product/domain state and removed before final submission if it does not help judges.

- [ ] **Step 8: Verify real browser discovery, invocation, and teardown on Day 1**

Run the app on a browser-accessible local URL. In ChatGPT's in-app browser, or Chrome 149+ with `chrome://flags/#enable-webmcp-testing`, ask the Agent to call `claimgate_compatibility_probe` with a unique nonce. Verify the exact nonce returns, then navigate away and verify the tool disappears. Record date, browser/app version, flag state, registration signature, and observed result in `docs/submission/webmcp-probe.md`. A jsdom mock does not satisfy this step.

- [ ] **Step 9: Run the foundation checks**

Run: `npm run lint`
Run: `npm run typecheck`
Run: `npm test -- src/features/webmcp/model-context.test.ts`
Run: `npm run test:e2e -- tests/e2e/webmcp-probe.spec.ts`
Run: `npm run build`
Expected: all PASS; Next produces a standalone build.

- [ ] **Step 10: Commit**

```powershell
git add package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs vitest.config.mts playwright.config.ts src tests/e2e/webmcp-probe.spec.ts scripts docs/submission/webmcp-probe.md
git commit -m "工程：建立 ClaimGate 与 WebMCP 兼容基线"
```

### Task 2: Public-field deterministic matching

**Files:**
- Create: `src/features/inventory/found-item.ts`
- Create: `src/features/matching/score-candidate.ts`
- Create: `src/features/matching/match-service.ts`
- Test: `src/features/matching/score-candidate.test.ts`
- Test: `src/features/matching/match-service.test.ts`
- Create: `src/test/factories.ts`

- [ ] **Step 1: Write failing score tests for the exact spec table**

Cover category mismatch, overlapping/same-day/24-hour time scores, exact/adjacent areas, exact/color-family matches, tag cap, threshold 50, Top 3 ordering, and `strong/possible/weak` labels.

```ts
it("rejects a candidate with a different category before scoring", () => {
  expect(scoreCandidate(report({ category: "earbuds" }), item({ category: "wallet" })))
    .toBeNull();
});

it("returns a strong explainable candidate without secret fields", () => {
  const result = scoreCandidate(earbudReport(), matchingEarbudItem());
  expect(result).toMatchObject({ score: 100, confidence: "strong" });
  expect(JSON.stringify(result)).not.toContain("unique_mark");
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npm test -- src/features/matching`
Expected: FAIL because matching modules are absent.

- [ ] **Step 3: Implement focused value types and the score function**

```ts
export type MatchCandidate = {
  candidateId: string;
  score: number;
  confidence: "strong" | "possible" | "weak";
  reasons: string[];
  publicSummary: PublicFoundItem;
};
```

Keep adjacency and color-family maps in explicit constants. Never accept or return secret evidence through matching types.

- [ ] **Step 4: Implement thresholding and stable Top 3 selection**

Sort by score descending, then `foundAt` ascending, then opaque ID for deterministic ties. Return no item below 50.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- src/features/matching`
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/features/inventory src/features/matching src/test
git commit -m "功能：实现可解释的失物候选匹配"
```

### Task 3: Minimal domain errors and state guards

Keep this task deliberately small so the real four-tool viability gate is reached before blind-evidence or pickup-pass implementation.

**Files:**
- Create: `.env.example`
- Create: `src/shared/domain-error.ts`
- Create: `src/features/claims/claim-state.ts`
- Create: `src/server/security/keyring.ts`
- Test: `src/features/claims/claim-state.test.ts`
- Test: `src/server/security/keyring.test.ts`

- [ ] **Step 1: Write failing legal/illegal transition tests**

Test the full Report, Item, and Claim state graph as pure data, including no direct `UNDER_REVIEW → PICKUP_READY`, no `PICKUP_READY → APPROVED` rollback, and terminal-state idempotency rules. This defines states needed by the staging slice without implementing evidence, Staff review, or pickup passes.

- [ ] **Step 2: Define bounded domain errors and purpose-separated keys**

Define `DomainError` with a closed error-code union, safe public message metadata, and no arbitrary details, stack serialization, or embedded identifiers. The keyring accepts an injected stable 256-bit-or-stronger `CLAIMGATE_HMAC_KEY` and derives distinct evidence, pickup-pass, candidate-handle, and database key-check subkeys with HKDF. Tests inject a fixed master key and prove derivation is stable across keyring instances but distinct by purpose; production never auto-generates or rotates the key implicitly. Add empty `CLAIMGATE_HMAC_KEY`, `CLAIMGATE_SESSION_KEY`, and `CLAIMGATE_CSRF_KEY` names to `.env.example`; create high-entropy local values only in ignored `.env.local`, never in command output or Git.

- [ ] **Step 3: Implement transition guards as pure functions**

```ts
export function assertClaimTransition(from: ClaimStatus, to: ClaimStatus) {
  if (!allowedClaimTransitions[from].includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION");
  }
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- src/features/claims/claim-state.test.ts src/server/security/keyring.test.ts`
Expected: PASS.

```powershell
git add .env.example src/shared/domain-error.ts src/features/claims/claim-state.ts src/server/security/keyring.ts src/features/claims/claim-state.test.ts src/server/security/keyring.test.ts
git commit -m "领域：定义 ClaimGate 状态与错误边界"
```

### Task 4: SQLite repository, seed data, and isolated demo instances

**Files:**
- Create: `src/server/db/schema.sql`
- Create: `src/server/db/connection.ts`
- Create: `src/server/db/migrate.ts`
- Create: `src/server/db/repository.ts`
- Create: `src/server/db/seed.ts`
- Create: `src/server/security/rate-limit.ts`
- Create: `scripts/reset-expired-demo-instances.mjs`
- Test: `src/server/db/repository.test.ts`
- Test: `src/server/security/rate-limit.test.ts`

- [ ] **Step 1: Write failing repository tests against a temporary database**

Test instance cloning, instance scoping, two-hour expiry, report/item/claim version increments, demo inventory `catalog_version` increments, audit redaction, idempotency lookup, transaction rollback, persistent rate-limit buckets, and the database key-check lifecycle. Reopen with the same injected key successfully; a different key must fail startup with a bounded configuration error. Add negative tests proving that a valid ID from instance A cannot be referenced by a row or repository method in instance B.

- [ ] **Step 2: Verify failure**

Run: `npm test -- src/server/db/repository.test.ts`
Expected: FAIL because repository modules are absent.

- [ ] **Step 3: Add the schema with explicit foreign keys and indexes**

Every business table includes `demo_instance_id`. Use composite primary/unique keys and composite foreign keys such as `(demo_instance_id, id)` so SQLite itself rejects cross-instance references. Enable `PRAGMA foreign_keys = ON`, verify it on each connection, and use WAL mode. Add a monotonic `catalog_version` to each demo instance and increment it in every transaction that changes inventory availability or public match fields. Reserve evidence-slot columns/tables for later salted digests and pickup-pass columns for digest-only storage, but do not implement those features before the four-tool gate. Add a scoped rate-limit bucket table keyed by instance, actor, action, and window—never by raw secret input—and a consumed one-time-action nonce table for high-consequence CSRF transactions. Store only a key-check authenticator produced by the dedicated key-check subkey so a changed master key fails closed; require a high-entropy key to avoid making the authenticator useful for guessing weak secrets.

- [ ] **Step 4: Implement a dependency-injected repository**

Expose methods by use case rather than generic table access, including `withTransaction`, optimistic `expectedVersion`, and unique idempotency keys.

- [ ] **Step 5: Add fictional Northbridge Campus seed fixtures**

Include at least six same-category distractors using public match fields only at this checkpoint. The demo earbud candidate scores strongly, but private evidence answers are added only after the Task 6A viability gate.

- [ ] **Step 6: Ensure internal inventory identity cannot cross the repository boundary**

Add a test that scans returned DTOs, errors, route-ready objects, and audit rows for raw internal item IDs and cross-instance references. Only repository-internal records may contain the internal key; browser/API-facing DTOs use later signed candidate handles.

- [ ] **Step 7: Implement and test persistent rate-limit primitives**

Use an atomic fixed-window or token-bucket update in SQLite. The primitive accepts an injected clock, returns only allowed/retry-after metadata, and behaves deterministically under concurrent calls and process restarts.

- [ ] **Step 8: Run repository and full unit tests**

Run: `npm test -- src/server/db src/server/security src/features`
Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/server/db src/server/security scripts/reset-expired-demo-instances.mjs
git commit -m "功能：加入隔离演示数据与事务仓库"
```

## Chunk 2: Authenticated product workflow

### Task 5: Signed demo sessions and request authorization

**Files:**
- Create: `src/features/auth/demo-session.ts`
- Create: `src/features/auth/csrf.ts`
- Create: `src/server/http/api-error.ts`
- Create: `src/server/http/request-context.ts`
- Modify: `src/server/security/rate-limit.ts`
- Create: `src/app/api/demo/start/route.ts`
- Create: `src/app/api/demo/switch-role/route.ts`
- Create: `src/components/demo-role-bar.tsx`
- Test: `src/features/auth/demo-session.test.ts`
- Test: `src/features/auth/csrf.test.ts`
- Extend: `src/server/security/rate-limit.test.ts`
- Test: `tests/integration/api-authorization.test.ts`

- [ ] **Step 1: Write failing session tests**

Cover HMAC signature, HttpOnly/SameSite=Lax/Secure-in-production cookie attributes, expiry, tampering, role, opaque session ID, server-derived user ID, and demo instance binding. A role switch must select only a fixed server-side demo identity for that role; it must never accept a caller-provided `userId`.

- [ ] **Step 2: Write failing CSRF, authorization, and rate-limit tests**

Claimant cannot access Staff context; Staff cannot act on another demo instance; absent and malformed cookies return the same bounded response. Every cookie-authenticated state-changing route rejects a missing, expired, wrong-action, wrong-session, reused-when-single-use, or tampered CSRF token and rejects a cross-origin `Origin`/`Sec-Fetch-Site`. WebMCP write adapters obtain the token from authenticated page state and attach it internally; it is never part of tool input or output.

Define a named action bucket for every write: `demo_start`, `role_switch`, `draft_create`, `draft_update`, `report_publish`, `report_archive`, `claim_stage`, `evidence_submit`, `claim_approve`, `claim_reject`, `claim_unlock`, `pickup_issue`, `pickup_reissue`, and `handoff`. Also limit the expensive read `match_find`. Tests must enumerate the matrix so adding a write route without a bucket fails. Verify concurrency, process restart, and `RATE_LIMITED` with bounded `Retry-After`; later route tasks prove each action is wired to its declared bucket.

- [ ] **Step 3: Run and verify failures**

Run: `npm test -- src/features/auth src/server/security tests/integration/api-authorization.test.ts`
Expected: FAIL because session and request-context modules are absent.

- [ ] **Step 4: Implement signed session claims**

```ts
type DemoSession = {
  sessionId: string;
  demoInstanceId: string;
  userId: string;
  role: "CLAIMANT" | "STAFF";
  expiresAt: number;
};
```

Require `CLAIMGATE_SESSION_KEY` outside tests. Do not put secrets or PII in the cookie.

- [ ] **Step 5: Implement action-bound CSRF and normalized request errors**

Mint a short-lived signed CSRF token bound to session ID, HTTP method, route/action, nonce, and expiry. Validate it together with same-origin headers before calling a service. Keep tokens out of URLs, tool contracts/results, and logs; high-consequence manual tokens are consumed transactionally in the same write. Map the closed `DomainError` union to bounded HTTP/WebMCP error codes without stack traces or identifiers.

- [ ] **Step 6: Implement start, explicit demo-role switch, and rate-limited request context**

Starting clones a new instance and enters Claimant mode. Switching changes only the signed role and fixed server-side demo identity for the same instance and is visibly labeled as a public-demo affordance. Request context applies the persistent rate limiter before expensive or abuse-sensitive service calls; both API and WebMCP adapters surface the same `RATE_LIMITED` code.

- [ ] **Step 7: Run tests**

Run: `npm test -- src/features/auth src/server/security tests/integration/api-authorization.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/features/auth src/server/http src/server/security src/app/api/demo src/components/demo-role-bar.tsx tests/integration/api-authorization.test.ts
git commit -m "安全：隔离演示会话与角色权限"
```

### Task 6: Claimant report and matching workflow

**Files:**
- Create: `src/features/reports/report-service.ts`
- Create: `src/features/matching/candidate-handle.ts`
- Modify: `src/features/matching/match-service.ts`
- Create: `src/app/api/reports/route.ts`
- Create: `src/app/api/reports/[reportId]/publish/route.ts`
- Create: `src/app/api/reports/[reportId]/archive/route.ts`
- Create: `src/app/api/reports/[reportId]/matches/route.ts`
- Create: `src/app/claimant/page.tsx`
- Create: `src/app/claimant/reports/[reportId]/page.tsx`
- Create: `src/components/candidate-card.tsx`
- Create: `src/components/privacy-boundary.tsx`
- Test: `src/features/reports/report-service.test.ts`
- Test: `src/features/matching/candidate-handle.test.ts`
- Test: `tests/integration/report-routes.test.ts`

- [ ] **Step 1: Write failing service tests**

Test idempotent private draft creation, owner-only update, manual publish, archive restrictions, deterministic candidate output, no secret fields, stale versions, and match rate limits. Candidate results must contain signed opaque handles rather than raw inventory IDs.

For candidate handles, test tampering, expiry, cross-report use, cross-instance use, and replay after report or inventory change. The signed payload binds `demoInstanceId`, `reportId`, `foundItemId`, current `reportVersion`, current demo `catalogVersion`, and a 15-minute-or-shorter expiry; only the verifier may recover the internal item ID. `catalogVersion` is the authoritative monotonic database value from Task 4, not a browser counter: any item availability/public-match mutation increments it transactionally. `find_candidate_matches` remains read-only and signs the current report/catalog snapshot; staging rejects the handle if either current version differs.

- [ ] **Step 2: Run and verify failures**

Run: `npm test -- src/features/reports src/features/matching/candidate-handle.test.ts tests/integration/report-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement service methods with Zod boundaries**

Routes parse inputs and map domain errors only; business rules stay in services. Wire `draft_create`, `draft_update`, `report_publish`, `report_archive`, and `match_find` to their named buckets and test each. Publish and archive are ordinary POST forms with action-bound CSRF tokens, same-origin checks, optimistic versions, and no WebMCP tool. Matching is rate-limited before inventory work.

- [ ] **Step 4: Build the Claimant Report → Match UI**

Use server components for initial state and small client components for forms. Candidate cards show only a signed opaque candidate handle, broad time/area, color, confidence, and public reasons. Never render or serialize `foundItemId` to the browser.

- [ ] **Step 5: Add accessibility and empty/error states**

All status information must be textual, keyboard reachable, and not color-only. A failed match explains which public input can be refined without revealing inventory details.

- [ ] **Step 6: Run targeted and build checks**

Run: `npm test -- src/features/reports src/features/matching/candidate-handle.test.ts tests/integration/report-routes.test.ts`
Run: `npm run typecheck`
Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/features/reports src/features/matching src/app/api/reports src/app/claimant src/components/candidate-card.tsx src/components/privacy-boundary.tsx tests/integration/report-routes.test.ts
git commit -m "功能：完成报失与脱敏候选流程"
```

### Task 6A: Deliver the 48-hour four-tool vertical slice

This is the stop-loss checkpoint: complete it within 48 hours of implementation start before investing in evidence, Staff, polish, or deployment. If a real supported browser cannot discover and execute the native tools after the Task 1 probe and this slice, stop and reassess contest viability rather than building a WebMCP-shaped mock.

**Files:**
- Create: `src/features/claims/claim-service.ts` (staging only at this checkpoint)
- Create: `src/app/api/claims/route.ts` (staging only at this checkpoint)
- Create: `src/features/webmcp/tool-contracts.ts` (first four tools)
- Create: `src/features/webmcp/tool-executor.ts`
- Create: `src/features/webmcp/tool-registry.ts`
- Create: `src/features/webmcp/use-claimgate-tools.ts`
- Create: `src/features/webmcp/activity-store.ts`
- Create: `src/components/agent-activity.tsx`
- Create: `src/components/webmcp-provider.tsx`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/claimant/page.tsx`
- Modify: `src/app/claimant/reports/[reportId]/page.tsx`
- Create: `src/app/claimant/claims/[claimId]/page.tsx` (minimal `EVIDENCE_REQUIRED` checkpoint page)
- Create: `tests/webmcp/four-tool-slice.test.ts`
- Create: `tests/e2e/claimant-flow.spec.ts` (draft → manual publish → match → stage checkpoint)

- [ ] **Step 1: Write failing direct-execution contracts for four tools**

Cover `create_lost_report_draft`, `list_my_reports`, `find_candidate_matches`, and `stage_claim_candidate`. Each wrapper must strict-parse at runtime with Zod (`.strict()`), reject extra/malformed fields, enforce the authenticated role/state again server-side, and return the common bounded envelope. JSON Schema is discovery metadata, not a validation boundary.

- [ ] **Step 2: Write failing handle-bound staging and post-execute tests**

`stage_claim_candidate` accepts the signed candidate handle, `expectedVersion`, and idempotency key—never a raw item ID. Test cross-report/cross-instance/expired/tampered handles, replay after report update, unavailable item, duplicate call, and stale version. After a successful write tool, the executor must apply the returned `nextPath`, refresh the server snapshot, abort old registrations, and expose the new state-appropriate tool set.

- [ ] **Step 3: Write the first browser vertical slice**

Mount the client `WebMcpProvider` and visible activity component from the real app layout/pages, passing only the authenticated page snapshot they require. Start a fresh isolated instance, invoke the draft tool, publish via the manual CSRF form, invoke match, invoke stage, and assert the browser arrives at the real minimal Claim page in `EVIDENCE_REQUIRED` with only the safe next tool set. Include an unsupported-browser fallback assertion. A registry unit test without a mounted provider does not satisfy this step.

- [ ] **Step 4: Implement the smallest shared adapters and staging transaction**

Reuse report/match services through authenticated HTTP routes; do not duplicate domain rules in the browser. Claim staging verifies the signed handle, current report/catalog versions, item availability, ownership, instance, the `claim_stage` action bucket, idempotency, and optimistic version in one transaction.

- [ ] **Step 5: Run mock, build, and real-browser gates**

Run: `npm test -- tests/webmcp/four-tool-slice.test.ts`
Run: `npm run typecheck`
Run: `npm run build`
Run: `npm run test:e2e -- tests/e2e/claimant-flow.spec.ts`
Then run the same four-tool flow once in the current supported in-app/Chrome environment and record browser version, WebMCP flag/API signature, timestamp, and observed teardown in `docs/submission/webmcp-probe.md`. Expected: all four native tools are discoverable and execute against a fresh real instance.

- [ ] **Step 6: Commit the viability checkpoint**

```powershell
git add src/features/claims src/app/api/claims src/features/webmcp src/components/agent-activity.tsx src/components/webmcp-provider.tsx src/app/layout.tsx src/app/claimant tests/webmcp tests/e2e/claimant-flow.spec.ts docs/submission/webmcp-probe.md
git commit -m "功能：跑通 WebMCP 四工具最小闭环"
```

### Task 6B: Blind-evidence primitives and private seed digests

Begin this task only after Task 6A passes in a real supported browser.

**Files:**
- Create: `src/features/evidence/normalize.ts`
- Create: `src/features/evidence/evidence-service.ts`
- Modify: `src/server/db/seed.ts`
- Modify: `src/server/db/repository.ts`
- Test: `src/features/evidence/evidence-service.test.ts`
- Extend: `src/server/db/repository.test.ts`

- [ ] **Step 1: Write failing normalization, threshold, and leakage tests**

```ts
it.each([
  ["  Blue–Star  ", "blue-star"],
  ["ＢＬＵＥ  STAR", "blue star"],
])("normalizes %s", (input, expected) => {
  expect(normalizeEvidence(input)).toBe(expected);
});

it("qualifies two correct answers and reveals no field result", () => {
  expect(verifyEvidence(secretDigests(), twoCorrectAnswers()))
    .toEqual({ outcome: "ELIGIBLE_FOR_REVIEW" });
});
```

Also test one wrong answer, fewer than two answers, three failures, and one Staff unlock. Each stored evidence slot receives an independent random 16-byte salt. Assert that the same normalized answer produces different digests for different items, slots, instances, and salts, and that neither the answer nor a reusable unsalted digest appears in output or storage.

- [ ] **Step 2: Implement canonical keyed salted comparison**

Use the keyring's evidence subkey and compute over a canonical length-prefixed encoding:

```text
HMAC-SHA256(evidenceKey, demoInstanceId:itemId:slot:salt:normalizedValue)
```

The service returns only `ELIGIBLE_FOR_REVIEW`, `INSUFFICIENT_EVIDENCE`, or `LOCKED`; never return per-field results, counts, salts, or field names. Compare digests with `timingSafeEqual`.

- [ ] **Step 3: Add per-instance private seed digests**

When cloning an isolated demo instance, generate independent salts and hash the three fictional seed answers against that new `demoInstanceId`. Raw seed answers live only inside the server seeding call long enough to normalize/hash; never persist, log, return, or place them in client bundles. Include at least six distractors with private slots.

- [ ] **Step 4: Verify restart and leak boundaries**

Close and reopen the database with the same injected master key and prove verification still succeeds. A changed key fails at the Task 4 key-check before serving requests. Scan table values, DTOs, audit rows, serialized errors, and logs for every raw seed answer.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- src/features/evidence src/server/db/repository.test.ts`
Expected: PASS.

```powershell
git add src/features/evidence src/server/db/seed.ts src/server/db/repository.ts src/server/db/repository.test.ts
git commit -m "安全：加入加盐盲举证与私有种子摘要"
```

### Task 7: Claims, blind evidence, and Staff decisions

**Files:**
- Modify: `src/features/claims/claim-service.ts`
- Create: `src/features/audit/audit-service.ts`
- Modify: `src/app/api/claims/route.ts`
- Create: `src/app/api/claims/[claimId]/evidence/route.ts`
- Create: `src/app/api/staff/claims/[claimId]/decision/route.ts`
- Modify: `src/app/claimant/claims/[claimId]/page.tsx`
- Create: `src/app/staff/page.tsx`
- Create: `src/app/staff/claims/[claimId]/page.tsx`
- Create: `src/components/evidence-form.tsx`
- Create: `src/components/staff-decision-form.tsx`
- Create: `src/components/claim-stepper.tsx`
- Test: `src/features/claims/claim-service.test.ts`
- Test: `tests/integration/claim-transaction.test.ts`

- [ ] **Step 1: Write failing claim-service tests**

Extend stage-claim tests, then cover the manual evidence route, evidence rate limits, 3-attempt lock, single Staff unlock, `UNDER_REVIEW`, manual approve/reject, item `HELD`, and rejection of competing claims without resolving their reports. Every write includes `expectedVersion` and has an idempotent repeat result.

- [ ] **Step 2: Write a failing transaction rollback test**

Inject a repository failure after Claim update and assert Claim, Item, competing Claims, and Audit remain unchanged.

- [ ] **Step 3: Run and verify failures**

Run: `npm test -- src/features/claims tests/integration/claim-transaction.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement ClaimService around one transaction boundary per write**

Keep raw evidence parameters inside the route-to-service call, clear client fields after submit, and write only aggregate outcomes to storage/audit. Approve in one transaction: recheck Claim/Item versions and state, hold the item, increment the instance `catalogVersion`, approve the winner, reject other pending claims, and write one redacted audit event. Concurrent approvals must yield one winner and one bounded conflict.

- [ ] **Step 5: Implement Claimant evidence and Staff queue/review pages**

Use password inputs for evidence. Staff sees eligibility, attempts, conflict state, and redacted audit entries—not raw evidence.

- [ ] **Step 6: Add CSRF, rate limits, and explicit consequence copy to manual forms**

Evidence, approve, reject, and unlock routes validate action-bound CSRF, same-origin headers, role/ownership, optimistic version, and their respective `evidence_submit`, `claim_approve`, `claim_reject`, or `claim_unlock` bucket before their transaction. Evidence attempts still obey the three-attempt lock. The approve form must say it holds the item and rejects competing claims. Reject and unlock are separate explicit actions with separate tokens.

- [ ] **Step 7: Run targeted tests and build**

Run: `npm test -- src/features/claims tests/integration/claim-transaction.test.ts`
Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/features/claims src/features/audit src/app/api/claims src/app/api/staff src/app/claimant/claims src/app/staff src/components/evidence-form.tsx src/components/staff-decision-form.tsx src/components/claim-stepper.tsx tests/integration/claim-transaction.test.ts
git commit -m "功能：完成盲举证与人工审核闭环"
```

### Task 8: Pickup-pass issuance and atomic handoff

**Files:**
- Modify: `src/features/claims/claim-service.ts`
- Create: `src/features/claims/pickup-pass.ts`
- Modify: `src/server/db/repository.ts`
- Create: `src/app/api/claims/[claimId]/pickup-pass/route.ts`
- Create: `src/app/api/staff/claims/[claimId]/handoff/route.ts`
- Create: `src/components/pickup-pass.tsx`
- Modify: `src/app/claimant/claims/[claimId]/page.tsx`
- Modify: `src/app/staff/claims/[claimId]/page.tsx`
- Test: `src/features/claims/pickup-pass.test.ts`
- Test: `tests/integration/pickup-handoff.test.ts`
- Create: `tests/integration/no-secret-leak.test.ts`

- [ ] **Step 1: Write failing route and transaction tests**

Test Claimant-only issuance, `APPROVED/PICKUP_READY` preconditions, 128-bit random pass generation, digest-only persistence, constant-time comparison, generation increments, 10-minute expiry, old-pass invalidation, `pickup_issue`/`pickup_reissue` limits, Staff-only handoff, and atomic `COLLECTED/RETURNED/RESOLVED` updates. Reissue atomically updates state/generation/digest/expiry and invalidates the old generation. Because the server stores only a digest, retrying the same successful issuance idempotency key returns `ALREADY_ISSUED` with safe metadata and no pass, no new generation, and no duplicate audit; the UI offers an explicit separately limited reissue when the first response was lost. Handoff requires `expectedVersion`; an idempotent repeat returns the already-collected result without duplicate transitions or audit events.

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- src/features/claims/pickup-pass.test.ts tests/integration/pickup-handoff.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement manual pass issuance**

Use the pickup-pass subkey to bind the digest to claim ID, demo instance, generation, and expiry. The Claimant page visibly wires separate “Generate pass” and “Reissue pass” forms to the manual route with action-bound single-use CSRF, same-origin checks, version, idempotency key, and their respective rate-limit buckets. Return the newly generated one-time token only once in that no-store manual response. Render it client-side as a QR/canvas and masked fallback, clear it on navigation/timeout, and never add it to URL/history, audit, HTML server markup, WebMCP state, analytics, or logs. Set `Cache-Control: no-store` and a restrictive referrer policy.

- [ ] **Step 4: Implement Staff handoff transaction**

The Staff page wires a separate handoff-confirmation form with CSRF, expected version, idempotency key, the `handoff` rate-limit bucket, and explicit consequence copy. Verify digest, instance, generation, expiry, unused state, Staff role, and held item in one transaction before final updates. Atomically mark Claim `COLLECTED`, Item `RETURNED`, and the winning Report `RESOLVED`, consume the pass, increment `catalogVersion`, and append exactly one redacted audit event.

- [ ] **Step 5: Run tests and scan artifacts**

Create the leak test here, seed distinctive canaries, and scan route responses, rendered HTML, captured logs, database/audit rows, and current WebMCP state. Run: `npm test -- tests/integration/pickup-handoff.test.ts tests/integration/no-secret-leak.test.ts`
Expected: PASS and no raw token/secret anywhere other than the explicit manual issuance response body held only in client memory.

- [ ] **Step 6: Commit**

```powershell
git add src/features/claims src/server/db/repository.ts src/app/api/claims src/app/api/staff src/app/claimant/claims src/app/staff/claims src/components/pickup-pass.tsx tests/integration
git commit -m "功能：加入一次性领取凭证与原子交接"
```

## Chunk 3: WebMCP, verification, deployment, and submission

### Task 9: State-aware WebMCP tools

**Files:**
- Modify: `src/features/webmcp/tool-contracts.ts`
- Modify: `src/features/webmcp/tool-executor.ts`
- Modify: `src/features/webmcp/tool-registry.ts`
- Modify: `src/features/webmcp/use-claimgate-tools.ts`
- Modify: `src/features/webmcp/activity-store.ts`
- Modify: `src/components/agent-activity.tsx`
- Create: `src/app/api/claims/[claimId]/route.ts`
- Create: `src/app/api/claims/[claimId]/pickup-instructions/route.ts`
- Create: `src/app/api/staff/claims/route.ts`
- Create: `src/app/api/staff/claims/[claimId]/route.ts`
- Test: `tests/webmcp/tool-lifecycle.test.ts`
- Test: `tests/webmcp/tool-selection.eval.test.ts`
- Create: `tests/integration/tool-api-routes.test.ts`

- [ ] **Step 1: Write failing contract tests for all nine tools**

Expand the four-tool slice to all nine approved tools. Validate exact names, role/page/state matrix, strict JSON Schemas with `additionalProperties: false`, output size, `readOnlyHint`, and `untrustedContentHint` where UGC can appear. Directly execute every wrapper with malformed, missing, and extra fields and assert strict Zod runtime rejection; schema metadata alone is never trusted.

- [ ] **Step 2: Write failing lifecycle tests**

Use a fake `document.modelContext.registerTool` to capture registrations and AbortSignals. Verify DRAFT → PUBLISHED, EVIDENCE_REQUIRED → UNDER_REVIEW, APPROVED → PICKUP_READY, role switch, and COLLECTED teardown.

- [ ] **Step 3: Write failing HTTP adapter and navigation-sync tests**

Cover authenticated/redacted GET APIs for Claim status, pickup instructions, Staff pending claims, and Staff review summary. Exercise real tool `execute` callbacks—not only registry metadata—and assert that successful writes return `nextPath` plus a fresh state snapshot. Verify create and stage calls push/refresh to the new route, rerender the hook, abort prior registrations, and register exactly the new state-appropriate set.

- [ ] **Step 4: Verify failures**

Run: `npm test -- tests/webmcp tests/integration/tool-api-routes.test.ts`
Expected: FAIL because the remaining five tools, read APIs, and synchronization behavior are absent.

- [ ] **Step 5: Implement tool contracts as strict adapters to HTTP/domain APIs**

```ts
await context.registerTool(contract, { signal: controller.signal });
return () => controller.abort();
```

Every `execute` callback strict-parses with its Zod schema before any call. Do not expose publish, evidence submit, Staff decision, pass issuance, archive, or handoff tools. All service/API responses must be authorization-checked and redacted before tool return. The four read endpoints above use the same service DTOs and return no evidence values, item IDs, pass values, cookies, or private audit details.

- [ ] **Step 6: Implement post-execute application synchronization**

`tool-executor.ts` consumes the adapter result, updates the bounded client snapshot, calls `router.push(nextPath)` when needed or `router.refresh()` in place, and only then resolves the tool result. The hook rerenders from authenticated route/state, aborts the old controller before new registration, and prevents stale completion from resurrecting old tools.

- [ ] **Step 7: Complete the React lifecycle hook**

The hook derives the exact tool set from authenticated role, route, and state. Abort the previous set before registering a new set, handle Strict Mode/HMR without duplicates, and no-op when unsupported.

- [ ] **Step 8: Add a bounded visible activity stream**

Show tool name, start/end time, success/error code, and state change only. Never show full inputs, evidence, cookies, IDs not already public to that role, or pickup tokens.

- [ ] **Step 9: Add deterministic selection eval cases**

Cases include “I lost something” → draft, “publish it” → stop at manual form, “claim this” → stage then manual evidence, “approve it” → no tool, and malicious UGC → ignored.

- [ ] **Step 10: Run tests and build**

Run: `npm test -- tests/webmcp tests/integration/tool-api-routes.test.ts`
Run: `npm run typecheck`
Run: `npm run build`
Expected: PASS.

- [ ] **Step 11: Commit**

```powershell
git add src/features/webmcp src/components/agent-activity.tsx src/app/api/claims src/app/api/staff tests/webmcp tests/integration/tool-api-routes.test.ts
git commit -m "功能：接入动态 WebMCP 协作工具"
```

### Task 10: Security regressions and product verification

**Files:**
- Extend: `tests/integration/no-secret-leak.test.ts`
- Extend: `tests/integration/api-authorization.test.ts`
- Extend: `tests/integration/claim-transaction.test.ts`
- Create: `src/server/http/security-headers.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add failing whole-system secret canary tests**

Seed distinctive canaries and scan serialized API responses, rendered server HTML, WebMCP outputs, database audit rows, and captured logs. Allow the Claimant-submitted raw value only inside the evidence request body and the newly issued pass only inside its manual response.

- [ ] **Step 2: Add failing authorization/concurrency/idempotency tests**

Cover cross-instance IDs/composite foreign keys, role confusion, stale versions, duplicate keys, two simultaneous approvals, repeat handoff, absent/invalid/replayed CSRF, cross-origin writes, rate-limit bypass attempts, expired sessions, and candidate-handle tampering/replay.

- [ ] **Step 3: Run and verify failures**

Run: `npm test -- tests/integration src/server/http`
Expected: at least the new assertions fail before hardening.

- [ ] **Step 4: Apply the minimal hardening needed for green tests**

Require stable production session/HMAC/CSRF secrets, set the nonce CSP and remaining security headers, bound body/output sizes, normalize errors, and ensure no debug logging of request bodies. Browser-test that production hydration and an interactive control work without `unsafe-inline` or production `unsafe-eval`.

- [ ] **Step 5: Run the complete non-E2E gate**

Run: `npm run check:files`
Run: `npm run lint`
Run: `npm run typecheck`
Run: `npm test`
Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add .env.example src tests
git commit -m "安全：封闭权限并防止秘密数据泄漏"
```

### Task 11: End-to-end flows and public-demo polish

**Files:**
- Extend: `tests/e2e/claimant-flow.spec.ts`
- Create: `tests/e2e/staff-handoff.spec.ts`
- Create: `tests/e2e/concurrent-claims.spec.ts`
- Create: `tests/e2e/demo-isolation.spec.ts`
- Create: `tests/e2e/risk-paths.spec.ts`
- Modify: `src/app/globals.css`
- Modify: Claimant/Staff pages and shared components only as failures require

- [ ] **Step 1: Write the main failing Playwright flow**

Start an isolated instance, create/publish report, match, stage, submit two secrets, switch to Staff, approve, switch back, issue pass, handoff, and assert read-only final state.

- [ ] **Step 2: Write the complete risk-path E2E matrix**

Test competing claims; separate instances and reset isolation; evidence failure, three-attempt lock, Staff unlock, and resubmission; pass reissue, old-pass rejection, expiry, and single use; stale expected versions; repeat/idempotent handoff; and mobile Claimant report/match/evidence layout.

- [ ] **Step 3: Run and verify failures**

Run: `npm run test:e2e -- tests/e2e/claimant-flow.spec.ts`
Expected: FAIL until selectors, copy, and missing state refreshes are corrected.

- [ ] **Step 4: Fix only user-visible coherence and accessibility gaps**

Use stable accessible roles/names rather than test IDs where possible. Keep the visual system warm-white/navy with green/amber status accents and ensure focus/error states are visible.

- [ ] **Step 5: Run all E2E and final local gate**

Run: `npm run test:e2e`
Run: `npm run verify`
Expected: PASS.

- [ ] **Step 6: Perform three fresh real WebMCP browser acceptance passes**

Reset into a new isolated demo instance for each run. In ChatGPT's in-app browser or supported Chrome, execute the complete video-script path three independent times: tool-assisted create → manual publish → tool-assisted match/stage → manual evidence → Staff read tools plus manual decision → Claimant status/pickup-instruction tools plus manual pass issuance → manual Staff handoff → final `COLLECTED`. On every run, exercise all nine tools in their valid states, verify old tools are dynamically removed after each transition, verify no human-only action is exposed as a tool, and prove reset creates clean reproducible state. Record browser version, WebMCP flag/API signature, timestamps, instance-reset method, per-run result, and teardown evidence in `docs/submission/testing.md`. This is separate from mock-based tests and must not reuse prior state.

- [ ] **Step 7: Commit**

```powershell
git add src tests/e2e docs/submission/testing.md
git commit -m "测试：完成 ClaimGate 端到端验收"
```

### Task 12: Isolated deployment

**Files:**
- Create: `src/app/api/health/route.ts`
- Test: `src/app/api/health/route.test.ts`
- Create: `deploy/Dockerfile`
- Create: `deploy/docker-compose.example.yml`
- Create: `deploy/claimgate.service.example`
- Create: `deploy/nginx-claimgate.conf.example`
- Create: `scripts/healthcheck.mjs`
- Create: `docs/submission/deployment.md`

- [ ] **Step 1: Add a production health endpoint and failing health test**

Health must verify process and database connectivity without exposing versions, paths, secrets, or record counts. The route test covers healthy, database-unavailable, and no-cache responses.

- [ ] **Step 2: Build the standalone container locally**

Run: `docker build -f deploy/Dockerfile -t claimgate:local .`
Run: `docker run -d --name claimgate-local-smoke -p 127.0.0.1:3410:3000 --env-file .env.production.local claimgate:local`
Run health/smoke checks, capture bounded logs on failure, then run `docker rm -f claimgate-local-smoke`.
Expected: health returns 200, a new demo instance completes the smoke path, and the temporary container is removed.

- [ ] **Step 3: Perform a read-only server inventory before deployment**

Record existing containers, listeners, Nginx vhosts, certificate paths, systemd units, disk/memory, and VPN/proxy lifelines in a private path outside the repository such as `%TEMP%\claimgate-private\server-inventory-<timestamp>.md`. Select a new bounded directory, container name, port, data volume, and subdomain; do not reuse or stop an existing resource. The public `docs/submission/deployment.md` contains only redacted ClaimGate configuration and the final unchanged-services conclusion—never raw server inventory, addresses, usernames, certificate paths, or credentials.

- [ ] **Step 4: Prepare an additive deployment and scoped rollback**

Before changes, save a private copy/checksum of the exact Nginx include state and the existing-service health baseline. Copy only the release artifact/config into the new directory, start only the new named container, add a dedicated Nginx vhost, run `nginx -t`, then reload Nginx without restarting unrelated services. If Docker is unavailable, use the standalone Next.js output with the dedicated `claimgate.service` unit, unique unoccupied loopback port, isolated environment/data directory, and the same additive Nginx procedure. Never modify an existing unit or shared listener.

Define and dry-review the rollback before starting: on any container/unit, certificate, Nginx, public HTTPS, or regression-check failure, stop and remove/disable only the new ClaimGate runtime, remove only the new ClaimGate vhost/include, run `nginx -t`, reload smoothly, and re-run every baseline health check. Preserve the ClaimGate Docker volume or systemd data directory for diagnosis; do not recursively delete it and do not touch unrelated containers, units, listeners, certificates, VPN/proxy services, or project files.

- [ ] **Step 5: Verify from three layers**

Check localhost on server, public HTTPS, and ChatGPT in-app browser. Run external Playwright:

`$env:PLAYWRIGHT_BASE_URL='https://<final-host>'; npm run test:e2e`

Expected: PASS with existing DinnerSync/VPN/other health checks unchanged from the pre-deploy snapshot.

- [ ] **Step 6: Commit reusable deployment assets, not secrets**

```powershell
git add src/app/api/health deploy scripts/healthcheck.mjs docs/submission/deployment.md
git commit -m "部署：加入独立生产运行与验收配置"
```

### Task 13: Public repository and submission package

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `docs/submission/architecture.md`
- Create: `docs/submission/demo-script.md`
- Create: `docs/submission/devpost.md`
- Create: `docs/submission/submitted.md` (only after successful submission)
- Create: `scripts/validate-submission.mjs`

- [ ] **Step 1: Write the English README and architecture evidence**

Explain the real audience, WebMCP fit, human-only boundaries, nine-tool lifecycle, deterministic matching, threat model, local/deployed setup, testing commands, and dated competition work. Include a Mermaid or SVG architecture diagram and MIT license.

- [ ] **Step 2: Draft the under-three-minute demo**

Target 2:30–2:45. Show the actual in-app browser, tool discovery, report/match, private manual evidence, Staff manual approval, pass issuance, handoff, and final tool teardown. Do not claim the Agent cannot see all DOM or resist general computer control; claim only the verified WebMCP boundary.

- [ ] **Step 3: Add submission validation**

The script checks public URL, repository visibility, license, README sections, required Devpost fields, video URL visibility/duration/audio metadata, no placeholders, no local paths, and no secret patterns.

- [ ] **Step 4: Run the local pre-publication gate**

Run: `npm run verify`
Run: `npm run test:e2e`
Run: `node scripts/validate-submission.mjs --prepublish`
Expected: code, local artifacts, copy, placeholders, local paths, and secret scans all PASS. This mode must not require public repository/video/Devpost URLs that do not exist yet.

- [ ] **Step 5: Create/push the public GitHub repository**

After every gate is green, fast-forward the local `main` branch to the reviewed `codex/claimgate-mvp` revision without rewriting unrelated history. Use the authenticated user account to create the public repository, push `main`, set `main` as the remote default branch, and add the MIT license topic/description. Verify the remote HEAD, README, LICENSE, release commit, and a logged-out public clone. The feature branch may also be pushed for provenance, but judges must land on `main`. Never include `.env`, database files, private inventory, server addresses, or credentials.

- [ ] **Step 6: Record and upload the public YouTube video**

Upload as Public, confirm it opens logged out, has audio, and remains under 3 minutes. If CAPTCHA/2FA appears, pause only for the user to complete that verification.

- [ ] **Step 7: Fill and save the Devpost draft**

Re-read the official deadline and requirements. Fill all English fields, live URL, public repo, public video, screenshots, and testing instructions, then save without submitting. If a CAPTCHA, 2FA, or new legal/identity/tax declaration appears, pause only for the user.

- [ ] **Step 8: Run the final external-artifact gate**

Run: `node scripts/validate-submission.mjs --final`
Expected: live HTTPS, logged-out public repository/default branch/README/LICENSE, logged-out public video/duration/audio metadata, saved Devpost field inventory, screenshots, and no placeholders/local paths/secrets all PASS.

- [ ] **Step 9: Submit Devpost and verify the terminal state**

Submit under the already registered eligible account and verify the management page explicitly shows `Submitted`. Record a non-sensitive timestamp and submission URL locally. “Draft saved” or a public project page alone is not completion.

- [ ] **Step 10: Tag the submitted revision and record proof**

```powershell
git tag -a webmcp-submitted -m "WebMCP Challenge submitted revision"
git push origin main --tags
```

Save non-sensitive submission URLs and timestamp in `docs/submission/submitted.md`, commit, and push only if Devpost rules permit post-submission repository documentation updates; otherwise keep the proof local until judging ends.

---

## Execution acceptance

The project is not complete merely because code exists. Completion requires:

- all P0 behavior and security invariants in the approved design;
- mock contract tests plus a real supported-browser WebMCP pass;
- local and public E2E evidence;
- additive deployment with unchanged unrelated service health;
- public repo/video/live URL; and
- Devpost management UI explicitly showing `Submitted`.
