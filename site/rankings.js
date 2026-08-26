(function () {
    'use strict';

    const BRIDGE_READY = 'HYB_CARD_RANKINGS_BRIDGE_READY';
    const BRIDGE_REQUEST = 'HYB_CARD_RANKINGS_REQUEST';
    const BRIDGE_RESPONSE = 'HYB_CARD_RANKINGS_RESPONSE';
    const BRIDGE_TIMEOUT_MS = 22000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const RESET_HOUR_MS = 4 * 60 * 60 * 1000;
    const AUTO_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
    const CAPTURE_BUCKET_MS = 60 * 60 * 1000;
    const RANKINGS_RETRY_MS = 60 * 60 * 1000;
    const MAX_AUTO_RETRIES = 1;
    const MAX_PINNED_USERS = 20;
    const REQUIRED_USERSCRIPT_VERSION = '1.3.3';
    const USERSCRIPT_URL = '/userscripts/hyb-card-dashboard-rankings.user.js';
    const TREND_CHART_FIXED_AXIS_WIDTH = 86;
    const TREND_CHART_AXIS_PADDING_RATIO = 0.03;
    const SETTINGS_STORAGE_KEY = 'hyb-card-rankings-settings-v1';
    const CALCULATOR_STORAGE_KEY = 'legend-card-calculator-snapshot-v1';
    const PINS_STORAGE_KEY = 'hyb-card-rankings-pins-v1';
    const UPLOAD_STATE_STORAGE_KEY = 'hyb-card-rankings-upload-state-v1';
    const AUTO_UPLOAD_MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;
    const SPEND_VALUE_PER_USD = 500000;
    const VIP_DAILY_SPEND_USD = 6000;
    const VIP_DAILY_PAID_PULLS = 600;
    const VIP_DAILY_FREE_PULLS = 50;
    const VIP_DAILY_PULLS = VIP_DAILY_PAID_PULLS + VIP_DAILY_FREE_PULLS;
    const ORDINARY_DAILY_SPEND_USD = 4000;
    const ORDINARY_DAILY_PAID_PULLS = 400;
    const ORDINARY_DAILY_FREE_PULLS = 30;
    const ORDINARY_DAILY_PULLS = ORDINARY_DAILY_PAID_PULLS + ORDINARY_DAILY_FREE_PULLS;
    const BOOST_ORDINARY_DAILY_SPEND_USD = 8000;
    const BOOST_ORDINARY_DAILY_PAID_PULLS = 800;
    const BOOST_ORDINARY_DAILY_FREE_PULLS = 60;
    const BOOST_VIP_DAILY_SPEND_USD = 10000;
    const BOOST_VIP_DAILY_PAID_PULLS = 1000;
    const BOOST_VIP_DAILY_FREE_PULLS = 80;
    const LOCAL_SOURCE_SCOPES = Object.freeze(['global', 'friends']);
    const LOCAL_SOURCE_SCOPE_CONFIG = Object.freeze({ scope: 'global,friends', order: LOCAL_SOURCE_SCOPES });
    const API_CACHE_TTL = Object.freeze({
        latest: 15 * 1000,
        leaderboard: 30 * 1000,
        users: 30 * 1000,
        history: 60 * 1000,
        events: 30 * 1000
    });
    const apiMemoryCache = new Map();

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
                ? values.map((value) => String(value || '').trim()).filter(Boolean).slice(0, MAX_PINNED_USERS)
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
            stored[pinSeasonKey(seasonId)] = stored[pinSeasonKey(seasonId)].slice(0, MAX_PINNED_USERS);
            window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(stored));
        } catch (_) {
            // Private browsing or storage restrictions must not block rankings viewing.
        }
    }

    function uploadStateKey(season, scope) {
        return `${String(season || '').trim()}\u0000${String(scope || '').trim()}`;
    }

    function readUploadState() {
        try {
            const stored = JSON.parse(window.localStorage.getItem(UPLOAD_STATE_STORAGE_KEY) || '{}') || {};
            if (typeof stored !== 'object' || Array.isArray(stored)) throw new Error('invalid upload state');
            const normalized = {};
            Object.entries(stored).forEach(([key, entry]) => {
                const separator = key.indexOf('\u0000');
                const season = separator >= 0 ? key.slice(0, separator).trim() : '';
                const scope = separator >= 0 ? key.slice(separator + 1).trim() : '';
                const capturedAt = normalizeCapturedAt(entry && entry.capturedAt, null);
                const uploadedAt = normalizeCapturedAt(entry && entry.uploadedAt, null);
                if (!season || !scope || !capturedAt || !uploadedAt || key !== uploadStateKey(season, scope)) {
                    throw new Error('invalid upload state entry');
                }
                normalized[key] = { capturedAt, uploadedAt };
            });
            return normalized;
        } catch (_) {
            try { window.localStorage.removeItem(UPLOAD_STATE_STORAGE_KEY); } catch (_) { /* ignore storage failures */ }
            return {};
        }
    }

    function writeUploadState(uploadState) {
        try {
            window.localStorage.setItem(UPLOAD_STATE_STORAGE_KEY, JSON.stringify(uploadState));
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
        userscriptVersion: '',
        scriptUpdateRequired: false,
        bridgeRequest: null,
        hourlyRefreshTimer: null,
        rankingsRetryTimer: null,
        rankingsRetryPending: false,
        rankingsRetryCount: 0,
        rankingsRetryAt: 0,
        rows: [],
        partialRows: [],
        userQuery: '',
        remotePage: true,
        page: 1,
        pageSize: 50,
        leaderboard: {
            cursor: null,
            nextCursor: null,
            previousCursors: [],
            hasMore: false,
            totalRows: 0,
            summary: null,
            limit: 50
        },
        pinnedRows: [],
        searchTimer: null,
        onlyCompleteDays: false,
        status: '等待榜单数据',
        trend: {
            mode: 'daily',
            period: 'total',
            metric: 'epicTotal',
            selectedIds: [],
            histories: new Map(),
            busy: false,
            modalOpen: false
        }
    };

    const $ = (selector) => document.querySelector(selector);

    function apiUrl(path) {
        return new URL(path, window.location.origin).href;
    }

    function apiCacheType(path) {
        const pathname = new URL(path, window.location.origin).pathname;
        if (pathname.endsWith('/latest')) return 'latest';
        if (pathname.endsWith('/leaderboard')) return 'leaderboard';
        if (pathname.endsWith('/users')) return 'users';
        if (pathname.endsWith('/history')) return 'history';
        if (pathname.endsWith('/events')) return 'events';
        return '';
    }

    async function apiGet(path, options = {}) {
        const cacheKey = String(path);
        const cacheType = apiCacheType(path);
        const ttl = API_CACHE_TTL[cacheType] || 0;
        const fresh = options.fresh === true || options.cache === 'reload';
        const cached = apiMemoryCache.get(cacheKey);
        if (!fresh && cached && cached.expiresAt > Date.now()) return cached.body;
        if (fresh) apiMemoryCache.delete(cacheKey);
        const headers = { accept: 'application/json' };
        if (fresh) headers['cache-control'] = 'no-cache';
        const response = await fetch(apiUrl(path), {
            method: 'GET',
            credentials: 'same-origin',
            cache: options.cache || 'default',
            headers
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const fallback = response.status === 503
                ? '榜单服务暂时繁忙，请稍后重试'
                : `HTTP ${response.status}`;
            const error = new Error(body.message || body.error || fallback);
            error.status = response.status;
            error.code = body.error || '';
            error.retryable = body.retryable !== false && response.status >= 500;
            throw error;
        }
        if (response.ok && ttl > 0) apiMemoryCache.set(cacheKey, {
            body,
            expiresAt: Date.now() + ttl
        });
        return body;
    }

    function invalidateRankingsCache() {
        for (const key of apiMemoryCache.keys()) {
            if (key.includes('/api/rankings/')) apiMemoryCache.delete(key);
        }
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
        if (!response.ok) {
            const fallback = response.status === 503
                ? '榜单服务暂时繁忙，请稍后重试'
                : `HTTP ${response.status}`;
            const error = new Error(body.message || body.reason || body.error || fallback);
            error.status = response.status;
            error.code = body.error || '';
            error.retryable = body.retryable !== false && response.status >= 500;
            throw error;
        }
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

    function compareVersions(left, right) {
        const parse = (value) => String(value || '').split('.').map((part) => Number(part));
        const a = parse(left);
        const b = parse(right);
        if (!a.length || a.some((part) => !Number.isInteger(part) || part < 0)) return -1;
        if (!b.length || b.some((part) => !Number.isInteger(part) || part < 0)) return 1;
        const length = Math.max(a.length, b.length);
        for (let index = 0; index < length; index += 1) {
            const difference = (a[index] || 0) - (b[index] || 0);
            if (difference) return difference > 0 ? 1 : -1;
        }
        return 0;
    }

    function userscriptVersionSupported(version) {
        return Boolean(String(version || '').trim()) && compareVersions(version, REQUIRED_USERSCRIPT_VERSION) >= 0;
    }

    function userscriptUpdateError(version = '') {
        const error = new Error(`同步脚本需要更新到 v${REQUIRED_USERSCRIPT_VERSION}`);
        error.name = 'ScriptUpdateRequired';
        error.code = 'script_update_required';
        error.scriptUpdateRequired = true;
        error.retryable = false;
        error.scriptVersion = String(version || '');
        return error;
    }

    function renderUserscriptLink() {
        const link = $('#rankingsInstallLink');
        if (!link) return;
        link.href = apiUrl(USERSCRIPT_URL);
        link.textContent = state.scriptUpdateRequired ? '更新脚本' : '安装用户脚本';
        link.classList.toggle('is-update-required', state.scriptUpdateRequired);
    }

    function markUserscriptVersion(version) {
        state.userscriptVersion = String(version || '').trim();
        state.scriptUpdateRequired = !userscriptVersionSupported(state.userscriptVersion);
        renderUserscriptLink();
        return !state.scriptUpdateRequired;
    }

    function errorCanAutoRetry(error) {
        return !state.scriptUpdateRequired
            && !(error && (error.scriptUpdateRequired || error.cooldown || error.blocked || error.code === 'userscript_missing'))
            && (!error || error.retryable !== false);
    }

    function retryStatusSuffix() {
        const suffix = retrySuffix();
        return suffix ? `；${suffix}` : '；本轮不再自动重试。';
    }

    function retrySuffix() {
        if (state.rankingsRetryPending) return '1小时后最多自动重试1次。';
        if (state.rankingsRetryCount >= MAX_AUTO_RETRIES) return '本轮已停止自动重试。';
        return '';
    }

    function clearRankingsRetry() {
        if (state.rankingsRetryTimer) {
            window.clearTimeout(state.rankingsRetryTimer);
            state.rankingsRetryTimer = null;
        }
        state.rankingsRetryPending = false;
        state.rankingsRetryAt = 0;
        state.rankingsRetryCount = 0;
    }

    function scheduleRankingsRetry() {
        if (state.scriptUpdateRequired || state.rankingsRetryCount >= MAX_AUTO_RETRIES) {
            state.rankingsRetryPending = false;
            state.rankingsRetryAt = 0;
            return false;
        }
        if (!state.rankingsRetryPending) {
            state.rankingsRetryPending = true;
            state.rankingsRetryAt = Date.now() + RANKINGS_RETRY_MS;
        }
        if (state.rankingsRetryTimer || state.view !== 'rankings') return true;
        const tick = () => {
            state.rankingsRetryTimer = null;
            if (!state.rankingsRetryPending || state.view !== 'rankings') return;
            const waitMs = Math.max(0, state.rankingsRetryAt - Date.now());
            if (waitMs > 0 || state.busy) {
                state.rankingsRetryTimer = window.setTimeout(tick, waitMs > 0 ? waitMs : 1000);
                return;
            }
            state.rankingsRetryPending = false;
            state.rankingsRetryAt = 0;
            state.rankingsRetryCount += 1;
            loadRankingsView({ autoRefresh: true, retry: true });
        };
        state.rankingsRetryTimer = window.setTimeout(tick, Math.max(0, state.rankingsRetryAt - Date.now()));
        return true;
    }

    function runRankingsRetryNow() {
        if (!state.rankingsRetryPending || state.busy || state.view !== 'rankings') return false;
        if (Date.now() < state.rankingsRetryAt) return false;
        if (state.rankingsRetryTimer) {
            window.clearTimeout(state.rankingsRetryTimer);
            state.rankingsRetryTimer = null;
        }
        state.rankingsRetryPending = false;
        state.rankingsRetryAt = 0;
        state.rankingsRetryCount += 1;
        loadRankingsView({ autoRefresh: true, retry: true });
        return true;
    }

    function installRankingsRetryLifecycleListeners() {
        const wake = () => {
            if (document.visibilityState && document.visibilityState !== 'visible') return;
            runRankingsRetryNow();
        };
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        window.addEventListener('pageshow', wake);
        window.addEventListener('online', wake);
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

    function formatBeijingDate(value) {
        const time = Number(value);
        if (!Number.isFinite(time) || time <= 0) return '—';
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(new Date(time)).replace(/\s+/g, ' ');
    }

    function readRankingBoostConfig() {
        let values = {};
        try {
            const stored = JSON.parse(window.localStorage.getItem(CALCULATOR_STORAGE_KEY) || '{}') || {};
            values = stored.values && typeof stored.values === 'object' ? stored.values : {};
        } catch (_) {
            values = {};
        }
        const mode = new Set(['open', 'season', 'days']).has(String(values.boostEndMode))
            ? String(values.boostEndMode)
            : 'open';
        const rules = window.StardustRules || {};
        const defaultDuration = Number(rules.BOOST_DEFAULT_DURATION_DAYS) || 72;
        const normalizeDuration = typeof rules.normalizeBoostDurationDays === 'function'
            ? rules.normalizeBoostDurationDays
            : (value) => Math.max(1, Math.min(defaultDuration, Math.floor(Number(value) || defaultDuration)));
        const durationDays = mode === 'days'
            ? normalizeDuration(values.boostDurationDays)
            : defaultDuration;
        const seasonEndAt = Number(rules.SEASON_END_AT) || null;
        const endAt = mode === 'days'
            ? (typeof rules.getBoostEndAt === 'function' ? rules.getBoostEndAt(durationDays) : null)
            : mode === 'season' ? seasonEndAt : null;
        return {
            enabled: values.enableBoost !== false,
            mode,
            durationDays,
            endAt,
            startAt: Number(rules.BOOST_START_AT) || Date.parse('2026-08-20T04:00:00+08:00')
        };
    }

    function rankingQuotaForDay(day, isVip, config = readRankingBoostConfig()) {
        const rules = window.StardustRules || {};
        if (typeof rules.getDailyQuotaForSeasonDay === 'function') {
            return rules.getDailyQuotaForSeasonDay(day, {
                enabled: config.enabled,
                durationDays: config.durationDays,
                vip: Boolean(isVip)
            });
        }
        const seasonStart = Number(rules.SEASON_START_AT) || Date.parse('2026-08-02T04:00:00+08:00');
        const dayMs = 24 * 60 * 60 * 1000;
        const timestamp = seasonStart + (Math.max(1, Math.floor(Number(day) || 1)) - 1) * dayMs;
        const boosted = config.enabled
            && timestamp >= config.startAt
            && (config.endAt == null || timestamp < config.endAt);
        if (isVip) {
            return boosted
                ? { paidCost: BOOST_VIP_DAILY_SPEND_USD, paidPulls: BOOST_VIP_DAILY_PAID_PULLS, freePulls: BOOST_VIP_DAILY_FREE_PULLS, totalPulls: BOOST_VIP_DAILY_PAID_PULLS + BOOST_VIP_DAILY_FREE_PULLS }
                : { paidCost: VIP_DAILY_SPEND_USD, paidPulls: VIP_DAILY_PAID_PULLS, freePulls: VIP_DAILY_FREE_PULLS, totalPulls: VIP_DAILY_PULLS };
        }
        return boosted
            ? { paidCost: BOOST_ORDINARY_DAILY_SPEND_USD, paidPulls: BOOST_ORDINARY_DAILY_PAID_PULLS, freePulls: BOOST_ORDINARY_DAILY_FREE_PULLS, totalPulls: BOOST_ORDINARY_DAILY_PAID_PULLS + BOOST_ORDINARY_DAILY_FREE_PULLS }
            : { paidCost: ORDINARY_DAILY_SPEND_USD, paidPulls: ORDINARY_DAILY_PAID_PULLS, freePulls: ORDINARY_DAILY_FREE_PULLS, totalPulls: ORDINARY_DAILY_PULLS };
    }

    function renderRankingBoostNotice() {
        const notice = $('#rankingsFreePullsNotice');
        const text = $('#rankingsFreePullsNoticeText');
        if (!notice || !text) return;
        const config = readRankingBoostConfig();
        const rules = window.StardustRules || {};
        const now = Date.now();
        const seasonDay = typeof rules.getSeasonDay === 'function' ? rules.getSeasonDay(now) : 1;
        const vipQuota = rankingQuotaForDay(seasonDay, true, config);
        const ordinaryQuota = rankingQuotaForDay(seasonDay, false, config);
        const active = config.enabled && now >= config.startAt && (config.endAt == null || now < config.endAt);
        const endText = config.mode === 'open'
            ? '-'
            : config.endAt ? formatBeijingDate(config.endAt) : '—';
        notice.dataset.boostState = active ? 'active' : config.enabled ? 'scheduled' : 'disabled';
        text.textContent = `当前额度：VIP ${vipQuota.paidPulls} 付费 + ${vipQuota.freePulls} 免费 = ${vipQuota.totalPulls} 抽/天；普通 ${ordinaryQuota.paidPulls} 付费 + ${ordinaryQuota.freePulls} 免费 = ${ordinaryQuota.totalPulls} 抽/天。翻倍开始：${formatBeijingDate(config.startAt)}；结束：${endText}。根据消费金额反推付费天数，并按 VIP / 普通玩家的每日免费额度计入总抽数；出卡率仅供参考。`;
    }

    const TREND_METRICS = Object.freeze({
        epicTotal: '传说卡数量',
        spendUsd: '消费金额',
        estimatedPulls: '抽卡次数',
        exchangeCount: '兑换次数',
        estimatedLegendProbability: '出卡率'
    });
    // 趋势图的数值展示按指标单独配置：数量类不显示无意义的小数，
    // 比例类保留精度；后续新增指标时只需在这里补充规则。
    const TREND_METRIC_FORMATS = Object.freeze({
        epicTotal: Object.freeze({ value: 'integer', axis: 'integer' }),
        spendUsd: Object.freeze({ value: 'currency', axis: 'integer' }),
        estimatedPulls: Object.freeze({ value: 'integer', axis: 'integer' }),
        exchangeCount: Object.freeze({ value: 'integer', axis: 'integer' }),
        estimatedLegendProbability: Object.freeze({
            value: 'probability',
            axis: 'decimal',
            scale: 100,
            suffix: '%',
            axisMaxFractionDigits: 5
        })
    });
    const TREND_PERIODS = Object.freeze({
        total: '整个赛季',
        today: '今日',
        week: '本周',
        month: '本月'
    });
    const TREND_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'];
    const TREND_HISTORY_PAGE_LIMIT = 200;

    function trendNumber(value) {
        const number = Number(value);
        // 榜单历史中缺失用户有时会以 0 占位；趋势只绘制真实的正数观测。
        return Number.isFinite(number) && number > 0 ? number : null;
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

    function finalizeTrendPoint(point, period = state.trend.period) {
        const estimate = estimateFromSpend(point.spendValue, point.isVip, {
            capturedAt: point.capturedAt,
            period
        });
        const canDerive = point.epicTotal != null && point.spendValue != null;
        return {
            ...point,
            spendUsd: estimate.spendUsd,
            paidPulls: estimate.paidPulls,
            freePulls: estimate.freePulls,
            estimatedPulls: estimate.estimatedPulls,
            estimatedLegendProbability: canDerive
                ? estimatedProbability(point.epicTotal, point.spendValue, point.isVip, {
                    capturedAt: point.capturedAt,
                    period
                })
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
            .map((point) => finalizeTrendPoint(point, period));
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
            .map((point) => finalizeTrendPoint(point, period));
    }

    function trendMetricValue(point, metric = state.trend.metric) {
        const value = point && point[metric];
        if (value == null || !Number.isFinite(Number(value))) return null;
        const number = Number(value);
        return trendMetricFormat(metric).value === 'integer' ? Math.round(number) : number;
    }

    function trendMetricFormat(metric = state.trend.metric) {
        return TREND_METRIC_FORMATS[metric] || { value: 'decimal', axis: 'decimal', axisMaxFractionDigits: 2 };
    }

    function formatTrendValue(value, metric = state.trend.metric) {
        if (value == null || !Number.isFinite(Number(value))) return '';
        const format = trendMetricFormat(metric);
        if (format.value === 'currency') return formatUsd(Number(value));
        if (format.value === 'probability') return formatProbability(Number(value));
        if (format.value === 'integer') return formatNumber(Number(value));
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
        const minimumTickCount = Math.max(2, count);
        const maximumTickCount = minimumTickCount + 3;
        const intervals = minimumTickCount - 1;
        const minimum = Number(minValue);
        const maximum = Number(maxValue);
        const range = Math.max(Number.EPSILON, maximum - minimum);
        const minimumStep = integerOnly ? 1 : 0.00001;
        const baseStep = Math.max(minimumStep, niceTrendStep(range / intervals, integerOnly));
        const candidateSteps = new Set();
        const addCandidateStep = (value) => {
            const step = Number(value);
            if (Number.isFinite(step) && step >= minimumStep) candidateSteps.add(step);
        };
        addCandidateStep(baseStep);
        addCandidateStep(niceTrendStep(baseStep / 2, integerOnly));
        addCandidateStep(niceTrendStep(baseStep / 4, integerOnly));
        let largerStep = baseStep;
        for (let index = 0; index < 6; index += 1) {
            largerStep = nextNiceTrendStep(largerStep, integerOnly);
            addCandidateStep(largerStep);
        }

        let best = null;
        candidateSteps.forEach((step) => {
            const axisMin = Math.floor((minimum + step * 1e-10) / step) * step;
            const actualIntervals = Math.max(
                intervals,
                Math.ceil((maximum - axisMin) / step - 1e-10)
            );
            const actualTickCount = actualIntervals + 1;
            if (actualTickCount < minimumTickCount || actualTickCount > maximumTickCount) return;
            const axisMax = axisMin + actualIntervals * step;
            const wastedRange = (minimum - axisMin) + (axisMax - maximum);
            const relativeWaste = wastedRange / range;
            const tickPenalty = (actualTickCount - minimumTickCount) * 0.02;
            const score = relativeWaste + tickPenalty;
            if (!best || score < best.score) best = { axisMin, axisMax, step, actualIntervals, score };
        });

        const fallbackStep = baseStep;
        const axisMin = best ? best.axisMin : Math.floor(minimum / fallbackStep) * fallbackStep;
        const axisMax = best
            ? best.axisMax
            : axisMin + intervals * fallbackStep;
        const step = best ? best.step : fallbackStep;
        const outputIntervals = best ? best.actualIntervals : intervals;
        return {
            min: axisMin,
            max: axisMax,
            step,
            values: Array.from({ length: outputIntervals + 1 }, (_, index) => axisMax - index * step)
                .map((value) => Math.abs(value) < step * 1e-9 ? 0 : value)
        };
    }

    function trendAxisDomain(values, metric = state.trend.metric) {
        const axisValues = (Array.isArray(values) ? values : [])
            .map((value) => trendAxisValue(value, metric))
            .filter((value) => value != null);
        if (!axisValues.length) return null;

        let minAxisValue = Math.min(...axisValues);
        let maxAxisValue = Math.max(...axisValues);
        if (minAxisValue === maxAxisValue) {
            const equalRangePad = Math.max(
                Math.abs(maxAxisValue) * 0.1,
                trendMetricFormat(metric).value === 'probability' ? 0.1 : 1
            );
            minAxisValue = Math.max(0, minAxisValue - equalRangePad);
            maxAxisValue += equalRangePad;
        }

        const axisPadding = (maxAxisValue - minAxisValue) * TREND_CHART_AXIS_PADDING_RATIO;
        minAxisValue = Math.max(0, minAxisValue - axisPadding);
        maxAxisValue += axisPadding;
        return niceTrendAxis(
            minAxisValue,
            maxAxisValue,
            5,
            trendMetricFormat(metric).axis === 'integer'
        );
    }

    function trendAxisPrecision(values, step, metric = state.trend.metric) {
        const format = trendMetricFormat(metric);
        if (format.axis === 'integer') return 0;
        const numericStep = Math.abs(Number(step));
        const maximumFractionDigits = Math.max(0, Math.min(5, Number(format.axisMaxFractionDigits) || 2));
        for (let digits = 0; digits <= maximumFractionDigits; digits += 1) {
            const labels = values.map((value) => Number(value).toFixed(digits));
            const scaledStep = numericStep * (10 ** digits);
            const stepIsExact = Math.abs(scaledStep - Math.round(scaledStep)) <= Math.max(1, scaledStep) * 1e-9;
            if (stepIsExact && new Set(labels).size === labels.length) return digits;
        }
        return maximumFractionDigits;
    }

    function trendAxisValue(value, metric = state.trend.metric) {
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        const scale = Number(trendMetricFormat(metric).scale);
        return number * (Number.isFinite(scale) ? scale : 1);
    }

    function formatTrendAxisValue(value, metric, precision) {
        metric = metric || state.trend.metric;
        precision = Number.isFinite(Number(precision)) ? Number(precision) : 0;
        const number = Number(value);
        if (!Number.isFinite(number)) return '';
        const format = trendMetricFormat(metric);
        if (format.value === 'probability') {
            const digits = Math.max(0, Math.min(5, Number.parseInt(precision, 10) || 0));
            return `${number.toFixed(digits)}%`;
        }
        if (format.axis === 'integer') {
            const rounded = Math.round(number);
            if (format.value === 'currency') return `$${rounded.toLocaleString('en-US')}`;
            return rounded.toLocaleString('zh-CN');
        }
        const digits = Math.max(0, Math.min(5, Number.parseInt(precision, 10) || 0));
        const suffix = format.suffix || '';
        return `${number.toLocaleString('zh-CN', { maximumFractionDigits: digits })}${suffix}`;
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
        if (state.trend.modalOpen) refreshTrendHistories();
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
            const active = button.dataset.trendMode === 'daily';
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    function renderTrendChart() {
        const svg = $('#rankingsTrendChart');
        const yAxisElement = $('#rankingsTrendYAxis');
        const chartLayout = document.querySelector('.rankings-trend-chart-layout');
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
            if (yAxisElement) yAxisElement.innerHTML = '';
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
        const padding = { top: 24, right: 24, bottom: 48, left: 10 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const values = series.flatMap((item) => item.points
            .map((point) => trendMetricValue(point))
            .filter((value) => value != null));
        const axis = trendAxisDomain(values, state.trend.metric);
        if (!axis) {
            svg.innerHTML = '';
            if (yAxisElement) yAxisElement.innerHTML = '';
            empty.textContent = '暂无可用趋势数据';
            empty.classList.remove('is-hidden');
            return;
        }
        const axisMinValue = axis.min;
        const axisMaxValue = axis.max;
        const axisRange = Math.max(Number.EPSILON, axisMaxValue - axisMinValue);
        const yTickPrecision = trendAxisPrecision(axis.values, axis.step, state.trend.metric);
        const axisWidth = TREND_CHART_FIXED_AXIS_WIDTH;
        if (chartLayout) chartLayout.style.setProperty('--trend-axis-width', `${axisWidth}px`);
        if (yAxisElement) {
            yAxisElement.innerHTML = axis.values.map((value) => {
                const ratio = (axisMaxValue - value) / axisRange;
                const top = ((padding.top + ratio * chartHeight) / height) * 100;
                return `<span class="rankings-trend-y-label" style="top:${top.toFixed(4)}%">${escapeHtml(formatTrendAxisValue(value, state.trend.metric, yTickPrecision))}</span>`;
            }).join('');
        }
        const xFor = (index) => labelKeys.length <= 1
            ? padding.left + chartWidth / 2
            : padding.left + (index / (labelKeys.length - 1)) * chartWidth;
        const yForAxis = (value) => padding.top + chartHeight - ((value - axisMinValue) / axisRange) * chartHeight;
        const yFor = (value) => yForAxis(trendAxisValue(value));
        const grid = [];
        axis.values.forEach((value) => {
            const y = yForAxis(value);
            grid.push(`<line x1="${padding.left}" y1="${y.toFixed(2)}" x2="${width - padding.right}" y2="${y.toFixed(2)}" class="trend-grid-line"/>`);
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
                if (segment.length >= 2) lines.push(`<polyline points="${segment.join(' ')}" fill="none" stroke="${item.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
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
            : null;
    }

    function selectTrendUser(userId, userName = '') {
        const normalizedId = String(userId || '').trim();
        if (!normalizedId || state.trend.selectedIds.includes(normalizedId)) return false;
        const row = state.rows.find((item) => item.userId === normalizedId);
        state.trend.selectedIds.push(normalizedId);
        state.trend.histories.set(normalizedId, {
            userId: normalizedId,
            userName: userName || row?.userName || normalizedId,
            rows: [],
            nextCursor: null,
            hasMore: false,
            mode: 'daily',
            since: null,
            until: null
        });
        return true;
    }

    function openTrendModal(userId) {
        state.trend.modalOpen = true;
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
        state.trend.modalOpen = false;
        const backdrop = $('#rankingsTrendBackdrop');
        if (backdrop) backdrop.classList.add('is-hidden');
        document.body.classList.remove('modal-open');
    }

    function trendHistoryRange(period = state.trend.period) {
        const latestCapturedAt = Number(state.latest?.snapshot?.capturedAt)
            || Math.max(...state.rows.map((row) => Number(row && row.capturedAt) || 0), Date.now());
        const latestDayStartAt = dayStartAtForCapturedAt(latestCapturedAt);
        const dayCount = period === 'today' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 30;
        return {
            since: Math.max(0, latestDayStartAt - (dayCount - 1) * DAY_MS),
            until: latestCapturedAt
        };
    }

    async function loadTrendHistoryPage(userId, options = {}) {
        const record = trendUserRecord(userId);
        const append = options.append === true;
        const range = trendHistoryRange(state.trend.period);
        const params = new URLSearchParams({
            userId,
            mode: 'daily',
            since: String(record.since == null || !append ? range.since : record.since),
            until: String(record.until == null || !append ? range.until : record.until),
            limit: String(TREND_HISTORY_PAGE_LIMIT)
        });
        if (append && record.nextCursor) params.set('cursor', record.nextCursor);
        const payload = await apiGet(`/api/rankings/history?${params.toString()}`);
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        const existingRows = append && Array.isArray(record.rows) ? record.rows : [];
        return {
            userId,
            userName: state.rows.find((row) => row.userId === userId)?.userName || payload.userName || record.userName || userId,
            rows: [...existingRows, ...rows],
            nextCursor: payload.nextCursor || null,
            hasMore: Boolean(payload.hasMore),
            mode: 'daily',
            since: Number(payload.since) || range.since,
            until: Number(payload.until) || range.until
        };
    }

    function renderTrendPagination() {
        const button = $('#rankingsTrendLoadMore');
        if (!button) return;
        const hasMore = state.trend.selectedIds.some((userId) => trendUserRecord(userId).hasMore);
        button.classList.toggle('is-hidden', !hasMore);
        button.disabled = state.trend.busy;
    }

    async function loadMoreTrendHistories() {
        if (!state.trend.modalOpen || state.trend.busy) return;
        const users = state.trend.selectedIds.filter((userId) => trendUserRecord(userId).hasMore);
        if (!users.length) return;
        state.trend.busy = true;
        renderTrendPagination();
        const results = await Promise.allSettled(users.map((userId) => loadTrendHistoryPage(userId, { append: true })));
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && state.trend.selectedIds.includes(users[index])) {
                state.trend.histories.set(users[index], result.value);
            }
        });
        state.trend.busy = false;
        renderTrendSelection();
        renderTrendPagination();
        renderTrendChart();
    }

    async function refreshTrendHistories() {
        if (!state.trend.modalOpen) return;
        if (!state.trend.selectedIds.length) {
            state.trend.busy = false;
            renderTrendChart();
            renderTrendPagination();
            return;
        }
        state.trend.busy = true;
        renderTrendChart();
        const results = await Promise.allSettled(state.trend.selectedIds.map((userId) => loadTrendHistoryPage(userId)));
        results.forEach((result, index) => {
            const userId = state.trend.selectedIds[index];
            if (result.status === 'fulfilled' && state.trend.selectedIds.includes(userId)) {
                state.trend.histories.set(userId, result.value);
            }
        });
        state.trend.busy = false;
        renderTrendSelection();
        renderTrendPagination();
        renderTrendChart();
    }

    async function addTrendUser() {
        const input = $('#rankingsTrendUserSearch');
        const query = String(input && input.value || '').trim();
        let user = resolveTrendUser(query);
        if (!user && query) {
            try {
                const payload = await apiGet(`/api/rankings/users?${new URLSearchParams({ q: query, limit: '20' }).toString()}`);
                const first = Array.isArray(payload.users) ? payload.users[0] : null;
                if (first) user = { userId: first.userId, userName: first.userName || first.userId };
            } catch (_) {
                user = null;
            }
        }
        if (!user || !selectTrendUser(user.userId, user.userName)) return;
        if (input) input.value = '';
        renderTrendSelection();
        renderTrendChart();
        if (state.trend.modalOpen) refreshTrendHistories();
    }

    function removeTrendUser(userId) {
        state.trend.selectedIds = state.trend.selectedIds.filter((id) => id !== userId);
        state.trend.histories.delete(userId);
        renderTrendSelection();
        renderTrendPagination();
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
        const capturedAt = normalizeCapturedAt(source.capturedAt, null)
            || normalizeCapturedAt(source.lastUpdatedAt, null);
        const observedAt = normalizeCapturedAt(source.observedAt, null) || Date.now();
        return {
            ...source,
            capturedAt,
            observedAt,
            capturedAtSource: capturedAt ? 'upstream' : 'observed'
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

    function uploadStateForSnapshot(snapshot) {
        const source = snapshotSource(snapshot);
        const season = source && source.season && typeof source.season === 'object'
            ? String(source.season.id || '').trim()
            : '';
        const scope = String(source && source.scope || '').trim();
        const capturedAt = normalizeCapturedAt(source && source.capturedAt, null)
            || normalizeCapturedAt(source && source.observedAt, null);
        if (!season || !scope || !capturedAt) return null;
        return { season, scope, capturedAt };
    }

    function pendingUploadSnapshots(snapshots, options = {}) {
        const normalizedSnapshots = normalizeSnapshotsForUpload(snapshots);
        if (options.manual) return normalizedSnapshots;
        const now = normalizeCapturedAt(options.now, Date.now()) || Date.now();
        const uploaded = readUploadState();
        return normalizedSnapshots.filter((snapshot) => {
            const current = uploadStateForSnapshot(snapshot);
            if (!current) return true;
            const previous = uploaded[uploadStateKey(current.season, current.scope)];
            if (!previous) return true;
            const withinMinimumInterval = now - Number(previous.uploadedAt) < AUTO_UPLOAD_MIN_INTERVAL_MS;
            return current.capturedAt > Number(previous.capturedAt) && !withinMinimumInterval;
        });
    }

    function shouldSkipUpload(snapshots, options = {}) {
        if (options.manual) return false;
        const normalizedSnapshots = normalizeSnapshotsForUpload(snapshots);
        return normalizedSnapshots.length > 0
            && pendingUploadSnapshots(normalizedSnapshots, options).length === 0;
    }

    function rememberUploadedSnapshots(snapshots, uploadedAt = Date.now()) {
        const uploadState = readUploadState();
        const observedAt = normalizeCapturedAt(uploadedAt, Date.now()) || Date.now();
        normalizeSnapshotsForUpload(snapshots).forEach((snapshot) => {
            const current = uploadStateForSnapshot(snapshot);
            if (!current) return;
            const key = uploadStateKey(current.season, current.scope);
            const previous = uploadState[key];
            uploadState[key] = {
                capturedAt: Math.max(current.capturedAt, Number(previous && previous.capturedAt) || 0),
                uploadedAt: observedAt
            };
        });
        writeUploadState(uploadState);
    }

    function rememberableUploadSnapshots(snapshots, response) {
        const cooldownScopes = new Set((Array.isArray(response && response.skippedScopes)
            ? response.skippedScopes
            : [])
            .filter((item) => item && item.reason === 'automatic_cooldown')
            .map((item) => uploadStateKey(item.seasonId, item.scope)));
        return normalizeSnapshotsForUpload(snapshots).filter((snapshot) => {
            const current = uploadStateForSnapshot(snapshot);
            return !current || !cooldownScopes.has(uploadStateKey(current.season, current.scope));
        });
    }

    function compactSnapshotForUpload(snapshot) {
        const source = snapshotSource(snapshot);
        if (!source || typeof source !== 'object') return null;
        const season = source.season && typeof source.season === 'object'
            ? {
                id: String(source.season.id || '').trim(),
                name: String(source.season.name || '').trim()
            }
            : { id: '', name: '' };
        const leaderboards = {};
        Object.entries(source.leaderboards || {}).forEach(([boardKey, rows]) => {
            if (!Array.isArray(rows)) return;
            leaderboards[boardKey] = rows.map((row) => ({
                userId: rowUserId(row),
                userName: rowName(row, rowUserId(row)),
                avatar: rowAvatar(row),
                value: rowValue(row),
                rank: rowRank(row, null),
                isVip: rowIsVip(row),
                activeNameDecoration: row && row.activeNameDecoration != null
                    ? String(row.activeNameDecoration)
                    : null,
                nameDisplayPreference: row && row.nameDisplayPreference != null
                    ? String(row.nameDisplayPreference)
                    : null
            })).filter((row) => row.userId && row.value != null && row.rank != null);
        });
        return {
            season,
            scope: String(source.scope || '').trim(),
            capturedAt: normalizeCapturedAt(source.capturedAt, null),
            observedAt: normalizeCapturedAt(source.observedAt, null),
            capturedAtSource: String(source.capturedAtSource || (source.capturedAt ? 'upstream' : 'observed')),
            leaderboards
        };
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
                    const { __scope, ...clean } = row;
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

    function estimateFromSpend(spendValue, isVip, options = {}) {
        if (spendValue == null || spendValue === '') {
            return {
                spendUsd: null,
                estimatedDays: null,
                paidPulls: null,
                freePulls: null,
                estimatedPulls: null,
                estimateStatus: 'missing_spend'
            };
        }
        const rawValue = Number(spendValue);
        if (!Number.isFinite(rawValue) || rawValue < 0) {
            return {
                spendUsd: null,
                estimatedDays: null,
                paidPulls: null,
                freePulls: null,
                estimatedPulls: null,
                estimateStatus: 'missing_spend'
            };
        }
        const spendUsd = rawValue / SPEND_VALUE_PER_USD;
        const config = options.config || readRankingBoostConfig();
        const capturedAt = Number(options.capturedAt)
            || Number(state.latest && state.latest.snapshot && state.latest.snapshot.capturedAt)
            || Date.now();
        const rules = window.StardustRules || {};
        const seasonDay = typeof rules.getSeasonDay === 'function' ? rules.getSeasonDay(capturedAt) : 1;
        const firstSeasonDay = options.period === 'today' ? seasonDay : 1;
        const firstQuota = rankingQuotaForDay(firstSeasonDay, isVip, config);
        if (spendUsd < firstQuota.paidCost) {
            return {
                spendUsd,
                estimatedDays: null,
                paidPulls: null,
                freePulls: null,
                estimatedPulls: null,
                estimateStatus: 'low_sample'
            };
        }
        const paidPulls = spendUsd / 10;
        let remainingSpend = spendUsd;
        let completeDays = 0;
        let partialDay = false;
        let freePulls = 0;
        for (let day = firstSeasonDay; day <= seasonDay; day += 1) {
            const quota = rankingQuotaForDay(day, isVip, config);
            if (remainingSpend + 1e-9 >= quota.paidCost) {
                remainingSpend -= quota.paidCost;
                completeDays += 1;
                freePulls += quota.freePulls;
                continue;
            }
            if (remainingSpend > 1e-9) {
                partialDay = true;
                freePulls += quota.freePulls;
            }
            remainingSpend = 0;
            break;
        }
        while (remainingSpend > 1e-9 && completeDays + (partialDay ? 1 : 0) < 180) {
            const quota = rankingQuotaForDay(seasonDay + 1, isVip, config);
            if (remainingSpend + 1e-9 >= quota.paidCost) {
                remainingSpend -= quota.paidCost;
                completeDays += 1;
                freePulls += quota.freePulls;
            } else {
                partialDay = true;
                freePulls += quota.freePulls;
                remainingSpend = 0;
            }
        }
        const estimatedDays = Math.max(1, completeDays + (partialDay ? 1 : 0));
        const estimatedPulls = paidPulls + freePulls;
        return {
            spendUsd,
            estimatedDays,
            paidPulls,
            freePulls,
            estimatedPulls,
            estimateStatus: partialDay ? 'partial_day' : 'complete_days'
        };
    }

    function estimatedProbability(epicTotal, spendValue, isVip, options = {}) {
        const estimate = estimateFromSpend(spendValue, isVip, options);
        return estimate.estimatedPulls > 0 && Number.isFinite(epicTotal)
            ? Number(epicTotal) / estimate.estimatedPulls
            : null;
    }

    function rowInCapturedBucket(row, capturedBucket) {
        if (!row) return false;
        if (capturedBucket == null) return true;
        const capturedAt = Number(row.__capturedAt ?? row.capturedAt ?? row.captured_at);
        return Number.isFinite(capturedAt)
            && Math.floor(capturedAt / CAPTURE_BUCKET_MS) === Number(capturedBucket);
    }

    function emptyLocalEstimate(spendUsd, estimateStatus) {
        return {
            spendUsd,
            estimatedDays: null,
            paidPulls: null,
            freePulls: null,
            estimatedPulls: null,
            estimateStatus
        };
    }

    function localEstimateStatus({ hasEpic, hasSpend, currentEpic, currentSpend, currentCapturedBucket }) {
        if (currentCapturedBucket != null) {
            if (!currentEpic && !currentSpend) return hasEpic || hasSpend ? 'missing_current_pair' : 'missing_pair';
            if (!currentEpic) return hasEpic ? 'missing_current_epic' : 'missing_epic';
            if (!currentSpend) return hasSpend ? 'missing_current_spend' : 'missing_spend';
        }
        if (!hasEpic && !hasSpend) return 'missing_pair';
        if (!hasEpic) return 'missing_epic';
        if (!hasSpend) return 'missing_spend';
        return 'missing_pair';
    }

    function dayStartAtForCapturedAt(capturedAt) {
        const value = Number(capturedAt);
        if (!Number.isFinite(value) || value <= 0) return null;
        return Math.floor((value - RESET_HOUR_MS) / DAY_MS) * DAY_MS + RESET_HOUR_MS;
    }

    function shouldReplaceLocalDailyRow(existing, incoming, capturedAt) {
        const existingCapturedAt = Number(existing && existing.__capturedAt);
        if (!Number.isFinite(existingCapturedAt) || capturedAt > existingCapturedAt) return true;
        if (capturedAt < existingCapturedAt) return false;
        return rowValue(incoming) >= rowValue(existing);
    }

    function latestLocalDailyRow(rowsByDay) {
        if (!rowsByDay || !rowsByDay.size) return null;
        return Array.from(rowsByDay.values())
            .sort((left, right) => Number(right.__dayStartAt) - Number(left.__dayStartAt)
                || Number(right.__capturedAt) - Number(left.__capturedAt))[0] || null;
    }

    function completeLocalDailyPair(user, commonDays = []) {
        for (const dayStartAt of commonDays) {
            const epicRow = user.daily.epic.get(dayStartAt);
            const spendRow = user.daily.spend.get(dayStartAt);
            if (!epicRow || !spendRow) continue;
            const isVip = Boolean(user.isVip || rowIsVip(epicRow) || rowIsVip(spendRow));
            const estimate = estimateFromSpend(rowValue(spendRow), isVip);
            if (estimate.estimateStatus === 'complete_days') {
                return { dayStartAt, epicRow, spendRow, isVip, estimate };
            }
        }
        return null;
    }

    function summarizeLocalUsersFromSnapshots(snapshots = [], period = 'total', sort = 'legend', latestCapturedAt = null) {
        const users = new Map();
        const boardKinds = [
            [`epic_${period}`, 'epic'],
            [`spend_${period}`, 'spend'],
            [`sets_${period}`, 'sets']
        ];
        snapshots.forEach((snapshot) => {
            const source = snapshotSource(snapshot);
            if (!source) return;
            const capturedAt = normalizeCapturedAt(source.capturedAt, null);
            const dayStartAt = dayStartAtForCapturedAt(capturedAt);
            if (!capturedAt || !dayStartAt) return;
            boardKinds.forEach(([boardKey, kind]) => {
                const rows = Array.isArray(source.leaderboards && source.leaderboards[boardKey])
                    ? source.leaderboards[boardKey]
                    : [];
                rows.forEach((rawRow) => {
                    const userId = rowUserId(rawRow);
                    if (!userId) return;
                    const current = users.get(userId) || {
                        userId,
                        userName: '',
                        avatar: '',
                        isVip: false,
                        daily: { epic: new Map(), spend: new Map(), sets: new Map() }
                    };
                    const row = {
                        ...rawRow,
                        userId,
                        userName: rowName(rawRow, userId),
                        avatar: rowAvatar(rawRow),
                        isVip: rowIsVip(rawRow),
                        __capturedAt: capturedAt,
                        __dayStartAt: dayStartAt
                    };
                    const existing = current.daily[kind].get(dayStartAt);
                    if (!existing || shouldReplaceLocalDailyRow(existing, row, capturedAt)) {
                        current.daily[kind].set(dayStartAt, row);
                    }
                    current.userName = current.userName || row.userName;
                    current.avatar = current.avatar || row.avatar;
                    current.isVip = current.isVip || row.isVip;
                    users.set(userId, current);
                });
            });
        });
        const latestDayStartAt = dayStartAtForCapturedAt(latestCapturedAt);
        return Array.from(users.values())
            .map((user) => buildLocalDailyUserSummary(user, period, latestDayStartAt))
            .sort((left, right) => compareLocalUsers(left, right, sort));
    }

    function buildLocalDailyUserSummary(user, period, latestDayStartAt = null) {
        const latestEpic = latestLocalDailyRow(user.daily.epic);
        const latestSpend = latestLocalDailyRow(user.daily.spend);
        const latestSets = latestLocalDailyRow(user.daily.sets);
        const epicTotal = rowValue(latestEpic);
        const spendValue = rowValue(latestSpend);
        const exchangeCount = rowValue(latestSets);
        const hasEpic = epicTotal != null && Number.isFinite(epicTotal);
        const hasSpend = spendValue != null && Number.isFinite(spendValue);
        const commonDays = Array.from(user.daily.epic.keys())
            .filter((dayStartAt) => user.daily.spend.has(dayStartAt))
            .sort((left, right) => right - left);
        const completePair = completeLocalDailyPair(user, commonDays);
        const estimateDayStartAt = completePair
            ? completePair.dayStartAt
            : (commonDays.length ? commonDays[0] : null);
        const pairEpic = completePair && completePair.epicRow;
        const pairSpend = completePair && completePair.spendRow;
        const pairEstimate = completePair && completePair.estimate;
        const rawEstimate = estimateFromSpend(spendValue, user.isVip);
        const estimate = pairEstimate || rawEstimate;
        const estimateStatus = !hasEpic && !hasSpend
            ? 'missing_pair'
            : !hasSpend
                ? 'missing_spend'
                : !hasEpic
                    ? 'missing_epic'
                    : !commonDays.length
                        ? 'missing_common_day'
                        : completePair
                            ? 'complete_days'
                            : 'partial_day';
        const displayEpicTotal = pairEpic ? rowValue(pairEpic) : epicTotal;
        const displaySpendValue = pairSpend ? rowValue(pairSpend) : spendValue;
        const probability = completePair
            ? estimatedProbability(displayEpicTotal, displaySpendValue, completePair.isVip)
            : null;
        const estimateUsesHistoricalData = estimateDayStartAt != null
            && latestDayStartAt != null
            && estimateDayStartAt < latestDayStartAt;
        return {
            snapshotId: null,
            boardKey: `users_${period}`,
            userId: user.userId,
            userName: user.userName || user.userId,
            avatar: user.avatar,
            value: displaySpendValue ?? displayEpicTotal ?? exchangeCount,
            rank: null,
            isVip: user.isVip,
            previousRank: null,
            previousValue: null,
            rankDelta: null,
            valueDelta: null,
            event: '',
            epicTotal: displayEpicTotal,
            spendValue: displaySpendValue,
            spendTotal: displaySpendValue,
            spendUsd: estimate.spendUsd,
            estimatedDays: estimate.estimatedDays,
            paidPulls: estimate.paidPulls,
            freePulls: estimate.freePulls,
            estimatedPulls: estimate.estimatedPulls,
            exchangeCount,
            estimateStatus,
            estimateDayStartAt,
            estimateUsesHistoricalData,
            isPartial: estimateStatus !== 'complete_days' || probability == null,
            estimatedLegendProbability: probability
        };
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

    function localPairViews(pairs, limit = 100, currentCapturedBucket = null) {
        const complete = [];
        const partial = [];
        pairs.forEach((pair) => {
            const row = pair.epicRow || pair.spendRow;
            if (!row) return;
            const view = { row, pair, rankOverride: null };
            const estimate = pair.epicRow && pair.spendRow
                ? estimateFromSpend(rowValue(pair.spendRow), pair.isVip)
                : null;
            if (estimate && estimate.estimateStatus === 'complete_days'
                && rowInCapturedBucket(pair.epicRow, currentCapturedBucket)
                && rowInCapturedBucket(pair.spendRow, currentCapturedBucket)) complete.push(view);
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

    function localEnrichedRow(rawRow, pair, board, rankOverride, currentCapturedBucket = null) {
        const userId = rowUserId(rawRow);
        const epicTotal = pair && pair.epicRow
            ? rowValue(pair.epicRow)
            : board === 'epic' ? rowValue(rawRow) : null;
        const spendValue = pair && pair.spendRow
            ? rowValue(pair.spendRow)
            : board === 'spend' ? rowValue(rawRow) : null;
        const isVip = rowIsVip(rawRow) || Boolean(pair && pair.isVip);
        const hasEpic = epicTotal != null && Number.isFinite(epicTotal);
        const hasSpend = spendValue != null && Number.isFinite(spendValue);
        const currentEpic = hasEpic && rowInCapturedBucket(pair && pair.epicRow || (board === 'epic' ? rawRow : null), currentCapturedBucket);
        const currentSpend = hasSpend && rowInCapturedBucket(pair && pair.spendRow || (board === 'spend' ? rawRow : null), currentCapturedBucket);
        const canDerive = currentEpic && currentSpend;
        const rawEstimate = estimateFromSpend(spendValue, isVip);
        const estimate = rawEstimate;
        const estimateStatus = canDerive
            ? estimate.estimateStatus
            : localEstimateStatus({
                hasEpic,
                hasSpend,
                currentEpic,
                currentSpend,
                currentCapturedBucket
            });
        const probability = canDerive && estimateStatus === 'complete_days'
            ? estimatedProbability(epicTotal, spendValue, isVip)
            : null;
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
            spendUsd: rawEstimate.spendUsd,
            estimatedDays: estimate.estimatedDays,
            paidPulls: estimate.paidPulls,
            freePulls: estimate.freePulls,
            estimatedPulls: estimate.estimatedPulls,
            estimateStatus,
            isPartial: estimateStatus !== 'complete_days' || probability == null,
            estimatedLegendProbability: probability
        };
    }

    function summarizeLocalUsers(epicRows = [], spendRows = [], setsRows = [], sort = 'legend', currentCapturedBucket = null) {
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
            const hasEpic = epicTotal != null && Number.isFinite(epicTotal);
            const hasSpend = spendValue != null && Number.isFinite(spendValue);
            const currentEpic = hasEpic && rowInCapturedBucket(user.epicRow, currentCapturedBucket);
            const currentSpend = hasSpend && rowInCapturedBucket(user.spendRow, currentCapturedBucket);
            const canDerive = currentEpic && currentSpend;
            const rawEstimate = estimateFromSpend(spendValue, user.isVip);
            const estimate = rawEstimate;
            const estimateStatus = canDerive
                ? estimate.estimateStatus
                : localEstimateStatus({
                    hasEpic,
                    hasSpend,
                    currentEpic,
                    currentSpend,
                    currentCapturedBucket
                });
            const probability = canDerive && estimateStatus === 'complete_days'
                ? estimatedProbability(epicTotal, spendValue, user.isVip)
                : null;
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
                spendUsd: rawEstimate.spendUsd,
                estimatedDays: estimate.estimatedDays,
                paidPulls: estimate.paidPulls,
                freePulls: estimate.freePulls,
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
        if (state.pinnedUserIds.has(normalized)) {
            state.pinnedUserIds.delete(normalized);
        } else {
            if (state.pinnedUserIds.size >= MAX_PINNED_USERS) {
                setStatus(`最多置顶 ${MAX_PINNED_USERS} 位用户`);
                return;
            }
            state.pinnedUserIds.add(normalized);
        }
        savePinnedUsers(seasonId, state.pinnedUserIds);
        if (state.remotePage) {
            loadLeaderboard().catch((error) => setStatus(`置顶用户刷新失败：${String(error && error.message || error)}`, true));
        } else {
            renderRankingsTableRows();
        }
    }

    function localLeaderboardPayload(snapshotOrBundle) {
        const normalizedSnapshots = normalizeSnapshotsForUpload(snapshotOrBundle);
        const source = mergeLocalSnapshots(normalizedSnapshots);
        const leaderboards = source && source.leaderboards;
        if (!source || !leaderboards || typeof leaderboards !== 'object') return null;
        const boardKey = `${state.board}_${state.period}`;
        const rawRows = Array.isArray(leaderboards[boardKey]) ? leaderboards[boardKey] : [];
        const epicRows = Array.isArray(leaderboards[`epic_${state.period}`]) ? leaderboards[`epic_${state.period}`] : [];
        const spendRows = Array.isArray(leaderboards[`spend_${state.period}`]) ? leaderboards[`spend_${state.period}`] : [];
        const setsRows = Array.isArray(leaderboards[`sets_${state.period}`]) ? leaderboards[`sets_${state.period}`] : [];
        const currentCapturedAt = normalizeCapturedAt(source.capturedAt, null)
            || normalizeCapturedAt(source.lastUpdatedAt, null)
            || Date.now();
        const currentCapturedBucket = Math.floor(currentCapturedAt / CAPTURE_BUCKET_MS);
        if (state.board === 'users') {
            const sort = state.sort || 'legend';
            const rows = summarizeLocalUsersFromSnapshots(normalizedSnapshots, state.period, sort, currentCapturedAt)
                .map((row, index) => ({ ...row, rank: index + 1 }));
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
                    capturedAt: currentCapturedAt,
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
        const luck = state.board === 'luck' ? localPairViews(pairs, 100, currentCapturedBucket) : null;
        const views = state.board === 'luck'
            ? luck.complete
            : rawRows.slice(0, 100).map((rawRow) => ({ row: rawRow, pair: pairByUser.get(rowUserId(rawRow)) || null }));
        const rows = views.map((view) => localEnrichedRow(view.row, view.pair, state.board, view.rankOverride === null ? undefined : view.rankOverride, currentCapturedBucket))
            .filter((row) => row.userId && Number.isFinite(row.value));
        const partialRows = state.board === 'luck'
            ? luck.partial.map((view) => localEnrichedRow(view.row, view.pair, state.board, null, currentCapturedBucket))
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
                    capturedAt: currentCapturedAt,
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
        if (state.view !== 'rankings') {
            clearRankingsRetry();
            closeTrendModal();
        }
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

    window.setDashboardView = setDashboardView;

    function requestBridgeSnapshot(options = {}) {
        if (state.bridgeRequest) return state.bridgeRequest;
        const manual = Boolean(options.manual);
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
                markUserscriptVersion(data.scriptVersion);
                if (data.ok && (Array.isArray(data.snapshots) || data.snapshot)) {
                    if (state.scriptUpdateRequired) {
                        finish(reject, userscriptUpdateError(data.scriptVersion));
                        return;
                    }
                    finish(resolve, {
                        snapshots: normalizeSnapshotsForUpload(data),
                        errors: Array.isArray(data.errors) ? data.errors : [],
                        partial: Boolean(data.partial),
                        blocked: Boolean(data.blocked),
                        retryable: Boolean(data.retryable),
                        scriptVersion: String(data.scriptVersion || '')
                    });
                } else {
                    const error = new Error(data.error || '同步脚本请求失败');
                    error.scriptVersion = String(data.scriptVersion || '');
                    error.scriptUpdateRequired = state.scriptUpdateRequired;
                    error.retryable = data.retryable !== false && !error.scriptUpdateRequired;
                    error.blocked = Boolean(data.blocked);
                    error.cooldown = Boolean(data.cooldown);
                    error.retryAt = Number(data.retryAt) || 0;
                    finish(reject, error);
                }
            };
            const timeoutId = window.setTimeout(() => {
                const error = new Error('未检测到同步脚本或请求超时');
                error.code = 'userscript_missing';
                error.retryable = false;
                finish(reject, error);
            }, BRIDGE_TIMEOUT_MS);
            window.addEventListener('message', onMessage);
            window.postMessage({ type: BRIDGE_REQUEST, requestId, manual }, window.location.origin);
        }).finally(() => {
            state.bridgeRequest = null;
        });
        return state.bridgeRequest;
    }

    async function loadLatestSnapshot(options = {}) {
        const latest = await apiGet('/api/rankings/latest', {
            cache: options.fresh ? 'reload' : 'default'
        });
        state.latest = latest;
        if (latest.snapshot) {
            syncPinnedSeason(latest.snapshot.seasonId);
            const updated = $('#rankingsUpdatedAt');
            if (updated) updated.textContent = `更新于 ${formatDate(latest.snapshot.capturedAt)}`;
        }
        return latest;
    }

    async function uploadSnapshot(snapshot, options = {}) {
        const normalizedSnapshots = normalizeSnapshotsForUpload(snapshot);
        if (!normalizedSnapshots.length || normalizedSnapshots.some((item) => {
            const observedAt = normalizeCapturedAt(item.capturedAt, null)
                || normalizeCapturedAt(item.observedAt, null);
            return !Number.isInteger(observedAt) || observedAt <= 0;
        })) {
            throw new Error('榜单快照缺少有效抓取时间');
        }
        if (shouldSkipUpload(normalizedSnapshots, options)) {
            return { ok: true, status: 'unchanged', skippedUpload: true, snapshots: [] };
        }
        const snapshotsToUpload = pendingUploadSnapshots(normalizedSnapshots, options);
        const compactSnapshots = snapshotsToUpload
            .map(compactSnapshotForUpload)
            .filter((item) => item && item.scope && item.season.id && item.season.name);
        if (!compactSnapshots.length) throw new Error('榜单观察数据为空');
        const response = await apiPost('/api/rankings/snapshots', {
            snapshots: compactSnapshots,
            source: 'card-dashboard-userscript',
            mode: options.manual ? 'manual' : 'automatic'
        });
        rememberUploadedSnapshots(rememberableUploadSnapshots(compactSnapshots, response));
        invalidateRankingsCache();
        return response;
    }

    async function ensureFreshSnapshot(force = false, retry = false, manual = false) {
        if (!force && !retry && state.localSnapshots.length && !state.settings.autoUpload) {
            setStatus('已显示本地抓取数据，尚未上传云端');
            return { localOnly: true, snapshots: state.localSnapshots };
        }
        const latest = await loadLatestSnapshot({ fresh: force || retry });
        if (!force && !retry && latest.snapshot && !latest.stale) {
            clearRankingsRetry();
            setStatus(`数据新鲜 · ${formatDate(latest.snapshot.capturedAt)}`);
            return latest;
        }

        setStatus(force
            ? '正在检查云端榜单…'
            : (latest.snapshot ? '榜单超过 3 小时，正在检查更新…' : '暂无快照，正在请求榜单…'), false, true);
        try {
            setStatus(state.bridgeReady ? '正在请求最新榜单…' : '正在等待用户脚本连接…', false, true);
            const bundle = await requestBridgeSnapshot({ manual });
            state.bridgeReady = true;
            setStatus('已收到榜单数据，正在整理…', false, true);
            state.localSnapshots = normalizeSnapshotsForUpload(bundle);
            if (!state.localSnapshots.length) throw new Error('同步脚本返回的榜单为空');
            const partial = Boolean(bundle.partial);
            const retryablePartial = !manual && partial && bundle.retryable !== false && !bundle.blocked;
            if (manual) clearRankingsRetry();
            else if (retryablePartial) scheduleRankingsRetry();
            else clearRankingsRetry();
            if (!state.settings.autoUpload) {
                setStatus(partial
                    ? bundle.blocked
                        ? '已抓取本地榜单，部分来源被限制，已暂停自动请求。'
                        : retryablePartial
                            ? `已抓取本地榜单，部分来源失败${retryStatusSuffix()}`
                            : manual
                                ? '已抓取本地榜单，部分来源失败，本次不自动重试。'
                                : '已抓取本地榜单，部分来源失败，本轮不再自动重试。'
                    : '已抓取本地榜单，未上传云端');
                renderUploadControls();
                return { localOnly: true, snapshots: state.localSnapshots };
            }
            setStatus('正在上传榜单快照…', false, true);
            const uploadResult = await uploadSnapshot(bundle, { manual });
            state.localSnapshots = [];
            if (uploadResult && uploadResult.skippedUpload) {
                setStatus(`榜单没有新数据，已跳过上传 · ${formatDate(latest.snapshot && latest.snapshot.capturedAt)}`);
                renderUploadControls();
                return { ...latest, skippedUpload: true };
            }
            const refreshed = await loadLatestSnapshot({ fresh: true });
            setStatus(partial
                ? `${bundle.blocked
                    ? '已同步，但部分来源被限制，已暂停自动请求。'
                    : retryablePartial
                        ? `已同步，但部分来源失败${retryStatusSuffix()}`
                        : manual
                            ? '已同步，但部分来源失败，本次不自动重试。'
                            : '已同步，但部分来源失败，本轮不再自动重试。'} · ${formatDate(refreshed.snapshot && refreshed.snapshot.capturedAt)}`
                : `已同步 · ${formatDate(refreshed.snapshot && refreshed.snapshot.capturedAt)}`);
            renderUploadControls();
            return refreshed;
        } catch (error) {
            const canScheduleRetry = !manual && errorCanAutoRetry(error);
            const scheduled = canScheduleRetry && scheduleRankingsRetry();
            const suffix = error && error.scriptUpdateRequired
                ? '；请点击“更新脚本”安装新版本。'
                : error && error.code === 'userscript_missing'
                    ? '；请先安装同步脚本后再刷新。'
                    : error && error.cooldown
                    ? '；请求处于冷却期，请稍后再试。'
                    : scheduled || canScheduleRetry
                        ? retryStatusSuffix()
                        : '；本轮不再自动重试。';
            setStatus(`${String(error && error.message || error)}${suffix}`, true);
            renderUploadControls();
            return latest;
        }
    }

    async function loadLeaderboard(options = {}) {
        const params = new URLSearchParams({
            board: 'users',
            period: state.period,
            sort: state.sort,
            direction: state.sortDirection,
            limit: String(state.leaderboard.limit),
            pinned: Array.from(state.pinnedUserIds).join(',')
        });
        if (state.leaderboard.cursor) params.set('cursor', state.leaderboard.cursor);
        if (state.userQuery.trim()) params.set('q', state.userQuery.trim());
        const leaderboard = await apiGet(`/api/rankings/leaderboard?${params.toString()}`, {
            fresh: options.fresh === true
        });
        state.remotePage = true;
        state.rows = (Array.isArray(leaderboard.rows) ? leaderboard.rows : []).map(enrichRankingEstimate);
        state.partialRows = (Array.isArray(leaderboard.partialRows) ? leaderboard.partialRows : []).map(enrichRankingEstimate);
        state.pinnedRows = (Array.isArray(leaderboard.pinnedRows) ? leaderboard.pinnedRows : [])
            .map(enrichRankingEstimate)
            .filter((row) => row && row.userId);
        state.leaderboard.totalRows = Math.max(0, Number(leaderboard.totalRows) || 0);
        if (leaderboard.summary) state.leaderboard.summary = leaderboard.summary;
        state.leaderboard.nextCursor = leaderboard.nextCursor || null;
        state.leaderboard.hasMore = Boolean(leaderboard.hasMore);
        if (leaderboard.snapshot) {
            state.latest = { ...(state.latest || {}), snapshot: leaderboard.snapshot };
            syncPinnedSeason(leaderboard.snapshot.seasonId);
        }
        renderLeaderboard(leaderboard);
        return leaderboard;
    }

    function resetLeaderboardPagination() {
        state.page = 1;
        state.leaderboard.cursor = null;
        state.leaderboard.nextCursor = null;
        state.leaderboard.previousCursors = [];
        state.leaderboard.hasMore = false;
    }

    async function loadRankingsView(options = {}) {
        const refresh = options === true || Boolean(options && options.refresh);
        const autoRefresh = Boolean(options && options.autoRefresh);
        const retry = Boolean(options && options.retry);
        const manualRefresh = refresh && !autoRefresh;
        if (state.busy) return;
        setBusy(true);
        setStatus(refresh
            ? '正在检查云端榜单…'
            : autoRefresh
                ? '正在检查榜单新鲜度…'
                : '正在读取云端快照…', false, true);
        try {
            let source;
            let leaderboardLoaded = false;
            if (refresh || autoRefresh) {
                source = await ensureFreshSnapshot(refresh, retry, manualRefresh);
            } else if (state.localSnapshots.length && !state.settings.autoUpload) {
                setStatus('已显示本地抓取数据，尚未上传云端');
                source = { localOnly: true, snapshots: state.localSnapshots };
            } else {
                state.remotePage = true;
                const leaderboard = await loadLeaderboard();
                leaderboardLoaded = true;
                if (!leaderboard.snapshot) {
                    state.rows = [];
                    state.partialRows = [];
                    setStatus('暂无云端快照，请点击立即刷新');
                    state.loaded = true;
                    return;
                }
                source = leaderboard;
                if (Date.now() - Number(leaderboard.snapshot.capturedAt) < AUTO_REFRESH_INTERVAL_MS) clearRankingsRetry();
                setStatus(`已读取云端快照 · ${formatDate(leaderboard.snapshot.capturedAt)}`);
            }
            if (source && source.skippedUpload && state.loaded && state.remotePage) {
                renderLeaderboard(source);
                return;
            }
            if (source && source.localOnly) {
                state.remotePage = false;
                state.pinnedRows = [];
                const payload = localLeaderboardPayload(source.snapshots);
                state.rows = payload ? payload.rows : [];
                state.partialRows = payload ? payload.partialRows : [];
                renderLeaderboard(payload || { rows: [] });
            } else {
                state.remotePage = true;
                if (!leaderboardLoaded) await loadLeaderboard({ fresh: refresh || autoRefresh });
            }
            state.loaded = true;
        } catch (error) {
            const canScheduleRetry = !manualRefresh && errorCanAutoRetry(error);
            const scheduled = canScheduleRetry && scheduleRankingsRetry();
            const suffix = error && error.scriptUpdateRequired
                ? '；请点击“更新脚本”安装新版本。'
                : error && error.code === 'userscript_missing'
                    ? '；请先安装同步脚本后再刷新。'
                    : error && error.cooldown
                    ? '；请求处于冷却期，请稍后再试。'
                    : scheduled || canScheduleRetry
                        ? retryStatusSuffix()
                        : '；本轮不再自动重试。';
            setStatus(`读取失败：${String(error && error.message || error)}${suffix}`, true);
            renderLeaderboard({ snapshot: state.latest && state.latest.snapshot });
        } finally {
            setBusy(false);
        }
    }

    async function uploadPendingSnapshot() {
        if (!state.localSnapshots.length || state.busy) return;
        if (state.scriptUpdateRequired) {
            renderUserscriptLink();
            setStatus(`同步脚本需要更新到 v${REQUIRED_USERSCRIPT_VERSION}；请点击“更新脚本”安装新版本。`, true);
            return;
        }
        setBusy(true);
        setStatus('正在上传本次榜单快照…');
        try {
            await uploadSnapshot({ snapshots: state.localSnapshots }, { manual: true });
            state.localSnapshots = [];
            const refreshed = await loadLatestSnapshot({ fresh: true });
            await loadLeaderboard({ fresh: true });
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
        const status = formatEstimateStatus(row.estimateStatus, row.isPartial, row);
        const importProtocol = window.HYBCardCalculatorImport;
        const importData = importProtocol && typeof importProtocol.buildImportData === 'function'
            ? importProtocol.buildImportData(row)
            : null;
        const importQuery = importData && typeof importProtocol.buildQuery === 'function'
            ? importProtocol.buildQuery(importData)
            : '';
        const calculatorButton = importQuery
            ? `<button class="rankings-calculator-button" type="button" data-calculator-import="${escapeHtml(importQuery)}" aria-label="将 ${escapeHtml(row.userName || row.userId)} 导入收益表" title="导入收益表">导入计算</button>`
            : `<button class="rankings-calculator-button is-disabled" type="button" disabled aria-label="${escapeHtml(row.userName || row.userId)} 数据不完整，无法导入收益表" title="数据不完整，无法导入">导入计算</button>`;
        return `<tr class="${rowClass}"${pinStyle} data-user-id="${escapeHtml(row.userId)}">
            <td class="rank-number">${formatNumber(rankNumber)}</td>
            <td class="rank-vip-cell">${row.isVip ? '<span class="rank-vip">VIP</span>' : ''}</td>
            <td class="rank-user-cell"><span class="rank-user-button"><button class="rankings-pin-button" type="button" data-pin-user="${escapeHtml(row.userId)}" data-user-name="${escapeHtml(row.userName || row.userId)}" aria-pressed="false" aria-label="置顶 ${escapeHtml(row.userName || row.userId)}" title="置顶用户"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.25 2.75h3.5L9 6.75l2.75 2.75H4.25L7 6.75l-.75-4Z"/><path d="M8 9.5v3.75M6.25 13.25h3.5"/></svg></button>${avatar}<span>${escapeHtml(row.userName || row.userId)}</span></span></td>
            <td class="rank-legend">${formatOptionalNumber(row.epicTotal)}</td>
            <td class="rank-spend">${formatOptionalUsd(row.spendUsd)}</td>
            <td class="rank-paid-pulls">${formatOptionalNumber(row.paidPulls)}</td>
            <td class="rank-free-pulls">${formatOptionalNumber(row.freePulls)}</td>
            <td class="rank-sets">${formatOptionalNumber(row.exchangeCount)}</td>
            <td class="rank-probability">${formatOptionalProbability(row.estimatedLegendProbability)}</td>
            <td class="rank-status ${row.isPartial ? 'is-partial' : ''}">${status}</td>
            <td class="rank-trend"><button class="rankings-trend-trigger" type="button" data-trend-user="${escapeHtml(row.userId)}" aria-label="查看 ${escapeHtml(row.userName || row.userId)} 趋势" title="查看趋势"><svg class="rankings-trend-trigger-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5 5.5 9l2.5 2 5.5-6"/><path d="M10.5 5H14v3.5"/></svg></button></td>
            <td class="rank-calculator">${calculatorButton}</td>
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
        container.querySelectorAll('[data-calculator-import]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const protocol = window.HYBCardCalculatorImport;
                if (!protocol || typeof protocol.readQuery !== 'function' || typeof window.applyCalculatorImport !== 'function') return;
                const data = protocol.readQuery(button.dataset.calculatorImport);
                if (data) window.applyCalculatorImport(data, { updateUrl: true, captureUndo: true });
            });
        });
        container.querySelectorAll('[data-pin-user]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                togglePinnedUser(button.dataset.pinUser);
            });
        });
    }

    function rankingsPageMeta(totalRows) {
        const total = Math.max(0, Number(totalRows) || 0);
        const pageSize = Math.max(1, Number(state.pageSize) || 50);
        const pageCount = Math.max(1, Math.ceil(total / pageSize));
        state.page = Math.min(Math.max(1, Number(state.page) || 1), pageCount);
        return {
            total,
            pageSize,
            pageCount,
            offset: Number.isFinite(pageSize) ? (state.page - 1) * pageSize : 0
        };
    }

    function renderRankingsPagination(totalRows, pageCount) {
        const summary = $('#rankingsPaginationSummary');
        const controls = $('#rankingsPaginationControls');
        const pageSize = $('#rankingsPageSize');
        const indicator = $('#rankingsPageIndicator');
        const previous = $('#rankingsPreviousPage');
        const next = $('#rankingsNextPage');
        if (summary) summary.textContent = `共 ${formatNumber(totalRows)} 位用户`;
        if (pageSize) pageSize.value = String(state.pageSize);
        if (indicator) indicator.textContent = `${state.page} / ${pageCount}`;
        if (previous) previous.disabled = state.page <= 1;
        if (next) next.disabled = state.page >= pageCount;
        if (controls) controls.dataset.pageCount = String(pageCount);
    }

    function renderRankingsTableRows() {
        const body = $('#rankingsTableBody');
        const pinnedBody = $('#rankingsPinnedBody');
        if (!body) return;

        if (state.remotePage) {
            const visibleRows = state.rows.filter((row) => !state.onlyCompleteDays || isCompleteDayRow(row));
            const pinnedRows = state.pinnedRows
                .filter((row) => !state.onlyCompleteDays || isCompleteDayRow(row))
                .filter((row) => state.pinnedUserIds.has(row.userId));
            const normalRows = visibleRows.filter((row) => !state.pinnedUserIds.has(row.userId));
            if (pinnedBody) {
                pinnedBody.innerHTML = pinnedRows
                    .map((row, index) => renderRankingsRow(row, Number(row.rank) || index + 1, true, index))
                    .join('');
            }
            body.innerHTML = normalRows.length
                ? normalRows.map((row, index) => renderRankingsRow(row, Number(row.rank) || index + 1)).join('')
                : pinnedRows.length
                    ? ''
                    : `<tr><td class="rankings-empty" colspan="12">${state.onlyCompleteDays ? '没有符合条件的完整天数用户' : state.userQuery ? '没有匹配的用户' : '暂无榜单数据'}</td></tr>`;
            const summaryRows = [...pinnedRows, ...normalRows];
            const summary = $('#rankingsPaginationSummary');
            const controls = $('#rankingsPaginationControls');
            const pageSize = $('#rankingsPageSize');
            const indicator = $('#rankingsPageIndicator');
            const previous = $('#rankingsPreviousPage');
            const next = $('#rankingsNextPage');
            if (summary) summary.textContent = `第 ${state.page} 页 · 当前 ${formatNumber(summaryRows.length)} 位用户`;
            if (pageSize) pageSize.value = String(state.leaderboard.limit);
            if (indicator) indicator.textContent = `第 ${state.page} 页`;
            if (previous) previous.disabled = state.leaderboard.previousCursors.length === 0;
            if (next) next.disabled = !state.leaderboard.hasMore;
            if (controls) controls.dataset.pageCount = state.leaderboard.hasMore ? 'more' : String(state.page);
            const partialNotice = $('#rankingsPartialNotice');
            if (partialNotice) {
                const incompleteCount = summaryRows.filter((row) => row.isPartial).length;
                partialNotice.textContent = incompleteCount
                    ? `当前表格中有 ${formatNumber(incompleteCount)} 位用户的估算数据不完整，缺失项保持空白。`
                    : '';
                partialNotice.classList.toggle('is-hidden', !incompleteCount);
            }
            bindRankingsTableEvents(pinnedBody);
            bindRankingsTableEvents(body);
            updatePinButtons();
            renderSummary(state.leaderboard.summary, [], state.leaderboard.totalRows);
            return;
        }

        const sortedRows = sortRowsForDisplay(state.rows);
        const rankByUserId = new Map(sortedRows.map((row, index) => [row.userId, index + 1]));
        const visibleRows = sortRowsForDisplay(filterUserRows(state.rows));
        const pinnedRows = visibleRows.filter((row) => state.pinnedUserIds.has(row.userId));
        const normalRows = visibleRows.filter((row) => !state.pinnedUserIds.has(row.userId));
        const pageMeta = rankingsPageMeta(normalRows.length);
        const pageRows = normalRows.slice(pageMeta.offset, pageMeta.offset + pageMeta.pageSize);

        if (pinnedBody) {
            pinnedBody.innerHTML = pinnedRows
                .map((row, index) => renderRankingsRow(row, rankByUserId.get(row.userId) || index + 1, true, index))
                .join('');
        }
        body.innerHTML = pageRows.length
            ? pageRows.map((row) => renderRankingsRow(row, rankByUserId.get(row.userId) || 0)).join('')
            : pinnedRows.length
                ? ''
                : `<tr><td class="rankings-empty" colspan="12">${state.onlyCompleteDays ? '没有符合条件的完整天数用户' : state.userQuery ? '没有匹配的用户' : '暂无榜单数据'}</td></tr>`;

        const rowsForSummary = [...pinnedRows, ...normalRows];
        renderRankingsPagination(rowsForSummary.length, pageMeta.pageCount);
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
        const localSummaryRows = state.rows.filter((row) => !state.onlyCompleteDays || isCompleteDayRow(row));
        renderSummary(null, localSummaryRows, localSummaryRows.length);
    }

    function renderLeaderboard(payload) {
        const boardLabel = '用户总览';
        const title = $('#rankingsBoardTitle');
        const updated = $('#rankingsUpdatedAt');
        if (title) title.textContent = boardLabel;
        renderRankingBoostNotice();
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

    function isCompleteDayRow(row) {
        return Boolean(row && row.estimateStatus === 'complete_days' && !row.isPartial);
    }

    function filterUserRows(rows = []) {
        const query = String(state.userQuery || '').trim().toLowerCase();
        return rows.filter((row) => {
            if (state.onlyCompleteDays && !isCompleteDayRow(row)) return false;
            if (!query) return true;
            return [row.userName, row.userId]
                .some((value) => String(value || '').toLowerCase().includes(query));
        });
    }

    function enrichRankingEstimate(row) {
        if (!row || row.spendValue == null) return row;
        const hasEpic = row.epicTotal != null && Number.isFinite(Number(row.epicTotal));
        const hasSpend = row.spendValue != null && Number.isFinite(Number(row.spendValue));
        const canDerive = hasEpic && hasSpend
            && !String(row.estimateStatus || '').startsWith('missing_');
        const estimate = estimateFromSpend(row.spendValue, row.isVip, {
            capturedAt: row.capturedAt || row.valueCapturedAt || row.value_captured_at,
            period: state.period
        });
        if (!canDerive) {
            return { ...row, spendUsd: estimate.spendUsd };
        }
        const probability = estimate.estimateStatus === 'complete_days'
            ? estimatedProbability(row.epicTotal, row.spendValue, row.isVip, {
                capturedAt: row.capturedAt || row.valueCapturedAt || row.value_captured_at,
                period: state.period
            })
            : null;
        return {
            ...row,
            spendUsd: estimate.spendUsd,
            estimatedDays: estimate.estimatedDays,
            paidPulls: estimate.paidPulls,
            freePulls: estimate.freePulls,
            estimatedPulls: estimate.estimatedPulls,
            estimateStatus: estimate.estimateStatus,
            isPartial: estimate.estimateStatus !== 'complete_days' || probability == null,
            estimatedLegendProbability: probability
        };
    }

    function formatEstimateDay(value) {
        const time = Number(value);
        if (!Number.isFinite(time) || time <= 0) return '';
        return new Date(time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    }

    function formatEstimateStatus(status, isPartial, row = {}) {
        const day = row && row.estimateUsesHistoricalData ? formatEstimateDay(row.estimateDayStartAt) : '';
        const prefix = day ? `截至 ${day} · ` : '';
        if (status === 'missing_pair') return '缺少欧皇榜与消费榜';
        if (status === 'missing_current_pair') return '当前批次缺少双榜';
        if (status === 'missing_spend') return '缺少消费榜';
        if (status === 'missing_current_spend') return '当前批次缺少消费榜';
        if (status === 'missing_epic') return '缺少欧皇榜';
        if (status === 'missing_current_epic') return '当前批次缺少欧皇榜';
        if (status === 'missing_common_day') return '暂无完整共同日期 · 暂不计算';
        if (status === 'low_sample') return `${prefix}低样本 / 数据不足`;
        if (status === 'partial_day') return `${prefix}非完整天数 · 暂不计算`;
        if (status === 'complete_days' && day) return `完整天数 · 按截至 ${day} 计算`;
        if (isPartial) return `${prefix}数据不完整 · 暂不计算`;
        return '完整天数';
    }

    function formatOptionalNumber(value) {
        return value == null || value === '' || !Number.isFinite(Number(value)) ? '' : formatNumber(value);
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

    function renderSummary(remoteSummary = null, fallbackRows = state.rows, fallbackTotalRows = fallbackRows.length) {
        const spends = fallbackRows.map((row) => row.spendUsd).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const pulls = fallbackRows.map((row) => row.estimatedPulls).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const probabilities = fallbackRows.map((row) => row.estimatedLegendProbability).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const summaryElement = $('#rankingsSummary');
        if (!summaryElement) return;
        const totalRows = remoteSummary && Number.isFinite(Number(remoteSummary.totalRows))
            ? Number(remoteSummary.totalRows)
            : fallbackTotalRows;
        const cards = [
            ['用户数', formatNumber(totalRows)],
            ['总消费 USD', remoteSummary
                ? formatOptionalUsd(remoteSummary.totalSpendUsd)
                : spends.length ? formatUsd(spends.reduce((a, b) => a + b, 0)) : '—'],
            ['平均估算抽数', remoteSummary
                ? formatOptionalNumber(remoteSummary.averageEstimatedPulls)
                : pulls.length ? formatNumber(pulls.reduce((a, b) => a + b, 0) / pulls.length) : '—'],
            ['平均出卡率', remoteSummary
                ? formatOptionalProbability(remoteSummary.averageProbability)
                : probabilities.length ? formatProbability(probabilities.reduce((a, b) => a + b, 0) / probabilities.length) : '—']
        ];
        summaryElement.innerHTML = cards.map(([label, value]) => `<article class="rankings-summary-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
    }

    function scheduleHourlyRefresh() {
        if (state.hourlyRefreshTimer) {
            window.clearTimeout(state.hourlyRefreshTimer);
            state.hourlyRefreshTimer = null;
        }
        if (!state.settings.hourlyRefresh) return;
        state.hourlyRefreshTimer = window.setTimeout(() => {
            state.hourlyRefreshTimer = null;
            runHourlyRefresh();
        }, AUTO_REFRESH_INTERVAL_MS);
    }

    async function runHourlyRefresh() {
        if (!state.settings.hourlyRefresh) return;
        if (state.busy) {
            scheduleHourlyRefresh();
            return;
        }
        try {
            await loadRankingsView({ autoRefresh: true });
        } finally {
            scheduleHourlyRefresh();
        }
    }

    function configureHourlyRefresh(options = {}) {
        if (state.hourlyRefreshTimer) {
            window.clearTimeout(state.hourlyRefreshTimer);
            state.hourlyRefreshTimer = null;
        }
        if (!state.settings.hourlyRefresh) return;
        if (options.runNow) {
            window.setTimeout(() => runHourlyRefresh(), Number(options.delayMs) || 0);
            return;
        }
        scheduleHourlyRefresh();
    }

    function bindControls() {
        document.querySelectorAll('[data-rank-board]').forEach((button) => {
            button.addEventListener('click', () => {
                state.board = button.dataset.rankBoard;
                resetLeaderboardPagination();
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
                resetLeaderboardPagination();
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
            resetLeaderboardPagination();
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
                resetLeaderboardPagination();
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
            setStatus(state.settings.hourlyRefresh
                ? '已开启每 3 小时刷新；正在首次抓取…'
                : '已关闭自动刷新；请手动点击立即刷新。');
            configureHourlyRefresh({ runNow: state.settings.hourlyRefresh });
            renderUploadControls();
        });
        const searchShell = document.querySelector('.rankings-overview-search');
        const searchInput = $('#rankingsUserSearch');
        const searchToggle = $('#rankingsSearchToggle');
        const setSearchExpanded = (expanded, focus = false) => {
            if (!searchShell) return;
            searchShell.classList.toggle('is-expanded', expanded);
            if (searchToggle) searchToggle.setAttribute('aria-expanded', String(expanded));
            if (focus && searchInput) searchInput.focus();
        };
        searchToggle?.addEventListener('click', () => {
            const expanded = searchShell && !searchShell.classList.contains('is-expanded');
            setSearchExpanded(Boolean(expanded), Boolean(expanded));
        });
        searchInput?.addEventListener('focus', () => setSearchExpanded(true));
        searchInput?.addEventListener('blur', () => {
            if (!String(searchInput.value || '').trim()) setSearchExpanded(false);
        });
        searchInput?.addEventListener('input', (event) => {
            state.userQuery = String(event.target.value || '');
            if (state.userQuery.trim()) setSearchExpanded(true);
            resetLeaderboardPagination();
            if (state.searchTimer) window.clearTimeout(state.searchTimer);
            state.searchTimer = window.setTimeout(() => {
                state.searchTimer = null;
                if (state.view === 'rankings' && state.remotePage) {
                    loadLeaderboard().catch((error) => setStatus(`搜索失败：${String(error && error.message || error)}`, true));
                } else {
                    renderLeaderboard({ snapshot: state.latest && state.latest.snapshot });
                }
            }, 250);
        });
        $('#rankingsCompleteDaysOnly')?.addEventListener('change', (event) => {
            state.onlyCompleteDays = Boolean(event.target.checked);
            state.page = 1;
            renderRankingsTableRows();
        });
        $('#rankingsPageSize')?.addEventListener('change', (event) => {
            const value = String(event.target.value || '50');
            state.pageSize = [50, 100].includes(Number(value)) ? Number(value) : 50;
            state.leaderboard.limit = state.pageSize;
            resetLeaderboardPagination();
            if (state.remotePage) loadLeaderboard().catch((error) => setStatus(`换页失败：${String(error && error.message || error)}`, true));
            else renderRankingsTableRows();
        });
        $('#rankingsPreviousPage')?.addEventListener('click', async () => {
            if (!state.remotePage || !state.leaderboard.previousCursors.length) return;
            state.leaderboard.cursor = state.leaderboard.previousCursors.pop() || null;
            state.page = Math.max(1, state.page - 1);
            try {
                await loadLeaderboard();
            } catch (error) {
                setStatus(`换页失败：${String(error && error.message || error)}`, true);
            }
        });
        $('#rankingsNextPage')?.addEventListener('click', async () => {
            if (!state.remotePage || !state.leaderboard.hasMore || !state.leaderboard.nextCursor) return;
            state.leaderboard.previousCursors.push(state.leaderboard.cursor);
            state.leaderboard.cursor = state.leaderboard.nextCursor;
            state.page += 1;
            try {
                await loadLeaderboard();
            } catch (error) {
                setStatus(`换页失败：${String(error && error.message || error)}`, true);
            }
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
            if (state.trend.modalOpen) refreshTrendHistories();
        });
        document.querySelectorAll('[data-trend-mode]').forEach((button) => {
            button.addEventListener('click', () => {
                state.trend.mode = 'daily';
                renderTrendModeButtons();
                renderTrendChart();
                if (state.trend.modalOpen) refreshTrendHistories();
            });
        });
        $('#rankingsTrendAddButton')?.addEventListener('click', addTrendUser);
        $('#rankingsTrendLoadMore')?.addEventListener('click', loadMoreTrendHistories);
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
                else runRankingsRetryNow();
            }
        });
        installRankingsRetryLifecycleListeners();
        bindControls();
        window.addEventListener('hyb:calculator-settings-changed', () => {
            renderRankingBoostNotice();
            if (state.view !== 'rankings' || !state.rows.length) return;
            state.rows = state.rows.map(enrichRankingEstimate);
            state.partialRows = state.partialRows.map(enrichRankingEstimate);
            renderRankingsTableRows();
        });
        renderSortHeaders();
        renderTrendModeButtons();
        renderTrendPeriodControl();
        renderUploadControls();
        renderRankingBoostNotice();
        setDashboardView('rankings');
        configureHourlyRefresh({ runNow: true, delayMs: 600 });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
