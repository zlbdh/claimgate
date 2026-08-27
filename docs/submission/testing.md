# ClaimGate Native WebMCP Three-Run Acceptance

## Conclusion

The same production build passed native Chrome 151 acceptance in three strictly serial runs, each executed in an independent process. Every run created a fresh temporary SQLite database and exactly one demo instance, exercised all nine WebMCP tools, completed report publication, evidence submission, approval, pickup-pass generation, and handoff through manual actions, then confirmed that the Home tool set was empty before cleaning up the browser, server, and temporary directory.

This evidence was produced from a clean worktree. The base commit matches the source that was built.

## Build and Environment

| Field | Value |
| --- | --- |
| Base commit | `04c618da85f63d3c5485b90f3a8924f8e919bf37` |
| Next build ID | `J6kGt3e4z_6cAce9eLg4v` |
| Source state | `clean` |
| Node | `v22.20.0` |
| Playwright | `1.62.1` |
| Browser | Chrome for Testing `151.0.7922.34` |
| Feature | `--enable-features=WebMCPTesting` |
| Generated at | 2026-08-27T21:12:55.193Z |

Commands:

```powershell
npm run accept:native:3
# Final clean-evidence gate for the reviewed implementation commit:
npm run accept:native:3:clean
```

The command builds once and then launches three independent verifier child processes in sequence. A failure in any child process, structural validation, cleanup step, or artifact validation stops the run immediately, and no partial-success evidence is published.

## Three-Run Summary

| Run | Run ID | Started UTC | Ended UTC | Duration | Browser | Tools | Human-only absent | Home teardown | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `4147975c-0948-4574-b9b1-e54ed5f21795` | 2026-08-27T21:12:33.008Z | 2026-08-27T21:12:42.688Z | 9680 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |
| 2 | `c6dc2f99-8051-411a-951d-b73da0a31767` | 2026-08-27T21:12:43.405Z | 2026-08-27T21:12:48.974Z | 5569 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |
| 3 | `9e79cced-f5a5-499e-8a10-76f54ac550e9` | 2026-08-27T21:12:49.663Z | 2026-08-27T21:12:55.165Z | 5502 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |

Each result also verifies `instanceCount=1`, `cleanupVerified=true`, and `humanOnlyToolsAbsent=true`. Tool output, HTML, Agent activity, browser and server logs, storage, and history are scanned to exclude internal inventory IDs, the runtime-evidence canary, and the pickup credential.

## Canonical 13-Stage Matrix

The table below comes from Run 1. Runs 2 and 3 are validated field by field against the same structured contract.

| Phase | Observed UTC | Native getTools() |
| --- | --- | --- |
| Claimant workspace | 2026-08-27T21:12:38.661Z | `create_lost_report_draft`, `list_my_reports` |
| DRAFT report | 2026-08-27T21:12:38.966Z | `list_my_reports`, `update_lost_report_draft` |
| PUBLISHED report | 2026-08-27T21:12:39.350Z | `find_candidate_matches`, `list_my_reports` |
| PUBLISHED with candidates | 2026-08-27T21:12:39.489Z | `find_candidate_matches`, `list_my_reports`, `stage_claim_candidate` |
| EVIDENCE_REQUIRED checkpoint | 2026-08-27T21:12:39.705Z | `get_claim_status` |
| UNDER_REVIEW Claimant | 2026-08-27T21:12:40.077Z | `get_claim_status` |
| Staff queue | 2026-08-27T21:12:40.464Z | `list_pending_claims` |
| Staff UNDER_REVIEW claim | 2026-08-27T21:12:40.728Z | `get_claim_review_summary`, `get_claim_status` |
| Staff APPROVED claim | 2026-08-27T21:12:41.008Z | `get_claim_review_summary`, `get_claim_status` |
| Claimant APPROVED claim | 2026-08-27T21:12:41.537Z | `get_claim_status`, `get_pickup_instructions` |
| Staff PICKUP_READY claim | 2026-08-27T21:12:42.066Z | `get_claim_review_summary`, `get_claim_status` |
| Staff COLLECTED claim | 2026-08-27T21:12:42.330Z | `get_claim_status` |
| Home teardown | 2026-08-27T21:12:42.534Z | `[]` |

## Manual-Action Boundary

| Manual action | Acceptance method | WebMCP tool |
| --- | --- | --- |
| Publish report | Page CSRF form button | None |
| Submit private evidence | Password-type manual form | None |
| Approve claim | Staff manual button | None |
| Generate pickup pass | Claimant manual button | None |
| Complete handoff | Staff manual credential form | None |
| Switch role | Demo manual button | None |

Every tool name observed at every stage belongs strictly to the approved nine-tool set. The names of the manual actions above occur zero times across every descriptor in all three runs.

## Isolation, Teardown, and Cleanup

- The three runs execute in three independent Node processes, with no reuse of module-level phase or executed state.
- Each run uses `mkdtemp` to create an isolated database directory and verifies that the database contains exactly one demo instance.
- Each run ends on Home and continuously observes a stable native `getTools() = []` result.
- The result JSON is emitted only after `cleanupNativeRun` succeeds. Cleanup closes the browser, terminates or force-terminates the standalone server, and removes the protected temporary directory.

## Raw Evidence and SHA-256

| Run | Artifact | SHA-256 |
| --- | --- | --- |
| Run 1 | [evidence/native/run-1.json](evidence/native/run-1.json) | `c0d9260091ac200f1989703ce41d800ac186d0cc735cbfe0bd0dd2a2d366fdf3` |
| Run 2 | [evidence/native/run-2.json](evidence/native/run-2.json) | `7abbd5f4fa6ff66a19ca0d35ec8003e26daf7396a06df97bfd9127824a08bc26` |
| Run 3 | [evidence/native/run-3.json](evidence/native/run-3.json) | `207cf060bc504f3804b4a8ecce459269373e307e914415cc11c116d86d91a1e9` |

Aggregated evidence: [aggregate.json](evidence/native/aggregate.json). Verification manifest: [SHA256SUMS.txt](evidence/native/SHA256SUMS.txt). The evidence records no Cookie, CSRF token, session, candidate handle, report/claim/internal inventory ID, or user-entered body text.

## Evidence Boundaries and Limitations

- This is native WebMCP evidence from a local production standalone server using the Chrome testing feature. It is not equivalent to acceptance of a public HTTPS deployment.
- Tool membership is established through three consecutive identical observations. This cannot capture extremely brief intermediate states; StrictMode, HMR, A→B→A transitions, delayed completion, and `AbortSignal` are covered by targeted lifecycle tests.
- Chrome WebMCP is still a proposed API. This evidence records the actual Chrome 151 signature and does not reinterpret the historical runtime using a later draft.
