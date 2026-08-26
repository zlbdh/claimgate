# ClaimGate 原生 WebMCP 兼容性探针

## 结论

2026-08-26（Asia/Shanghai），ClaimGate 在启用官方测试 feature 的 Chrome for Testing 151 中完成原生 WebMCP 发现、调用和注销闭环。普通 Chrome 会话未暴露该 API，页面按设计降级且人工控件仍可使用。

## 官方依据

- [OpenAI WebMCP Challenge](https://openai.com/webmcp-challenge/) 说明可在 ChatGPT 内置浏览器，或启用实验 flag / origin trial 的 Chrome 中测试。
- [Chrome WebMCP 命令式 API](https://developer.chrome.com/docs/ai/webmcp/imperative-api) 使用 `document.modelContext.registerTool()`，并通过 `AbortSignal` 注销工具；`navigator.modelContext` 已弃用。
- [Chrome 149 DevTools WebMCP 说明](https://developer.chrome.com/blog/new-in-devtools-149) 指定 `#enable-webmcp-testing` 测试 flag。
- [Chromium 151 about_flags.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/151.0.7922.34/chrome/browser/about_flags.cc) 将 `enable-webmcp-testing` 映射为 `blink::features::kWebMCPTesting`。

## 真实浏览器证据

| 字段 | 观察值 |
| --- | --- |
| 日期 | 2026-08-26 |
| 浏览器 | Chrome for Testing `151.0.7922.34`（Playwright Chromium `v1234`） |
| flag 状态 | 临时进程参数 `--enable-features=WebMCPTesting`，等价于官方测试 flag；未修改用户 Chrome 配置 |
| 页面 | `http://127.0.0.1:3100/webmcp-probe` |
| 注册签名 | `document.modelContext.registerTool(tool, { signal })` |
| 工具 | `claimgate_compatibility_probe` |
| 唯一 nonce | `native-1787718828335` |
| 调用结果 | `{"ok":true,"nonce":"native-1787718828335","api":"document.modelContext"}` |
| 注销结果 | 离开探针页后收到 1 次原生 `toolchange`；随后 `getTools()` 返回空数组 |
| 命令退出码 | `0` |

执行命令：

```powershell
npm run build
node scripts/start-standalone.mjs
npm run probe:native
```

`scripts/verify-native-webmcp.ts` 启动匹配的真实 Chrome 二进制并启用原生 feature，然后调用浏览器自身的 `getTools()` 和 `executeTool()`；脚本没有定义、覆盖或注入 `document.modelContext`。

## 降级与自动化边界

- 已连接的用户 Chrome 会话中，`"modelContext" in document` 为 `false`；页面显示“不支持 Agent 协作”的非阻塞提示，人工 readiness 按钮仍可使用。由于浏览器控制安全策略禁止访问 `chrome://version` 和 `chrome://flags`，没有绕过该限制，也没有声称该会话已启用 flag。
- Vitest/jsdom 只验证 feature detection 和工具契约。
- Playwright E2E 中的注入用例只验证 React 注册/调用/AbortSignal 生命周期；它不计作真实 WebMCP 证据。
- 上表的 PASS 来自另一条无注入的 Chrome 151 原生 feature 路径，并以真实 `getTools()`、`executeTool()` 和 `toolchange` 为依据。
- 本次没有在 ChatGPT 内置浏览器 Agent 会话中复验；Chrome 149+ 官方测试环境已完成 brief 要求的替代路径。
