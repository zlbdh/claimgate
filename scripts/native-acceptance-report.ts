import type { NativeAcceptanceResult } from "./native-acceptance-contract";

export type NativeRunArtifact = Readonly<{
  ordinal: number;
  runId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  browserVersion: string;
  artifact: string;
  sha256: string;
}>;

export type NativeAcceptanceAggregate = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  baseCommit: string;
  buildId: string;
  sourceState: "clean" | "dirty";
  serial: true;
  runCount: 3;
  allPassed: true;
  runs: readonly NativeRunArtifact[];
}>;

function tools(value: readonly string[]): string {
  return value.length === 0 ? `\`[]\`` : value.map((name) => `\`${name}\``).join(", ");
}

export function renderNativeTestingMarkdown(
  aggregate: NativeAcceptanceAggregate,
  canonical: NativeAcceptanceResult,
): string {
  const sourceNotice = aggregate.sourceState === "clean"
    ? "This evidence comes from a clean worktree; the base commit matches the source that was built."
    : "> **Development evidence:** The source state for this run is `dirty`. After committing Task 11 code, run `npm run accept:native:3:clean` and replace this directory with evidence from the exact clean commit before using it for final submission.";
  const runRows = aggregate.runs.map((run) => `| ${[
    run.ordinal, `\`${run.runId}\``, run.startedAt, run.endedAt,
    `${run.durationMs} ms`, `\`${run.browserVersion}\``, "9/9", "PASS", "PASS", "PASS",
  ].join(" | ")} |`).join("\n");
  const phaseRows = canonical.phases.map((phase) => (
    `| ${phase.phase} | ${phase.observedAt} | ${tools(phase.tools)} |`
  )).join("\n");
  const artifactRows = aggregate.runs.map((run) => (
    `| Run ${run.ordinal} | [${run.artifact}](${run.artifact}) | \`${run.sha256}\` |`
  )).join("\n");
  return `# ClaimGate Task 11: Three Native WebMCP Acceptance Runs

## Conclusion

The same production build completed native Chrome 151 acceptance in three strictly sequential, independent processes. Each run created a fresh temporary SQLite database and one demo instance, executed all nine WebMCP tools, manually completed publication, evidence submission, approval, pass issuance, and handoff, then confirmed an empty Home tool set and cleaned up the browser, server, and temporary directory.

${sourceNotice}

## Build and environment

| Field | Value |
| --- | --- |
| Base commit | \`${aggregate.baseCommit}\` |
| Next build ID | \`${aggregate.buildId}\` |
| Source state | \`${aggregate.sourceState}\` |
| Node | \`${canonical.nodeVersion}\` |
| Playwright | \`${canonical.playwrightVersion}\` |
| Browser | Chrome for Testing \`${canonical.browserVersion}\` |
| Feature | \`${canonical.flag}\` |
| Generated at | ${aggregate.generatedAt} |

Command:

\`\`\`powershell
npm run accept:native:3
# Final evidence gate after the Task 11 commit:
npm run accept:native:3:clean
\`\`\`

This command builds once, then starts three independent verifier subprocesses in sequence. A subprocess, structural validation, cleanup, or artifact-validation failure immediately stops execution without publishing partially successful evidence.

## Three-run summary

| Run | Run ID | Started UTC | Ended UTC | Duration | Browser | Tools | Human-only absent | Home teardown | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${runRows}

Each result also verifies \`instanceCount=1\`, \`cleanupVerified=true\`, and \`humanOnlyToolsAbsent=true\`, and scans tool output, HTML, Agent activity, browser/server logs, storage, and history for internal inventory IDs, runtime evidence canaries, and pickup credentials.

## Canonical 13-stage matrix

The table below comes from Run 1. Runs 2 and 3 are checked item by item against the same structured contract.

| Phase | Observed UTC | Native getTools() |
| --- | --- | --- |
${phaseRows}

## Human-action boundaries

| Human action | Acceptance method | WebMCP tool |
| --- | --- | --- |
| Publish report | Page CSRF form button | None |
| Submit private evidence | Manual password-input form | None |
| Approve claim | Manual Staff button | None |
| Generate pickup pass | Manual Claimant button | None |
| Complete handoff | Manual Staff credential form | None |
| Switch role | Manual demo button | None |

Tool names at every stage belong strictly to the approved nine-tool set. None of the human-action names above appears in any descriptor across the three runs.

## Isolation, teardown, and cleanup

- The three runs use three independent Node processes without reusing module-level phase/executed state.
- Each run uses \`mkdtemp\` for a separate database directory and verifies exactly one demo instance in the database.
- Each run ends on Home and repeatedly observes stable native \`getTools() = []\` results.
- Result JSON is emitted only after \`cleanupNativeRun\` succeeds. Cleanup closes the browser, terminates or force-terminates the standalone server, and removes the protected temporary directory.

## Raw evidence and SHA-256

| Run | Artifact | SHA-256 |
| --- | --- | --- |
${artifactRows}

Aggregate evidence: [aggregate.json](evidence/native/aggregate.json); checksum manifest: [SHA256SUMS.txt](evidence/native/SHA256SUMS.txt). Evidence does not record cookies, CSRF, sessions, candidate handles, report/claim/internal inventory IDs, or user-input bodies.

## Evidence boundaries and limitations

- This is native WebMCP evidence from a local production standalone build with the Chrome testing feature; it is not public HTTPS deployment acceptance.
- Membership is considered stable after three consecutive identical observations, so very brief intermediate states may be missed. Dedicated lifecycle tests cover StrictMode, HMR, A→B→A, delayed completion, and AbortSignal.
- Chrome WebMCP remains a proposed API. This evidence records the actual Chrome 151 signatures without inferring older runtime behavior from later drafts.
`;
}
