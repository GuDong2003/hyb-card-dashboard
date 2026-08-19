# 排行榜带入收益表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在排行榜每一行提供“带入收益表”按钮，仅对数据完整的用户启用，并把榜单数据安全带入收益表。

**Architecture:** 使用独立的 `site/calculator-import.js` 作为排行榜与收益表之间的共享数据协议。排行榜负责校验行数据、生成 URL 参数并触发导入；收益表负责读取 URL 参数、覆盖输入缓存并立即计算。缺失传说数量、估算抽数或估算天数时按钮禁用；兑换套数缺失使用 0，星尘固定使用 0。

**Tech Stack:** 原生 JavaScript、静态 HTML/CSS、Node.js 内置 `node:test`、Wrangler 静态构建。

---

### Task 1: 定义并测试排行榜导入协议

**Files:**
- Create: `site/calculator-import.js`
- Test: `test/calculator-import.test.js`

- [x] **Step 1: 写失败测试**

测试完整行可以生成导入数据；缺少传说数量、累计抽数或估算天数时拒绝；兑换套数缺失默认为 0、星尘为 0；URL 参数可往返解析。

- [x] **Step 2: 运行测试确认失败**

运行 `node --test test/calculator-import.test.js`，预期因共享协议文件尚不存在而失败。

- [x] **Step 3: 实现最小协议**

导出到 `window.HYBCardCalculatorImport`：`canImportRow`、`buildImportData`、`buildQuery`、`readQuery`。所有数值必须是非负整数，天数限制在 1～90；不完整数据返回 `null`。

- [x] **Step 4: 运行测试确认通过**

运行 `node --test test/calculator-import.test.js`，预期全部通过。

### Task 2: 收益表读取导入参数

**Files:**
- Modify: `site/index.html`
- Modify: `scripts/build.mjs`

- [x] **Step 1: 写页面结构断言**

确认收益表加载共享脚本，并存在全局导入应用函数。

- [x] **Step 2: 实现导入应用**

在 `restoreSnapshot()` 后读取 `window.location.search`；成功读取时覆盖 `currentDay`、`currentTotalDraws`、`currentCards`、`currentUsableCards`、`redeemedSets`、`stardustBalance`，保存缓存并执行 `calculate(false, false)`。提供 `window.applyCalculatorImport` 供排行榜按钮调用，并通过 `history.pushState` 更新地址栏。

- [x] **Step 3: 保持原有手动输入行为**

没有有效导入参数时继续使用原有缓存和动态默认值；用户仍可手动修改所有输入。

### Task 3: 排行榜行按钮和禁用状态

**Files:**
- Modify: `site/index.html`
- Modify: `site/rankings.js`
- Modify: `site/rankings.css`
- Modify: `test/rankings-view.test.js`

- [x] **Step 1: 扩展表格列**

新增“收益表”操作列，将空行 `colspan` 从 11 改为 12。

- [x] **Step 2: 渲染按钮**

使用共享协议生成导入数据；完整时渲染可点击按钮，不完整时渲染 `disabled` 按钮并提供“数据不完整，无法带入”提示。

- [x] **Step 3: 绑定点击事件**

点击按钮阻止事件冒泡，调用 `window.applyCalculatorImport`，切换到收益表并立即刷新计算。

- [x] **Step 4: 添加样式**

为操作列和按钮增加紧凑、可见、可聚焦样式；禁用状态保持明确的灰色提示。

### Task 4: 完整验证

**Files:**
- No new files.

- [x] **Step 1: 运行全量测试**

运行 `npm test`，确认没有回归。

- [x] **Step 2: 构建静态产物**

运行 `npm run build`，确认 `dist/calculator-import.js`、更新后的 `dist/index.html`、`dist/rankings.js` 和 CSS 均生成。

- [x] **Step 3: 检查差异**

运行 `git diff --check` 和 `git status --short`，确认只包含本功能相关修改。

### Task 5: 排行榜导入撤销

**Files:**
- Modify: `site/calculator-import.js`
- Modify: `site/index.html`
- Modify: `site/calculator-ui.css`
- Modify: `site/rankings.js`
- Test: `test/calculator-import.test.js`

- [x] **Step 1: 写撤销快照测试**

验证快照保存被覆盖字段、原始查询和本次导入查询；缺少字段的快照不能恢复。

- [x] **Step 2: 实现快照协议**

在共享协议中增加 `captureUndoState` 与 `readUndoState`，用于校验单级撤销数据。

- [x] **Step 3: 接入导入流程**

排行榜按钮触发导入前保存当前输入值和 URL；按钮导入后将撤销状态写入 `sessionStorage`，收益表初始化时仅在当前 URL 匹配导入目标时显示撤销按钮。

- [x] **Step 4: 增加标题右侧按钮**

在“预测基准”标题行右侧显示 `↶ 撤销带入`，恢复输入、缓存、计算结果和原始 URL 后隐藏按钮；使用响应式样式，不占用页面布局空间。

### Task 6: 顶部收益摘要顺序与套数

**Files:**
- Create: `site/profit-metrics.js`
- Modify: `scripts/build.mjs`
- Modify: `site/index.html`
- Test: `test/profit-metrics.test.js`

- [x] **Step 1: 写指标格式化和顺序测试**

验证金额指标可格式化为“第 X 天 · 第 Y 套 · 金额”，并检查六张摘要卡按用户指定顺序排列。

- [x] **Step 2: 实现格式化与页面更新**

将最终利润、最大资金缺口、最高利润点分别关联到最后一行、最低利润行、最高利润行的累计套数；只调整摘要显示，不改变现金流计算。

- [x] **Step 3: 全量验证并部署**

运行测试、构建和线上页面检查后部署到 `card.gudong226.com`。

### Task 7: 摘要卡跳转演算行

**Files:**
- Modify: `site/profit-metrics.js`
- Modify: `site/index.html`
- Modify: `site/calculator-ui.css`
- Test: `test/profit-metrics.test.js`

- [ ] **Step 1: 写摘要卡映射测试**

验证累计类卡片指向最后一天，回本/亏损/最高利润卡片指向各自日期，无回本日时返回空值。

- [ ] **Step 2: 实现点击跳转与高亮**

给摘要卡增加目标标记和键盘操作；给现金流表行增加天数标记；点击后平滑滚动并临时高亮对应行。

- [ ] **Step 3: 全量验证并部署**

运行全量测试、构建和线上页面核对，然后部署到 `card.gudong226.com`。
