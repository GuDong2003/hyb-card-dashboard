# 传说卡收益计算

`card.gudong226.com` 是一个面向 HYB 卡牌赛季的收益计算工具，用于把当前赛季进度、抽卡成本、传说卡产出、星尘操作和兑换奖励曲线放在同一张 90 天现金流模型中核算。

## 功能概览

- 按北京时间凌晨 4 点自动推算当前赛季天数，并为累计抽数提供动态默认值。
- 录入当前卡牌、可用传说卡、已有合成传说和星尘余额，估算可完成的兑换套数。
- 使用页面标注的传说概率、600 抽普通传说保底和传说大保底规则进行产出估算。
- 自动计入每日 20 张史诗卡的融解额度、星尘收入和 VIP 手续费。
- 在星尘足够且每日合成额度允许时，自动按需合成传说卡，并把历史已有的合成传说与本期模拟合成分开显示。
- 按 90 天逐日计算抽卡支出、融解/合成支出、兑换收入、累计现金流、首次回本日、最大资金缺口和最高利润点。
- 支持 SP 兑换加成：每张有效 SP 提高 10%，单次最多计入 3 张；SP 点数可手动设置上限并自动按收益最高的轮次分配。
- 顶栏提供 Farm Dashboard、三态主题切换和 GitHub 仓库入口。
- 增加同地址“榜单统计”视图：按用户合并欧皇榜、消费榜和兑换榜，支持今日、本周、本月和整个赛季周期，并可按出卡率、消费金额、抽卡次数、兑换次数或用户排序。
- 榜单快照按当前赛季写入 Cloudflare D1，服务器约一小时刷新一次；同一小时重复快照自动去重。
- 用户总览表显示排名、用户、VIP、传说卡数量、消费金额、付费抽数、免费抽数、兑换次数、出卡率和数据状态。
- 页面输入会缓存在浏览器本地，刷新后可继续上次的计算快照。

## 页面输入说明

### 动态默认值

- `当前天数`：根据当前时间与赛季起始时间（北京时间凌晨 4 点）自动计算。
- `累计抽数`：默认等于当前天数 × 每日 650 抽。
- `今日剩余融解`：不再要求手动输入，默认按当天自动执行 20 张史诗卡融解。

### 需要手动维护的内容

- 当前持有的普通、稀有、史诗和传说卡数量。
- 当前可用传说数量，以及此前已经通过星尘合成得到的额外传说数量。
- 当前星尘余额。
- SP 点数上限和是否启用 SP 兑换加成。
- 是否启用自动融解与自动合成模型。

工具只按品质总量判断是否满足一套卡组，不展开同品质内的具体卡牌编号；卡组要求和保底细节请以实际赛季页面为准。

## 计算口径

### 抽卡与赛季

- 赛季周期：90 天。
- VIP 每日抽卡额度：50 次免费抽 + 600 次付费抽，共 650 次。
- 付费抽卡按 10 美元/抽折算。
- 传说产出使用页面配置的概率；普通、稀有和史诗卡主要用于满足品质数量及星尘转化模型。

### 兑换奖励

计算器使用当前赛季的分段奖励曲线：

```text
第 1～48 次：R(n) = min(2000 × 1.05^(n-1), 20000)
第 49～54 次：R(n) = 20000
第 55 次以后：R(n) = max(1000, 20000 × 0.975^(n-54))
```

兑换套数按可用传说卡数量与每套 6 张传说卡折算，并同时受完整卡组数量与赛季天数限制。

### 星尘融解与合成

- 每日最多融解 20 张卡牌；当前自动模型按 20 张史诗卡计算，获得 1000 星尘并计入 VIP 手续费 900 美元。
- 每日最多合成 5 张卡牌；合成不额外收取现金手续费。
- 合成成本：普通 40、稀有 100、史诗 400、传说 1600 星尘。
- 可以指定合成目标，但不能合成 SP。
- 自动合成只在星尘余额足够、仍有合成额度且对最终可兑换套数有帮助时执行。

## SP 分配逻辑

SP 卡可以积攒到后期统一使用，日常普通兑换不消耗 SP。点击“一键分配最优”时，计算器会在当前可兑换轮次中优先选择基础奖励更高的轮次，并遵守：

- 手动设置的 SP 点数上限。
- 单轮最多 3 张 SP。
- 已经分配的轮次会使用明显的状态颜色标记。
- 修改 SP 上限后会立即重新计算最优分配，避免只从最后一轮机械扣减。

## 主题与导航

顶栏采用与 HYB Farm Dashboard 一致的单行布局：左侧显示页面标题，右侧固定放置三个操作图标。

