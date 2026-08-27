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

## 2026-08-26 [Task 4 review fix round 2：数据库 v2 迁移决策]

- schema 版本提升到 v2。打开 v1 文件时，必须先用 v1 metadata authenticator 验证配置密钥，再在同一 `BEGIN IMMEDIATE` 内升级。
- ClaimGate 尚未部署，业务数据仅为可丢弃的两小时 demo；v1→v2 因此按依赖顺序删除并重建所有业务表，不复制旧 demo 行。迁移保留数据库 UUID 与 key-check salt，完成 v2 schema 和 `foreign_key_check` 后才写入 v2 authenticator。
- 任一步骤失败会回滚全部 DDL、业务行和 metadata；错误密钥、未知版本或不完整 schema 均失败关闭，不自动接管数据库。

## 2026-08-27 [Task 9：九工具动态 WebMCP 与只读 API]

- **记录**：2026-08-27 19:59 by Codex — 记录 Chrome 151 兼容、状态工具注销和输出预算的阶段性结论，防止 Task 10/11 回归。
- **改动**：四工具扩展为九工具；新增 Claim 状态、领取说明、Staff 队列与审核摘要四个认证 GET；Claimant/Staff 页面按角色、页面和状态动态注册工具；活动流展示最近 20 条工具的开始/结束时间。
- **决策**：发布、归档、私密举证、批准/拒绝/解锁、领取码签发/重签、角色切换和交接继续只允许人工完成，不注册 WebMCP 工具。
- **兼容性**：Chrome 151 在工具注销时仍可能影响执行中调用，所以写工具先返回规范结果，再在下一 macrotask 导航/刷新；所有候选、导航、刷新和活动副作用均受页面 generation 门保护。
- **安全边界**：工具运行时再次 strict parse；嵌套 JSON Schema 全部拒绝额外字段；单次工具结果按实际 JSON 序列化不超过 1,500 字符；HTTP 响应最多流式读取 65,536 bytes，超限取消；公开描述、时间线和报告列表只返回最小白名单摘要。
- **踩坑**：仅在客户端过滤 50 条完整报告会使合法 UTF-8 响应超过读取上限；修为服务端 canonical `status/limit` 过滤并只返回摘要。候选重新查询失败若不清旧结果，会让 `stage_claim_candidate` 错误滞留；失败路径现在 generation-safe 清理并按状态刷新。
- **验证**：提交 `4ffc6dca8f2362d7e2cc23c58802e9a9e85d3fb1`；完整 `verify` 连续两轮通过（103 files / 921 tests）；生产 Playwright 4/4；Chrome 151 原生 13 阶段全部九工具真实执行、annotations 精确、Home 最终 `[]`；无配置生产接口返回 93-byte 规范 500 且无泄漏；服务端与 WebMCP 独立复审均为 PASS。

## 2026-08-27 [Task 10：全系统安全回归与秘密门禁]

- **记录**：2026-08-27 20:39 by Codex — 记录贯穿式 canary、构建产物门禁和原生清理策略，防止部署/演示阶段把局部安全测试误当整体验收。
- **改动**：新增真实 evidence→approve→issue→handoff 秘密 canary 流；补齐 reject/unlock 物理路由、过期会话、严格 JSON 流、12 个隔离 runtime env 子进程；安全头显式 `Permissions-Policy: tools=(self)`，生产 CSP 保持 nonce + strict-dynamic。
- **构建门禁**：`verify` 在 build 后串行执行 evidence、pickup 和 sensitive-surface 三道扫描；公开 static/public 禁止私密证据、server-only marker、source map 和 sourceMappingURL；standalone 服务端 map 禁止 `sourcesContent`。
- **踩坑**：并行 build/native 会让 `.next/standalone` 在清理窗口出现 EBUSY/缺文件假红；最终门必须独占并串行。原生 cleanup 不能因 `browser.close()` 失败跳过 server/temp 清理；现在两级终止、确认退出并限制删除到系统 Temp。
- **门禁决策**：仅按工具名包含 `issue/reissue/handoff` 会漏同义人工写工具；改为精确九工具 allowlist，并扫描 WebMCP 源码禁止 issue/reissue/evidence/approve/reject/unlock/handoff/publish/archive/switch-role 十类人工写路径。
- **验证**：提交 `0480fbb`；完整 `verify` 连续两轮通过（110 files / 971 tests）；生产 E2E 7/7；Chrome 151 原生九工具、runtime evidence/pickup transport canary 与最终 teardown 通过；无配置接口仍为 93-byte generic 500；三位独立复审无剩余 Critical/Important。

## 2026-08-27 [Task 11：风险路径 E2E 与 clean 原生三跑]

