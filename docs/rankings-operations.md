# 榜单统计运维说明

## 数据流

```text
Card Dashboard 页面
  └─ userscript bridge
      └─ GM_xmlhttpRequest → https://cdk.hybgzs.com/api/cards/leaderboard?scope=global
          └─ POST /api/rankings/snapshots
              └─ Cloudflare D1 rank_snapshots + rank_entries
```

只有 `card.gudong226.com` 发起同步。`cdk.hybgzs.com/entertainment/cards/leaderboard` 是数据来源页面，不部署本项目的榜单按钮或脚本 UI。

## 本地数据库

`wrangler.jsonc` 使用 `RANKINGS_DB` 绑定，数据库名称为 `hyb-card-rankings-db`。首次初始化：

```bash
npx wrangler d1 migrations apply hyb-card-rankings-db --local
npx wrangler d1 execute hyb-card-rankings-db --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

预期表包括 `rank_snapshots`、`rank_entries` 和 Wrangler 的 migration 元数据表。

生产环境创建独立数据库后，将 Cloudflare 输出的真实 database ID 填入 `wrangler.jsonc`，再在取得授权后执行：

```bash
npx wrangler d1 migrations apply hyb-card-rankings-db --remote
```

不要复用 Farm Dashboard 的价格数据库；榜单历史是独立的全服共享数据。

## 快照去重

- `capturedAt` 按一小时分桶保存到 `captured_bucket`。
- `(season_id, scope, captured_bucket)` 是唯一约束。
- 同一小时再次上传时返回 `status: duplicate`，不会插入新的快照。
- 用户掉出当前前 100 后，旧快照中的 `rank_entries` 不删除，因此仍可通过用户搜索和历史接口查询。

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

页面打开榜单视图时先读取 D1。只有无快照或最新快照超过一小时，才通过 bridge 请求 CDK 一次；周期或榜单类型切换只读取 D1，不重复请求 CDK。请求遇到 401/403、429 或超时，页面保留旧快照并显示错误。

## 隐私与安全

- 不在 D1 保存登录 Cookie、Authorization、IP 或用户私人资料。
- `raw_json` 只保存榜单接口公开返回的赛季和榜单行，用于审计与历史重建。
- userscript 只匹配 `https://card.gudong226.com/*`，只为 `cdk.hybgzs.com` 声明跨域连接权限。
- 远程 D1 migration、Worker 部署和公开发布需在确认数据库绑定后执行。
