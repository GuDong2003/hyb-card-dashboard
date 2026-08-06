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

预期表包括 `rank_snapshots`、`rank_entries`、`rank_user_metrics` 和 Wrangler 的 migration 元数据表。

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
- `rank_user_metrics` 是按赛季、`userId` 和榜单键维护的当前聚合层；它由原始快照回填并在每次上传时增量更新。该表可以重建，不能替代原始快照。
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
```

没有快照时，`latest` 应返回 `snapshot: null` 和 `stale: true`；榜单接口应返回空 `rows`，而不是静态 `index.html`。

## 刷新策略

页面打开榜单视图时先读取 D1，不主动抓取 CDK。只有手动点击“立即刷新”或开启“每小时刷新”后，才通过 bridge 请求 CDK；周期或榜单类型切换只读取 D1，不重复请求 CDK。默认不自动上传，关闭上传时新快照只在当前页面显示；开启自动上传或点击“上传云端”后才写入 D1。请求遇到 401/403、429 或超时，页面保留旧快照并显示错误。

## 隐私与安全

- 不在 D1 保存登录 Cookie、Authorization、IP 或用户私人资料。
- `raw_json` 只保存榜单接口公开返回的赛季和榜单行，用于审计与历史重建。
- userscript 匹配 `https://card.gudong226.com/*` 和 `https://cdk.hybgzs.com/*`，只为 `cdk.hybgzs.com` 声明跨域连接权限；CDK 页面不注入榜单 UI。
- 远程 D1 migration、Worker 部署和公开发布需在确认数据库绑定后执行。