- Farm 图标：[HYB Farm Dashboard](https://hyb.gudong226.com/)
- 主题图标：跟随系统 → 暗色 → 亮色 → 跟随系统
- GitHub 图标：[GuDong2003/hyb-card-dashboard](https://github.com/GuDong2003/hyb-card-dashboard)

## 榜单统计

榜单统计入口和主动获取按钮只在 [HYB Card Dashboard](https://card.gudong226.com/) 中显示，地址不会改变，只在收益计算与榜单统计两个视图之间切换。

榜单数据来源为 [CDK 卡牌排行榜](https://cdk.hybgzs.com/entertainment/cards/leaderboard)，对应接口为：

```text
https://cdk.hybgzs.com/api/cards/leaderboard?scope=global
```

### 安装同步脚本

1. 在 Card Dashboard 页面安装 [`hyb-card-dashboard-rankings.user.js`](https://card.gudong226.com/userscripts/hyb-card-dashboard-rankings.user.js)。
2. 登录 `cdk.hybgzs.com`，回到 Card Dashboard 的“榜单统计”视图。
3. 页面没有快照或快照超过 1 小时时，点击“↻ 立即刷新”主动获取一次；新鲜快照不会重复请求 CDK。

榜单页默认关闭“抓取后自动上传”：关闭时只在当前页面显示本次抓到的公开榜单，不会提交 D1；需要共享本次快照时，点击“上传云端”，或在设置中开启自动上传。上传开关只保存在当前浏览器。

油猴脚本匹配 `card.gudong226.com` 和 `cdk.hybgzs.com`。打开 CDK 榜单页时，脚本通过 GM relay 代 Card Dashboard 读取同源接口；如果没有打开 CDK 页面，再回退到 `GM_xmlhttpRequest`。`cdk.hybgzs.com` 页面不会显示榜单按钮、统计视图或 Card Dashboard 入口。

消费榜原始 `value` 会先换算成美元：

```text
spendUsd = spend.value / 500000
```

用户总览表按同一周期、同一 `userId` 合并三类榜单后估算传说概率：

```text
paidPulls = spendUsd / 10

VIP：dailyPaidLimit = 600，dailyFreePulls = 50，minimumSpend = 6000 USD
普通：dailyPaidLimit = 400，dailyFreePulls = 30，minimumSpend = 4000 USD

estimatedDays = ceil(paidPulls / dailyPaidLimit)
freePulls = estimatedDays × dailyFreePulls
estimatedPulls = paidPulls + freePulls
estimatedLegendProbability = epic_period / estimatedPulls
```

只有同一赛季、同一周期、同一 `userId` 且欧皇榜和消费榜在同一有效日期内都有数据，才会计算付费抽数、免费抽数、总抽数和出卡率。消费低于对应最低样本门槛时，页面保留原始消费与传说卡数量，但派生列留空并标记“低样本 / 数据不足”。历史榜单数据不会删除；如果当天没有新抓取，则沿用最近的累计快照，但会标记数据日期。消费金额不是完整日成本倍数时，页面标记“非完整天数 / 估算”。默认显示整个赛季，切换周期后会重新计算并排序。该概率只用于跨用户比较，不能视为服务器标注的真实抽卡概率。
榜单列表以北京时间凌晨 4 点为日界线：同一天内取每个用户、每个榜单的最后一次有效抓取；如果当天没有更新，则沿用最近的累计快照。欧皇榜和消费榜用于派生计算时，取两者最近的共同日期，避免把不同日期的数据直接拼接；页面会在状态中标记“截至某日”的历史数据。

接口中的 `myRank`、`participants`、`cached`、`friendsTruncated` 和名称装饰字段会随原始快照保存在 D1，用于后续审计；当前用户总览不把它们混入核心统计表。`lastUpdatedAt` 会转换为页面顶部的“更新于”时间。

## 项目结构

```text
card-dashboard/
├── site/
│   ├── index.html             # 页面结构、计算交互和本地缓存
│   ├── calculator-ui.css      # 页面布局、主题和响应式样式
│   ├── rankings.css           # 榜单统计视图样式
│   ├── rankings.js            # 榜单视图、D1 API 和油猴桥接交互
│   ├── userscripts/            # Card Dashboard 专用油猴脚本
│   ├── stardust-rules.js      # 星尘、融解和合成规则
│   ├── legend-card-icon.svg   # 传说卡品牌图标
│   └── farm-icon.svg          # Farm 导航图标
├── scripts/build.mjs          # 静态资源构建脚本
├── src/index.js               # Cloudflare Worker 入口
├── src/rankings-core.js        # 榜单规范化、签名、概率和差异计算
├── src/rankings-worker.js      # 榜单 D1 API
├── migrations/0001_rankings.sql # 榜单 D1 表结构
├── test/                       # Node.js 内置测试
├── wrangler.jsonc             # Cloudflare 配置
└── package.json
```

## 本地开发与部署

在 `card-dashboard/` 目录执行：

```bash
npm install
npm test
npm run build
npm run dev
```

`npm run build` 会把 `site/` 下的静态资源复制到 `dist/`。本地预览使用 Wrangler，默认会启动 Cloudflare Worker 开发服务器。

部署到 Cloudflare：

```bash
npm run deploy
```

首次配置榜单 D1 时，在本地应用 migration：

```bash
npx wrangler d1 migrations apply hyb-card-rankings-db --local
npx wrangler d1 execute hyb-card-rankings-db --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

远程 D1 migration 和生产部署需要先确认 `wrangler.jsonc` 中的 D1 数据库绑定，再单独执行；不要把登录凭据或用户榜单原始数据提交到仓库。

部署前请确认 Wrangler 已登录，并在 `wrangler.jsonc` 中配置正确的 Worker 与自定义域名。当前线上地址为 [card.gudong226.com](https://card.gudong226.com/)。

## 缓存与刷新

计算输入会写入浏览器 `localStorage`，因此刷新页面不会恢复成空白默认值。若需要清空旧快照，可在浏览器开发者工具中删除站点存储，或使用无痕窗口重新打开页面。

Cloudflare 或浏览器仍可能缓存静态资源。部署新版本后，如果页面没有立即更新，可使用强制刷新，或给资源 URL 增加查询参数进行验证。

## 注意事项

- 结果是基于当前输入与规则的模型估算，不代表服务器最终结算承诺。
- 概率、保底、奖励曲线、手续费和每日额度发生变化时，应同步更新页面与规则脚本。
- 传说大保底会受到已拥有卡牌与兑换节奏影响；模型按“尚未拥有的新传说”口径估算，实际账号状态应以页面数据为准。
- 交易手续费、具体卡牌编号、SP 获取轮次等未纳入品质总量模型的因素，需要在实际操作时单独确认。

## 社区

感谢 [LINUX DO](https://linux.do) 社区提供的交流与启发。
