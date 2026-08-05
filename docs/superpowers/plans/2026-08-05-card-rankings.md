# HYB Card Dashboard 榜单统计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 `card.gudong226.com` 地址的前提下，增加榜单统计二级视图、按赛季保存全服榜单历史、按小时去重，并通过仅部署在 Card Dashboard 页面的油猴脚本从 `cdk.hybgzs.com` 获取数据。

**Architecture:** 将现有静态 Assets Worker 扩展为 Worker + D1 API；榜单数据通过 Card Dashboard 页面触发的 userscript bridge 从 `https://cdk.hybgzs.com/api/cards/leaderboard?scope=global` 获取，规范化后写入 D1。前端在同一地址内切换收益计算视图与榜单统计视图，`cdk.hybgzs.com` 不增加任何 Card Dashboard 按钮或页面入口。

**Tech Stack:** Cloudflare Workers, D1, Wrangler, 原生 JavaScript, HTML/CSS, Tampermonkey/Greasemonkey `GM_xmlhttpRequest`, Node.js built-in test runner.

---

### Task 1: 建立榜单数据核心模块与单元测试

**Files:**
- Create: `src/rankings-core.js`
- Create: `test/rankings-core.test.js`
- Modify: `package.json`

- [ ] **Step 1: 写失败测试，锁定接口和规则**

在 `test/rankings-core.test.js` 写入以下测试骨架，覆盖 12 个榜单键、规范化、签名、估算概率和相邻快照事件：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_KEYS,
  normalizeLeaderboardSnapshot,
  computeSnapshotSignature,
  estimateLegendProbability,
  diffBoardRows
} from '../src/rankings-core.js';

const row = (overrides = {}) => ({
  userId: 'u-1', userName: '猪猪', avatar: '', value: 10,
  rank: 1, isVip: true, activeNameDecoration: null,
  nameDisplayPreference: 'auto', ...overrides
});

test('accepts all server leaderboard keys and keeps at most 100 rows', () => {
  const leaderboards = Object.fromEntries(BOARD_KEYS.map((key) => [key, [row()]]));
  const result = normalizeLeaderboardSnapshot({
    season: { id: 'season-1', name: '第四赛季-周年庆' },
    scope: 'global', leaderboards, capturedAt: 1785922892568
  }, 1785922892568);
  assert.equal(result.ok, true);
  assert.deepEqual(result.boardKeys, BOARD_KEYS);
  assert.equal(result.entries.length, 12);
});

test('rejects unknown boards and future captures', () => {
  const base = {
    season: { id: 'season-1', name: '测试赛季' }, scope: 'global',
    leaderboards: { epic_total: [row()] }, capturedAt: 2000
  };
  assert.equal(normalizeLeaderboardSnapshot({ ...base, leaderboards: { bad: [] } }, 1000).reason, 'unknown_board');
  assert.equal(normalizeLeaderboardSnapshot(base, 1000).reason, 'future_captured_at');
});

test('signature is stable when object key order changes', () => {
  const left = { b: 2, a: 1 };
  const right = { a: 1, b: 2 };
  assert.equal(computeSnapshotSignature(left), computeSnapshotSignature(right));
});

test('estimates pull count with VIP free pulls and returns a percentage', () => {
  assert.equal(estimateLegendProbability({ epicTotal: 12, spendTotal: 6000, elapsedDays: 2, isVip: true }), 12 / 700);
});

test('diffs rank movement and enter/leave events', () => {
  const previous = [row({ userId: 'u-1', rank: 4, value: 9 }), row({ userId: 'u-2', rank: 2, value: 5 })];
  const current = [row({ userId: 'u-1', rank: 1, value: 10 }), row({ userId: 'u-3', rank: 2, value: 7 })];
  const result = diffBoardRows(previous, current);
  assert.equal(result.find((item) => item.userId === 'u-1').rankDelta, 3);
  assert.equal(result.find((item) => item.userId === 'u-3').event, 'entered');
  assert.equal(result.find((item) => item.userId === 'u-2').event, 'left');
});
```

- [ ] **Step 2: 运行测试，确认核心模块尚未存在而失败**

运行：`node --test test/rankings-core.test.js`

预期：FAIL，提示 `../src/rankings-core.js` 或其中导出函数不存在。

- [ ] **Step 3: 实现 `src/rankings-core.js` 的最小纯函数集合**

实现以下固定导出和规则：

```js
export const BOARD_KEYS = [
  'sets_total', 'sets_month', 'sets_week', 'sets_today',
  'epic_total', 'epic_month', 'epic_week', 'epic_today',
  'spend_total', 'spend_month', 'spend_week', 'spend_today'
];

