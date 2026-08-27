# ClaimGate Task 11 原生 WebMCP 三次验收

## 结论

同一正式构建在三个严格串行、彼此独立的进程中完成原生 Chrome 151 验收。每次均创建全新临时 SQLite 与单一 demo instance，执行全部九个 WebMCP 工具，人工完成发布、举证、审批、凭证签发与交接，最后确认 Home 工具集为空并完成浏览器、server 和临时目录清理。

本证据来自 clean worktree，base commit 与被构建源码一致。

## 构建与环境

| 字段 | 值 |
| --- | --- |
| Base commit | `0f5d2413a34d6666017c25c21f029d065a13564a` |
| Next build ID | `ObqMwp2L2MqRBOqNz9Ymu` |
| Source state | `clean` |
| Node | `v22.20.0` |
| Playwright | `1.62.1` |
| Browser | Chrome for Testing `151.0.7922.34` |
| Feature | `--enable-features=WebMCPTesting` |
| 生成时间 | 2026-08-27T13:30:31.389Z |

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
| 1 | `b1762128-c16c-4fbb-934c-37051022f2c5` | 2026-08-27T13:30:09.791Z | 2026-08-27T13:30:18.977Z | 9186 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |
| 2 | `1c9f8313-0731-4830-ba4b-1e082802ac33` | 2026-08-27T13:30:19.666Z | 2026-08-27T13:30:25.177Z | 5511 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |
| 3 | `2204c312-04ca-406c-a615-7cf1b8c87636` | 2026-08-27T13:30:25.877Z | 2026-08-27T13:30:31.348Z | 5471 ms | `151.0.7922.34` | 9/9 | PASS | PASS | PASS |

每次结果还验证：`instanceCount=1`、`cleanupVerified=true`、`humanOnlyToolsAbsent=true`，并扫描 tool output、HTML、Agent activity、浏览器/server 日志、storage 与 history，排除 internal inventory ID、runtime evidence canary 和 pickup credential。

## Canonical 13-stage matrix

下表来自 Run 1；Run 2、Run 3 由相同结构化契约逐项校验。

| Phase | Observed UTC | Native getTools() |
| --- | --- | --- |
| Claimant workspace | 2026-08-27T13:30:15.122Z | `create_lost_report_draft`, `list_my_reports` |
| DRAFT report | 2026-08-27T13:30:15.435Z | `list_my_reports`, `update_lost_report_draft` |
| PUBLISHED report | 2026-08-27T13:30:15.794Z | `find_candidate_matches`, `list_my_reports` |
| PUBLISHED with candidates | 2026-08-27T13:30:15.934Z | `find_candidate_matches`, `list_my_reports`, `stage_claim_candidate` |
| EVIDENCE_REQUIRED checkpoint | 2026-08-27T13:30:16.135Z | `get_claim_status` |
| UNDER_REVIEW Claimant | 2026-08-27T13:30:16.478Z | `get_claim_status` |
| Staff queue | 2026-08-27T13:30:16.882Z | `list_pending_claims` |
| Staff UNDER_REVIEW claim | 2026-08-27T13:30:17.161Z | `get_claim_review_summary`, `get_claim_status` |
| Staff APPROVED claim | 2026-08-27T13:30:17.441Z | `get_claim_review_summary`, `get_claim_status` |
| Claimant APPROVED claim | 2026-08-27T13:30:17.875Z | `get_claim_status`, `get_pickup_instructions` |
| Staff PICKUP_READY claim | 2026-08-27T13:30:18.373Z | `get_claim_review_summary`, `get_claim_status` |
| Staff COLLECTED claim | 2026-08-27T13:30:18.636Z | `get_claim_status` |
| Home teardown | 2026-08-27T13:30:18.839Z | `[]` |

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
| Run 1 | [evidence/native/run-1.json](evidence/native/run-1.json) | `9a63a5cc6d747dd73f206fc847b5932d795d94376c1379e79f77298523a57b27` |
| Run 2 | [evidence/native/run-2.json](evidence/native/run-2.json) | `6297d6a490cba4870ac7093b78ac551058208ae5b3eff5b6f289864b62d148cc` |
| Run 3 | [evidence/native/run-3.json](evidence/native/run-3.json) | `3c62c3522802e1a6f103d68520dc37e045a74d4d599f2004f2cf299a62589c5b` |

聚合证据：[aggregate.json](evidence/native/aggregate.json)；校验清单：[SHA256SUMS.txt](evidence/native/SHA256SUMS.txt)。证据不记录 Cookie、CSRF、session、candidate handle、report/claim/internal inventory ID 或用户输入正文。

## 证据边界与限制

- 这是本地正式 standalone + Chrome testing feature 的原生 WebMCP 证据，不等同于公开 HTTPS 部署验收。
- membership 采用连续三次相同结果的稳定观察，不能捕捉极短暂的中间态；StrictMode、HMR、A→B→A、延迟完成与 AbortSignal 由专项生命周期测试覆盖。
- Chrome WebMCP 仍是提案 API；本证据固定记录 Chrome 151 的真实签名，不用后续草案反推旧运行时。
