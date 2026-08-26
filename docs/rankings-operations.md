# 榜单统计运维说明

## 数据流

```text
Card Dashboard 页面
  └─ userscript bridge
      ├─ 优先通过 GM relay → 已打开的 CDK 榜单页同源请求
      └─ CDK relay 不可用时回退 GM_xmlhttpRequest → CDK leaderboard API
          ├─ 上传确认后 POST /api/rankings/snapshots
          │   └─ Worker 按用户 + 北京时间日增量 upsert compact D1
          └─ 未确认上传
              └─ 只在当前页面临时展示，不写入 D1
```

油猴脚本匹配 `card.gudong226.com` 与 `cdk.hybgzs.com`，但只有 Card 页面显示榜单 UI。上传请求可以带全服前 100 和好友列表；Worker 会按 `userId` 合并，不保存原始响应、快照明细或客户端 fingerprint。

## compact 数据库

线上旧库 `hyb-card-rankings-db` 保留不动。新库建议命名为 `hyb-card-rankings-v2-db`，初始 schema 只包含四张业务表：

- `rank_seasons`：最新赛季元数据和最后观测时间；
- `rank_ingest_state`：每个赛季/来源的最新 `capturedAt` 水位，重复或过期来源在写入前跳过；
- `rank_user_current`：每个赛季、用户一行，保存当前各榜单字段和排序派生值；
- `rank_user_days`：每个赛季、北京时间日、用户一行，保存按日趋势。

初始化新库：

```bash
npx wrangler d1 create hyb-card-rankings-v2-db
npx wrangler d1 execute hyb-card-rankings-v2-db --remote --yes \
  --file=migrations-v2/0001_compact_rankings.sql
npx wrangler d1 execute hyb-card-rankings-v2-db --remote --yes \
  --file=migrations-v2/0002_period_sort_fields.sql
npx wrangler d1 execute hyb-card-rankings-v2-db --remote --yes \
  --command="SELECT type, name FROM sqlite_master ORDER BY type, name"
```

预期不出现 `rank_snapshots`、`rank_entries`、`rank_user_metrics`、`rank_daily_metrics`、`raw_json` 或 fingerprint 表/字段。把 `d1 create` 输出的真实 ID 写入 `wrangler.jsonc` 前，必须先完成迁移和验证。

## 上传与读取规则

- 用户上传仍可按 `global` / `friends` 两个来源发送；相同用户只写一行日数据和一行 current 数据。
- `*_total` 累计值取已观测最大值，周期值按较新的 `capturedAt`，同一天重复值不会产生无意义更新。
- 相同 `season_id + scope` 的旧或重复来源由 `rank_ingest_state` 拦截；POST 仍有 `RANKINGS_WRITE_LIMITER` 限流。
- Dashboard 首屏只读取 `latest` 元数据和当前榜单第一页；榜单不再使用全量窗口排名。第一页的计数查询同时返回符合条件用户的总消费、平均估算抽数和平均出卡率，浏览器会复用这份全量汇总；搜索、置顶用户和翻页只更新对应用户/页，不改变顶部汇总。
- 当前榜单只展示最新北京日内、消费金额/估算抽数/兑换次数至少一项有值的用户；历史日表和用户历史接口不受该展示过滤影响。
- 历史接口只接受按日模式，必须带 `userId`；默认最近 30 天，最多 90 天，可用 `since/until/limit/cursor` 追加页面。
- 浏览器对 GET 使用内存 TTL 缓存：`latest` 15 秒，榜单/用户/事件 30 秒，历史 60 秒；POST、4xx、5xx 不缓存。
- 赛季只有 90 天，当前不增加清理任务；旧库、备份和新库都不执行删除或 reset。

API 冒烟检查：

```bash
curl -sS https://card.gudong226.com/api/rankings/latest
curl -sS 'https://card.gudong226.com/api/rankings/leaderboard?board=users&period=total&limit=50'
curl -sS 'https://card.gudong226.com/api/rankings/history?userId=u-1&limit=30'
```

## 备份、迁移和校验

备份目录必须是新的、不存在的目录。脚本只导出旧 D1、保存 schema/行数 metadata、压缩并校验 SHA-256：

```bash
node scripts/backup-card-rankings.mjs \
  --database hyb-card-rankings-db \
  --output backups/card-rankings-2026-08-26 \
  --remote
```

生成 `database.sql`、`database.sql.gz`、`metadata.json`、`manifest.json`。`backups/` 已加入 `.gitignore`，但仍需保留该目录用于回滚审计。

迁移前先初始化新 schema，再按明确的北京日区间运行 compact 回填。每次只读取一个日范围；重复运行同一天是主键 upsert，不修改旧库：

```bash
node scripts/migrate-card-rankings-compact.mjs \
  --source hyb-card-rankings-db \
  --target hyb-card-rankings-v2-db \
  --from 2026-08-02T04:00:00+08:00 \
  --until 2026-08-26T04:00:00+08:00 \
  --remote
```

迁移查询只选择旧日表/旧榜单明细中的用户、榜单值、排名、来源和时间字段，不选择 `raw_json`；目标写入只涉及 compact 表。某一天失败时只重新执行该天的 `[from, until)` 范围。

切换前用独立只读校验比较旧/新赛季、每日用户数、current 用户数和目标 schema；需要时可抽样一个用户：

```bash
node scripts/verify-card-rankings-compact.mjs \
  --source hyb-card-rankings-db \
  --target hyb-card-rankings-v2-db \
  --from 2026-08-02T04:00:00+08:00 \
  --until 2026-08-26T04:00:00+08:00 \
  --remote --user u-1
```

## Cron 与部署顺序

Cron 保持 UTC `20:05`（北京时间次日 `04:05`）。它只从 `rank_user_current` 读取必要字段，刷新排序派生列并更新赛季元数据，不再调用旧的全量日聚合。

本地门禁：

```bash
npm test
npm run build
git diff --check
```

远程切换顺序：

1. 备份旧库并确认 manifest 可复算；
2. 创建新 D1、应用 `migrations-v2/0001_compact_rankings.sql` 和 `0002_period_sort_fields.sql`；
3. 按日迁移并运行只读校验；
4. 仅在校验通过后修改 `wrangler.jsonc` 的 `RANKINGS_DB.database_id`；
5. 重新跑测试/构建，push 并部署；
6. 做线上 `latest`、第一页榜单、单用户历史和重复 POST 冒烟检查；
7. 继续按日补齐缺失历史，旧库和备份暂不删除。

若新库异常，恢复旧 `database_id`，部署旧 Worker commit；新库保留用于诊断。任何回滚都不删除旧库、新库或备份。

## 隐私与安全

- D1 不保存登录 Cookie、Authorization、IP 或原始 CDK 响应。
- 用户上传脚本不维护客户端 fingerprint 或本地 diff 状态；去重和增量判断在 Worker/D1 完成。
- 远程导出、创建新 D1、迁移和部署均使用显式数据库名与时间范围，脚本没有删除、drop、reset 操作。
