# ClaimGate Native WebMCP Compatibility Evidence

> Historical note: This document records the Task 6A four-tool feasibility gate and its page matrix, not the current nine-tool implementation. See [testing.md](testing.md) and its structured artifacts for the three current nine-tool native acceptance runs.

## Conclusion

On 2026-08-27 at 11:41 (Asia/Shanghai), ClaimGate completed the four-tool workflow in Chrome for Testing 151 without injecting or overriding `document.modelContext`, using a production build, a fresh temporary SQLite database, and a fresh demo instance. Both write tools returned non-`null` JSON strings before Next performed same-document navigation to `nextPath`. The tool sets were empty at the Claim checkpoint and after leaving the Claimant page.

Browsers without WebMCP still display a bounded fallback explanation, and manual forms remain usable. Injected Playwright coverage checks provider/HTTP/page regressions only and does not replace the native evidence below.

## Official references and versions

- The [Chrome WebMCP imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api) uses `document.modelContext.registerTool()` and `AbortSignal`. Chrome 153 explicitly improves how unregistration affects executing tools, so this gate retains deferred generation changes for Chrome 151.
- [Chromium 151 about_flags.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.34/chrome/browser/about_flags.cc) maps `enable-webmcp-testing` to `blink::features::kWebMCPTesting`.
- The current draft has changed. This acceptance uses the actual Chrome 151 runtime rather than inferring older browser behavior from a newer draft.

## Environment and actual signatures

| Field | Observed value |
| --- | --- |
| Time | `2026-08-27T03:41:50.907Z` |
| Browser | Chrome for Testing `151.0.7922.34` (Playwright Chromium `v1234`) |
| feature | `--enable-features=WebMCPTesting` |
| Registration | `registerTool(tool, { signal }) -> Promise<void>` |
| Discovery | `getTools() -> Promise<descriptor[]>` |
| Schema | Descriptor `inputSchema` is a JSON string; each is parsed as a strict object |
| Execution | `executeTool(descriptor, JSON.stringify(input)) -> Promise<string|null>` |
| Isolation | Fresh temporary SQLite database and demo instance, deleted after the run |

## Four-tool stage matrix

| Page stage | Native `getTools()` results in lexicographic order |
| --- | --- |
| Claimant workspace | `create_lost_report_draft`, `list_my_reports` |
| DRAFT report | `list_my_reports` |
| PUBLISHED report | `find_candidate_matches`, `list_my_reports` |
| PUBLISHED + current candidates | `find_candidate_matches`, `list_my_reports`, `stage_claim_candidate` |
| EVIDENCE_REQUIRED checkpoint | Empty array |
| After leaving the Claimant page | Empty array |

Each of the four tools executed once in an allowed stage. Publication used a real manual CSRF form and was never registered as a tool. Native raw results from `create_lost_report_draft` and `stage_claim_candidate` were non-`null` JSON strings; `list_my_reports` and `find_candidate_matches` also returned JSON-string envelopes.

## Lifecycle, navigation, and scanning

- Chrome 151 registration/unregistration briefly changes membership; `toolchange` counts and timing are not fixed contracts. The verifier waits for three consecutive identical tool sets before execution instead of asserting a fixed event count.
- Candidate state is published in a later macrotask after find completes. `router.push()` and `router.refresh()` run in a later macrotask after create/stage complete. Native results therefore finish serialization before the old scope aborts.
- Both create and stage reached their `nextPath` without hard navigation or cross-document `null` write results.
- Before the native run ended, it navigated to Home and confirmed that `getTools()` was empty again.
- Scanning raw tool results, stage HTML, Agent activity, browser console, and local server logs with actual database internal inventory IDs found no leaks. Tool results also contained no internal-ID fields, catalog versions, exact found times, scores, CSRF, cookies, or stacks.

Command:

```powershell
npm run build
npm run probe:native
```

`scripts/verify-native-webmcp.ts` starts the production standalone server, creates a temporary database, and launches Chrome 151 with the official testing feature. Its `finally` block closes the browser/server and deletes the database. The script neither defines, overrides, nor injects `document.modelContext`.

## Automation boundaries

- Vitest verifies strict schemas, direct execution, staging transactions, page matrices, StrictMode/partial failure/generation behavior, and activity redaction.
- Production injected Playwright verifies the real mounted provider, tool callbacks, HTTP, cookies, SQLite, and page navigation. It is not evidence of native acceptance.
- This file records no CSRF, cookies, sessions, candidate handles, report/claim/internal inventory IDs, or user-input bodies.
