# Card 榜单用户级增量存储设计

## 目标

解决 `hyb-card-rankings-db` 因重复保存完整快照、榜单明细和 `raw_json` 而触及 D1 免费容量上限的问题，同时保留 Card 榜单需要的当前榜单、用户搜索和用户趋势能力。

本次切换的核心约束已经确认：

- 先完整备份旧 D1，再新建精简 D1；旧库保留作回滚和迁移源，不在旧库内做破坏性清理。
- 新库以用户为中心，每个赛季、每个北京时间日、每个用户只保存一行；同一行包含该用户各榜单的相关字段。
- 同一天首次观察某个来源时保存该用户当天的基线；后续刷新可以继续提交当前观察到的用户行，由 Worker 在 D1 侧判断变化并只更新发生变化的字段。
- 不保存新的原始快照、榜单明细、`raw_json` 或每次请求的幂等日志。
- Dashboard 启动只取最新元数据和第一页；换页只取对应页；点击或添加用户时才取该用户的历史。
- 浏览器和 Worker 都启用短时缓存；上传成功后使用显式 revalidation，避免缓存遮住刚写入的数据。
- 赛季最多 90 天，不增加清理任务。旧库备份在新库验证完成前不删除。

## 背景与现状

旧库的单次榜单响应本身并不大，真正造成膨胀的是刷新时重复保存同一批用户：

```text
一次刷新
  ├─ rank_snapshots：完整响应 + raw_json
  └─ rank_entries：每个榜单的每个用户一行 + raw_json

多次刷新/多来源
  └─ 同一用户和相近数据反复产生快照、明细、索引和聚合写入
```

旧版读放大优化已经让 Dashboard 不再启动时加载全量历史，历史接口也有时间范围和 cursor。剩余主要问题是存储模型仍然以快照为中心，以及前端上传仍然把完整来源响应交给 Worker。新设计把写入单位改成“用户日”，把读取单位改成“当前页”或“单个用户”。

## 方案选择

### 方案 A：继续保存快照，只增加更多拦截

实现改动最少，但每次有效刷新仍会保存完整快照和明细；重复签名只能阻止完全相同的 payload，用户数据只要有一点变化就会重新产生大量原始行。不能从根本上解决容量问题。

### 方案 B：只保存稀疏变化日志

空间最小，上传也可以只提交变化字段。但要恢复某一天的完整榜单，查询必须向前寻找每个用户的最近值；全服榜单和按日趋势都需要做大量 as-of 合并，查询复杂且容易重新产生读放大。

### 方案 C：用户日表 + 用户当前表（推荐）

每天每个被观察用户保留一条扁平记录，同一天后续变化覆盖该用户日记录中的对应字段；另维护一条用户当前记录供榜单分页。它比“每个用户每个榜单一行”更紧凑，也不需要每次读取时解析 JSON 或扫描整季变化日志。旧数据可以按日从旧库聚合迁入，新数据直接走同样的用户级 upsert。

## 总体架构

```text
CDK 返回全量榜单（上游接口限制）
  └─ userscript 返回当前来源的观察结果
       └─ Dashboard 去掉 raw 字段后提交当前用户行
            └─ POST /api/rankings/snapshots（保留路径，语义改为观察增量）
                 ├─ 按 userId + Beijing day 合并
                 ├─ 条件 upsert rank_user_days
                 ├─ 条件 upsert rank_user_current
                 └─ 更新 rank_seasons 元数据

Dashboard 启动
  ├─ GET /api/rankings/latest
  └─ GET /api/rankings/leaderboard（第一页）

换页/排序
  └─ GET /api/rankings/leaderboard?limit=...&cursor=...

点击或添加用户
  └─ GET /api/rankings/history?userId=...&since=...&until=...&limit=...&cursor=...
```

## 新 D1 数据模型

新库建议命名为 `hyb-card-rankings-v2-db`。生产绑定仍使用 `RANKINGS_DB`，切换时只替换 binding 的 database ID；旧库可以另记为 `LEGACY_RANKINGS_DB`，但不让新请求依赖它。

