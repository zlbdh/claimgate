# ClaimGate Devpost copy draft

Status: working submission draft. The public artifacts have been verified, but
this file does not represent the project as formally submitted on Devpost.
Re-read the live form and rules before finalization.

## Project name

ClaimGate

## Tagline

Agent-assisted lost-property search with private proof and human release
decisions.

## Links

| Devpost field | Value |
| --- | --- |
| Try it out | <https://ds.zlbdh.top:8443> |
| Code repository | <https://github.com/zlbdh/claimgate> |
| Demo video | <https://youtu.be/v3siwO314Aw> |
| Gallery thumbnail | `gallery-thumbnail-3x2.png` (uploaded to Devpost) |
| Gallery screenshots | `gallery-01-candidates.png`, `gallery-02-staff-review.png`, `gallery-03-collected.png` (uploaded to Devpost) |

## Built with

WebMCP, Next.js, React, TypeScript, SQLite, better-sqlite3, Zod, Vitest,
Testing Library, Playwright, Node.js, Nginx, Docker

## Problem

Lost-property desks need enough public detail to find a likely item without
publishing the details that prove ownership. Giving every field to an Agent
would turn private proof into searchable material.

ClaimGate separates public matching from private proof. The Agent handles
structured preparation and safe reads. People publish, submit evidence, decide
the claim, issue the pickup credential, and complete the release.

## Why WebMCP

This workflow changes as the claim moves from draft to match, review, pickup,
and collection. WebMCP lets the page expose the few actions that are valid now,
with typed inputs and bounded results. The Agent does not have to infer controls
from page layout, and sensitive actions can stay absent from the tool set.

## Better experience

A Claimant can describe a loss once, let the Agent structure the public fields,
and receive explainable candidates without copying data between screens. Staff
gets a short queue and a redacted summary. Each person sees the next action in
the same claim instead of reconstructing context after every role change.

## Before and after

Before ClaimGate, the demo journey is a sequence of manual forms and page
searches, with a risk of mixing public clues and ownership proof. With ClaimGate,
the Agent prepares, searches, and summarizes through explicit tools while the UI
reserves publication, proof, judgment, credential transfer, and handoff for
visible human controls.

## What it does

A Claimant starts a fresh two-hour instance with fictional Northbridge Campus
inventory. The Agent can create or update a lost-report draft, list reports,
find up to three candidates, and stage one candidate. Results contain broad
fields, confidence bands, and public reasons, not internal inventory IDs.

The Claimant publishes and submits masked evidence manually. Two correct slots
are sufficient even if a third submitted slot is wrong. The browser receives
only aggregate eligibility, insufficiency, or the third-attempt `LOCKED` state.
Staff reads a bounded queue and redacted review summary, then decides manually.

After approval, the Agent can read pickup instructions. The Claimant manually
generates and copies a ten-minute, one-time credential, then Staff pastes it into
the handoff form. One transaction marks the claim collected, item returned, and
report resolved. The normal web flow also works without WebMCP.

## How implemented

ClaimGate is one Next.js 16 application with separate report, matching,
evidence, claim, authorization, audit, and WebMCP modules. SQLite scopes every
record to a demo instance. Signed HttpOnly sessions and server routes enforce
role, ownership, state, version, CSRF, origin, idempotency, and rate limits.

The browser uses native `document.modelContext.registerTool()`. A page and state
registry selects nine tools, and an `AbortController` removes the previous
generation on navigation or state change. Tool visibility assists selection;
the server remains authoritative.

The tools are `create_lost_report_draft`, `update_lost_report_draft`,
`list_my_reports`, `find_candidate_matches`, `stage_claim_candidate`,
`get_claim_status`, `get_pickup_instructions`, `list_pending_claims`, and
`get_claim_review_summary`. Publishing, evidence, decisions, pass issue or
reissue, role switching, and handoff have no WebMCP tool.

Matching uses fixed category, time, area, color, and tag rules. Runtime evidence
comparison uses salted HMAC digests and a fixed three-slot shape. The public
repository contains the readable fictional seed answers so judges can run the
demo; the privacy boundary covers runtime clients, pages, APIs, WebMCP, logs,
and stored raw evidence, not repository readers.