export function estimateLegendProbability({ epicTotal, spendTotal, elapsedDays, isVip }) {
  const pulls = Number(spendTotal || 0) / 10 + Math.max(0, Number(elapsedDays || 0)) * (isVip ? 50 : 30);
  return pulls > 0 ? Number(epicTotal || 0) / pulls : null;
}
```

其余函数必须：检查 `season.id`、`scope === 'global'`、抓取时间不能超过服务器时间 10 分钟；每个已知榜单最多保留 100 行；将 `value`、`rank` 转为非负整数，将 `isVip` 转为 0/1；用排序后的规范化 JSON 生成 SHA-256 签名；`diffBoardRows` 同时返回当前行、排名变化、数值变化、`entered` 和 `left` 事件。

- [ ] **Step 4: 运行测试，确认全部通过**

运行：`node --test test/rankings-core.test.js`

预期：5 个测试 PASS。

- [ ] **Step 5: 增加测试脚本并提交核心模块**

在 `package.json` 增加：

```json
"test": "node --test test/*.test.js"
```

运行：`npm test`

预期：当前测试全部 PASS。提交：

```bash
git add src/rankings-core.js test/rankings-core.test.js package.json
git commit -m "feat: add rankings normalization core"
```

### Task 2: 建立 D1 榜单历史表并配置 Worker 绑定

**Files:**
- Create: `migrations/0001_rankings.sql`
- Modify: `wrangler.jsonc`
- Modify: `scripts/build.mjs`

- [ ] **Step 1: 写入 D1 migration**

`migrations/0001_rankings.sql` 使用以下结构：

```sql
CREATE TABLE IF NOT EXISTS rank_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id TEXT NOT NULL,
  season_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  captured_bucket INTEGER NOT NULL,
  source TEXT NOT NULL,
  signature TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (season_id, scope, captured_bucket)
);

