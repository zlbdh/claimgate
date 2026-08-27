# ClaimGate 原生 WebMCP 兼容性证据

## 结论

2026-08-27 11:41（Asia/Shanghai），ClaimGate 在未注入、未覆盖 `document.modelContext` 的 Chrome for Testing 151 中，使用正式构建、全新临时 SQLite 数据库和全新 demo instance 跑通四工具闭环。两个写工具都先返回非 `null` JSON 字符串，再由 Next 同文档导航到 `nextPath`；Claim checkpoint 与离开 Claimant 页面后的工具集均为空。

普通不支持 WebMCP 的浏览器仍显示有界降级说明，人工表单保持可用。Injected Playwright 只作为 provider/HTTP/页面回归，不替代下述原生证据。

## 官方与版本依据

- [Chrome WebMCP 命令式 API](https://developer.chrome.com/docs/ai/webmcp/imperative-api) 使用 `document.modelContext.registerTool()` 与 `AbortSignal`；Chrome 153 才明确改善“注销影响执行中工具”的行为，因此本门禁保留 Chrome 151 的延后换代顺序。
- [Chromium 151 about_flags.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.34/chrome/browser/about_flags.cc) 将 `enable-webmcp-testing` 映射为 `blink::features::kWebMCPTesting`。
- 当前草案已发生漂移；本次验收以 Chrome 151 实际运行时为准，而不是用新草案反推旧浏览器。

## 运行环境与真实签名

| 字段 | 观察值 |
| --- | --- |
| 时间 | `2026-08-27T03:41:50.907Z` |
| 浏览器 | Chrome for Testing `151.0.7922.34`（Playwright Chromium `v1234`） |
| feature | `--enable-features=WebMCPTesting` |
| 注册 | `registerTool(tool, { signal }) -> Promise<void>` |
| 发现 | `getTools() -> Promise<descriptor[]>` |
| schema | descriptor `inputSchema` 为 JSON 字符串；逐个解析为 strict object |
| 执行 | `executeTool(descriptor, JSON.stringify(input)) -> Promise<string|null>` |
| 隔离 | 全新临时 SQLite 数据库与全新 demo instance；结束后删除 |

## 四工具阶段矩阵

| 页面阶段 | 原生 `getTools()` 字典序结果 |
| --- | --- |
| Claimant workspace | `create_lost_report_draft`, `list_my_reports` |
| DRAFT report | `list_my_reports` |
| PUBLISHED report | `find_candidate_matches`, `list_my_reports` |
| PUBLISHED + 当前候选 | `find_candidate_matches`, `list_my_reports`, `stage_claim_candidate` |
| EVIDENCE_REQUIRED checkpoint | 空数组 |
| 离开 Claimant 页面 | 空数组 |

四个工具均在合法阶段执行一次。Publish 通过真实人工 CSRF 表单完成，从未注册为工具。`create_lost_report_draft` 与 `stage_claim_candidate` 的原生 raw result 均为非 `null` JSON 字符串；`list_my_reports` 与 `find_candidate_matches` 也返回 JSON 字符串 envelope。

## 生命周期、导航与扫描

- Chrome 151 的注册/注销会短暂改变 membership，且 `toolchange` 次数与时机不是固定契约。Verifier 按条件连续观察三次相同工具集后再执行，不断言固定事件数。
- find 完成后才在后续 macrotask 发布候选状态；create/stage 完成后才在后续 macrotask触发 `router.push()` 与 `router.refresh()`。原生执行结果因此先完成序列化，随后旧 scope 才 abort。
- create 与 stage 均到达各自 `nextPath`；没有硬跳转，也没有跨文档 `null` 写结果。
- 原生运行结束前进入 Home，并再次确认 `getTools()` 为空。
- 使用数据库中真实 internal inventory ID 扫描 raw tool results、阶段 HTML、Agent activity、浏览器 console 与本地 server log，未发现泄漏；tool result 也未出现 internal-ID 字段、catalog version、exact found time、score、CSRF、Cookie 或 stack。

执行命令：

```powershell
npm run build
npm run probe:native
```

`scripts/verify-native-webmcp.ts` 自行启动正式 standalone server、创建临时数据库、启动带官方测试 feature 的 Chrome 151，并在 `finally` 中关闭浏览器/server、删除数据库。脚本不定义、不覆盖、不注入 `document.modelContext`。

## 自动化边界

- Vitest 验证 strict schemas、direct execution、staging 事务、页面矩阵、StrictMode/partial failure/generation 和 activity 脱敏。
- Production injected Playwright 验证真实 mounted provider、tool callbacks、HTTP、Cookie、SQLite 与页面导航；它不是原生通过依据。
- 本文件不记录 CSRF、Cookie、session、candidate handle、report/claim/internal inventory ID 或用户输入正文。
