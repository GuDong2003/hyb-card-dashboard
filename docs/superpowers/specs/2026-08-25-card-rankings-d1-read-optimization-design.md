# Card 榜单 D1 读放大优化设计

## 目标

降低 `hyb-card-rankings-db` 的 D1 行读取量，同时保留 Card 榜单的现有展示语义：原始快照可以审计和回放，用户总览仍能读取最新累计数据，趋势仍支持按天和按实际抓取查看。

本次改造不增加清理任务、不删除任何原始快照或明细。赛季最长 90 天，原始数据在赛季范围内持续保留。

## 已确认的现状

- `site/rankings.js` 只有在进入榜单视图时才读取榜单；用户趋势请求由趋势弹窗触发，但榜单刷新路径仍可能重复刷新已选择用户的历史。
- `src/rankings-worker.js` 的 `mergeSnapshotMetrics()` 每次上传都会执行 `SELECT * FROM rank_user_metrics WHERE season_id = ?`，再把整季汇总读入 Worker 内存。
- `dailyMetricsForPeriod()` 每次请求都扫描 `rank_entries`，连接 `rank_snapshots`，并用窗口函数按天选代表行。
- `getHistory()` 没有时间范围和分页，默认读取一个用户在整季的所有原始明细。
- `getEvents()` 先读取整季快照，再为每一对相邻快照读取榜单明细。
- `jsonResponse()` 对所有接口统一使用 `cache-control: no-store`，前端 `apiGet()` 也强制使用 `cache: no-store`。
- 现有 `rank_user_metrics` 是有价值的小型当前聚合层，应继续保留；但它不应再通过整季读放大来维护。

## 方案选择

### 方案 A：每次读请求时继续从原始表聚合

实现改动最少，但用户总览和趋势请求仍会反复读取相同的 `rank_entries` 行，无法从根本上降低 D1 行读取量。

### 方案 B：在每次上传时维护完整的日聚合

查询会很快，但每次上传都会额外写入和更新日聚合，实时采集频率越高，写放大越明显，也偏离“每天聚合一次”的业务需求。

### 方案 C：原始快照只增不减，已结束日期每天物化一次，当前日期只读实时尾部

推荐方案。已结束日期只在北京时间每天 04:05 聚合一次；历史查询直接读日聚合表。当前日期因为尚未封口，只读取当前日期的原始尾部，范围最多一天，不扫描整季。上传路径通过 SQL 条件 upsert 更新小型 `rank_user_metrics`，不再把整季汇总加载到 Worker。

## 架构与数据流

```text
Card 页面启动
  └─ 只读取 latest / leaderboard

用户主动打开“用户趋势”
  └─ GET /api/rankings/history
       ├─ mode=daily：日聚合表 + 当前日期实时尾部
       └─ mode=snapshot：限定 since/until 的原始明细

用户脚本上传快照
  ├─ 限流
  ├─ 签名重复检查、同 scope 过期检查（INSERT 前）
  ├─ INSERT rank_snapshots + rank_entries
  └─ 对本次 entries 逐行 SQL upsert rank_user_metrics

Cloudflare Cron（UTC 20:05 = 北京时间 04:05）
  └─ 物化已经结束的前一北京日到 rank_daily_metrics
```

### 原始数据与日聚合的职责

- `rank_snapshots`、`rank_entries`：只增不减的原始审计数据，保留现有字段和用途。
- `rank_user_metrics`：每个赛季、用户、榜单键一行的当前/累计汇总，用于总榜和用户搜索；通过单行条件 upsert 维护。
- `rank_daily_metrics`：每个赛季、北京日、用户、榜单键一行，保存该日最后一次有效观测；用于用户总览的历史配对、趋势和默认事件查询。

日代表行的选择规则与现有逻辑一致：同一赛季、用户、榜单键、北京日内，优先 `captured_at` 较新；时间相同时优先 `value` 较大，再优先 `snapshot_id` 较大，最后优先 `rank` 较小。北京日边界固定为每天 04:00（`day_start_at` 使用 Unix 毫秒）。

## 数据库设计

新增 migration：`migrations/0004_rank_daily_metrics.sql`。

### `rank_daily_metrics`

```sql
CREATE TABLE IF NOT EXISTS rank_daily_metrics (
  season_id TEXT NOT NULL,
  day_start_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  board_key TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  snapshot_id INTEGER NOT NULL REFERENCES rank_snapshots(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, day_start_at, user_id, board_key)
);
```

`rank_snapshots` 另外增加 `accepted INTEGER NOT NULL DEFAULT 1`。现有快照迁移后默认有效；上传入口在 INSERT 前拦截重复和过期提交，因此新写入的原始快照也只会是有效数据。

索引：

- `(season_id, board_key, day_start_at, rank)`：周期榜和事件查询的日期范围读取。
- `(season_id, user_id, board_key, day_start_at)`：单用户趋势查询。

同时补充 Card 侧与实际 SQL 访问路径对应的索引：