### `rank_user_days`

每个赛季、北京日、用户一行：

```sql
CREATE TABLE rank_user_days (
  season_id TEXT NOT NULL,
  day_start_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  observed_at INTEGER NOT NULL,
  source_scopes TEXT NOT NULL DEFAULT '',

  sets_total_value INTEGER,
  sets_total_rank INTEGER,
  sets_month_value INTEGER,
  sets_month_rank INTEGER,
  sets_week_value INTEGER,
  sets_week_rank INTEGER,
  sets_today_value INTEGER,
  sets_today_rank INTEGER,
  epic_total_value INTEGER,
  epic_total_rank INTEGER,
  epic_month_value INTEGER,
  epic_month_rank INTEGER,
  epic_week_value INTEGER,
  epic_week_rank INTEGER,
  epic_today_value INTEGER,
  epic_today_rank INTEGER,
  spend_total_value INTEGER,
  spend_total_rank INTEGER,
  spend_month_value INTEGER,
  spend_month_rank INTEGER,
  spend_week_value INTEGER,
  spend_week_rank INTEGER,
  spend_today_value INTEGER,
  spend_today_rank INTEGER,

  sets_total_observed_at INTEGER,
  sets_month_observed_at INTEGER,
  sets_week_observed_at INTEGER,
  sets_today_observed_at INTEGER,
  epic_total_observed_at INTEGER,
  epic_month_observed_at INTEGER,
  epic_week_observed_at INTEGER,
  epic_today_observed_at INTEGER,
  spend_total_observed_at INTEGER,
  spend_month_observed_at INTEGER,
  spend_week_observed_at INTEGER,
  spend_today_observed_at INTEGER,

  PRIMARY KEY (season_id, day_start_at, user_id)
);
```

上述 12 个 board key 各自维护一个 `*_observed_at`。同一 board key 的 value、rank 和观测时间在一次 upsert 中原子更新；较早请求不能覆盖较晚请求。行级 `observed_at` 保存该用户当天最后一次发生有效字段变化的时间。字段为空表示该用户当天没有观察到该榜单，不表示数值为 0。

索引：

- `(season_id, user_id, day_start_at)`：单用户历史和趋势。
- `(season_id, day_start_at, user_id)`：指定日期的用户页、事件比较和迁移校验。

不保存单行原始 JSON、snapshot ID 或对旧库的外键引用。这样旧库以后即使离线，也不会影响新库读取。

### `rank_user_current`

每个赛季、用户一行，字段布局与 `rank_user_days` 的指标字段一致，另外包含：

- `first_observed_at`、`last_observed_at`
- `source_scopes`
- 最新用户资料和 VIP 状态
- 与 12 个 board key 对应的 `*_observed_at`
- 当前用户榜单所需的派生排序值：`sort_legend_value`、`sort_spend_usd`、`sort_estimated_pulls`、`sort_exchange_count`、`sort_probability`。这些值由 Worker 使用既有估算规则，在当前 upsert 时持久化，并由每日维护任务按新的赛季日重算已有行

主键为 `(season_id, user_id)`，索引为：

- `(season_id, last_observed_at DESC, user_id)`
- `(season_id, epic_total_value DESC, user_id)`
- `(season_id, spend_total_value DESC, user_id)`
- `(season_id, sets_total_value DESC, user_id)`
- `(season_id, sort_probability DESC, user_id)`
- `(season_id, sort_estimated_pulls DESC, user_id)`

它只保存“当前可展示值”，不保存每次变化。累计榜的 value 取已观察到的最大值；今日/周/月榜取较新的观察值；rank 和资料按较新的观察更新。用户从最新 100 名或好友列表中暂时消失时，不删除当前记录。

### `rank_seasons`

保存最新赛季的小型元数据：

