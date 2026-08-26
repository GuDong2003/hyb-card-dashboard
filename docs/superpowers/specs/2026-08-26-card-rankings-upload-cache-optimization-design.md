# Card 榜单上传与缓存优化设计

## 目标

在不牺牲“每天保留最新数据”和用户主动刷新能力的前提下，继续降低 `hyb-card-rankings-v2-db` 的 D1 读取、写入和无效请求量。

本次优化只处理运行时读写路径，不删除历史数据、不改变现有用户过滤规则、不新增数据保留清理任务。

## 当前问题

当前 compact 存储已经具备以下保护：

- 同一赛季、北京时间日、用户只有一行日数据；
- `rank_user_current` 每个赛季、用户只有一行；
- 来源水位会跳过相同或更旧的 `capturedAt`；
- 用户日表和当前表使用条件 upsert，相同指标不会更新用户行；
- Dashboard 有浏览器内存缓存和 `Cache-Control` 响应头。

仍存在三个可优化点：

1. 同一浏览器成功提交过相同来源时间后，手动或多标签流程仍可能再次发 POST；
2. `Cache-Control` 只告诉浏览器和 CDN 如何缓存，Worker 本身没有主动读取 `caches.default`，同一边缘节点的重复 GET 仍可能进入 D1；
3. `rank_seasons` 的元数据 upsert 会把仅有抓取时间变化当成写入，即使用户行没有任何有效字段变化。

## 方案选择

### 方案 A：只提高 D1 upsert 条件

改动最少，但重复 HTTP 请求和 GET 仍会到达 Worker；在多人访问时，D1 读量下降有限。

### 方案 B：只增加浏览器本地缓存

可以减少同一标签页的 GET 和 POST，但无法复用多个用户或多个边缘节点的结果，也不能保护绕过前端的上传请求。

### 方案 C：客户端来源水位 + Worker 边缘缓存 + 元数据无变化跳过（推荐）

客户端只保存每个赛季/来源最后成功提交的 `capturedAt` 和时间，不保存榜单正文、不计算 fingerprint；同一来源时间的自动提交直接在请求前跳过。Worker 对公开 GET 使用短 TTL 的边缘缓存，显式 `no-cache` 请求会删除对应缓存键并回源。D1 继续作为最终一致性来源，用户表条件 upsert 逻辑保持不变；只有用户行实际发生变化时才更新赛季元数据。

推荐原因：不引入新的持久化表，不增加 D1 依赖，不识别或记录用户 IP/指纹，不影响主动刷新和历史查询，同时同时覆盖浏览器、Worker 和 D1 三层的无效操作。

## 总体架构

```text
Dashboard 自动刷新/手动刷新
  ├─ 本地来源水位判断（只比较 season + scope + capturedAt）
  │    └─ 已成功且无新来源时间：不发 POST
  └─ POST /api/rankings/snapshots
       └─ compact 用户条件 upsert
            ├─ 用户行有变化：更新 rank_seasons
            └─ 用户行无变化：只推进必要的来源水位

Dashboard GET
  └─ Worker fetch
       ├─ 命中 caches.default：直接返回，不访问 D1
       └─ 未命中：查询 D1，按响应 Cache-Control 写入短 TTL 边缘缓存
```

## 客户端上传水位

新增一个版本化的 `localStorage` 键，仅保存如下小型记录：

```json
{
  "season-id\u0000global": { "capturedAt": 1720000000000, "uploadedAt": 1720000001000 },
  "season-id\u0000friends": { "capturedAt": 1720000000000, "uploadedAt": 1720000001000 }
}
```

行为规则：

