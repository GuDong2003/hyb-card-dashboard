(function () {
    'use strict';

    const BRIDGE_READY = 'HYB_CARD_RANKINGS_BRIDGE_READY';
    const BRIDGE_REQUEST = 'HYB_CARD_RANKINGS_REQUEST';
    const BRIDGE_RESPONSE = 'HYB_CARD_RANKINGS_RESPONSE';
    const BRIDGE_TIMEOUT_MS = 9000;
    const SETTINGS_STORAGE_KEY = 'hyb-card-rankings-settings-v1';
    const DAY_MS = 24 * 60 * 60 * 1000;
    const DEFAULT_SEASON_START_AT = Date.parse('2026-08-02T04:00:00+08:00');

    const BOARD_LABELS = Object.freeze({ epic: '欧皇榜', spend: '消费榜', sets: '兑换榜' });
    const PERIOD_LABELS = Object.freeze({ today: '今日', week: '本周', month: '本月', total: '赛季' });

    function loadSettings() {
        try {
            const stored = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}') || {};
            return { autoUpload: stored.autoUpload === true };
        } catch (_) {
            return { autoUpload: false };
        }
    }

    function saveSettings(settings) {
        try {
            window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
                autoUpload: settings.autoUpload === true
            }));
        } catch (_) {
            // Private browsing or storage restrictions must not block rankings viewing.
        }
    }

    const state = {
        view: 'calculator',
        board: 'epic',
        period: 'today',
        settings: loadSettings(),
        latest: null,
        localSnapshot: null,
        loaded: false,
        busy: false,
        bridgeReady: false,
        bridgeRequest: null,
        rows: [],
        events: [],
        selectedUserId: '',
        status: '等待榜单数据'
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

    function setStatus(message, isError = false) {
        state.status = message;
        const element = $('#rankingsStatus');
        if (!element) return;
        element.textContent = message;
        element.classList.toggle('is-error', Boolean(isError));
    }

    function setBusy(busy) {
        state.busy = Boolean(busy);
        const button = $('#rankingsRefreshButton');
        if (button) {
            button.disabled = state.busy;
            button.textContent = state.busy ? '同步中…' : '检查更新';
        }
        renderUploadControls();
    }

    function renderUploadControls() {
        const toggle = $('#rankingsAutoUpload');
        if (toggle) toggle.checked = state.settings.autoUpload === true;
        const uploadButton = $('#rankingsUploadButton');
        if (uploadButton) {
            uploadButton.disabled = state.busy || !state.localSnapshot;
            uploadButton.textContent = state.localSnapshot ? '上传本次快照' : '暂无待上传快照';
        }
        const localStatus = $('#rankingsUploadStatus');
        if (localStatus) {
            localStatus.textContent = state.localSnapshot
                ? (state.settings.autoUpload ? '自动上传已开启' : '本次抓取仅保存在当前页面')
                : '尚无待上传的本地快照';
        }
    }

    function formatNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.round(number).toLocaleString('zh-CN') : '—';
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

    function rowUserId(row) {
        return String(row && (row.userId ?? row.user_id ?? row.id) || '').trim();
    }

    function rowName(row, userId) {
        return String(row && (row.userName ?? row.user_name ?? row.name) || userId).trim();
    }

    function rowValue(row) {
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

    function elapsedSeasonDays() {
        return Math.max(1, Math.min(90, Math.floor((Date.now() - DEFAULT_SEASON_START_AT) / DAY_MS) + 1));
    }

    function estimatedProbability(epicTotal, spendTotal, isVip) {
        const pulls = Number(spendTotal || 0) / 10 + elapsedSeasonDays() * (isVip ? 50 : 30);
        return pulls > 0 && Number.isFinite(epicTotal) ? Number(epicTotal) / pulls : null;
    }

    function localLeaderboardPayload(snapshot) {
        const source = snapshotSource(snapshot);
        const leaderboards = source && source.leaderboards;
        if (!source || !leaderboards || typeof leaderboards !== 'object') return null;
        const boardKey = `${state.board}_${state.period}`;
        const rawRows = Array.isArray(leaderboards[boardKey]) ? leaderboards[boardKey] : [];
        const epicRows = Array.isArray(leaderboards.epic_total) ? leaderboards.epic_total : [];
        const spendRows = Array.isArray(leaderboards.spend_total) ? leaderboards.spend_total : [];
        const epicByUser = new Map(epicRows.map((row) => [rowUserId(row), rowValue(row)]));
        const spendByUser = new Map(spendRows.map((row) => [rowUserId(row), rowValue(row)]));
        const rows = rawRows.slice(0, 100).map((rawRow, index) => {
            const userId = rowUserId(rawRow);
            const userName = rowName(rawRow, userId);
            const isVip = rowIsVip(rawRow);
            const epicTotal = epicByUser.get(userId) ?? (state.board === 'epic' && state.period === 'total' ? rowValue(rawRow) : null);
            const spendTotal = spendByUser.get(userId) ?? (state.board === 'spend' && state.period === 'total' ? rowValue(rawRow) : null);
            return {
                snapshotId: null,
                boardKey,
                userId,
                userName,
                avatar: rowAvatar(rawRow),
                value: rowValue(rawRow) ?? 0,
                rank: rowRank(rawRow, index + 1),
                isVip,
                previousRank: null,
                previousValue: null,
                rankDelta: null,
                valueDelta: null,
                event: '',
                epicTotal,
                spendTotal,
                estimatedPulls: epicTotal == null && spendTotal == null
                    ? null
                    : Number(spendTotal || 0) / 10 + elapsedSeasonDays() * (isVip ? 50 : 30),
                estimatedLegendProbability: estimatedProbability(epicTotal, spendTotal, isVip)
            };
        }).filter((row) => row.userId && Number.isFinite(row.value));
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
                capturedAt: Number(source.capturedAt) || Date.now(),
                source: 'local-unsent'
            },
            previousSnapshot: null,
            elapsedDays: elapsedSeasonDays(),
            estimated: true,
            localOnly: true,
            rows
        };
    }

    function setDashboardView(view) {
        state.view = view === 'rankings' ? 'rankings' : 'calculator';
        const calculator = $('#calculatorView');
        const rankings = $('#rankingsView');
        if (calculator) calculator.classList.toggle('is-hidden', state.view !== 'calculator');
        if (rankings) rankings.classList.toggle('is-hidden', state.view !== 'rankings');
        document.querySelectorAll('[data-view]').forEach((button) => {
            const active = button.dataset.view === state.view;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        if (state.view === 'rankings') loadRankingsView();
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
                if (data.ok && data.snapshot) finish(resolve, data.snapshot);
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
            const updated = $('#rankingsUpdatedAt');
            if (updated) updated.textContent = `更新于 ${formatDate(latest.snapshot.capturedAt)}`;
        }
        return latest;
    }

    async function uploadSnapshot(snapshot) {
        return apiPost('/api/rankings/snapshots', { snapshot, source: 'card-dashboard-userscript' });
    }

    async function ensureFreshSnapshot(force = false) {
        if (!force && state.localSnapshot && !state.settings.autoUpload) {
            setStatus('已显示本地抓取数据，尚未上传云端');
            return { localOnly: true, snapshot: state.localSnapshot };
        }
        const latest = await loadLatestSnapshot();
        if (latest.snapshot && !latest.stale) {
            setStatus(`数据新鲜 · ${formatDate(latest.snapshot.capturedAt)}`);
            return latest;
        }

        setStatus(latest.snapshot ? '榜单超过 1 小时，正在检查更新…' : '暂无快照，正在请求榜单…');
        try {
            const snapshot = await requestBridgeSnapshot();
            state.bridgeReady = true;
            state.localSnapshot = snapshot;
            if (!state.settings.autoUpload) {
                setStatus('已抓取本地榜单，未上传云端');
                renderUploadControls();
                return { localOnly: true, snapshot };
            }
            await uploadSnapshot(snapshot);
            state.localSnapshot = null;
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
        const query = `/api/rankings/leaderboard?board=${encodeURIComponent(state.board)}&period=${encodeURIComponent(state.period)}&limit=100`;
        const [leaderboard, events] = await Promise.all([
            apiGet(query),
            apiGet(`/api/rankings/events?board=${encodeURIComponent(state.board)}`).catch(() => ({ events: [] }))
        ]);
        state.rows = Array.isArray(leaderboard.rows) ? leaderboard.rows : [];
        state.events = Array.isArray(events.events) ? events.events : [];
        renderLeaderboard(leaderboard);
    }

    async function loadRankingsView(force = false) {
        if (state.busy) return;
        setBusy(true);
        try {
            const source = await ensureFreshSnapshot(force);
            if (source && source.localOnly) {
                const payload = localLeaderboardPayload(source.snapshot);
                state.rows = payload ? payload.rows : [];
                state.events = [];
                renderLeaderboard(payload || { rows: [] });
            } else {
                await loadLeaderboard();
            }
            state.loaded = true;
        } catch (error) {
            setStatus(String(error && error.message || error), true);
            renderLeaderboard({ rows: [] });
        } finally {
            setBusy(false);
        }
    }

    async function uploadPendingSnapshot() {
        if (!state.localSnapshot || state.busy) return;
        setBusy(true);
        setStatus('正在上传本次榜单快照…');
        try {
            await uploadSnapshot(state.localSnapshot);
            state.localSnapshot = null;
            const refreshed = await loadLatestSnapshot();
            await loadLeaderboard();
            setStatus(`已上传并同步 · ${formatDate(refreshed.snapshot && refreshed.snapshot.capturedAt)}`);
        } catch (error) {
            setStatus(`上传失败：${String(error && error.message || error)}`, true);
        } finally {
            setBusy(false);
            renderUploadControls();
        }
    }

    function renderLeaderboard(payload) {
        const boardLabel = BOARD_LABELS[state.board];
        const periodLabel = PERIOD_LABELS[state.period];
        const kicker = $('#rankingsBoardKicker');
        const title = $('#rankingsBoardTitle');
        const updated = $('#rankingsUpdatedAt');
        if (kicker) kicker.textContent = `${state.board} · ${state.period}`;
        if (title) title.textContent = `${boardLabel} · ${periodLabel}`;
        if (updated && payload.snapshot) updated.textContent = `更新于 ${formatDate(payload.snapshot.capturedAt)}`;

        const body = $('#rankingsTableBody');
        if (!body) return;
        if (!state.rows.length) {
            body.innerHTML = '<tr><td class="rankings-empty" colspan="6">暂无榜单数据</td></tr>';
        } else {
            body.innerHTML = state.rows.map((row) => {
                const changeClass = Number(row.rankDelta) > 0 ? 'is-positive' : Number(row.rankDelta) < 0 ? 'is-negative' : '';
                const rowClass = row.event === 'entered' ? 'is-entered' : row.event === 'left' ? 'is-left' : '';
                const avatar = row.avatar
                    ? `<img class="rank-avatar" data-initials="${initials(row.userName)}" src="${escapeHtml(row.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
                    : `<span class="rank-avatar-fallback">${initials(row.userName)}</span>`;
                return `<tr class="${rowClass}" data-user-id="${escapeHtml(row.userId)}">
                    <td class="rank-number">${formatNumber(row.rank)}</td>
                    <td class="rank-user-cell"><button class="rank-user-button" type="button" data-user-id="${escapeHtml(row.userId)}">${avatar}<span>${escapeHtml(row.userName || row.userId)}</span></button></td>
                    <td>${row.isVip ? '<span class="rank-vip">VIP</span>' : '—'}</td>
                    <td class="rank-value">${formatNumber(row.value)}</td>
                    <td class="rank-change ${changeClass}">${formatRankChange(row)}</td>
                    <td class="rank-probability">${formatProbability(row.estimatedLegendProbability)}</td>
                </tr>`;
            }).join('');
        }
        body.querySelectorAll('[data-user-id]').forEach((element) => {
            element.addEventListener('click', () => loadUserHistory(element.dataset.userId));
        });
        body.querySelectorAll('img.rank-avatar').forEach((image) => {
            image.addEventListener('error', () => {
                const fallback = document.createElement('span');
                fallback.className = 'rank-avatar-fallback';
                fallback.textContent = image.dataset.initials || '?';
                image.replaceWith(fallback);
            }, { once: true });
        });
        renderSummary();
        renderEvents();
    }

    function formatRankChange(row) {
        if (row.event === 'entered') return '<span class="rank-event">入榜</span>';
        if (row.event === 'left') return '<span class="rank-event is-left">出榜</span>';
        const delta = Number(row.rankDelta);
        if (!Number.isFinite(delta) || delta === 0) return '—';
        return delta > 0 ? `↑ ${delta}` : `↓ ${Math.abs(delta)}`;
    }

    function renderSummary() {
        const values = state.rows.map((row) => Number(row.value)).filter(Number.isFinite);
        const probabilities = state.rows.map((row) => Number(row.estimatedLegendProbability)).filter(Number.isFinite);
        const rising = state.rows.filter((row) => Number(row.rankDelta) > 0).length;
        const summary = $('#rankingsSummary');
        if (!summary) return;
        const cards = [
            ['当前榜单人数', formatNumber(state.rows.length)],
            ['榜首当前值', values.length ? formatNumber(Math.max(...values)) : '—'],
            ['平均估算传说概率', probabilities.length ? formatProbability(probabilities.reduce((a, b) => a + b, 0) / probabilities.length) : '—'],
            ['较上次上升', formatNumber(rising)]
        ];
        summary.innerHTML = cards.map(([label, value]) => `<article class="rankings-summary-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
    }

    function renderEvents() {
        const container = $('#rankingsEvents');
        if (!container) return;
        const recent = state.events.slice(-8).reverse();
        if (!recent.length) {
            container.innerHTML = '<div class="rankings-empty">暂无入榜/出榜事件</div>';
            return;
        }
        container.innerHTML = `<h3>最近变化</h3>${recent.map((event) => {
            const label = event.event === 'entered' ? '入榜' : event.event === 'left' ? '出榜' : '排名变化';
            return `<div class="rank-event-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(event.userName || event.userId || '')}</span><time>${formatDate(event.capturedAt)}</time></div>`;
        }).join('')}`;
    }

    async function searchUsers() {
        const input = $('#rankingsUserSearch');
        const target = $('#rankingsSearchResults');
        if (!input || !target) return;
        const query = input.value.trim();
        if (!query) {
            target.innerHTML = '';
            return;
        }
        target.innerHTML = '<div class="rankings-loading">搜索中…</div>';
        try {
            const result = await apiGet(`/api/rankings/users?query=${encodeURIComponent(query)}`);
            const users = Array.isArray(result.users) ? result.users : [];
            target.innerHTML = users.length ? users.map((user) => `<button type="button" class="rank-search-result" data-user-id="${escapeHtml(user.userId)}"><span class="rank-avatar-fallback">${initials(user.userName)}</span><span><strong>${escapeHtml(user.userName || user.userId)}</strong><small>${escapeHtml(user.userId)}</small></span></button>`).join('') : '<div class="rankings-empty">没有找到历史用户</div>';
            target.querySelectorAll('[data-user-id]').forEach((element) => element.addEventListener('click', () => loadUserHistory(element.dataset.userId)));
        } catch (error) {
            target.innerHTML = `<div class="rankings-error">${escapeHtml(error.message || error)}</div>`;
        }
    }

    async function loadUserHistory(userId) {
        if (!userId) return;
        state.selectedUserId = userId;
        const target = $('#rankingsUserDetail');
        if (!target) return;
        target.innerHTML = '<div class="rankings-loading">加载历史中…</div>';
        try {
            const result = await apiGet(`/api/rankings/history?userId=${encodeURIComponent(userId)}`);
            const rows = Array.isArray(result.rows) ? result.rows.slice().reverse() : [];
            if (!rows.length) {
                target.innerHTML = '<div class="rankings-empty">暂无历史记录</div>';
                return;
            }
            const latest = rows[0];
            target.innerHTML = `<div class="rankings-user-summary"><strong>${escapeHtml(latest.userName || latest.userId)}</strong><span>${latest.isVip ? 'VIP' : '普通用户'} · ${escapeHtml(latest.userId)}</span></div><div class="rank-history-list">${rows.slice(0, 40).map((row) => `<div class="rank-history-row"><span>${escapeHtml(row.boardKey)}</span><strong>#${formatNumber(row.rank)}</strong><span>${formatNumber(row.value)}</span><time>${formatDate(row.capturedAt)}</time></div>`).join('')}</div>`;
        } catch (error) {
            target.innerHTML = `<div class="rankings-error">${escapeHtml(error.message || error)}</div>`;
        }
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
                if (state.view === 'rankings') loadRankingsView();
            });
        });
        document.querySelectorAll('[data-rank-period]').forEach((button) => {
            button.addEventListener('click', () => {
                state.period = button.dataset.rankPeriod;
                document.querySelectorAll('[data-rank-period]').forEach((item) => {
                    const active = item === button;
                    item.classList.toggle('is-active', active);
                    item.setAttribute('aria-selected', String(active));
                });
                if (state.view === 'rankings') loadRankingsView();
            });
        });
        $('#rankingsRefreshButton')?.addEventListener('click', () => loadRankingsView(true));
        $('#rankingsUploadButton')?.addEventListener('click', uploadPendingSnapshot);
        $('#rankingsAutoUpload')?.addEventListener('change', (event) => {
            state.settings.autoUpload = Boolean(event.target.checked);
            saveSettings(state.settings);
            setStatus(state.settings.autoUpload
                ? '已开启抓取后自动上传云端。'
                : '已关闭自动上传；只有手动点击上传才会提交云端。');
            renderUploadControls();
        });
        $('#rankingsSearchButton')?.addEventListener('click', searchUsers);
        $('#rankingsUserSearch')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') searchUsers();
        });
    }

    function init() {
        window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin) return;
            if (event.data && event.data.type === BRIDGE_READY) {
                state.bridgeReady = true;
            }
        });
        bindControls();
        renderUploadControls();
        setDashboardView('calculator');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
