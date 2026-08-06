(function () {
    'use strict';

    const BRIDGE_READY = 'HYB_CARD_RANKINGS_BRIDGE_READY';
    const BRIDGE_REQUEST = 'HYB_CARD_RANKINGS_REQUEST';
    const BRIDGE_RESPONSE = 'HYB_CARD_RANKINGS_RESPONSE';
    const BRIDGE_TIMEOUT_MS = 22000;
    const HOURLY_REFRESH_MS = 60 * 60 * 1000;
    const SETTINGS_STORAGE_KEY = 'hyb-card-rankings-settings-v1';
    const PINS_STORAGE_KEY = 'hyb-card-rankings-pins-v1';
    const SPEND_VALUE_PER_USD = 500000;
    const VIP_DAILY_SPEND_USD = 6000;
    const VIP_DAILY_PULLS = 650;
    const ORDINARY_DAILY_SPEND_USD = 4000;
    const ORDINARY_DAILY_PULLS = 430;
    const LOCAL_SOURCE_SCOPES = Object.freeze(['global', 'friends']);
    const LOCAL_SOURCE_SCOPE_CONFIG = Object.freeze({ scope: 'global,friends', order: LOCAL_SOURCE_SCOPES });

    const BOARD_LABELS = Object.freeze({ epic: '欧皇榜', spend: '消费榜', sets: '兑换榜', luck: '运气榜' });

    function loadSettings() {
        try {
            const stored = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}') || {};
            return {
                autoUpload: stored.autoUpload === true,
                hourlyRefresh: stored.hourlyRefresh === true
            };
        } catch (_) {
            return { autoUpload: false, hourlyRefresh: false };
        }
    }

    function saveSettings(settings) {
        try {
            window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
                autoUpload: settings.autoUpload === true,
                hourlyRefresh: settings.hourlyRefresh === true
            }));
        } catch (_) {
            // Private browsing or storage restrictions must not block rankings viewing.
        }
    }

    function pinSeasonKey(seasonId) {
        return String(seasonId || 'default').trim() || 'default';
    }

    function loadPinnedUsers(seasonId) {
        try {
            const stored = JSON.parse(window.localStorage.getItem(PINS_STORAGE_KEY) || '{}') || {};
            const values = stored[pinSeasonKey(seasonId)];
            return new Set(Array.isArray(values)
                ? values.map((value) => String(value || '').trim()).filter(Boolean)
                : []);
        } catch (_) {
            return new Set();
        }
    }

    function savePinnedUsers(seasonId, userIds) {
        try {
            const stored = JSON.parse(window.localStorage.getItem(PINS_STORAGE_KEY) || '{}') || {};
            stored[pinSeasonKey(seasonId)] = Array.from(userIds || [])
                .map((value) => String(value || '').trim())
                .filter(Boolean);
            window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(stored));
        } catch (_) {
            // Private browsing or storage restrictions must not block rankings viewing.
        }
    }

    const state = {
        view: 'calculator',
        board: 'users',
        period: 'total',
        sort: 'legend',
        sortDirection: 'desc',
        settings: loadSettings(),
        latest: null,
        seasonId: '',
        pinnedSeasonId: '',
        pinnedUserIds: new Set(),
        localSnapshots: [],
        loaded: false,
        busy: false,
        bridgeReady: false,
        bridgeRequest: null,
        hourlyRefreshTimer: null,
        rows: [],
        partialRows: [],
        userQuery: '',
        status: '等待榜单数据',
        trend: {
            mode: 'daily',
            period: 'total',
            metric: 'epicTotal',
            selectedIds: [],
            histories: new Map(),
            busy: false
        }
    };

    const $ = (selector) => document.querySelector(selector);

    function apiUrl(path) {
        return new URL(path, window.location.origin).href;
    }

    async function apiGet(path) {
        const response = await fetch(apiUrl(path), {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' }
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
        return body;
    }

    async function apiPost(path, payload) {
        const response = await fetch(apiUrl(path), {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || body.reason || body.error || `HTTP ${response.status}`);
        return body;
    }

    function setStatus(message, isError = false, isBusy = false) {
        state.status = message;
        const element = $('#rankingsStatus');
        if (!element) return;
        element.textContent = message;
        const errorState = Boolean(isError);
        const busyState = Boolean(isBusy && !errorState);
        element.classList.toggle('is-error', errorState);
        element.classList.toggle('is-busy', busyState);
        element.dataset.state = errorState ? 'error' : busyState ? 'busy' : 'success';
    }

    function setBusy(busy) {
        state.busy = Boolean(busy);
        const button = $('#rankingsRefreshButton');
        if (button) {
            button.disabled = state.busy;
            button.textContent = state.busy ? '↻ 同步中…' : '↻ 立即刷新';
        }
        renderUploadControls();
    }

    function renderUploadControls() {
        const hourlyToggle = $('#rankingsHourlyRefresh');
        if (hourlyToggle) hourlyToggle.checked = state.settings.hourlyRefresh === true;
        const toggle = $('#rankingsAutoUpload');
        if (toggle) toggle.checked = state.settings.autoUpload === true;
        const uploadButton = $('#rankingsUploadButton');
        if (uploadButton) {
            uploadButton.disabled = state.busy || !state.localSnapshots.length;
            uploadButton.textContent = '上传云端';
        }
        const localStatus = $('#rankingsUploadStatus');
        if (localStatus) {
            localStatus.textContent = state.localSnapshots.length
                ? (state.settings.autoUpload ? '自动上传已开启' : '本次抓取仅保存在当前页面')
                : '尚无待上传的本地快照';
        }
    }

    function formatNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.round(number).toLocaleString('zh-CN') : '—';
    }

    function formatDecimal(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
    }

    function formatUsd(value) {
        const number = Number(value);
        return Number.isFinite(number)
            ? `$${number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : '—';
    }

    function formatProbability(value) {
        const number = Number(value);
        return Number.isFinite(number) ? `${(number * 100).toFixed(3)}%` : '—';
    }

    function formatDate(value) {
        const time = Number(value);
        if (!Number.isFinite(time) || time <= 0) return '—';
        return new Date(time).toLocaleString('zh-CN', { hour12: false });
    }

    const TREND_METRICS = Object.freeze({
        epicTotal: '传说卡数量',
        spendUsd: '消费金额',
        estimatedPulls: '抽卡次数',
        exchangeCount: '兑换次数',
        estimatedLegendProbability: '出卡率'
    });
    const TREND_PERIODS = Object.freeze({
        total: '整个赛季',
        today: '今日',
        week: '本周',
        month: '本月'
    });
    const TREND_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'];

    function trendNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : null;
    }

    function getTrendDayKey(capturedAt) {
        const timestamp = Number(capturedAt);
        if (!Number.isFinite(timestamp)) return '';
        const shifted = new Date(timestamp - (4 * 60 * 60 * 1000));
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(shifted);
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    function finalizeTrendPoint(point) {
        const estimate = estimateFromSpend(point.spendValue, point.isVip);
        return {
            ...point,
            spendUsd: estimate.spendUsd,
            estimatedPulls: estimate.estimatedPulls,
            estimatedLegendProbability: point.epicTotal != null
                ? estimatedProbability(point.epicTotal, point.spendValue, point.isVip)
                : null
        };
    }

    function trendSnapshotPoints(rows = [], period = state.trend.period) {
        period = normalizeTrendPeriod(period);
        const snapshots = new Map();
        rows.forEach((row) => {
            const boardKey = String(row && row.boardKey || '');
            if (!boardKey.endsWith(`_${period}`)) return;
            const capturedAt = normalizeCapturedAt(row && row.capturedAt, null);
            if (!capturedAt) return;
            const point = snapshots.get(capturedAt) || {
                capturedAt,
                dayKey: getTrendDayKey(capturedAt),
                epicTotal: null,
                spendValue: null,
                exchangeCount: null,
                isVip: false
            };
            point.isVip = point.isVip || Boolean(row && row.isVip);
            const value = trendNumber(row && row.value);
            if (boardKey === 'epic_total') point.epicTotal = value;
            if (boardKey === 'spend_total') point.spendValue = value;
            if (boardKey === 'sets_total') point.exchangeCount = value;
            snapshots.set(capturedAt, point);
        });
        return Array.from(snapshots.values())
            .sort((left, right) => left.capturedAt - right.capturedAt)
            .map(finalizeTrendPoint);
    }

    function aggregateTrendRows(rows = [], mode = 'daily', period = state.trend.period) {
        const snapshots = trendSnapshotPoints(rows, period);
        if (mode !== 'daily') return snapshots;

        const days = new Map();
        snapshots.forEach((point) => {
            const dayKey = point.dayKey || getTrendDayKey(point.capturedAt);
            if (!dayKey) return;
            const current = days.get(dayKey) || {
                capturedAt: 0,
                dayKey,
                epicTotal: null,
                spendValue: null,
                exchangeCount: null,
                isVip: false
            };
            current.capturedAt = Math.max(current.capturedAt, point.capturedAt);
            current.isVip = current.isVip || point.isVip;
            ['epicTotal', 'spendValue', 'exchangeCount'].forEach((field) => {
                if (point[field] == null) return;
                if (current[field] == null || point[field] > current[field]) current[field] = point[field];
            });
            days.set(dayKey, current);
        });
        return Array.from(days.values())
            .sort((left, right) => left.capturedAt - right.capturedAt)
            .map(finalizeTrendPoint);
    }

    function trendMetricValue(point, metric = state.trend.metric) {
        const value = point && point[metric];
        return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    }

    function formatTrendValue(value, metric = state.trend.metric) {
        if (value == null || !Number.isFinite(Number(value))) return '';
        if (metric === 'spendUsd') return formatUsd(Number(value));
        if (metric === 'estimatedLegendProbability') return formatProbability(Number(value));
        return formatDecimal(Number(value));
    }

    function niceTrendStep(rawStep, integerOnly = false) {
        const value = Number(rawStep);
        if (!Number.isFinite(value) || value <= 0) return 1;
        const exponent = Math.floor(Math.log10(value));
        const magnitude = 10 ** exponent;
        const fraction = value / magnitude;
        const candidates = integerOnly ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
        const niceFraction = candidates.find((candidate) => fraction <= candidate) || 10;
        return niceFraction * magnitude;
    }

    function nextNiceTrendStep(step, integerOnly = false) {
        const value = Number(step);
        if (!Number.isFinite(value) || value <= 0) return 1;
        const exponent = Math.floor(Math.log10(value));
        const magnitude = 10 ** exponent;
        const fraction = value / magnitude;
        const candidates = integerOnly ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
        const nextFraction = candidates.find((candidate) => candidate > fraction + 1e-10);
        return nextFraction ? nextFraction * magnitude : 20 * magnitude;
    }

    function niceTrendAxis(minValue, maxValue, tickCount, integerOnly = false) {
        const count = Math.max(2, Math.floor(Number(tickCount)) || 5);
        const intervals = count - 1;
        const minimum = Number(minValue);
        const maximum = Number(maxValue);
        const range = Math.max(Number.EPSILON, maximum - minimum);
        const minimumStep = integerOnly ? 1 : 0.00001;
        let step = Math.max(minimumStep, niceTrendStep(range / intervals, integerOnly));

        for (let attempt = 0; attempt < 12; attempt += 1) {
            const axisMin = Math.floor((minimum + step * 1e-10) / step) * step;
            const axisMax = axisMin + intervals * step;
            if (axisMax + step * 1e-9 >= maximum) {
                const values = Array.from({ length: count }, (_, index) => axisMax - index * step)
                    .map((value) => Math.abs(value) < step * 1e-9 ? 0 : value);
                return { min: axisMin, max: axisMax, step, values };
            }
            step = nextNiceTrendStep(step, integerOnly);
        }

        const axisMin = Math.floor(minimum / step) * step;
        const axisMax = axisMin + intervals * step;
        return {
            min: axisMin,
            max: axisMax,
            step,
            values: Array.from({ length: count }, (_, index) => axisMax - index * step)
        };
    }

    function trendAxisPrecision(values, step, metric = state.trend.metric) {
        if (metric !== 'estimatedLegendProbability') return 0;
        const numericStep = Math.abs(Number(step));
        for (let digits = 0; digits <= 5; digits += 1) {
            const labels = values.map((value) => Number(value).toFixed(digits));
            const scaledStep = numericStep * (10 ** digits);
            const stepIsExact = Math.abs(scaledStep - Math.round(scaledStep)) <= Math.max(1, scaledStep) * 1e-9;
            if (stepIsExact && new Set(labels).size === labels.length) return digits;
        }
        return 3;
    }

    function trendAxisValue(value, metric = state.trend.metric) {
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        return metric === 'estimatedLegendProbability' ? number * 100 : number;
    }

    function formatTrendAxisValue(value, metric, precision) {
        metric = metric || state.trend.metric;
        precision = Number.isFinite(Number(precision)) ? Number(precision) : 0;
        const number = Number(value);
        if (!Number.isFinite(number)) return '';
        if (metric === 'estimatedLegendProbability') {
            const digits = Math.max(0, Math.min(5, Number.parseInt(precision, 10) || 0));
            return `${number.toFixed(digits)}%`;
        }
        const rounded = Math.round(number);
        if (metric === 'spendUsd') return `$${rounded.toLocaleString('en-US')}`;
        return rounded.toLocaleString('zh-CN');
    }

    function formatTrendAxisLabel(value, mode) {
        if (mode === 'daily') {
            const date = new Date(`${value}T00:00:00+08:00`);
            return Number.isNaN(date.getTime())
                ? value
                : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
        }
        return formatDate(value).replace(/:\d{2}(?=$|\s)/, '');
    }

    function trendPointKey(point, mode) {
        return mode === 'daily' ? point.dayKey : String(point.capturedAt);
    }

    function normalizeTrendPeriod(value) {
        return Object.prototype.hasOwnProperty.call(TREND_PERIODS, value) ? value : 'total';
    }

    function renderTrendPeriodControl() {
        const select = $('#rankingsTrendPeriodSelect');
        if (select) select.value = normalizeTrendPeriod(state.trend.period);
    }

    function syncTrendPeriodFromOuter() {
        state.trend.period = state.period;
        renderTrendPeriodControl();
        renderTrendChart();
    }

    function renderTrendUserOptions() {
        const list = $('#rankingsTrendUserOptions');
        if (!list) return;
        const rows = Array.from(new Map(state.rows
            .filter((row) => row && row.userId)
            .map((row) => [row.userId, row])).values());
        list.innerHTML = rows.map((row) => `<option value="${escapeHtml(row.userName || row.userId)}">${escapeHtml(row.userId)}</option>`).join('');
    }

    function trendUserRecord(userId) {
        const row = state.rows.find((item) => item.userId === userId);
        const history = state.trend.histories.get(userId);
        return history || {
            userId,
            userName: row && row.userName || userId,
            rows: []
        };
    }

    function renderTrendSelection() {
        const container = $('#rankingsTrendSelected');
        if (!container) return;
        container.innerHTML = state.trend.selectedIds.map((userId, index) => {
            const record = trendUserRecord(userId);
            const color = TREND_COLORS[index % TREND_COLORS.length];
            return `<span class="rankings-trend-chip" style="--trend-color:${color}">
                <i aria-hidden="true"></i><span>${escapeHtml(record.userName || userId)}</span>
                <button type="button" data-trend-remove="${escapeHtml(userId)}" aria-label="移除 ${escapeHtml(record.userName || userId)}">×</button>
            </span>`;
        }).join('');
        container.querySelectorAll('[data-trend-remove]').forEach((button) => {
            button.addEventListener('click', () => removeTrendUser(button.dataset.trendRemove));
        });
    }

    function renderTrendLegend(series) {
        const legend = $('#rankingsTrendLegend');
        if (!legend) return;
        legend.innerHTML = series.map((item) => `<span class="rankings-trend-legend-item">
            <i style="--trend-color:${item.color}" aria-hidden="true"></i>${escapeHtml(item.name)}
        </span>`).join('');
    }

    function renderTrendModeButtons() {
        document.querySelectorAll('[data-trend-mode]').forEach((button) => {
            const active = button.dataset.trendMode === state.trend.mode;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    function renderTrendChart() {
        const svg = $('#rankingsTrendChart');
        const empty = $('#rankingsTrendEmpty');
        if (!svg || !empty) return;
        const series = state.trend.selectedIds.map((userId, index) => {
            const record = trendUserRecord(userId);
            return {
                userId,
                name: record.userName || userId,
                color: TREND_COLORS[index % TREND_COLORS.length],
                points: aggregateTrendRows(record.rows, state.trend.mode, state.trend.period)
            };
        });
        renderTrendLegend(series);
        const hasData = series.some((item) => item.points.some((point) => trendMetricValue(point) != null));
        if (!hasData) {
            svg.innerHTML = '';
            empty.textContent = state.trend.busy
                ? '正在读取用户趋势…'
                : state.trend.selectedIds.length ? '暂无可用趋势数据' : '添加用户后显示趋势曲线';
            empty.classList.remove('is-hidden');
            return;
        }
        empty.classList.add('is-hidden');

        const labels = new Map();
        series.forEach((item) => item.points.forEach((point) => {
            const key = trendPointKey(point, state.trend.mode);
            if (key) labels.set(key, point);
        }));
        const labelKeys = Array.from(labels.keys()).sort((left, right) => state.trend.mode === 'daily'
            ? left.localeCompare(right)
            : Number(left) - Number(right));
        const width = 960;
        const height = 360;
        const padding = { top: 24, right: 24, bottom: 48, left: 74 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const values = series.flatMap((item) => item.points
            .map((point) => trendMetricValue(point))
            .filter((value) => value != null));
        const axisValues = values.map((value) => trendAxisValue(value)).filter((value) => value != null);
        let minAxisValue = Math.min(...axisValues);
        let maxAxisValue = Math.max(...axisValues);
        if (minAxisValue === maxAxisValue) {
            const equalRangePad = Math.max(Math.abs(maxAxisValue) * 0.1, state.trend.metric === 'estimatedLegendProbability' ? 0.1 : 1);
            minAxisValue = Math.max(0, minAxisValue - equalRangePad);
            maxAxisValue += equalRangePad;
        }
        const axisPadding = (maxAxisValue - minAxisValue) * 0.12;
        minAxisValue = Math.max(0, minAxisValue - axisPadding);
        maxAxisValue += axisPadding;
        const integerAxis = state.trend.metric !== 'estimatedLegendProbability';
        const yAxis = niceTrendAxis(minAxisValue, maxAxisValue, 5, integerAxis);
        const axisMinValue = yAxis.min;
        const axisMaxValue = yAxis.max;
        const axisRange = Math.max(Number.EPSILON, axisMaxValue - axisMinValue);
        const yTickPrecision = trendAxisPrecision(yAxis.values, yAxis.step);
        const xFor = (index) => labelKeys.length <= 1
            ? padding.left + chartWidth / 2
            : padding.left + (index / (labelKeys.length - 1)) * chartWidth;
        const yForAxis = (value) => padding.top + chartHeight - ((value - axisMinValue) / axisRange) * chartHeight;
        const yFor = (value) => yForAxis(trendAxisValue(value));
        const grid = [];
        yAxis.values.forEach((value) => {
            const y = yForAxis(value);
            grid.push(`<line x1="${padding.left}" y1="${y.toFixed(2)}" x2="${width - padding.right}" y2="${y.toFixed(2)}" class="trend-grid-line"/>`);
            grid.push(`<text x="${padding.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end" class="trend-axis-label">${escapeHtml(formatTrendAxisValue(value, state.trend.metric, yTickPrecision))}</text>`);
        });
        const labelStep = labelKeys.length <= 7 ? 1 : Math.ceil(labelKeys.length / 6);
        labelKeys.forEach((key, index) => {
            if (index !== 0 && index !== labelKeys.length - 1 && index % labelStep !== 0) return;
            const x = xFor(index);
            grid.push(`<text x="${x.toFixed(2)}" y="${height - 16}" text-anchor="middle" class="trend-axis-label">${escapeHtml(formatTrendAxisLabel(key, state.trend.mode))}</text>`);
        });

        const lines = [];
        series.forEach((item) => {
            const byKey = new Map(item.points.map((point) => [trendPointKey(point, state.trend.mode), point]));
            let segment = [];
            const flush = () => {
                if (segment.length >= 2) lines.push(`<polyline points="${segment.join(' ')}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);
                segment = [];
            };
            labelKeys.forEach((key, index) => {
                const value = trendMetricValue(byKey.get(key));
                if (value == null) {
                    flush();
                    return;
                }
                segment.push(`${xFor(index).toFixed(2)},${yFor(value).toFixed(2)}`);
            });
            flush();
            item.points.forEach((point) => {
                const value = trendMetricValue(point);
                if (value == null) return;
                const index = labelKeys.indexOf(trendPointKey(point, state.trend.mode));
                if (index < 0) return;
                const pointLabel = `${item.name} · ${formatTrendAxisLabel(trendPointKey(point, state.trend.mode), state.trend.mode)} · ${TREND_METRICS[state.trend.metric]}：${formatTrendValue(value, state.trend.metric)}`;
                const pointX = xFor(index);
                const pointY = yFor(value);
                const tooltipWidth = Math.min(340, Math.max(180, pointLabel.length * 7 + 24));
                const tooltipX = Math.min(width - padding.right - tooltipWidth, Math.max(padding.left, pointX - tooltipWidth / 2));
                const tooltipY = Math.max(4, pointY - 42);
                lines.push(`<g class="trend-point-wrap" tabindex="0" role="img" aria-label="${escapeHtml(pointLabel)}">
                    <circle cx="${pointX.toFixed(2)}" cy="${pointY.toFixed(2)}" r="12" class="trend-point-hit" fill="transparent" aria-hidden="true"/>
                    <circle cx="${pointX.toFixed(2)}" cy="${pointY.toFixed(2)}" r="5" fill="${item.color}" class="trend-point" aria-hidden="true"><title>${escapeHtml(pointLabel)}</title></circle>
                    <g class="trend-point-tooltip" transform="translate(${tooltipX.toFixed(2)} ${tooltipY.toFixed(2)})" aria-hidden="true">
                        <rect width="${tooltipWidth.toFixed(2)}" height="32" rx="6"/>
                        <text x="12" y="20">${escapeHtml(pointLabel)}</text>
                    </g>
                </g>`);
            });
        });
        svg.innerHTML = `${grid.join('')}${lines.join('')}`;
    }

    function resolveTrendUser(query) {
        const normalized = String(query || '').trim().toLowerCase();
        if (!normalized) return null;
        const exact = state.rows.find((row) => String(row.userId).toLowerCase() === normalized || String(row.userName).toLowerCase() === normalized);
        const matched = exact || state.rows.find((row) => String(row.userId).toLowerCase().includes(normalized) || String(row.userName).toLowerCase().includes(normalized));
        return matched
            ? { userId: matched.userId, userName: matched.userName || matched.userId }
            : { userId: String(query).trim(), userName: String(query).trim() };
    }

    function selectTrendUser(userId, userName = '') {
        const normalizedId = String(userId || '').trim();
        if (!normalizedId || state.trend.selectedIds.includes(normalizedId)) return false;
        const row = state.rows.find((item) => item.userId === normalizedId);
        state.trend.selectedIds.push(normalizedId);
        state.trend.histories.set(normalizedId, {
            userId: normalizedId,
            userName: userName || row?.userName || normalizedId,
            rows: []
        });
        return true;
    }

    function openTrendModal(userId) {
        const row = state.rows.find((item) => item.userId === userId);
        selectTrendUser(userId, row?.userName || userId);
        const backdrop = $('#rankingsTrendBackdrop');
        if (backdrop) backdrop.classList.remove('is-hidden');
        document.body.classList.add('modal-open');
        renderTrendSelection();
        renderTrendChart();
        refreshTrendHistories();
    }

    function closeTrendModal() {
        const backdrop = $('#rankingsTrendBackdrop');
        if (backdrop) backdrop.classList.add('is-hidden');
        document.body.classList.remove('modal-open');
    }

    async function refreshTrendHistories() {
        if (!state.trend.selectedIds.length) {
            state.trend.busy = false;
            renderTrendChart();
            return;
        }
        state.trend.busy = true;
        renderTrendChart();
        const results = await Promise.allSettled(state.trend.selectedIds.map(async (userId) => {
            const payload = await apiGet(`/api/rankings/history?userId=${encodeURIComponent(userId)}`);
            return {
                userId,
                userName: state.rows.find((row) => row.userId === userId)?.userName || payload.userName || userId,
                rows: Array.isArray(payload.rows) ? payload.rows : []
            };
        }));
        results.forEach((result, index) => {
            const userId = state.trend.selectedIds[index];
            if (result.status === 'fulfilled' && state.trend.selectedIds.includes(userId)) {
                state.trend.histories.set(userId, result.value);
            }
        });
        state.trend.busy = false;
        renderTrendSelection();
        renderTrendChart();
    }

    function addTrendUser() {
        const input = $('#rankingsTrendUserSearch');
        const user = resolveTrendUser(input && input.value);
        if (!user || !selectTrendUser(user.userId, user.userName)) return;
        if (input) input.value = '';
        renderTrendSelection();
        renderTrendChart();
        refreshTrendHistories();
    }

    function removeTrendUser(userId) {
        state.trend.selectedIds = state.trend.selectedIds.filter((id) => id !== userId);
        state.trend.histories.delete(userId);
        renderTrendSelection();
        renderTrendChart();
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[character]));
    }

    function initials(value) {
        const text = String(value || '?').trim();
        return escapeHtml(text.slice(0, 1).toUpperCase());
    }

    function snapshotSource(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return null;
        if (snapshot.data && snapshot.data.leaderboards) return snapshot.data;
        return snapshot;
    }

    function normalizeCapturedAt(value, fallback = Date.now()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
        if (value != null && value !== '') {
            const parsed = Date.parse(String(value));
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        const fallbackNumeric = Number(fallback);
        return Number.isFinite(fallbackNumeric) && fallbackNumeric > 0
            ? Math.floor(fallbackNumeric)
            : null;
    }

    function normalizeSnapshotForUpload(snapshot) {
        const source = snapshotSource(snapshot);
        if (!source || typeof source !== 'object') return snapshot;
        return {
            ...source,
            capturedAt: normalizeCapturedAt(source.capturedAt, null)
                || normalizeCapturedAt(source.lastUpdatedAt, null)
                || Date.now()
        };
    }

    function normalizeSnapshotsForUpload(payload) {
        const candidates = Array.isArray(payload)
            ? payload
            : Array.isArray(payload && payload.snapshots)
                ? payload.snapshots
                : payload && payload.snapshot
                    ? [payload.snapshot]
                    : [payload];
        return candidates
            .filter((snapshot) => snapshot && typeof snapshot === 'object')
            .map((snapshot) => normalizeSnapshotForUpload(snapshot))
            .filter((snapshot) => {
                const source = snapshotSource(snapshot);
                return Boolean(source && source.leaderboards && typeof source.leaderboards === 'object');
            });
    }

    function mergeLocalSnapshots(snapshots = []) {
        const normalizedSnapshots = normalizeSnapshotsForUpload(snapshots);
        const boardRows = new Map();
        const scopes = new Set();
        let latestSnapshot = null;

        const preferIncoming = (existing, incoming, boardKey, capturedAt) => {
            if (!existing) return true;
            const existingCapturedAt = normalizeCapturedAt(existing.__capturedAt, 0) || 0;
            const incomingValue = rowValue(incoming);
            const existingValue = rowValue(existing);
            if (String(boardKey).endsWith('_total')) {
                return incomingValue != null && (existingValue == null
                    || incomingValue > existingValue
                    || (incomingValue === existingValue && capturedAt >= existingCapturedAt));
            }
            return capturedAt > existingCapturedAt
                || (capturedAt === existingCapturedAt
                    && incomingValue != null
                    && (existingValue == null || incomingValue >= existingValue));
        };

        normalizedSnapshots.forEach((snapshot, snapshotIndex) => {
            const source = snapshotSource(snapshot);
            if (!source) return;
            const capturedAt = normalizeCapturedAt(source.capturedAt, null) || Date.now();
            const scope = String(source.scope || '').trim();
            if (scope) scopes.add(scope);
            if (!latestSnapshot || capturedAt >= latestSnapshot.capturedAt) {
                latestSnapshot = {
                    source,
                    capturedAt,
                    snapshotIndex
                };
            }
            Object.entries(source.leaderboards || {}).forEach(([boardKey, rows]) => {
                if (!Array.isArray(rows)) return;
                const byUser = boardRows.get(boardKey) || new Map();
                rows.forEach((rawRow) => {
                    const userId = rowUserId(rawRow);
                    if (!userId) return;
                    const current = byUser.get(userId);
                    const incoming = {
                        ...rawRow,
                        userId,
                        userName: rowName(rawRow, userId),
                        avatar: rowAvatar(rawRow),
                        isVip: rowIsVip(rawRow),
                        __capturedAt: capturedAt,
                        __scope: scope
                    };
                    if (!current) {
                        byUser.set(userId, incoming);
                        return;
                    }
                    const useIncomingValue = preferIncoming(current, incoming, boardKey, capturedAt);
                    const latestProfile = capturedAt >= (normalizeCapturedAt(current.__capturedAt, 0) || 0);
                    byUser.set(userId, {
                        ...(useIncomingValue ? incoming : current),
                        userName: latestProfile && incoming.userName ? incoming.userName : current.userName || incoming.userName,
                        avatar: latestProfile && incoming.avatar ? incoming.avatar : current.avatar || incoming.avatar,
                        isVip: Boolean(current.isVip || incoming.isVip),
                        __capturedAt: Math.max(capturedAt, normalizeCapturedAt(current.__capturedAt, 0) || 0),
                        __scope: Array.from(new Set([current.__scope, incoming.__scope].filter(Boolean))).join(',')
                    });
                });
                boardRows.set(boardKey, byUser);
            });
        });

        const leaderboards = {};
        boardRows.forEach((rows, boardKey) => {
            leaderboards[boardKey] = Array.from(rows.values())
                .map((row) => {
                    const { __capturedAt, __scope, ...clean } = row;
                    return clean;
                })
                .sort((left, right) => rowRank(left, Number.MAX_SAFE_INTEGER) - rowRank(right, Number.MAX_SAFE_INTEGER)
                    || rowUserId(left).localeCompare(rowUserId(right)));
        });

        const source = latestSnapshot && latestSnapshot.source || {};
        return {
            ...source,
            scope: LOCAL_SOURCE_SCOPE_CONFIG.scope.filter((scope) => scopes.has(scope)).join(',') || String(source.scope || 'global'),
            capturedAt: latestSnapshot ? latestSnapshot.capturedAt : Date.now(),
            leaderboards,
            source: 'local-unsent',
            sourceScopes: LOCAL_SOURCE_SCOPE_CONFIG.scope.filter((scope) => scopes.has(scope))
        };
    }

    function rowUserId(row) {
        return String(row && (row.userId ?? row.user_id ?? row.id) || '').trim();
    }

    function rowName(row, userId) {
        return String(row && (row.userName ?? row.user_name ?? row.name) || userId).trim();
    }

    function rowValue(row) {
        if (!row || typeof row !== 'object') return null;
        const value = Number(row && (row.value ?? row.total ?? row.count));
        return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    }

    function rowRank(row, fallback) {
        const rank = Number(row && (row.rank ?? row.position));
        return Number.isFinite(rank) && rank > 0 ? Math.floor(rank) : fallback;
    }

    function rowAvatar(row) {
        return String(row && (row.avatar ?? row.avatarUrl ?? row.avatar_url) || '').trim();
    }

    function rowIsVip(row) {
        return Boolean(row && (row.isVip ?? row.is_vip ?? row.vip));
    }

    function estimateFromSpend(spendValue, isVip) {
        if (spendValue == null || spendValue === '') {
            return { spendUsd: null, estimatedDays: null, estimatedPulls: null, estimateStatus: 'missing_spend' };
        }
        const rawValue = Number(spendValue);
        if (!Number.isFinite(rawValue) || rawValue < 0) {
            return { spendUsd: null, estimatedDays: null, estimatedPulls: null, estimateStatus: 'missing_spend' };
        }
        const spendUsd = rawValue / SPEND_VALUE_PER_USD;
        const dailySpendUsd = isVip ? VIP_DAILY_SPEND_USD : ORDINARY_DAILY_SPEND_USD;
        const dailyPulls = isVip ? VIP_DAILY_PULLS : ORDINARY_DAILY_PULLS;
        const estimatedDays = spendUsd / dailySpendUsd;
        const estimatedPulls = estimatedDays * dailyPulls;
        const completeDays = Math.abs(estimatedDays - Math.round(estimatedDays)) < 1e-9;
        return {
            spendUsd,
            estimatedDays,
            estimatedPulls,
            estimateStatus: completeDays ? 'complete_days' : 'partial_day'
        };
    }

    function estimatedProbability(epicTotal, spendValue, isVip) {
        const estimate = estimateFromSpend(spendValue, isVip);
        return estimate.estimatedPulls > 0 && Number.isFinite(epicTotal)
            ? Number(epicTotal) / estimate.estimatedPulls
            : null;
    }

    function pairLocalRows(epicRows = [], spendRows = []) {
        const users = new Map();
        const merge = (rawRow, kind) => {
            const userId = rowUserId(rawRow);
            if (!userId) return;
            const current = users.get(userId) || { userId, epicRow: null, spendRow: null, isVip: false };
            current[`${kind}Row`] = rawRow;
            current.isVip = current.isVip || rowIsVip(rawRow);
            users.set(userId, current);
        };
        epicRows.forEach((row) => merge(row, 'epic'));
        spendRows.forEach((row) => merge(row, 'spend'));
        return Array.from(users.values());
    }

    function localPairViews(pairs, limit = 100) {
        const complete = [];
        const partial = [];
        pairs.forEach((pair) => {
            const row = pair.epicRow || pair.spendRow;
            if (!row) return;
            const view = { row, pair, rankOverride: null };
            if (pair.epicRow && pair.spendRow) complete.push(view);
            else partial.push(view);
        });
        complete.sort((left, right) => {
            const leftProbability = estimatedProbability(
                rowValue(left.pair.epicRow), rowValue(left.pair.spendRow), left.pair.isVip
            );
            const rightProbability = estimatedProbability(
                rowValue(right.pair.epicRow), rowValue(right.pair.spendRow), right.pair.isVip
            );
            if (leftProbability == null && rightProbability == null) return left.pair.userId.localeCompare(right.pair.userId);
            if (leftProbability == null) return 1;
            if (rightProbability == null) return -1;
            return rightProbability - leftProbability
                || rowValue(right.pair.epicRow) - rowValue(left.pair.epicRow)
                || left.pair.userId.localeCompare(right.pair.userId);
        });
        return {
            complete: complete.slice(0, limit).map((view, index) => ({ ...view, rankOverride: index + 1 })),
            partial: partial.slice(0, 100)
        };
    }

    function localEnrichedRow(rawRow, pair, board, rankOverride) {
        const userId = rowUserId(rawRow);
        const epicTotal = pair && pair.epicRow
            ? rowValue(pair.epicRow)
            : board === 'epic' ? rowValue(rawRow) : null;
        const spendValue = pair && pair.spendRow
            ? rowValue(pair.spendRow)
            : board === 'spend' ? rowValue(rawRow) : null;
        const isVip = rowIsVip(rawRow) || Boolean(pair && pair.isVip);
        const estimate = estimateFromSpend(spendValue, isVip);
        let estimateStatus = estimate.estimateStatus;
        if (epicTotal == null) estimateStatus = 'missing_epic';
        else if (spendValue == null) estimateStatus = 'missing_spend';
        const probability = estimateStatus === 'missing_epic' || estimateStatus === 'missing_spend'
            ? null
            : estimatedProbability(epicTotal, spendValue, isVip);
        return {
            snapshotId: null,
            boardKey: `${board}_${state.period}`,
            userId,
            userName: rowName(rawRow, userId),
            avatar: rowAvatar(rawRow),
            value: rowValue(rawRow) ?? 0,
            rank: rankOverride === undefined ? rowRank(rawRow, null) : rankOverride,
            isVip,
            previousRank: null,
            previousValue: null,
            rankDelta: null,
            valueDelta: null,
            event: '',
            epicTotal,
            spendValue,
            spendTotal: spendValue,
            spendUsd: estimate.spendUsd,
            estimatedDays: estimate.estimatedDays,
            estimatedPulls: estimate.estimatedPulls,
            estimateStatus,
            isPartial: estimateStatus !== 'complete_days' || probability == null,
            estimatedLegendProbability: probability
        };
    }

    function summarizeLocalUsers(epicRows = [], spendRows = [], setsRows = [], sort = 'legend') {
        const users = new Map();
        const merge = (rawRow, kind) => {
            const userId = rowUserId(rawRow);
            if (!userId) return;
            const current = users.get(userId) || {
                userId,
                epicRow: null,
                spendRow: null,
                setsRow: null,
                userName: '',
                avatar: '',
                isVip: false
            };
            current[`${kind}Row`] = rawRow;
            const rawName = String(rawRow && (rawRow.userName ?? rawRow.user_name ?? rawRow.name) || '').trim();
            current.userName = current.userName || rawName;
            current.avatar = current.avatar || rowAvatar(rawRow);
            current.isVip = current.isVip || rowIsVip(rawRow);
            users.set(userId, current);
        };
        epicRows.forEach((row) => merge(row, 'epic'));
        spendRows.forEach((row) => merge(row, 'spend'));
        setsRows.forEach((row) => merge(row, 'sets'));
        return Array.from(users.values()).map((user) => {
            const epicTotal = rowValue(user.epicRow);
            const spendValue = rowValue(user.spendRow);
            const exchangeCount = rowValue(user.setsRow);
            const estimate = estimateFromSpend(spendValue, user.isVip);
            let estimateStatus = estimate.estimateStatus;
            if (epicTotal == null && spendValue == null) estimateStatus = 'missing_pair';
            else if (epicTotal == null) estimateStatus = 'missing_epic';
            else if (spendValue == null) estimateStatus = 'missing_spend';
            const probability = estimateStatus === 'missing_pair' || estimateStatus === 'missing_epic' || estimateStatus === 'missing_spend'
                ? null
                : estimatedProbability(epicTotal, spendValue, user.isVip);
            return {
                snapshotId: null,
                boardKey: `users_${state.period}`,
                userId: user.userId,
                userName: user.userName || user.userId,
                avatar: user.avatar,
                value: spendValue ?? epicTotal ?? exchangeCount,
                rank: null,
                isVip: user.isVip,
                previousRank: null,
                previousValue: null,
                rankDelta: null,
                valueDelta: null,
                event: '',
                epicTotal,
                spendValue,
                spendTotal: spendValue,
                spendUsd: estimate.spendUsd,
                estimatedDays: estimate.estimatedDays,
                estimatedPulls: estimate.estimatedPulls,
                exchangeCount,
                estimateStatus,
                isPartial: estimateStatus !== 'complete_days' || probability == null,
                estimatedLegendProbability: probability
            };
        }).sort((left, right) => compareLocalUsers(left, right, sort));
    }

    function compareLocalUsers(left, right, sort) {
        if (sort === 'user') return String(left.userName || left.userId).localeCompare(String(right.userName || right.userId)) || left.userId.localeCompare(right.userId);
        const value = (row) => sort === 'legend'
            ? row.epicTotal
            : sort === 'spend'
                ? row.spendUsd
                : sort === 'pulls'
                    ? row.estimatedPulls
                    : sort === 'sets'
                        ? row.exchangeCount
                        : row.estimatedLegendProbability;
        const leftValue = value(left);
        const rightValue = value(right);
        if (leftValue == null && rightValue == null) return left.userId.localeCompare(right.userId);
        if (leftValue == null) return 1;
        if (rightValue == null) return -1;
        return rightValue - leftValue || left.userId.localeCompare(right.userId);
    }

    function compareDisplayRows(left, right) {
        const direction = state.sortDirection === 'asc' ? 1 : -1;
        if (state.sort === 'user') {
            return direction * (
                String(left.userName || left.userId).localeCompare(String(right.userName || right.userId))
                || left.userId.localeCompare(right.userId)
            );
        }

        const value = (row) => state.sort === 'legend'
            ? row.epicTotal
            : state.sort === 'spend'
                ? row.spendUsd
                : state.sort === 'pulls'
                    ? row.estimatedPulls
                    : state.sort === 'sets'
                        ? row.exchangeCount
                        : row.estimatedLegendProbability;
        const leftValue = value(left);
        const rightValue = value(right);
        if (leftValue == null && rightValue == null) return left.userId.localeCompare(right.userId);
        if (leftValue == null) return 1;
        if (rightValue == null) return -1;
        return direction * (Number(leftValue) - Number(rightValue)) || left.userId.localeCompare(right.userId);
    }

    function sortRowsForDisplay(rows = []) {
        return rows.slice().sort(compareDisplayRows);
    }

    function renderSortHeaders() {
        document.querySelectorAll('[data-rank-sort]').forEach((button) => {
            const active = button.dataset.rankSort === state.sort;
            const direction = active ? state.sortDirection : 'none';
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none');
            const indicator = button.querySelector('.sort-indicator');
            if (indicator) indicator.textContent = active ? (direction === 'asc' ? '↑' : '↓') : '↕';
        });
    }

    function syncPinnedSeason(seasonId) {
        const normalized = String(seasonId || '').trim();
        if (!normalized) return;
        state.seasonId = normalized;
        if (state.pinnedSeasonId === normalized) return;
        state.pinnedSeasonId = normalized;
        state.pinnedUserIds = loadPinnedUsers(normalized);
    }

    function updatePinButtons() {
        document.querySelectorAll('[data-pin-user]').forEach((button) => {
            const userId = String(button.dataset.pinUser || '');
            const pinned = state.pinnedUserIds.has(userId);
            const userName = button.dataset.userName || userId;
            button.classList.toggle('is-pinned', pinned);
            button.setAttribute('aria-pressed', String(pinned));
            button.setAttribute('aria-label', pinned ? `取消置顶 ${userName}` : `置顶 ${userName}`);
            button.title = pinned ? '取消置顶' : '置顶用户';
        });
    }

    function togglePinnedUser(userId) {
        const normalized = String(userId || '').trim();
        if (!normalized) return;
        const seasonId = state.pinnedSeasonId || state.seasonId || 'default';
        if (state.pinnedUserIds.has(normalized)) state.pinnedUserIds.delete(normalized);
        else state.pinnedUserIds.add(normalized);
        savePinnedUsers(seasonId, state.pinnedUserIds);
        renderRankingsTableRows();
    }

    function localLeaderboardPayload(snapshotOrBundle) {
        const source = mergeLocalSnapshots(normalizeSnapshotsForUpload(snapshotOrBundle));
        const leaderboards = source && source.leaderboards;
        if (!source || !leaderboards || typeof leaderboards !== 'object') return null;
        const boardKey = `${state.board}_${state.period}`;
        const rawRows = Array.isArray(leaderboards[boardKey]) ? leaderboards[boardKey] : [];
        const epicRows = Array.isArray(leaderboards[`epic_${state.period}`]) ? leaderboards[`epic_${state.period}`] : [];
        const spendRows = Array.isArray(leaderboards[`spend_${state.period}`]) ? leaderboards[`spend_${state.period}`] : [];
        const setsRows = Array.isArray(leaderboards[`sets_${state.period}`]) ? leaderboards[`sets_${state.period}`] : [];
        if (state.board === 'users') {
            const sort = state.sort || 'legend';
            const rows = summarizeLocalUsers(epicRows, spendRows, setsRows, sort).map((row, index) => ({ ...row, rank: index + 1 }));
            return {
                ok: true,
                board: 'users',
                period: state.period,
                sort,
                boardKey,
                snapshot: {
                    id: null,
                    seasonId: String(source.season && source.season.id || ''),
                    seasonName: String(source.season && source.season.name || ''),
                    scope: String(source.scope || 'global'),
                    capturedAt: normalizeCapturedAt(source.capturedAt, null)
                        || normalizeCapturedAt(source.lastUpdatedAt, null)
                        || Date.now(),
                    source: 'local-unsent'
                },
                previousSnapshot: null,
                estimated: true,
                localOnly: true,
                rows,
                partialRows: []
            };
        }
        const pairs = pairLocalRows(epicRows, spendRows);
        const pairByUser = new Map(pairs.map((pair) => [pair.userId, pair]));
        const luck = state.board === 'luck' ? localPairViews(pairs, 100) : null;
        const views = state.board === 'luck'
            ? luck.complete
            : rawRows.slice(0, 100).map((rawRow) => ({ row: rawRow, pair: pairByUser.get(rowUserId(rawRow)) || null }));
        const rows = views.map((view) => localEnrichedRow(view.row, view.pair, state.board, view.rankOverride === null ? undefined : view.rankOverride))
            .filter((row) => row.userId && Number.isFinite(row.value));
        const partialRows = state.board === 'luck'
            ? luck.partial.map((view) => localEnrichedRow(view.row, view.pair, state.board, null))
            : rows.filter((row) => row.isPartial);
        return {
            ok: true,
            board: state.board,
            period: state.period,
            boardKey,
            snapshot: {
                id: null,
                seasonId: String(source.season && source.season.id || ''),
                seasonName: String(source.season && source.season.name || ''),
                scope: String(source.scope || 'global'),
                capturedAt: normalizeCapturedAt(source.capturedAt, null)
                    || normalizeCapturedAt(source.lastUpdatedAt, null)
                    || Date.now(),
                source: 'local-unsent'
            },
            previousSnapshot: null,
            estimated: true,
            localOnly: true,
            rows,
            partialRows
        };
    }

    function setDashboardView(view) {
        state.view = view === 'rankings' ? 'rankings' : 'calculator';
        if (state.view !== 'rankings') closeTrendModal();
        const calculator = $('#calculatorView');
        const rankings = $('#rankingsView');
        if (calculator) calculator.classList.toggle('is-hidden', state.view !== 'calculator');
        if (rankings) rankings.classList.toggle('is-hidden', state.view !== 'rankings');
        document.querySelectorAll('[data-view]').forEach((button) => {
            const active = button.dataset.view === state.view;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        if (state.view === 'rankings' && !state.loaded) loadRankingsView({ refresh: false });
    }

    function rankingsEntryUnlocked() {
        return new URLSearchParams(window.location.search).get('view') === 'rankings';
    }

    window.setDashboardView = setDashboardView;

    function requestBridgeSnapshot() {
        if (state.bridgeRequest) return state.bridgeRequest;
        const requestId = `rankings-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        state.bridgeRequest = new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeoutId);
                window.removeEventListener('message', onMessage);
                callback(value);
            };
            const onMessage = (event) => {
                if (event.origin !== window.location.origin) return;
                const data = event.data;
                if (!data || data.type !== BRIDGE_RESPONSE || data.requestId !== requestId) return;
                if (data.ok && (Array.isArray(data.snapshots) || data.snapshot)) {
                    finish(resolve, {
                        snapshots: normalizeSnapshotsForUpload(data),
                        errors: Array.isArray(data.errors) ? data.errors : [],
                        partial: Boolean(data.partial)
                    });
                }
                else finish(reject, new Error(data.error || '同步脚本请求失败'));
            };
            const timeoutId = window.setTimeout(() => finish(reject, new Error('未检测到同步脚本或请求超时')), BRIDGE_TIMEOUT_MS);
            window.addEventListener('message', onMessage);
            window.postMessage({ type: BRIDGE_REQUEST, requestId }, window.location.origin);
        }).finally(() => {
            state.bridgeRequest = null;
        });
        return state.bridgeRequest;
    }

    async function loadLatestSnapshot() {
        const latest = await apiGet('/api/rankings/latest');
        state.latest = latest;
        if (latest.snapshot) {
            syncPinnedSeason(latest.snapshot.seasonId);
            const updated = $('#rankingsUpdatedAt');
            if (updated) updated.textContent = `更新于 ${formatDate(latest.snapshot.capturedAt)}`;
        }
        return latest;
    }

    async function uploadSnapshot(snapshot) {
        const normalizedSnapshots = normalizeSnapshotsForUpload(snapshot);
        if (!normalizedSnapshots.length || normalizedSnapshots.some((item) => !Number.isInteger(item.capturedAt) || item.capturedAt <= 0)) {
            throw new Error('榜单快照缺少有效抓取时间');
        }
        return apiPost('/api/rankings/snapshots', {
            snapshots: normalizedSnapshots,
            source: 'card-dashboard-userscript'
        });
    }

    async function ensureFreshSnapshot(force = false) {
        if (!force && state.localSnapshots.length && !state.settings.autoUpload) {
            setStatus('已显示本地抓取数据，尚未上传云端');
            return { localOnly: true, snapshots: state.localSnapshots };
        }
        const latest = await loadLatestSnapshot();
        if (!force && latest.snapshot && !latest.stale) {
            setStatus(`数据新鲜 · ${formatDate(latest.snapshot.capturedAt)}`);
            return latest;
        }

        setStatus(force
            ? '正在检查云端榜单…'
            : (latest.snapshot ? '榜单超过 1 小时，正在检查更新…' : '暂无快照，正在请求榜单…'), false, true);
        try {
            setStatus(state.bridgeReady ? '正在请求最新榜单…' : '正在等待用户脚本连接…', false, true);
            const bundle = await requestBridgeSnapshot();
            state.bridgeReady = true;
            setStatus('已收到榜单数据，正在整理…', false, true);
            state.localSnapshots = normalizeSnapshotsForUpload(bundle);
            if (!state.localSnapshots.length) throw new Error('同步脚本返回的榜单为空');
            if (!state.settings.autoUpload) {
                setStatus('已抓取本地榜单，未上传云端');
                renderUploadControls();
                return { localOnly: true, snapshots: state.localSnapshots };
            }
            setStatus('正在上传榜单快照…', false, true);
            await uploadSnapshot(bundle);
            state.localSnapshots = [];
            const refreshed = await loadLatestSnapshot();
            setStatus(`已同步 · ${formatDate(refreshed.snapshot && refreshed.snapshot.capturedAt)}`);
            renderUploadControls();
            return refreshed;
        } catch (error) {
            setStatus(String(error && error.message || error), true);
            renderUploadControls();
            return latest;
        }
    }

    async function loadLeaderboard() {
        const query = `/api/rankings/leaderboard?board=users&period=${encodeURIComponent(state.period)}&sort=${encodeURIComponent(state.sort)}`;
        const leaderboard = await apiGet(query);
        state.rows = Array.isArray(leaderboard.rows) ? leaderboard.rows : [];
        state.partialRows = Array.isArray(leaderboard.partialRows) ? leaderboard.partialRows : [];
        renderLeaderboard(leaderboard);
    }

    async function loadRankingsView(options = {}) {
        const refresh = options === true || Boolean(options && options.refresh);
        if (state.busy) return;
        setBusy(true);
        setStatus(refresh ? '正在检查云端榜单…' : '正在读取云端快照…', false, true);
        try {
            let source;
            if (refresh) {
                source = await ensureFreshSnapshot(true);
            } else if (state.localSnapshots.length && !state.settings.autoUpload) {
                setStatus('已显示本地抓取数据，尚未上传云端');
                source = { localOnly: true, snapshots: state.localSnapshots };
            } else {
                const latest = await loadLatestSnapshot();
                if (!latest.snapshot) {
                    state.rows = [];
                    state.partialRows = [];
                    renderLeaderboard(latest || { rows: [] });
                    if (state.trend.selectedIds.length) await refreshTrendHistories();
                    setStatus('暂无云端快照，请点击立即刷新');
                    state.loaded = true;
                    return;
                }
                source = latest;
                setStatus(`已读取云端快照 · ${formatDate(latest.snapshot.capturedAt)}`);
            }
            if (source && source.localOnly) {
                const payload = localLeaderboardPayload(source.snapshots);
                state.rows = payload ? payload.rows : [];
                state.partialRows = payload ? payload.partialRows : [];
                renderLeaderboard(payload || { rows: [] });
            } else {
                await loadLeaderboard();
            }
            if (state.trend.selectedIds.length) await refreshTrendHistories();
            state.loaded = true;
        } catch (error) {
            setStatus(`读取失败：${String(error && error.message || error)}`, true);
            state.partialRows = [];
            renderLeaderboard({ rows: [] });
        } finally {
            setBusy(false);
        }
    }

    async function uploadPendingSnapshot() {
        if (!state.localSnapshots.length || state.busy) return;
        setBusy(true);
        setStatus('正在上传本次榜单快照…');
        try {
            await uploadSnapshot({ snapshots: state.localSnapshots });
            state.localSnapshots = [];
            const refreshed = await loadLatestSnapshot();
            await loadLeaderboard();
            if (state.trend.selectedIds.length) await refreshTrendHistories();
            setStatus(`已上传并同步 · ${formatDate(refreshed.snapshot && refreshed.snapshot.capturedAt)}`);
        } catch (error) {
            setStatus(`上传失败：${String(error && error.message || error)}`, true);
        } finally {
            setBusy(false);
            renderUploadControls();
        }
    }

    function renderRankingsRow(row, rankNumber, pinned = false, pinIndex = 0) {
        const rowClass = [
            row.isPartial ? 'is-partial' : '',
            pinned ? 'is-pinned-row' : ''
        ].filter(Boolean).join(' ');
        const pinStyle = pinned ? ` style="--rankings-pinned-top: ${43 + pinIndex * 46}px;"` : '';
        const avatar = row.avatar
            ? `<img class="rank-avatar" data-initials="${initials(row.userName)}" src="${escapeHtml(row.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
            : `<span class="rank-avatar-fallback">${initials(row.userName)}</span>`;
        const status = formatEstimateStatus(row.estimateStatus, row.isPartial);
        return `<tr class="${rowClass}"${pinStyle} data-user-id="${escapeHtml(row.userId)}">
            <td class="rank-number">${formatNumber(rankNumber)}</td>
            <td>${row.isVip ? '<span class="rank-vip">VIP</span>' : ''}</td>
            <td class="rank-user-cell"><span class="rank-user-button"><button class="rankings-pin-button" type="button" data-pin-user="${escapeHtml(row.userId)}" data-user-name="${escapeHtml(row.userName || row.userId)}" aria-pressed="false" aria-label="置顶 ${escapeHtml(row.userName || row.userId)}" title="置顶用户"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.25 2.75h3.5L9 6.75l2.75 2.75H4.25L7 6.75l-.75-4Z"/><path d="M8 9.5v3.75M6.25 13.25h3.5"/></svg></button>${avatar}<span>${escapeHtml(row.userName || row.userId)}</span></span></td>
            <td class="rank-legend">${formatOptionalNumber(row.epicTotal)}</td>
            <td class="rank-spend">${formatOptionalUsd(row.spendUsd)}</td>
            <td class="rank-pulls">${formatOptionalNumber(row.estimatedPulls)}</td>
            <td class="rank-sets">${formatOptionalNumber(row.exchangeCount)}</td>
            <td class="rank-probability">${formatOptionalProbability(row.estimatedLegendProbability)}</td>
            <td class="rank-status ${row.isPartial ? 'is-partial' : ''}">${status}</td>
            <td class="rank-trend"><button class="rankings-trend-trigger" type="button" data-trend-user="${escapeHtml(row.userId)}" aria-label="查看 ${escapeHtml(row.userName || row.userId)} 趋势" title="查看趋势"><svg class="rankings-trend-trigger-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5 5.5 9l2.5 2 5.5-6"/><path d="M10.5 5H14v3.5"/></svg></button></td>
        </tr>`;
    }

    function bindRankingsTableEvents(container) {
        if (!container) return;
        container.querySelectorAll('img.rank-avatar').forEach((image) => {
            image.addEventListener('error', () => {
                const fallback = document.createElement('span');
                fallback.className = 'rank-avatar-fallback';
                fallback.textContent = image.dataset.initials || '?';
                image.replaceWith(fallback);
            }, { once: true });
        });
        container.querySelectorAll('[data-trend-user]').forEach((button) => {
            button.addEventListener('click', () => openTrendModal(button.dataset.trendUser));
        });
        container.querySelectorAll('[data-pin-user]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                togglePinnedUser(button.dataset.pinUser);
            });
        });
    }

    function renderRankingsTableRows() {
        const body = $('#rankingsTableBody');
        const pinnedBody = $('#rankingsPinnedBody');
        if (!body) return;

        const sortedRows = sortRowsForDisplay(state.rows);
        const rankByUserId = new Map(sortedRows.map((row, index) => [row.userId, index + 1]));
        const pinnedRows = sortedRows.filter((row) => state.pinnedUserIds.has(row.userId));
        const visibleRows = sortRowsForDisplay(filterUserRows(state.rows));
        const normalRows = visibleRows.filter((row) => !state.pinnedUserIds.has(row.userId));

        if (pinnedBody) {
            pinnedBody.innerHTML = pinnedRows
                .map((row, index) => renderRankingsRow(row, rankByUserId.get(row.userId) || index + 1, true, index))
                .join('');
        }
        body.innerHTML = normalRows.length
            ? normalRows.map((row) => renderRankingsRow(row, rankByUserId.get(row.userId) || 0)).join('')
            : pinnedRows.length
                ? ''
                : `<tr><td class="rankings-empty" colspan="10">${state.userQuery ? '没有匹配的用户' : '暂无榜单数据'}</td></tr>`;

        const rowsForSummary = [...pinnedRows, ...normalRows];
        const partialNotice = $('#rankingsPartialNotice');
        if (partialNotice) {
            const incompleteCount = rowsForSummary.filter((row) => row.isPartial).length;
            partialNotice.textContent = incompleteCount
                ? `当前表格中有 ${formatNumber(incompleteCount)} 位用户的估算数据不完整，缺失项保持空白。`
                : '';
            partialNotice.classList.toggle('is-hidden', !incompleteCount);
        }
        bindRankingsTableEvents(pinnedBody);
        bindRankingsTableEvents(body);
        updatePinButtons();
        renderSummary(rowsForSummary);
    }

    function renderLeaderboard(payload) {
        const boardLabel = '用户总览';
        const title = $('#rankingsBoardTitle');
        const updated = $('#rankingsUpdatedAt');
        if (title) title.textContent = boardLabel;
        syncPinnedSeason(payload && payload.snapshot && payload.snapshot.seasonId
            || state.latest && state.latest.snapshot && state.latest.snapshot.seasonId
            || state.seasonId);
        if (updated && payload.snapshot) updated.textContent = `更新于 ${formatDate(payload.snapshot.capturedAt)}`;
        renderSortHeaders();
        renderTrendUserOptions();
        renderTrendSelection();
        renderTrendPeriodControl();
        renderTrendChart();
        renderRankingsTableRows();
    }

    function filterUserRows(rows = []) {
        const query = String(state.userQuery || '').trim().toLowerCase();
        if (!query) return rows;
        return rows.filter((row) => [row.userName, row.userId]
            .some((value) => String(value || '').toLowerCase().includes(query)));
    }

    function formatEstimateStatus(status, isPartial) {
        if (status === 'missing_pair') return '缺少欧皇榜与消费榜';
        if (status === 'missing_spend') return '缺少消费榜';
        if (status === 'missing_epic') return '缺少欧皇榜';
        if (status === 'partial_day') return '非完整天数 / 估算';
        if (isPartial) return '数据不完整';
        return '完整天数';
    }

    function formatOptionalNumber(value) {
        return value == null || value === '' || !Number.isFinite(Number(value)) ? '' : formatDecimal(value);
    }

    function formatOptionalUsd(value) {
        return value == null || value === '' || !Number.isFinite(Number(value)) ? '' : formatUsd(value);
    }

    function formatOptionalProbability(value) {
        return value == null || value === '' || !Number.isFinite(Number(value)) ? '' : formatProbability(value);
    }

    function formatRankChange(row) {
        if (row.event === 'entered') return '<span class="rank-event">入榜</span>';
        if (row.event === 'left') return '<span class="rank-event is-left">出榜</span>';
        const delta = Number(row.rankDelta);
        if (!Number.isFinite(delta) || delta === 0) return '—';
        return delta > 0 ? `↑ ${delta}` : `↓ ${Math.abs(delta)}`;
    }

    function renderSummary(rows = state.rows) {
        const spends = rows.map((row) => row.spendUsd).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const pulls = rows.map((row) => row.estimatedPulls).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const probabilities = rows.map((row) => row.estimatedLegendProbability).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const summary = $('#rankingsSummary');
        if (!summary) return;
        const cards = [
            ['用户数', formatNumber(rows.length)],
            ['总消费 USD', spends.length ? formatUsd(spends.reduce((a, b) => a + b, 0)) : '—'],
            ['平均估算抽数', pulls.length ? formatDecimal(pulls.reduce((a, b) => a + b, 0) / pulls.length) : '—'],
            ['平均出卡率', probabilities.length ? formatProbability(probabilities.reduce((a, b) => a + b, 0) / probabilities.length) : '—']
        ];
        summary.innerHTML = cards.map(([label, value]) => `<article class="rankings-summary-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
    }

    function configureHourlyRefresh() {
        if (state.hourlyRefreshTimer) {
            window.clearInterval(state.hourlyRefreshTimer);
            state.hourlyRefreshTimer = null;
        }
        if (!state.settings.hourlyRefresh) return;
        state.hourlyRefreshTimer = window.setInterval(() => {
            if (state.view !== 'rankings' || state.busy) return;
            loadRankingsView({ refresh: true });
        }, HOURLY_REFRESH_MS);
    }

    function bindControls() {
        document.querySelectorAll('[data-rank-board]').forEach((button) => {
            button.addEventListener('click', () => {
                state.board = button.dataset.rankBoard;
                document.querySelectorAll('[data-rank-board]').forEach((item) => {
                    const active = item === button;
                    item.classList.toggle('is-active', active);
                    item.setAttribute('aria-selected', String(active));
                });
                if (state.view === 'rankings') loadRankingsView({ refresh: false });
            });
        });
        document.querySelectorAll('[data-rank-period]').forEach((button) => {
            button.addEventListener('click', () => {
                state.period = button.dataset.rankPeriod;
                syncTrendPeriodFromOuter();
                document.querySelectorAll('[data-rank-period]').forEach((item) => {
                    const active = item === button;
                    item.classList.toggle('is-active', active);
                    item.setAttribute('aria-selected', String(active));
                });
                if (state.view === 'rankings') loadRankingsView({ refresh: false });
            });
        });
        $('#rankingsPeriodSelect')?.addEventListener('change', (event) => {
            state.period = event.target.value || 'total';
            syncTrendPeriodFromOuter();
            if (state.view === 'rankings') loadRankingsView({ refresh: false });
        });
        document.querySelectorAll('[data-rank-sort]').forEach((button) => {
            button.addEventListener('click', () => {
                const nextSort = button.dataset.rankSort || 'probability';
                if (state.sort === nextSort) {
                    state.sortDirection = state.sortDirection === 'desc' ? 'asc' : 'desc';
                } else {
                    state.sort = nextSort;
                    state.sortDirection = 'desc';
                }
                renderSortHeaders();
                if (state.view === 'rankings') loadRankingsView({ refresh: false });
            });
        });
        $('#rankingsRefreshButton')?.addEventListener('click', () => loadRankingsView({ refresh: true }));
        $('#rankingsUploadButton')?.addEventListener('click', uploadPendingSnapshot);
        $('#rankingsAutoUpload')?.addEventListener('change', (event) => {
            state.settings.autoUpload = Boolean(event.target.checked);
            saveSettings(state.settings);
            setStatus(state.settings.autoUpload
                ? '已开启抓取后自动上传云端。'
                : '已关闭自动上传；只有手动点击上传才会提交云端。');
            renderUploadControls();
        });
        $('#rankingsHourlyRefresh')?.addEventListener('change', (event) => {
            state.settings.hourlyRefresh = Boolean(event.target.checked);
            saveSettings(state.settings);
            configureHourlyRefresh();
            setStatus(state.settings.hourlyRefresh
                ? '已开启每小时刷新；仅在榜单页停留时自动抓取。'
                : '已关闭每小时刷新；请手动点击立即刷新。');
            renderUploadControls();
        });
        $('#rankingsUserSearch')?.addEventListener('input', (event) => {
            state.userQuery = String(event.target.value || '');
            renderLeaderboard({ snapshot: state.latest && state.latest.snapshot });
        });
        $('#rankingsTrendMetric')?.addEventListener('change', (event) => {
            const metric = String(event.target.value || '');
            if (!Object.prototype.hasOwnProperty.call(TREND_METRICS, metric)) return;
            state.trend.metric = metric;
            renderTrendChart();
        });
        $('#rankingsTrendPeriodSelect')?.addEventListener('change', (event) => {
            state.trend.period = normalizeTrendPeriod(String(event.target.value || 'total'));
            renderTrendChart();
        });
        document.querySelectorAll('[data-trend-mode]').forEach((button) => {
            button.addEventListener('click', () => {
                const mode = button.dataset.trendMode === 'snapshot' ? 'snapshot' : 'daily';
                state.trend.mode = mode;
                renderTrendModeButtons();
                renderTrendChart();
            });
        });
        $('#rankingsTrendAddButton')?.addEventListener('click', addTrendUser);
        $('#rankingsTrendUserSearch')?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            addTrendUser();
        });
        $('#rankingsTrendCloseButton')?.addEventListener('click', closeTrendModal);
        $('#rankingsTrendBackdrop')?.addEventListener('click', (event) => {
            if (event.target === event.currentTarget) closeTrendModal();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeTrendModal();
        });
    }

    function init() {
        window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin) return;
            if (event.data && event.data.type === BRIDGE_READY) {
                state.bridgeReady = true;
                if (state.busy) setStatus('用户脚本已连接，正在请求最新榜单…', false, true);
            }
        });
        bindControls();
        renderSortHeaders();
        renderTrendModeButtons();
        renderTrendPeriodControl();
        renderUploadControls();
        configureHourlyRefresh();
        const rankingsUnlocked = rankingsEntryUnlocked();
        const rankingsNavButton = $('#rankingsNavButton');
        if (rankingsNavButton) rankingsNavButton.classList.toggle('is-hidden', !rankingsUnlocked);
        setDashboardView(rankingsUnlocked ? 'rankings' : 'calculator');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