- `rank_snapshots(season_id, scope, captured_at DESC, id DESC)`：最新/过期检查和同 scope 时间范围。
- `rank_snapshots(season_id, signature)` 唯一索引：把签名幂等从应用层检查落实到数据库约束，避免并发重复插入。
- `rank_snapshots(captured_at DESC, id DESC)`：无 season 条件的 latest 查询。
- `rank_snapshots(accepted, captured_at DESC, id DESC)`：有效快照过滤、全局 latest 和时间范围读取。
- `rank_entries(snapshot_id, board_key, rank)`：当前/上一快照按榜单和排名读取。
- `rank_user_metrics(season_id, last_captured_at DESC, user_id)`：用户搜索不再读取整张表后在 Worker 过滤。

不会新增删除、归档或 90 天清理 migration。

在建立唯一签名索引前，部署脚本先执行只读重复检查：如果发现已有重复 `season_id + signature`，迁移暂停并报告重复 ID，不自动删除或合并任何原始数据；确认没有重复后才建立唯一索引。

### 现有历史的初始化

新表创建后需要一次性从现有原始快照填充，使用与每日 Cron 相同的代表行规则。初始化只做一次，不能放在每个 GET 或每个 POST 路径中；新增 `scripts/backfill-rank-daily.mjs`，通过 Wrangler D1 execute 按北京日生成并执行限定日期范围的 upsert SQL，按日分批以限制单次 D1 查询规模。脚本只写入 `rank_daily_metrics`，不删除或改写原始表。之后 Cron 只处理封口日期，重复执行同一天使用 upsert，不删除已有日聚合行。

## 上传路径

### INSERT 前拦截

对每个规范化快照，在写入 `rank_snapshots` 前完成：

1. 计算稳定签名。
2. 按 `season_id + signature` 查询重复；重复直接返回 `duplicate`，不插入 `rank_snapshots`、`rank_entries` 或汇总行。
3. 按 `season_id + scope` 查询最近 `captured_at`；如果本次时间不晚于最近时间，直接返回 `stale_or_existing_data`，不插入。
4. 仍保留现有 JSON、未来时间和空 entries 校验。

唯一签名索引负责并发竞态保护：两个请求同时通过预检查时，后到的 INSERT 遇到唯一约束后转为 `duplicate`，不能产生第二份明细。

幂等键采用规范化 payload 的稳定签名，不额外建立每请求一行的幂等表，避免为每次上传增加一组 D1 读写。

### 限流

使用 Cloudflare 原生 Rate Limiting binding `RANKINGS_WRITE_LIMITER`，在解析 body 和访问 D1 前按提交来源限流。初始策略为每个来源每 60 秒最多 10 次；超过时返回 HTTP 429 和 `retry-after`。限流器不可用时本地测试仍可运行，但生产配置必须绑定。

### `rank_user_metrics` 单行 upsert

删除 `SELECT * FROM rank_user_metrics WHERE season_id = ?` 及 Worker 内存合并。每个 incoming entry 直接执行 `INSERT ... ON CONFLICT (season_id, user_id, board_key) DO UPDATE`：

- `*_total` 取更大的累计值；值相同取时间较新的记录。
- 其他榜单取时间较新的观测；时间相同取值较大的记录。
- 用户资料和 VIP 状态按最新资料/已有非空资料合并。
- `first_captured_at` 取最小值，`last_*` 取最新值，`source_scopes` 保留已观测来源。

这样上传写入量基本不变，但读取量从“整季汇总表”降为零个整表读取。

## 日聚合任务

在 `src/index.js` 增加 `scheduled(controller, env)`，在 `wrangler.jsonc` 增加 UTC Cron：`5 20 * * *`。任务目标是当前北京时间日开始时间减一天的封口日。

任务执行一条限定日期范围的窗口查询，从 `rank_entries JOIN rank_snapshots` 选择 `accepted = 1` 的代表行，写入 `rank_daily_metrics`。不读取 `raw_json`，不删除任何行。由于输入只增不减，任务可以安全重试；迟到但属于该日的快照会通过同一日 upsert 修正代表行。

首次部署的历史 backfill 与每日任务共用同一个 `aggregateDay()`，但由独立运维命令按天调用；正常请求路径不触发 backfill。

## GET API 变化

### 历史接口

`GET /api/rankings/history` 保留 `userId` 和 `board`，新增：

- `since`：开始时间，支持 Unix 毫秒或 ISO 时间；缺省为 `until - 30 天`。
- `until`：结束时间，缺省为当前赛季最新快照时间。
- `limit`：每页条数，缺省 200，最大 500。
- `cursor`：不透明的 keyset cursor；不接受页码 offset。
- `mode`：`daily`（默认）或 `snapshot`。`daily` 读日聚合表，`snapshot` 只在明确请求时读限定时间范围的原始明细。

返回：

```json
{
  "ok": true,
  "userId": "u-1",
  "mode": "daily",
  "since": 0,
  "until": 0,
  "limit": 200,
  "rows": [],
  "nextCursor": null,
  "hasMore": false,
  "events": []
}
```

