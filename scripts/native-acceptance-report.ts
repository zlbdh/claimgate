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
    ? "本证据来自 clean worktree，base commit 与被构建源码一致。"
    : "> **开发期证据：** 本次 source state 为 `dirty`。Task 11 代码提交后必须运行 `npm run accept:native:3:clean`，用 clean exact commit 覆盖本目录后才可作为最终提交证据。";
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
  return `# ClaimGate Task 11 原生 WebMCP 三次验收

## 结论

同一正式构建在三个严格串行、彼此独立的进程中完成原生 Chrome 151 验收。每次均创建全新临时 SQLite 与单一 demo instance，执行全部九个 WebMCP 工具，人工完成发布、举证、审批、凭证签发与交接，最后确认 Home 工具集为空并完成浏览器、server 和临时目录清理。

${sourceNotice}

## 构建与环境

| 字段 | 值 |
| --- | --- |
| Base commit | \`${aggregate.baseCommit}\` |
| Next build ID | \`${aggregate.buildId}\` |
| Source state | \`${aggregate.sourceState}\` |
| Node | \`${canonical.nodeVersion}\` |
| Playwright | \`${canonical.playwrightVersion}\` |
| Browser | Chrome for Testing \`${canonical.browserVersion}\` |
| Feature | \`${canonical.flag}\` |
| 生成时间 | ${aggregate.generatedAt} |

执行命令：

\`\`\`powershell
npm run accept:native:3
# Task 11 commit 后的最终证据门：
npm run accept:native:3:clean
\`\`\`

该命令只构建一次，然后依次启动三个独立 verifier 子进程；任一子进程、结构校验、cleanup 或 artifact 校验失败都会立即终止，且不会发布部分成功证据。

## 三次运行摘要

| Run | Run ID | Started UTC | Ended UTC | Duration | Browser | Tools | Human-only absent | Home teardown | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${runRows}

每次结果还验证：\`instanceCount=1\`、\`cleanupVerified=true\`、\`humanOnlyToolsAbsent=true\`，并扫描 tool output、HTML、Agent activity、浏览器/server 日志、storage 与 history，排除 internal inventory ID、runtime evidence canary 和 pickup credential。

## Canonical 13-stage matrix

下表来自 Run 1；Run 2、Run 3 由相同结构化契约逐项校验。

| Phase | Observed UTC | Native getTools() |
| --- | --- | --- |
${phaseRows}

## 人工动作边界

| 人工动作 | 验收方式 | WebMCP 工具 |
| --- | --- | --- |
| Publish report | 页面 CSRF 表单按钮 | 无 |
| Submit private evidence | 密码型人工表单 | 无 |
| Approve claim | Staff 人工按钮 | 无 |
| Generate pickup pass | Claimant 人工按钮 | 无 |
| Complete handoff | Staff 凭证人工表单 | 无 |
| Switch role | Demo 人工按钮 | 无 |

所有阶段的工具名均严格属于批准的九工具集合；上述人工动作名称在三个 run 的全部 descriptor 中均为零。

## 隔离、teardown 与清理

- 三次运行是三个独立 Node 进程，模块级 phase/executed state 不复用。
- 每次使用 \`mkdtemp\` 创建独立数据库目录，并在数据库中验证恰有一个 demo instance。
- 每次最终进入 Home，连续稳定观察原生 \`getTools() = []\`。
- 结果 JSON 只在 \`cleanupNativeRun\` 成功后输出；cleanup 会关闭浏览器、终止或强制终止 standalone server，并删除受保护的临时目录。

## 原始证据与 SHA-256

| Run | Artifact | SHA-256 |
| --- | --- | --- |
${artifactRows}

聚合证据：[aggregate.json](evidence/native/aggregate.json)；校验清单：[SHA256SUMS.txt](evidence/native/SHA256SUMS.txt)。证据不记录 Cookie、CSRF、session、candidate handle、report/claim/internal inventory ID 或用户输入正文。

## 证据边界与限制

- 这是本地正式 standalone + Chrome testing feature 的原生 WebMCP 证据，不等同于公开 HTTPS 部署验收。
- membership 采用连续三次相同结果的稳定观察，不能捕捉极短暂的中间态；StrictMode、HMR、A→B→A、延迟完成与 AbortSignal 由专项生命周期测试覆盖。
- Chrome WebMCP 仍是提案 API；本证据固定记录 Chrome 151 的真实签名，不用后续草案反推旧运行时。
`;
}