```sql
CREATE TABLE rank_seasons (
  season_id TEXT PRIMARY KEY,
  season_name TEXT NOT NULL,
  last_observed_at INTEGER NOT NULL,
  last_day_start_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`latest` 只读取这张表，不再为了找最新快照扫描用户数据。新库切换后如果没有数据，返回与现有 API 兼容的空榜单响应。

## 北京日和保留语义

北京日固定从每天 04:00 开始：

```text
day_start_at = floor((captured_at - 04:00) / 24h) * 24h + 04:00
```

同一用户当天的日记录只保留最后一次有效字段值。用户在当天没有再次变化时，保留第一次日基线；不存在“为了刷新时间而重复写一行”的行为。当天结束后不再生成额外聚合表，日表本身就是聚合结果。

数据不会因为用户掉出榜单而被删除。没有收到某个用户当天的新观察，也不会把其已有数据改成 0；这能避免全量榜单只有前 100 名所造成的误删。赛季最多 90 天，不增加定时清理任务。

每日 UTC `20:05`（北京时间次日 `04:05`）的维护任务只做两件事：更新 `rank_seasons` 的当前日元数据，并在 `rank_user_current` 原地重算依赖赛季日的派生排序字段。它不创建新的历史行、不读取或解析原始 JSON，也不把当前用户表复制成另一份历史表。新数据的日记录由上传时的用户级 upsert 直接产生。

## 增量上传协议

### 客户端上传边界

上游 CDK 仍然返回全量前 100 名和好友列表，这是上游接口限制；本项目不在 userscript 中维护 fingerprint、GM 上传状态或本地确认日志。userscript 继续负责请求、规范化时间和跨页面 relay，Dashboard 的上传函数负责把当前响应裁剪为不含 `raw` 的规范化观察行。

POST 发送的是当前观察到的用户/榜单字段，而不是完整历史，也不包含 `rank_snapshots.raw_json`。同一天重复提交同一批当前行由 Worker/D1 条件 upsert 变成 no-op；新的一天使用新的 `day_start_at` 生成日基线。用户从这次前 100 或好友列表消失时不发送删除标记；缺失不等于数值为零。

这样“增量”定义在数据库写入层：HTTP body 可能包含当前这次观察到的全部用户行，但 D1 只新增或更新发生变化的用户日字段。由于单次最多是前 100 名和好友列表，避免客户端状态同步复杂度比进一步压缩 body 更重要。

### Worker 校验与幂等

保留 `/api/rankings/snapshots` 路径以兼容现有前端和旧脚本，但不再把请求命名为快照存储。Worker 兼容旧的 `snapshots` 外层结构，并把其中的榜单行当作观察增量处理；Dashboard 在 POST 前去掉 `raw` 字段。

每个用户批次执行以下检查：

- `season.id`、`scope`、`capturedAt`、`userId`、`boardKey`、value 和 rank 必须有效。
- 未来时间超过容差、未知榜单或超过单请求用户/字段上限直接返回 400。
- 旧日期数据允许迟到回填，但同一天同一字段只接受更晚的观测；较早值不会覆盖较新值。
- 同一 `(season_id, day_start_at, user_id)` 的重复请求通过主键 upsert 变成 no-op 或字段级更新，不产生第二行。
- `rank_user_current` 使用与指标类型对应的最大值/最新值规则；同一请求重放仍得到同样结果。
- 不建立会随请求无限增长的 `idempotency_receipts` 表，也不在浏览器保存 fingerprint。用户级日主键、字段时间条件和条件 upsert 已提供结果幂等；请求重放只会返回 `unchanged` 或实际变化数。
- POST 仍使用 Rate Limiting binding，默认每来源每 60 秒最多 10 次；429 不写入数据库。

为了让“未变化不写入”完全由服务端保证，日表和当前表的 upsert 必须带变化条件：如果 incoming 字段与现有值、rank、资料和来源都没有变化，`changes` 为 0。`observed_at` 不能单独触发更新，否则定时刷新仍会造成写放大。

## 查询 API

### 最新数据

`GET /api/rankings/latest`：

- 只读 `rank_seasons`。
- 返回 season、`lastObservedAt`、stale 状态和可用榜单类型。
- 不返回用户列表或历史。

### 当前榜单分页

`GET /api/rankings/leaderboard` 增加并默认使用：

- `limit`：默认 100，最大 100。
- `cursor`：不透明 keyset cursor，包含排序值和 userId；不使用 offset。
- `board`、`period`、`sort`：保持现有参数。

Worker 在 SQL 中直接对 `rank_user_current` 做过滤、排序和 `LIMIT limit + 1`，只把当前页返回给前端。排序变化会清空 cursor 并重新请求第一页。上一页事件比较只针对当前页的 userId，最多再读取对应页的一小组日记录，不读取全表。

用户榜 `board=users` 的出卡、消费、抽数、兑换和概率排序必须在 SQL 的分页查询中完成；所有排序字段都从 `rank_user_current` 的持久化字段读取，并配套 keyset cursor。不得把全部用户加载到 Worker 内存后再排序。

### 用户搜索和单用户历史

`GET /api/rankings/users?q=...&limit=20`：

- `q` 必填，按 `user_id/user_name` 在 SQL 中过滤。
- 默认最多 20 行，不返回全部用户。

`GET /api/rankings/history`：

- `userId` 必填；一次请求只处理一个用户。
- `since`、`until`、`limit`、`cursor` 保留并默认生效；默认时间窗口为最近 30 个北京日，最大 90 日。
- `board` 可选；不传时返回该用户一行/日的必要指标，传入时只序列化对应榜单字段。
- 默认且唯一的存储模式为 `daily`；旧的 `snapshot` 参数为兼容参数，但不再触发原始快照查询。
- keyset cursor 只按 `day_start_at` 推进，最多读取 `limit + 1` 行。

这样点击第二个用户会发第二个 `userId` 请求，换页只发新的 cursor 请求；不会为了一个用户把整季、全用户或全部 `prices_json/raw_json` 读出来。

### 事件接口

`GET /api/rankings/events` 默认限制最近 7 个北京日，并只比较请求涉及的用户/当前页范围。需要逐次抓取事件的旧行为不再作为默认路径；新库没有逐快照事件，若调用方明确需要，返回按日变化事件。

## 缓存策略

### Worker 边缘缓存

成功 GET 使用公开短 TTL：

- `latest`：15 秒。
- 当前榜单、用户搜索、事件：30 秒。
- 单用户历史：60 秒。

允许 `stale-while-revalidate`。POST、400、429、500 和数据库异常保持 `no-store`。缓存 key 必须包含完整 query string，因此不同用户、排序、页 cursor 不会互相串数据。

### 浏览器缓存

Dashboard 的 `apiGet` 增加内存缓存，必要时使用 `sessionStorage` 保存短 TTL 的 JSON：

- key 为请求路径和完整 query string。
- history 按 `userId + board + since + until + cursor` 独立缓存。
- 当前页、用户搜索和用户历史在短时间内重复打开时复用缓存。
- 手动刷新和上传成功后的请求使用 `cache: 'reload'` 或 `Cache-Control: no-cache`，并清除受影响的缓存 key。
- 页面关闭后不要求持久保存全量榜单；浏览器缓存只服务于当前用户的重复查看。

缓存允许几十秒最终一致性，但不参与 POST 幂等和数据校验。

## 旧库备份与新库迁移

### 1. 完整备份旧 D1

在切换任何 binding 前执行：

1. 导出旧 D1 的完整 SQL，包括 schema、数据和 migration 元数据。
2. 同时保存表行数、数据库大小、schema 查询结果、当前最新时间和若干抽样用户结果。
3. 对导出文件生成 gzip 和 SHA-256 manifest，并验证压缩包可以解压、SQL 文件非空。
4. 备份放在仓库外的明确目录，不提交到 Git；旧数据库和备份都保留。

这是可回滚的只读备份，不执行 `DROP`、`DELETE` 或旧库清理。

### 2. 建立新库并迁移已有聚合

新库先应用精简 schema，再按北京日、分批从旧库读取：

- 已有 `rank_daily_metrics`：按 `season_id + day_start_at + user_id` 分组，把不同 `board_key` 填入同一用户日行。
- 旧库中尚未完成日聚合的日期：只读取限定日期范围内的 `rank_entries` 必要列和 `rank_snapshots` 的 `season_id/scope/captured_at/id`，不选择 `raw_json`，按日聚合后写入新库。
- `rank_user_metrics`：迁入 `rank_user_current`，并按新字段布局转换；必要时用已迁入的日表校验累计值和最新值。
- 赛季元数据：从旧快照的最新记录或迁移结果写入 `rank_seasons`。

迁移脚本必须显式接收 `--from`、`--until`、`--remote` 和源/目标 database 名称；每次只处理一个北京日和有限用户批次。失败可以从该日重新执行，目标表的主键 upsert 保证不会重复。

至少完成当前赛季已有数据的首轮迁入后再切流；8 月 17 日以后尚未聚合的旧数据可以在新库上线后继续以单日小批量回填，但回填过程不能读取或写入旧库的 `raw_json`。

### 3. 验证与切换

切换前验证：

- 新旧库的赛季、用户数、用户日数和各榜单字段抽样一致。
- 抽样用户的 90 日趋势按北京日一致。
- 当前榜单第一页、用户搜索和单用户历史响应与旧 API 语义一致。
- 新库重复上传同一 payload 三次，只有第一次产生变化。
- 新库 schema 不包含 `rank_snapshots`、`rank_entries` 或 `raw_json`。

验证通过后只修改 `wrangler.jsonc` 中 `RANKINGS_DB.database_id` 指向新库，部署 Worker 和 Dashboard 静态资源；userscript 的抓取/relay 逻辑无需为增量存储增加本地状态。旧 Worker 版本、旧 binding 配置和旧 D1 均保留，出现问题时可以直接恢复旧配置并重新部署。

## 测试与验收

### 单元和契约测试

- 北京 04:00 边界正确，跨日首次基线写入新日。
- 同用户同日多来源能合并到一行，`source_scopes` 不丢失。
- 同日重复 payload 不新增行，也不因时间更新产生无意义写入。
- 较早字段不能覆盖较晚字段；累计榜取最大值，周期榜取最新值。
- 同一份完整当前观察 payload 重复提交时只产生第一次变化；POST 重放不会新增用户日行。
- 上传路径不出现旧表查询、`raw_json` 插入或完整快照签名索引依赖。
- `latest` 只读 season 元数据；leaderboard 使用 SQL `LIMIT + 1` 和 cursor；history 只读取一个 userId 的日行。
- 非法 cursor、时间范围、limit、用户 ID 和超大 payload 返回 400；限流返回 429。
- GET 缓存头正确，POST 和错误响应为 `no-store`。
- Dashboard 启动没有 history 请求，用户点击/添加/换页才产生对应请求。

### 生产验收

1. 备份 manifest 和导出校验通过。
2. 新库大小明显低于旧库免费上限，且没有原始 JSON 表。
3. 首屏只产生 latest 和第一页 leaderboard 读取。
4. 翻页、用户搜索、单用户趋势分别只读取目标页/目标用户。
5. 同一来源连续刷新但数据未变化时，D1 行数和关键行 `updated` 状态不变。
6. 跨北京时间 04:00 后第一次观察会产生新的用户日行；同日下一次刷新只更新变化字段。
7. 新库上线后持续抽样回填 8 月 17 日以后的缺失日期，回填不会阻塞当前读写。
8. D1 Analytics 中不再出现每次请求读取全量 history、整张用户聚合表返回 Worker 或重复写入原始快照的模式。

## 不在本次范围内

- 不删除旧 D1、旧备份或旧库中的原始数据。
- 不为赛季增加 90 天清理 Cron。
- 不把 Farm Dashboard 的价格数据迁入 Card 新库。
- 不在用户打开 Dashboard 时预加载所有用户或所有历史。
- 不承诺保留逐次刷新级别的原始事件；新库的历史粒度是用户每日数据。