- **记录**：2026-08-27 21:32 by Codex — 记录浏览器风险矩阵、exact-13 契约和原子证据发布，供部署后复用同一验收路径。
- **浏览器补证**：同实例两个竞争 Claim 最终严格一胜一败；两个 BrowserContext 与清 Cookie 重开完全隔离；一次解锁后正确证据可回到 UNDER_REVIEW；双标签 stale update 显示 STATE_CHANGED 且胜出数据不丢；服务端 digest-valid 过期凭证精确 403/FORBIDDEN；390px create→match→evidence 无溢出。
- **最终态**：双标签 handoff 响应集合严格为 COLLECTED + ALREADY_COLLECTED；Staff、Claimant 和 RESOLVED report 均只读，终态仅保留 get_claim_status。
- **原生证据**：新增三进程串行 wrapper，锁死 exact-13 阶段、每阶段 tools/schema、exact-9、单实例、人工工具缺失、Home=[]、cleanup 与 runtime canary；artifact 与 testing.md 使用同一可回滚发布事务并带 SHA-256。
- **踩坑**：测试复制生产 HMAC 会把 digest mismatch 误判为 expiry；改为隔离 react-server worker 直接复用生产 keyring/pickup crypto。证据发布在两个目标换入后才 committed，backup 清理失败不得触发破坏性回滚。
- **验证**：代码提交 `0f5d241`；完整 verify 连续两轮（114 files / 979 tests）、生产 E2E 13/13。随后 clean worktree 严格三跑，三次 base commit 均为 `0f5d2413…`、同 build、unique run ID、9/9、exact-13、cleanup=true、SHA 全匹配、Temp 残留 0；最终证据提交 `904cba3`。

## 2026-08-28 [Task 12：隔离部署资产质量加固]

- **发布可信链**：发布准备要求 clean Git、完整 40 位 revision、独占输出锁和 Docker immutable image ID；四项 canonical manifest 将应用、官方 Node、validator 与 revision 绑定。SSH controller 再核对 clean checkout、HEAD、产物 revision，远端逐层验证 realpath、属主和权限。
- **归档与身份**：validator 按实际 strip 0/1 后路径验证重复、祖先、符号链接与 hardlink；官方 Node 归档的固定 SHA 与 strip1 已实测。root 即使继承 umask 077，提取仍固定 022，最终 Node 与原生 SQLite smoke 必须以服务身份运行。
- **入口门禁**：配额数据库 busy timeout 收紧为 0，外部写锁冲突立即失败；真实 10 并发 HTTP 验证在 Nginx 截止前返回且不晚消费。来源使用 `$realip_remote_addr`，IPv4-mapped IPv6 统一为 IPv4。vhost 显式关闭继承的 proxy error interception，保持应用 403 与额度 429 分离。
- **可重复验证**：新增 `test:deployment:linux`，真实构建 Linux/amd64 镜像、解析 local-only Compose、验证 Nginx 1.22 继承行为、umask/非 root native SQLite、Unix socket 0660/group access、stale nonsocket 和 SIGTERM cleanup。Compose 仅用于本地 app/health smoke，生产唯一支持双 systemd unit + Nginx。

### 经验：Node ESM 入口路径与 systemd 符号链接

- **记录**：[2026-08-28 03:35] by Codex — 首次服务器启动暴露了本地直路径测试未覆盖的入口判断差异。
- **现象**：`claimgate-ingress-gate.service` 启动后约 0.3 秒以状态 0 正常退出，没有创建 Unix socket。
- **根因**：Node ESM 将 `import.meta.url` 解析为真实 release 路径，而 `process.argv[1]` 保留 `/opt/claimgate/current` 符号链接路径，字符串比较误判脚本不是主入口。
- **修复**：入口判断先用 `realpathSync()` 规范化启动路径；Linux 部署测试改为通过 `current` 符号链接启动并验证 socket 生命周期。
- **教训**：凡是生产 unit 通过 release symlink 启动，必须用同一路径形态做真实 Linux 回归，不能只测容器内直路径。

## 2026-08-28 [跨角色 Claim 上下文恢复]

### 经验：角色切换应携带闭合领域标识，而不是通用返回地址

- **记录**：[2026-08-28 04:51] by Codex — 记录可见演示链路断点及事务闭合方案，防止后续把导航便利性变成开放重定向或一次性令牌误消费。
- **现象**：Staff 审批后，Claimant 无法从可见入口重新找到同一 Claim；Claimant 签发凭证后，该 Claim 又不在 Staff 待审队列，完整交接只能依赖手工输入 Claim URL。
- **根因**：角色切换只在 Home 渲染且固定重定向 `/`，而审批、签发会按设计改变队列可见性；导航没有携带经过授权的 Claim 上下文。
- **修复**：表单只新增可选 opaque `resumeClaimId`，严格接受 2 或 3 个字段；Claim 查询、目标 Claimant 所有权、nonce、额度和会话旋转在同一事务内完成，响应位置仅由数据库 Claim 和目标角色生成；两类 Claim 页面复用共享 CSRF helper 与角色栏，并用真实 Copy/Ctrl+V E2E 覆盖完整交接。
- **教训**：跨身份恢复业务上下文时，只传闭合领域 ID，并在一次事务中先授权再派生站内路径；不要接受 `returnTo`、URL、查询串或片段，也不要让失败验证消耗可重试的一次性能力。