Only a successful issue or reissue response returns the full pickup credential.
The current Claimant page keeps it in memory and can reveal, mask, or copy it.
Navigation or refresh clears it and cannot recover it. The server stores only a
digest, and reissue invalidates the previous generation.

## Challenges we ran into

- **State-aware tool lifecycle:** Chrome 151 can briefly change membership while
  registrations are replaced. A serialized generation manager and server state
  checks make stale calls fail safely.
- **Runtime privacy evidence:** We separated public DTOs from private transports,
  signed opaque candidate handles, bounded outputs, and scanned tool results,
  HTML, logs, storage, history, and public build assets.
- **Visible cross-role continuity:** Claimant and Staff must resume the same
  authorized claim without hidden navigation. Contextual role switching and a
  14-scenario visible Playwright suite cover that path.

## Accomplishments that we're proud of

- The complete report, match, proof, review, pickup, and handoff flow works in
  the normal UI and the WebMCP-assisted path.
- Nine tools appear only in valid page and state scopes; human-only actions stay
  absent.
- A clean production build completed three independent native Chrome 151 runs.
  Each used fresh SQLite state, exercised all nine tools, completed the manual
  transitions, and ended with Home tools `[]`.
- All 14 visible Playwright E2E scenarios passed after commit `04c618d` added
  contextual cross-role claim navigation.
- The release path isolates its runtime, data, processes, ingress, and Nginx
  resources from unrelated services.

These are implementation and test results, not claims of awards, adoption,
users, or judging outcome.

## What we learned

Tool discovery improves planning but is not authorization. Runtime privacy needs
separate data paths, not hidden UI fields. Human control is clearest when a
sensitive transition has no tool at all. Stateful WebMCP also needs navigation,
stale-version, delayed-completion, and teardown tests, not only a happy path.

## What's next

A production pilot would need institutional identity, enrolled Staff,
accessibility and abuse review, retention policy, backup and recovery, and a
database architecture for multiple application instances. Configurable matching
and evidence policies should preserve the same public-match, private-proof, and
human-release boundaries.

## Testing instructions

```powershell
npm ci
npm run verify
npm run test:e2e
npm run verify:deployment
npm run accept:native:3:clean
```

`docs/submission/testing.md` records the native browser, build, three run IDs,
13 lifecycle phases, cleanup, and SHA-256 evidence. The public deployment remains
a separate gate until its live URL is verified.

## Judge path after publication

1. Open the live URL in the ChatGPT in-app browser and start a fresh instance.
2. Let the Agent create, update, and list a fictional report.
3. Click **Publish report manually**.
4. Call match and stage in separate prompts, then submit masked evidence manually.
5. Return Home, switch to Staff, open the desk, call the queue tool, and open the
   visible claim.
6. Read the review summary and approve manually.
7. Contextually switch to Claimant, read status and instructions, generate, and
   copy the pass.
8. Contextually switch to Staff, paste the pass, and click
   **Confirm atomic handoff**.
9. Read `COLLECTED`, return through the queue to Home, and confirm tools `[]`.

## Artifact verification before save

- Replace every `_PENDING` value.
- Verify the demo, repository, video, thumbnail, and screenshots while logged
  out.
- Verify that the default branch contains complete source, required assets,
  README, and MIT License, and that the public About panel recognizes MIT.
- Verify the live URL in the in-app browser and WebMCP-enabled Chrome.
- Verify YouTube is Public, has audio, and is strictly shorter than three minutes.
- Save the draft without calling it submitted; submit only after the final gate.
- Confirm that Devpost management explicitly shows `Submitted` afterward.

## Form-only user confirmation checklist

The account holder must personally confirm these facts in the live Devpost form.
Do not copy the answers into this repository, screenshots, logs, or automation:

- submitter type, such as individual, team, or organization;
- actual residence, country, and challenge eligibility;
- whether the entry is new or existing work, using the true work timeline;
- the intended public repository and its recognized open-source license;
- the challenge rules, platform Terms of Service, and any legal, identity, tax,
  or compliance declaration shown at submission time.