CREATE TABLE IF NOT EXISTS rank_entries (
  snapshot_id INTEGER NOT NULL REFERENCES rank_snapshots(id) ON DELETE CASCADE,
  board_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, board_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rank_snapshots_season_time
  ON rank_snapshots (season_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_rank_entries_board_snapshot
  ON rank_entries (board_key, snapshot_id, rank);
CREATE INDEX IF NOT EXISTS idx_rank_entries_user_board
  ON rank_entries (user_id, board_key, snapshot_id);
```

- [ ] **Step 2: 创建本地/远程数据库并写入 Wrangler 配置**

运行：

```bash
npx wrangler d1 create hyb-card-rankings-db
```

把命令输出中的真实 `database_id` 原样写入 `wrangler.jsonc`；下面的字段结构用于定位配置位置，不能把说明文字作为值提交：

```json
"d1_databases": [{
  "binding": "RANKINGS_DB",
  "database_name": "hyb-card-rankings-db",
  "database_id": "在上一步命令输出中复制的真实 ID"
}]
```

同时把静态 Assets 配置改为 SPA/Worker 组合：API 先由 Worker 处理，非 API 请求继续交给 `ASSETS.fetch(request)`。

- [ ] **Step 3: 应用 migration 并验证表结构**

运行：

```bash
npx wrangler d1 migrations apply hyb-card-rankings-db --local
npx wrangler d1 execute hyb-card-rankings-db --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

预期：输出 `rank_entries` 和 `rank_snapshots`。

- [ ] **Step 4: 让 build 复制榜单脚本和样式资源**

`scripts/build.mjs` 增加 `rankings.js`、`rankings.css` 和 `userscripts/hyb-card-dashboard-rankings.user.js` 的复制，并在复制前执行 `mkdir(dirname(target), { recursive: true })`。运行 `npm run build` 后，预期存在：

```text
dist/rankings.js
dist/rankings.css
dist/userscripts/hyb-card-dashboard-rankings.user.js
```

- [ ] **Step 5: 提交 D1 和构建配置**

```bash
git add migrations/0001_rankings.sql wrangler.jsonc scripts/build.mjs
git commit -m "feat: configure rankings D1 storage"
```

### Task 3: 实现 Worker 榜单 API

**Files:**
- Create: `src/rankings-worker.js`
- Modify: `src/index.js`
- Create: `test/rankings-worker.test.js`

- [ ] **Step 1: 写 Worker 路由测试用例**

测试至少覆盖：无 D1 绑定返回 503；未知 API 返回 404；`GET /api/rankings/latest` 无数据返回 `snapshot: null`；`POST /api/rankings/snapshots` 缺字段返回 400；同一赛季、scope、小时桶的第二次上传返回 `status: "duplicate"` 且不插入第二个快照。

使用一个内存 fake D1 adapter，暴露与 Worker 相同的 `prepare().bind().first()/all()/run()` 方法，测试不依赖远程 Cloudflare 账户。

- [ ] **Step 2: 实现 `/api/rankings/*` 路由**

在 `src/index.js` 中先判断 API，再回退 Assets：

```js
import { handleRankingsRequest } from './rankings-worker.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/rankings/')) {
      return handleRankingsRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
```

`src/rankings-worker.js` 实现以下接口：

1. `GET /api/rankings/latest`：返回当前赛季、最新 `capturedAt`、是否超过 1 小时、可用榜单键。
2. `GET /api/rankings/leaderboard?board=epic|spend|sets&period=today|week|month|total&limit=100`：读取当前赛季最新快照的对应 `board_period`，附带上一快照中的 `previousValue`、`rankDelta`、`valueDelta`、入榜状态和估算概率所需的 `epic_total`/`spend_total`。
3. `GET /api/rankings/history?userId=...&board=epic|spend|sets`：按抓取时间升序返回用户历史行、排名变化和估算概率字段。
4. `GET /api/rankings/users?query=...`：在当前赛季历史行中按 `user_id` 或 `user_name` 包含匹配，去重后最多 20 人。
5. `GET /api/rankings/events?board=...`：比较相邻快照，返回 `entered`、`left`、排名跃升和数值变化事件。
6. `POST /api/rankings/snapshots`：接受 userscript 回传的完整原始响应，调用 `normalizeLeaderboardSnapshot`；通过 `season_id + scope + captured_bucket` 查询去重；新快照在一个 D1 batch 中插入 snapshot 和全部 entries。

所有 JSON 响应使用 `content-type: application/json; charset=utf-8`；数据库缺失、SQL 失败和参数错误分别返回可读的 `error`/`reason`，不清空旧快照。

- [ ] **Step 3: 加入安全和历史规则**

在 Worker 中固定：每榜最多 100 行、`limit` 最大 100、只接受 `scope=global`、抓取时间未来容忍 10 分钟；头像和装饰字段只作为展示字符串保存；历史行永不删除；查询用户历史时不要求用户仍在最新前 100。

- [ ] **Step 4: 运行 Worker 单元测试**

运行：`node --test test/rankings-worker.test.js`

预期：路由、校验、去重和历史查询测试全部 PASS。

- [ ] **Step 5: 提交 Worker API**

```bash
git add src/index.js src/rankings-worker.js test/rankings-worker.test.js
git commit -m "feat: add rankings worker API"
```

### Task 4: 编写只在 Card Dashboard 页面工作的油猴桥接脚本

**Files:**
- Create: `site/userscripts/hyb-card-dashboard-rankings.user.js`
- Modify: `README.md`

- [ ] **Step 1: 写入脚本元数据和桥接常量**

脚本元数据必须限制为 Card Dashboard：

```js
// @match        https://card.gudong226.com/*
// @grant        GM_xmlhttpRequest
// @connect      cdk.hybgzs.com
```

不得添加 `https://cdk.hybgzs.com/*` 的 `@match`，不得向 CDK 页面注入按钮或 UI。桥接事件使用：

```js
const BRIDGE_READY = 'HYB_CARD_RANKINGS_BRIDGE_READY';
const BRIDGE_REQUEST = 'HYB_CARD_RANKINGS_REQUEST';
const BRIDGE_RESPONSE = 'HYB_CARD_RANKINGS_RESPONSE';
const SOURCE_API = 'https://cdk.hybgzs.com/api/cards/leaderboard?scope=global';
```

- [ ] **Step 2: 实现单次跨域请求和并发去重**

收到当前页面同源 `BRIDGE_REQUEST` 后，用 `GM_xmlhttpRequest` 请求 `SOURCE_API`，`credentials` 保持登录态，解析 JSON 后只回传一次对应 `requestId`。维护一个 `inFlight` Promise，使同一时间多个页面请求共享一次 HTTP 请求；HTTP 401 显示“请先登录 cdk.hybgzs.com”，429 显示“服务器刷新频率限制，请稍后再试”。

- [ ] **Step 3: 发送 READY 并校验消息来源**

脚本只接受 `event.origin === location.origin` 的请求，只向 `location.origin` 回传响应；脚本加载后发送 `BRIDGE_READY`。页面未发起请求时不得定时访问 CDK。

- [ ] **Step 4: 运行语法检查并提交脚本**

运行：`node --check site/userscripts/hyb-card-dashboard-rankings.user.js`

预期：无语法错误。然后提交：

```bash
git add site/userscripts/hyb-card-dashboard-rankings.user.js README.md
git commit -m "feat: add card dashboard rankings bridge"
```

### Task 5: 在同一地址增加榜单统计二级视图

**Files:**
- Modify: `site/index.html`
- Create: `site/rankings.js`
- Create: `site/rankings.css`
- Modify: `scripts/build.mjs`

- [ ] **Step 1: 增加同页视图标记和顶栏入口**

在现有顶栏加入 `button[data-view="rankings"]`，在收益计算主内容外层增加 `#calculatorView`，并新增默认隐藏的 `#rankingsView`。按钮只调用 `setDashboardView('rankings')`，不得修改 `location.pathname`、query 或 hash。

- [ ] **Step 2: 写榜单统计视图结构**

`#rankingsView` 必须包含：当前赛季/数据来源/最后更新时间/刷新状态；欧皇榜、消费榜、兑换榜切换；今日、本周、本月、赛季切换；统计摘要；榜单表格；用户搜索；点击行后的历史详情面板。榜单页显示三组固定映射：

```js
const BOARD_GROUPS = {
  epic: { label: '欧皇榜', prefix: 'epic' },
  spend: { label: '消费榜', prefix: 'spend' },
  sets: { label: '兑换榜', prefix: 'sets' }
};
const PERIODS = ['today', 'week', 'month', 'total'];
```

- [ ] **Step 3: 实现 `site/rankings.js` 数据流程**

实现以下函数：`loadLatestSnapshot()`、`requestBridgeSnapshot()`、`ensureFreshSnapshot()`、`submitSnapshot()`、`loadLeaderboard()`、`searchUsers()`、`loadUserHistory()`、`renderRankingTable()`、`renderUserHistory()`。流程固定为：先读取 D1；无数据或超过 1 小时才发 bridge；bridge 只成功一次后 POST D1；随后重新读取最新数据并渲染。页面显示“估算传说概率”，公式使用：

```js
const estimatedPulls = spendTotal / 10 + elapsedDays * (isVip ? 50 : 30);
const estimatedLegendProbability = epicTotal / estimatedPulls;
```

`estimatedPulls <= 0` 显示 `—`，周期切换只改变榜单键，不重新抓取 CDK。

- [ ] **Step 4: 加入视图切换和脚本安装提示**

首次打开榜单视图时，若没有收到 `BRIDGE_READY`，显示安装链接 `/userscripts/hyb-card-dashboard-rankings.user.js` 和“请先登录 cdk.hybgzs.com”说明；已存在 D1 新鲜数据时不显示阻塞提示。脚本未安装或请求失败时保留旧数据和最后更新时间。

- [ ] **Step 5: 增加样式并完成构建复制**

`site/rankings.css` 复用现有 CSS 变量，桌面端采用榜单优先布局，移动端改为单列；表头 sticky 且背景不透明；当前榜单行、排名上升、排名下降、入榜/出榜使用主题色；头像失败时显示首字母。`scripts/build.mjs` 复制 `rankings.css`、`rankings.js` 和 userscript。

- [ ] **Step 6: 构建并提交前端视图**

运行：`npm run build`

预期：`dist/index.html` 含榜单视图标记，`dist/rankings.js`、`dist/rankings.css` 和 `dist/userscripts/hyb-card-dashboard-rankings.user.js` 均存在。提交：

```bash
git add site/index.html site/rankings.js site/rankings.css scripts/build.mjs
git commit -m "feat: add in-page rankings dashboard"
```

### Task 6: 完善 README、部署说明与数据边界

**Files:**
- Modify: `README.md`
- Create: `docs/rankings-operations.md`

- [ ] **Step 1: 更新 README 使用说明**

README 必须说明：榜单按钮在 `card.gudong226.com` 顶栏；来源页是 `https://cdk.hybgzs.com/entertainment/cards/leaderboard`；安装 `/userscripts/hyb-card-dashboard-rankings.user.js`；只在 Card Dashboard 页面主动获取；CDK 页面不显示按钮；服务器约一小时刷新，D1 按赛季保留；传说概率是估算值，不代表服务器真实概率。

- [ ] **Step 2: 写运维文档**

`docs/rankings-operations.md` 记录：创建 D1、执行 migration、`wrangler.jsonc` 绑定、Worker 本地调试、快照去重策略、查询用户历史、远程 migration 前的备份与验证命令。文档不包含真实用户数据或登录凭据。

- [ ] **Step 3: 做文档和仓库检查**

运行：

```bash
rg -n "hybcdk|cdk\.hybgzs\.com|card\.gudong226\.com|估算传说概率" README.md docs site/userscripts
git diff --check
```

预期：所有来源域名表述一致，未出现把 CDK 页面当作 Card Dashboard 入口的文案。

### Task 7: 完成验证并准备上线（不自动执行生产部署）

**Files:**
- Verify: `dist/index.html`, `dist/rankings.js`, `dist/rankings.css`, `dist/userscripts/hyb-card-dashboard-rankings.user.js`
- Verify: `src/index.js`, `src/rankings-core.js`, `src/rankings-worker.js`, `migrations/0001_rankings.sql`

- [ ] **Step 1: 运行完整自动化检查**

运行：

```bash
npm test
npm run build
node --check src/index.js
node --check src/rankings-core.js
node --check src/rankings-worker.js
node --check site/rankings.js
node --check site/userscripts/hyb-card-dashboard-rankings.user.js
```

预期：测试、构建和所有语法检查均成功。

- [ ] **Step 2: 本地启动 Worker 并验证 API 响应**

运行：`npx wrangler dev --local`

用 `curl` 验证：

```bash
curl -sS http://127.0.0.1:8787/api/rankings/latest
curl -sS 'http://127.0.0.1:8787/api/rankings/leaderboard?board=epic&period=total&limit=5'
```

预期：JSON 响应，不会把 `/api/rankings/*` 错误地返回 `index.html`。

- [ ] **Step 3: 做静态页面验收**

用浏览器打开本地 Worker，确认：地址不变即可在收益计算/榜单统计之间切换；顶部仍保留 Farm 图标、主题切换和 GitHub 图标；榜单按钮只在 Card Dashboard；CDK 来源页不被修改；表格和详情在亮暗主题下均可读。

- [ ] **Step 4: 产出上线清单并等待部署授权**

在最终交付前报告：本地测试结果、D1 migration 状态、需要执行的远程命令和生产部署命令。除非猪猪明确要求，本计划不自动执行远程 D1 写入、`wrangler deploy` 或公开发布。

---

## Plan self-review

- 已覆盖设计稿中的同地址视图、三个榜单、四个周期、D1 赛季历史、小时去重、用户搜索、入榜/出榜、估算概率和仅 Card Dashboard 获取。
- 已明确 `cdk.hybgzs.com` 只作为来源，不添加任何 Card Dashboard 入口。
- 已明确测试命令、构建产物和本地 Worker 验收方式。
- 生产 D1 写入与部署保留到用户明确授权之后。
