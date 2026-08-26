# ClaimGate 开发日志

## 2026-08-26 [Task 1：项目基础与 WebMCP 兼容探针]

### 工程起点

- 操作人：Codex。
- 从基线提交 `0333e08462d3f5fe1e61af4bf30ca0d0d727fbdd` 开始，建立 Next.js 16、React 19、TypeScript、Vitest 与 Playwright 工具链。
- 生产 CSP 采用逐请求 nonce；开发环境只按 Next.js 要求增加 `unsafe-eval`，生产不允许 `unsafe-inline` 或 `unsafe-eval`。
- WebMCP 只使用原生 `document.modelContext`，不引入 polyfill、已弃用的 `navigator.modelContext` 或跨源暴露。
- 真实 WebMCP 发现、调用和注销必须由支持环境验证；自动化注入只能证明页面降级和生命周期逻辑，不能替代真实验收。

### TDD 与兼容性结果

- `resolveModelContext` 首次测试因模块不存在而 RED；最小实现后 2 项 feature detection 测试 GREEN。
- 探针工具首次测试因模块不存在而 RED；最小实现后名称、只读标记、nonce 返回和注册 signal 共 5 项测试 GREEN。
- 浏览器 E2E 首次因尚无 `app` 目录而 RED；实现 landing、探针页和逐请求 CSP 后 2 项生产 E2E GREEN。
- Playwright 1.62.1 安装匹配的 Chrome for Testing 151.0.7922.34；官方 npm registry 生产依赖审计为 0 vulnerabilities。
- 用户 Chrome 会话未暴露 `document.modelContext`，降级 UI 正常；独立 Chrome 151 以 `WebMCPTesting` feature 完成原生发现、精确 nonce 调用、`toolchange` 和离页注销。

### 关键决策与踩坑

- `output: standalone` 不能以 `next start` 作为验收启动方式；E2E 改为复制静态资源并直接启动 `.next/standalone/server.js`。
- 本机 npm 镜像不实现 audit API，首次审计返回 404；只对审计命令临时指定官方 registry 后得到 0 vulnerabilities，不更改用户全局 npm 配置。
- 安装阶段生成的 lockfile 曾固化本机镜像地址；提交前只将 registry host 机械规范化为官方 npm registry，并用 `npm ci --dry-run` 验证锁文件可安装，版本与完整性未变。
- 原生 `executeTool()` 将对象结果序列化为 JSON 字符串；验收脚本解析后再比较结构。Abort 注销通过异步 `toolchange` 传播，因此使用条件等待，不用固定睡眠冒充稳定性。
- Vitest 默认发现规则会收集 `tests/e2e`；将 Playwright 目录加入显式排除后，单元测试与浏览器测试保持职责分离。

## 2026-08-26 [Task 2：公开字段确定性候选匹配]

- 决定：Matching 只接收类别、时间窗/找到时间、粗粒度区域、颜色、公共标签和公共描述；类别不一致直接拒绝，评分达到 50 才进入候选。
- 决定：相邻区域与颜色族使用显式常量；结果理由仅输出稳定的公共字段说明，返回摘要不包含秘密证据字段。
- 验证：先运行缺失模块的匹配测试确认 RED，再以最小实现通过 8 项匹配测试与 TypeScript 严格类型检查；提交前继续执行完整 verify 门。
- 踩坑：组件分数测试必须隔离其他字段，否则时间分值会与区域、颜色和标签分值叠加；测试工厂因此支持覆盖公开字段。
