# ClaimGate Task 11 原生 WebMCP 三次验收

## 结论

同一正式构建在三个严格串行、彼此独立的进程中完成原生 Chrome 151 验收。每次均创建全新临时 SQLite 与单一 demo instance，执行全部九个 WebMCP 工具，人工完成发布、举证、审批、凭证签发与交接，最后确认 Home 工具集为空并完成浏览器、server 和临时目录清理。

> **开发期证据：** 本次 source state 为 `dirty`。Task 11 代码提交后必须运行 `npm run accept:native:3:clean`，用 clean exact commit 覆盖本目录后才可作为最终提交证据。

## 构建与环境

| 字段 | 值 |
| --- | --- |
| Base commit | `d6eab8aa2f3a1005142b857fd9eab851b0956343` |
| Next build ID | `qsTUO_NQONwcKcOfRHqN6` |
| Source state | `dirty` |
| Node | `v22.20.0` |
| Playwright | `1.62.1` |
| Browser | Chrome for Testing `151.0.7922.34` |
| Feature | `--enable-features=WebMCPTesting` |
| 生成时间 | 2026-08-27T13:25:40.073Z |

执行命令：

```powershell
npm run accept:native:3
# Task 11 commit 后的最终证据门：
npm run accept:native:3:clean
```

该命令只构建一次，然后依次启动三个独立 verifier 子进程；任一子进程、结构校验、cleanup 或 artifact 校验失败都会立即终止，且不会发布部分成功证据。

## 三次运行摘要

| Run | Run ID | Started UTC | Ended UTC | Duration | Browser | Tools | Human-only absent | Home teardown | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `96533d31-50e7-4f08-9fc7-5a9d448d91ce` | 2026-08-27T13:25:17.816Z | 2026-08-27T13:25:27.464Z | 9648 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |
| 2 | `f112ec7b-545d-46c5-bfb4-01f1c276f7f1` | 2026-08-27T13:25:28.195Z | 2026-08-27T13:25:33.755Z | 5560 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |
| 3 | `a27eecc0-832d-4e1b-b085-1d88ff78900a` | 2026-08-27T13:25:34.451Z | 2026-08-27T13:25:40.031Z | 5580 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |

每次结果还验证：`instanceCount=1`、`cleanupVerified=true`、`humanOnlyToolsAbsent=true`，并扫描 tool output、HTML、Agent activity、浏览器/server 日志、storage 与 history，排除 internal inventory ID、runtime evidence canary 和 pickup credential。

## Canonical 13-stage matrix

下表来自 Run 1；Run 2、Run 3 由相同结构化契约逐项校验。

| Phase | Observed UTC | Native getTools() |
| --- | --- | --- |
| Claimant workspace | 2026-08-27T13:25:23.537Z | `create_lost_report_draft`, `list_my_reports` |
| DRAFT report | 2026-08-27T13:25:23.864Z | `list_my_reports`, `update_lost_report_draft` |
| PUBLISHED report | 2026-08-27T13:25:24.224Z | `find_candidate_matches`, `list_my_reports` |
| PUBLISHED with candidates | 2026-08-27T13:25:24.363Z | `find_candidate_matches`, `list_my_reports`, `stage_claim_candidate` |
| EVIDENCE_REQUIRED checkpoint | 2026-08-27T13:25:24.582Z | `get_claim_status` |
| UNDER_REVIEW Claimant | 2026-08-27T13:25:24.970Z | `get_claim_status` |
| Staff queue | 2026-08-27T13:25:25.359Z | `list_pending_claims` |
| Staff UNDER_REVIEW claim | 2026-08-27T13:25:25.624Z | `get_claim_review_summary`, `get_claim_status` |
| Staff APPROVED claim | 2026-08-27T13:25:25.905Z | `get_claim_review_summary`, `get_claim_status` |
| Claimant APPROVED claim | 2026-08-27T13:25:26.339Z | `get_claim_status`, `get_pickup_instructions` |
| Staff PICKUP_READY claim | 2026-08-27T13:25:26.852Z | `get_claim_review_summary`, `get_claim_status` |
| Staff COLLECTED claim | 2026-08-27T13:25:27.118Z | `get_claim_status` |
| Home teardown | 2026-08-27T13:25:27.319Z | `[]` |

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
- 每次使用 `mkdtemp` 创建独立数据库目录，并在数据库中验证恰有一个 demo instance。
- 每次最终进入 Home，连续稳定观察原生 `getTools() = []`。
- 结果 JSON 只在 `cleanupNativeRun` 成功后输出；cleanup 会关闭浏览器、终止或强制终止 standalone server，并删除受保护的临时目录。

## 原始证据与 SHA-256

| Run | Artifact | SHA-256 |
| --- | --- | --- |
| Run 1 | [evidence/native/run-1.json](evidence/native/run-1.json) | `1ba2392d573c87ce38d8950434fcee6848f607d047ff5b4243d063f9db62f4c2` |
| Run 2 | [evidence/native/run-2.json](evidence/native/run-2.json) | `d261bb5935a1fbd7c7f08b5b00dc6cba3888b554e1d8de60cce1f5e25c6ad8a1` |
| Run 3 | [evidence/native/run-3.json](evidence/native/run-3.json) | `936912f8ebd9b001251814defb4f6e4dd8b35c303b7030aeefb7df531f57ea1a` |

聚合证据：[aggregate.json](evidence/native/aggregate.json)；校验清单：[SHA256SUMS.txt](evidence/native/SHA256SUMS.txt)。证据不记录 Cookie、CSRF、session、candidate handle、report/claim/internal inventory ID 或用户输入正文。

## 证据边界与限制

- 这是本地正式 standalone + Chrome testing feature 的原生 WebMCP 证据，不等同于公开 HTTPS 部署验收。
- membership 采用连续三次相同结果的稳定观察，不能捕捉极短暂的中间态；StrictMode、HMR、A→B→A、延迟完成与 AbortSignal 由专项生命周期测试覆盖。
- Chrome WebMCP 仍是提案 API；本证据固定记录 Chrome 151 的真实签名，不用后续草案反推旧运行时。
