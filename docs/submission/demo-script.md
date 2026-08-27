# ClaimGate demo script

Target length: 2 minutes 45 seconds to 2 minutes 50 seconds. Hard limit:
strictly under 3 minutes.

## Recording setup

- Record the actual ChatGPT in-app browser against the verified public HTTPS
  deployment, with the public domain visible in the address bar and the Agent
  activity panel readable.
- Never show a raw server IP, SSH detail, environment value, session value, or
  private recording note.
- Start a fresh demo instance and use only fictional, non-identifying
  Northbridge Campus data.
- Keep private evidence masked and out of Agent chat. The fictional seed values
  are readable in the public source, but they must not appear in runtime tool
  results or narration.
- Use the page's **Copy credential** control. Do not reveal or speak the full
  pickup credential.
- Record original narration. Use no music unless it is original or separately
  authorized for this submission.
- Do not use an injected test harness, DevTools console, or tool simulation.
- The page exposes a small WebMCP tool set that changes with visible state. The
  final Home return must show the complete tool teardown.

## Timed script

| Time | Visible action | Original narration |
| --- | --- | --- |
| 0:00-0:08 | Show the public ClaimGate domain in the in-app browser. Click **Start public demo**. | "ClaimGate lets an Agent handle the repetitive search steps while people keep control of proof and release." |
| 0:08-0:20 | Ask: **Create a lost-report draft for category earbuds, from `2026-08-25T17:30:00.000Z` to `2026-08-25T19:30:00.000Z`, area library, color black, tags wireless, charging-case, compact, and public description Black wireless earbud case lost near the library.** Show `create_lost_report_draft` and the draft page. | "The in-app browser discovers native WebMCP tools for the current page. The Agent turns my description into a structured private draft." |
| 0:20-0:29 | Ask: **Update the public description to Black wireless earbud charging case lost near the library reading room.** Show `update_lost_report_draft`. | "The server still checks the signed session, owner, version, and rate limit." |
| 0:29-0:36 | Ask: **List my reports.** Show `list_my_reports` and the current draft. | "A bounded read confirms the saved report without exposing private proof." |
| 0:36-0:43 | Click **Publish report manually**. | "Publication has no WebMCP tool. I make that decision in the page." |
| 0:43-0:53 | Ask: **Find up to three candidate matches for this published report.** Show `find_candidate_matches` and the visible candidate cards. | "Deterministic matching uses category, time, broad area, color, and public tags." |
| 0:53-1:02 | Ask: **Stage the strongest current candidate.** Show `stage_claim_candidate` and the claim page. | "The Agent receives an opaque current candidate handle, not an internal inventory ID." |
| 1:02-1:12 | Enter two prepared fictional values in the masked private form and click **Submit private evidence**. | "I submit proof manually. Two correct slots are eligible even if a third answer is wrong, and the response never identifies the matching fields." |
| 1:12-1:19 | Ask: **Read this claim's status and next safe step.** Show `get_claim_status` returning `UNDER_REVIEW`. | "The Agent can read the aggregate state, but it cannot approve the claim." |
| 1:19-1:35 | Click **Return to ClaimGate desk**. Wait for Home to settle and its ClaimGate tool set to become empty. Click **Switch to Staff role**, then **Open Staff review desk**. | "I change roles through visible controls. The first Staff visit starts from Home and the review desk, not a hidden route." |
| 1:35-1:44 | Ask: **List the pending claims.** Show `list_pending_claims` and the visible queue. | "Staff gets a short review queue with public item details." |
| 1:44-1:53 | Click the visible earbuds queue entry. Ask: **Read the safe review summary for this claim.** Show `get_claim_review_summary`. | "The summary contains eligibility, attempts, conflicts, and a redacted timeline, not the evidence values." |
| 1:53-2:00 | Read the consequence and click **Approve claim**. | "Approval is a Staff decision. One transaction holds the item and closes competing pending claims." |
| 2:00-2:10 | On the same claim page, click **Switch to Claimant role** and show the contextual redirect to the Claimant version of that claim. | "The visible role switch resumes the same authorized claim without copying an ID into the address bar." |
| 2:10-2:19 | Ask: **Read my claim status and pickup instructions. Do not issue a pass.** Show `get_claim_status` and `get_pickup_instructions`. | "The Agent can explain the desk, hours, readiness, and expiry, but it cannot issue the credential." |
| 2:19-2:28 | Click **Generate pickup pass**, wait for the in-memory credential, then click **Copy credential**. Keep it masked. | "Only this issue response returns the pass. It lives in this page's memory; leaving or refreshing cannot recover it." |
| 2:28-2:37 | Click **Switch to Staff role**. On the contextually resumed Staff claim, focus **One-time pickup credential** and press **Ctrl+V**. | "I transfer the one-time credential manually. It never enters a WebMCP result." |
| 2:37-2:44 | Click **Confirm atomic handoff**. Show `COLLECTED`. | "The handoff atomically marks the claim collected, the item returned, and the report resolved." |
| 2:44-2:50 | Ask: **Read the final claim status.** Show `get_claim_status`, click **Staff review queue**, then **Return to ClaimGate desk**, and show the visible no-tools status. | "The final status is read-only. Returning Home removes every ClaimGate tool; native acceptance records the resulting set as empty." |

## Coverage checklist

The recording must visibly exercise all nine approved tools:

1. `create_lost_report_draft`
2. `update_lost_report_draft`
3. `list_my_reports`
4. `find_candidate_matches`
5. `stage_claim_candidate`
6. `get_claim_status`
7. `list_pending_claims`
8. `get_claim_review_summary`
9. `get_pickup_instructions`

It must visibly complete these manual actions without representing them as
tools:

- **Publish report manually**;
- **Submit private evidence**;
- **Approve claim**;
- **Generate pickup pass** and **Copy credential**;
- **Confirm atomic handoff**;
- both visible role switches.

## Final recording checks

- Exported duration is 2:45 to 2:50, with audible original narration and no
  unauthorized music.
- YouTube visibility is Public, never Unlisted or Private.
- The public domain remains visible; no raw IP or SSH information appears.
- Tool names and Agent activity are legible at normal playback size.
- `find_candidate_matches` and `stage_claim_candidate` use separate prompts.
- The first Staff path visibly goes Home, waits, switches role, opens the Staff
  desk, calls the queue tool, and opens a visible queue entry.
- The credential is generated, copied, pasted with **Ctrl+V**, and never shown
  in Agent chat or clear text.
- No publish, evidence, decision, pass-issue, role-switch, or handoff tool is
  exposed.
- The last sequence shows `COLLECTED`, the Staff queue, Home, and the visible
  no-tools status. Native acceptance separately records `getTools() = []`.
