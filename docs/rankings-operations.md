# 榜单统计运维说明

## 数据流

```text
Card Dashboard 页面
  └─ userscript bridge
      ├─ 优先通过 GM relay → 已打开的 CDK 榜单页同源请求
      └─ CDK relay 不可用时回退 GM_xmlhttpRequest → https://cdk.hybgzs.com/api/cards/leaderboard?scope=global
          ├─ 自动上传开启 / 手动确认上传
          │   └─ POST /api/rankings/snapshots
          │       └─ Cloudflare D1 rank_snapshots + rank_entries
          └─ 自动上传关闭且未手动确认
              └─ 只在当前页面临时展示，不写入 D1
```

油猴脚本匹配 `card.gudong226.com` 与 `cdk.hybgzs.com`，但只有 Card 页面发起 bridge 请求和显示榜单 UI。`cdk.hybgzs.com/entertainment/cards/leaderboard` 只负责同源读取接口，不部署本项目的榜单按钮或统计视图。

## 本地数据库

`wrangler.jsonc` 使用 `RANKINGS_DB` 绑定，数据库名称为 `hyb-card-rankings-db`。首次初始化：

```bash
npx wrangler d1 migrations apply hyb-card-rankings-db --local
npx wrangler d1 execute hyb-card-rankings-db --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

预期表包括 `rank_snapshots`、`rank_entries`、`rank_user_metrics`、`rank_daily_metrics` 和 Wrangler 的 migration 元数据表。

生产环境创建独立数据库后，将 Cloudflare 输出的真实 database ID 填入 `wrangler.jsonc`，再在取得授权后执行：

```bash
npx wrangler d1 migrations apply hyb-card-rankings-db --remote
```

不要复用 Farm Dashboard 的价格数据库；榜单历史是独立的全服共享数据。

## 快照保存

- `capturedAt` 仍按一小时分桶保存到 `captured_bucket`，用于检索和时间归档。
- 同一赛季、scope 和小时内允许保存多份快照，分钟级刷新不会被 Worker 拦截。
- 每份快照保留自己的 `capturedAt`、`signature` 和榜单明细；最新接口按 `captured_at` 选择最新一份。
- 用户掉出当前前 100 后，旧快照中的 `rank_entries` 不删除，因此仍可通过用户搜索和历史接口查询。
- `rank_user_metrics` 是按赛季、`userId` 和榜单键维护的当前聚合层；用户总览的总榜优先读取这张小表，原始快照只用于按日配对和历史查询。它由原始快照回填并在每次上传时增量更新，可以重建但不能替代原始快照。
- `rank_snapshots.accepted` 默认为 `1`，所有榜单读取和日聚合只读取有效快照；`(accepted, captured_at, id)` 索引服务于有效快照的最新记录和时间范围读取。当前上传拦截的重复/过期数据不会插入快照；只有上线前已存在、经人工确认的重复快照才会保留原始行并标记为 `accepted=0`。
- `rank_daily_metrics` 按北京时间 04:00 划分日期，每个赛季、日期、用户和榜单键只保留当天最后一次有效观测。封口日由每日 Cron 物化；当前未封口日只读取一天范围内的原始尾部，不扫描整个赛季。
- 用户总览的今日、本周、本月和总榜历史部分优先读取 `rank_daily_metrics`；历史接口默认 `mode=daily`，只有明确传 `mode=snapshot` 才读取带时间范围的原始明细。
- 原始 `rank_snapshots` 和 `rank_entries` 只增不减，本项目不增加 90 天清理任务。赛季结束后仍由数据库保留原始审计数据，日聚合表可重复回填。
- 全服和好友是采集来源而不是展示范围。同一用户同时出现在两个来源时按 `userId` 合并，累计榜取已观测最大值，周期榜取最新观测值，不把两个来源相加。
- 多个用户分批上传时只追加或更新对应用户；一次上传缺少的用户不会被删除或重置为 0。
- 消费榜的原始 `value` 按 `value / 500000` 换算为 USD；VIP 使用每日 6000 USD / 650 抽，普通用户使用每日 4000 USD / 430 抽。
- 用户总览接口按同周期 `userId` 合并欧皇榜、消费榜和兑换榜；缺失用户或字段不会被当成 0，前端对应单元格留空。默认不传 `limit` 时返回聚合层中的全部用户，前端再按出卡率、消费、抽数、兑换或用户名排序。

## API 冒烟检查

本地启动：

```bash
npm run build
npx wrangler dev --local
```

另开终端执行：

```bash
curl -sS http://127.0.0.1:8787/api/rankings/latest
curl -sS 'http://127.0.0.1:8787/api/rankings/leaderboard?board=epic&period=total&limit=5'
curl -sS 'http://127.0.0.1:8787/api/rankings/history?userId=u1&mode=daily&limit=200'
```

没有快照时，`latest` 应返回 `snapshot: null` 和 `stale: true`；榜单接口应返回空 `rows`，而不是静态 `index.html`。

## 聚合、缓存与历史读取

第一次应用 `migrations/0004_rank_daily_metrics.sql` 前，先执行只读签名检查：

```bash
node scripts/check-rankings-signatures.mjs --remote
```

如果报告重复的 `season_id + signature`，先人工确认保留哪条为有效快照。先应用 `0004` 创建 `accepted` 列和日聚合表，再把确认无效的重复行标记为 `accepted=0`（只改状态，不删除原始快照或明细），最后应用 `0005` 建立只对 `accepted=1` 生效的签名唯一索引。不能跳过检查，也不能删除或合并原始行。

新表首次上线需要按天回填。脚本要求显式时间范围和目标环境，每次只对一个北京时间日执行有边界的 upsert：

```bash
node scripts/backfill-rank-daily.mjs \
  --from 2026-08-02T04:00:00+08:00 \
  --until 2026-08-25T04:00:00+08:00 \
  --remote
