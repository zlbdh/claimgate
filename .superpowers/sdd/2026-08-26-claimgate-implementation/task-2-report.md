# Task 2：公开字段确定性候选匹配报告

## 结果

- 已实现 `FoundItem`/`PublicFoundItem` 与 `LostReport`、`MatchCandidate` 类型。
- `scoreCandidate` 仅使用公开字段：类别、时间、区域、颜色、公共标签、公共描述；类别不一致返回 `null`。
- 评分遵循规格：时间 30/20/10，区域 25/12，颜色 20/10，标签每个 5 分且封顶 25 分；50 分以下不进入候选。
- `findMatches` 固定最多返回 Top 3，按分数降序、`foundAt` 升序、候选 ID 升序稳定排序。
- 置信度遵循 75+ `strong`、60–74 `possible`、50–59 `weak`；理由和公共摘要不含秘密字段。

## TDD 证据

1. RED：`npm test -- src/features/matching`；两个测试套件因 `./score-candidate`、`./match-service` 模块不存在而失败。
2. GREEN：实现最小领域模块后，`npm test -- src/features/matching` 输出 2 个文件、8 个测试全部通过；`npm run typecheck` 通过。
3. 完整门：`npm run verify` 通过，包含文件长度检查、lint、typecheck、全量测试（3 文件/13 测试）和 Next.js production build。

## 文件检查

新增/修改匹配相关文件均小于 300 行；最长实现文件为 `score-candidate.ts` 70 行。

## 限制与关注点

- 相邻区域与颜色族是显式 MVP 常量，后续若扩展校园地图需由领域配置明确更新并补测试。
- 找到时间按 ISO 时间解析并以 UTC 日历日判断“同一天”；上层应传入有效 ISO 时间。
