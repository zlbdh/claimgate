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

## 2026-08-26 [Task 3：领域状态与用途隔离密钥]

### 改动内容

- 新增 Report、Item、Claim 的纯状态守卫，拒绝同态、跳跃、回退和从终态离开的调用；服务层以后须在调用守卫前完成幂等短路。
- 新增闭合 `DomainError` 代码集与固定 JSON 安全元数据；错误序列化不含堆栈、cause、资源标识符或调用方自定义详情。
- 新增基于 Node `crypto.hkdfSync` 的用途隔离 keyring，从 `CLAIMGATE_HMAC_KEY` 派生 evidence、pickup-pass、candidate-handle 与 database-key-check 四个 32-byte 子密钥。

### 决定与验证

- 主密钥仅接受严格的标准 padded Base64：长度必须为 4 的倍数、回编码一致，解码后至少 32 bytes；这能避免 Node 的宽松解码把格式错误的部署配置悄悄接受。
- HKDF 使用固定 UTF-8 salt `ClaimGate/keyring/v1` 与带用途和版本号的 UTF-8 info，避免不同安全用途复用同一子密钥。
- TDD：先因领域模块不存在得到预期 RED；最小实现后目标测试 39 项 GREEN。完整 `npm run verify` 通过（55 项单测、lint、typecheck、文件行数与生产构建）。

## 2026-08-26 [Task 3 review fix round 1：运行时不可变边界]

### 修复内容

- `DomainError` 现在在运行时验证闭合 code，以私有字段保存可信 code，并冻结错误实例与公开代码集合；`toJSON` 仅从私有 code 映射固定安全消息。
- Report、Item、Claim 转移表及每个内部数组均冻结；公开 `KEY_PURPOSES` 同样冻结，调用方不能追加用途或改变图。
- 状态测试改为全部有序状态对：Report 16、Item 9、Claim 49；只有设计 addendum 列出的边可通过，包含全部同态与终态离开。

### TDD 与验证

- 新测试先 RED：非法 code 未拒绝，错误/状态表/用途集合均未冻结；全图测试随后明确验证现有合法边。
- 首次 GREEN 因冻结封装替换漏掉闭合括号而报 TypeScript 语法错误，修正后目标 85 项测试与 typecheck 通过。
- 完整 `npm run verify` 通过：文件行数、lint、typecheck、6 个文件 101 项测试和生产构建均成功。