```

日常 Cron 为 UTC `20:05`（北京时间次日 `04:05`），只聚合刚刚结束的北京日。重复执行同一天是安全的 upsert，不删除原始快照；Cron 失败会记录结构化错误，等待下一次重试。

成功 GET 的 Worker 缓存时间：`latest` 15 秒，榜单/用户搜索/事件 30 秒，历史 60 秒，并允许短暂 stale-while-revalidate。POST、4xx 和 5xx 保持 `no-store`。历史请求默认最近 30 天、每页最多 500 行，使用 `since/until/limit/cursor` 做 keyset 分页。

## 刷新策略

页面打开榜单视图时先读取 D1，不主动抓取 CDK，也不要求安装用户脚本。只有手动点击“立即刷新”、开启“每 3 小时刷新”或触发一次自动刷新时，才通过 bridge 请求 CDK；此时才检查用户脚本版本。手动刷新可以绕过普通的 3 小时自动冷却，但仍受请求进行中锁和 403、429、盾页、验证页等保护性冷却约束；手动普通失败不安排自动重试，手动成功会取消已有的待执行自动重试。旧脚本会显示更新入口，未安装脚本会提示安装，但都不会清空已有榜单。自动刷新遇到普通网络错误或服务端错误时，在 1 小时后最多自动重试 1 次；保护性错误不自动重试并进入 3 小时冷却。周期或榜单类型切换只读取 D1，不重复请求 CDK。默认不自动上传，关闭上传时新快照只在当前页面显示；开启自动上传或点击“上传云端”后才写入 D1。请求失败时页面保留旧快照并显示错误。

Dashboard 启动和普通榜单刷新不请求用户历史；只有打开趋势弹窗后才请求 `mode=daily` 历史。关闭趋势弹窗后不后台刷新已选用户的趋势，浏览器会复用 Worker 的短缓存；需要更多历史时使用 cursor 追加下一页。

## 隐私与安全

- 不在 D1 保存登录 Cookie、Authorization、IP 或用户私人资料。
- `raw_json` 只保存榜单接口公开返回的赛季和榜单行，用于审计与历史重建。
- userscript 匹配 `https://card.gudong226.com/*` 和 `https://cdk.hybgzs.com/*`，只为 `cdk.hybgzs.com` 声明跨域连接权限；CDK 页面不注入榜单 UI。
- 远程 D1 migration、Worker 部署和公开发布需在确认数据库绑定后执行。

本次代码修改不会自动执行远程 migration、签名检查、历史回填或 Worker 部署；这些命令必须在确认数据库状态后单独执行。