- 自动上传时，只有当任一来源的 `capturedAt` 晚于本地成功水位，才发送 POST；
- 自动上传在最近 15 分钟内成功提交过同一来源时，即使上游时间略有推进也暂缓重复提交，避免短时间刷新产生写检查；
- 手动“立即刷新”和手动“上传云端”绕过 15 分钟门槛，仍然可以获取和提交最新数据；
- POST 成功响应（包括服务端 `unchanged`）后才推进本地水位，失败不推进，保证失败可重试；
- 不保存正文、用户列表、IP、指纹或幂等日志；
- 本地状态损坏、无痕模式或存储不可用时自动退化为现有服务端水位和条件 upsert，不影响功能。

若自动上传因本地水位被跳过，Dashboard 不再为了确认结果额外请求一次 `latest` 和榜单；继续使用本次已有的云端状态。真正上传成功后，后续的 `latest`/榜单请求使用显式 revalidation，确保不会被旧边缘缓存遮住。

## Worker 边缘缓存

在 `src/index.js` 的 Worker fetch 层包裹现有 rankings handler：

- 只缓存 `GET /api/rankings/latest|leaderboard|history|users|events`；
- 缓存键使用规范化后的完整 URL，因此不同用户、搜索词、页 cursor、时间范围互不串数据；
- 只缓存 200 且响应声明 `public` 的响应；错误响应不缓存；
- 有 `Authorization` 或 `Cookie` 的请求不进入公共边缘缓存；
- 普通请求命中缓存直接返回；
- 带 `Cache-Control: no-cache/no-store` 的请求删除对应键后回源，并把新响应写回缓存；
- 缓存 TTL 继续由 rankings handler 的响应头控制：latest 15 秒、榜单和用户查询 30 秒、历史 60 秒；
- 写入 POST 不缓存，也不尝试枚举删除所有 query 变体；实际写入后的 fresh GET 会删除并重建自己使用的缓存键，其余变体最多等待各自短 TTL 过期。

因此榜单页面的短时间多人访问会复用边缘结果，单个用户历史仍按 `userId/since/until/cursor` 独立缓存，不会回到全量历史读取。

## D1 元数据写入

`rank_user_days` 和 `rank_user_current` 的现有条件 upsert 保持不变。`storeUserObservations()` 记录每个 season group 的实际 `changedUsers`：

- `changedUsers > 0` 时才执行 `rank_seasons` upsert，让最新有效数据和 stale 判断前进；
- 所有用户行都未变化时，不更新 `rank_seasons.updated_at` 或仅用于展示的最新观测时间；
- `rank_ingest_state` 仍在来源 `capturedAt` 前进时推进，这是服务端跳过重放的必要水位；相同或更旧时间继续在读取水位后直接跳过；
- 不改变日表、当前表的用户过滤和历史数据。

这样“来源时间变化但指标没有变化”的刷新不会再额外写赛季元数据；若实际数据变化，榜单新鲜度和统计仍正常更新。

## 错误处理

- Cache API 不可用时自动退回现有 `handleRankingsRequest()`，不影响 D1 正常读取；
- 缓存写入失败不影响已经生成的成功响应；
- 本地上传水位无法解析时清空该键并继续正常上传；
- 自动上传被本地水位跳过只返回本地 `unchanged` 状态，不显示为错误；
- 手动请求仍保留现有 429、503 和失败重试提示；
- 不执行远程删除、迁移或部署。

## 测试与验收

新增或补充测试覆盖：

1. 客户端成功来源水位会跳过相同时间的自动 POST，手动上传可以绕过；
2. 边缘缓存命中时不调用 rankings handler，未命中时写入缓存，fresh 请求会回源；
3. 缓存键包含完整查询参数，搜索、cursor、单用户历史不会互相复用；
4. 相同用户指标但更晚 `capturedAt` 不更新 `rank_seasons`；指标实际变化仍更新赛季元数据；
5. 现有用户过滤、汇总独立于搜索/分页、历史按用户日查询测试继续通过。

本地验收命令：

```bash
npm test
npm run build
git diff --check
```

验收标准是：测试全通过、构建成功、没有删除或新增旧快照表写入，普通 GET 命中边缘缓存时不触发 D1，重复自动上传不再进入 POST。