`daily` 查询范围为已封口的日聚合行，并在包含当前日时补读当前日原始尾部；当前日只限定在一个北京日内，不扫描更早快照。`snapshot` 查询必须带时间范围（缺省也会套用最近 30 天），按 `captured_at + snapshot_id` 做稳定 keyset 分页，并只选择趋势需要的列，不读取 `raw_json`。

### 其他历史/事件读取

- `getEvents()` 默认只读最近 7 天，优先比较 `rank_daily_metrics` 的日代表行；原始逐快照事件必须由调用方明确传 `mode=snapshot` 并提供范围。
- `getUsers()` 在 SQL 中按 `user_id/user_name` 做过滤并限制 20 行，不再把 `rank_user_metrics` 的 2000 行读入 Worker 后过滤。
- `dailyMetricsForPeriod()` 改为读取 `rank_daily_metrics`，仅在窗口包含当前日时追加当前日原始尾部；删除对整季 `rank_entries` 的无界窗口扫描。

## Dashboard 与浏览器缓存

- Dashboard 启动和榜单视图加载只请求 `latest`、`leaderboard`；不调用 history。
- 只有用户打开趋势弹窗/历史视图、添加用户或在历史视图内改变范围时才请求 history。
- 关闭历史视图后，榜单刷新不再后台刷新已选用户历史；再次打开时按当前范围重新请求。
- history 请求按当前趋势周期生成 `since/until/limit/cursor`，并在 `hasMore` 时继续取下一页；日趋势不再依赖浏览器读取整季原始行后再聚合。
- GET API 使用短 TTL 的公开缓存头：`latest` 约 15 秒，榜单/用户/事件约 30 秒，日历史约 60 秒；允许 `stale-while-revalidate`。POST 和错误响应保持 `no-store`。
- `site/rankings.js` 的 `apiGet()` 改用浏览器默认缓存策略，不再统一强制 `no-store`。上传成功后的最新状态请求使用显式 revalidation，避免短缓存遮住刚写入的数据。

缓存允许最多几十秒的最终一致性；D1 原始数据和上传幂等语义不受缓存影响。

## 错误处理与兼容性

- 旧客户端不传新增参数时仍能得到最近 30 天的 daily 历史，不会触发全季扫描。
- `cursor`、时间或 limit 非法返回 400；超过最大范围时裁剪到安全上限并在响应中返回实际值。
- 限流返回 429，不把限流错误写入 D1。
- 日聚合任务失败只记录结构化错误并等待下一次重试，不影响榜单 GET/POST；原始快照仍可用于恢复。
- 日聚合表为空或某一天尚未 backfill 时，运维 backfill 负责补齐；线上 GET 不回退到整季无界扫描。缺失历史只在响应中表现为暂时没有对应日数据。

## 测试与验收

### Worker / D1 契约测试

- 日聚合同一天重复执行不会重复行，并按最新时间、值、快照 ID、排名规则选代表行。
- 每日聚合 SQL 带日期边界，不读取 `raw_json`。
- POST 重复签名、同 scope 过期数据在 INSERT 前被拦截；并发唯一约束转换为 duplicate。
- POST 不再出现 `SELECT * FROM rank_user_metrics WHERE season_id = ?`；单行 upsert 能正确维护累计榜、周期榜、资料、来源和 first/last 字段。
- history 默认最近 30 天，`since/until/limit/cursor` 组合能稳定分页；daily 使用 `rank_daily_metrics`，snapshot 才读取限定原始明细。
- today/week/month/total 用户总览使用日聚合表和当前尾部，不再使用无界 `WITH daily_rows` 原始扫描。
- GET 返回公开短缓存，POST/错误返回 `no-store`；用户搜索在 SQL 中完成过滤。
- Rate Limiting binding 成功和拒绝分支分别返回 200/429。

### 前端契约测试

- 初始化和榜单刷新源码中不触发 history；打开趋势弹窗后才触发。
- 历史请求带 `mode`、时间窗口、limit 和 cursor，并能继续加载下一页。
- 前端 GET 不再强制 `cache: no-store`，上传后的 fresh 请求仍会 revalidate。

### 生产验收

1. 先应用 migration，再执行一次按日 backfill，确认 `rank_daily_metrics` 行数和抽样用户的日代表值。
2. 部署 Worker，确认 Cron 显示为 UTC 20:05，并观察一次日聚合成功日志。
3. 打开 Dashboard 只检查 latest/leaderboard 请求；打开用户趋势后检查 history 的默认范围和 daily 行数。
4. 重复上传同一签名和过期快照，确认不新增 `rank_snapshots`/`rank_entries`。
5. 在 D1 Analytics 对比优化前后 `rows read`，重点确认不再出现整季 `rank_user_metrics` 读取和按请求重复的原始日窗口扫描。

## 不在本次范围内

- 不删除原始快照、明细、`raw_json` 或现有汇总表数据。
- 不增加 90 天清理任务；赛季本身最多 90 天。
- 不改变排行榜数值、北京日边界、来源合并和累计值选择语义。
- 不把 Farm Dashboard 的价格表或数据迁移到 Card 数据库。
