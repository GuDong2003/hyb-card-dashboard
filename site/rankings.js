(function () {
    'use strict';

    const BRIDGE_READY = 'HYB_CARD_RANKINGS_BRIDGE_READY';
    const BRIDGE_REQUEST = 'HYB_CARD_RANKINGS_REQUEST';
    const BRIDGE_RESPONSE = 'HYB_CARD_RANKINGS_RESPONSE';
    const BRIDGE_TIMEOUT_MS = 22000;
    const SETTINGS_STORAGE_KEY = 'hyb-card-rankings-settings-v1';
    const SPEND_VALUE_PER_USD = 500000;
    const VIP_DAILY_SPEND_USD = 6000;
    const VIP_DAILY_PULLS = 650;
    const ORDINARY_DAILY_SPEND_USD = 4000;
    const ORDINARY_DAILY_PULLS = 430;

    const BOARD_LABELS = Object.freeze({ epic: '欧皇榜', spend: '消费榜', sets: '兑换榜', luck: '运气榜' });
    const PERIOD_LABELS = Object.freeze({ today: '今日', week: '本周', month: '本月', total: '整个赛季' });

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
        board: 'users',
        period: 'total',
        sort: 'probability',
        settings: loadSettings(),
        latest: null,
        localSnapshot: null,
        loaded: false,
        busy: false,
        bridgeReady: false,
        bridgeRequest: null,
        rows: [],
        events: [],
        partialRows: [],
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

    function summarizeLocalUsers(epicRows = [], spendRows = [], setsRows = [], sort = 'probability') {
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
        const value = (row) => sort === 'spend' ? row.spendUsd : sort === 'pulls' ? row.estimatedPulls : sort === 'sets' ? row.exchangeCount : row.estimatedLegendProbability;
        const leftValue = value(left);
        const rightValue = value(right);
        if (leftValue == null && rightValue == null) return left.userId.localeCompare(right.userId);
        if (leftValue == null) return 1;
        if (rightValue == null) return -1;
        return rightValue - leftValue || left.userId.localeCompare(right.userId);
    }

    function localLeaderboardPayload(snapshot) {
        const source = snapshotSource(snapshot);
        const leaderboards = source && source.leaderboards;
        if (!source || !leaderboards || typeof leaderboards !== 'object') return null;
        const boardKey = `${state.board}_${state.period}`;
        const rawRows = Array.isArray(leaderboards[boardKey]) ? leaderboards[boardKey] : [];
        const epicRows = Array.isArray(leaderboards[`epic_${state.period}`]) ? leaderboards[`epic_${state.period}`] : [];
        const spendRows = Array.isArray(leaderboards[`spend_${state.period}`]) ? leaderboards[`spend_${state.period}`] : [];
        const setsRows = Array.isArray(leaderboards[`sets_${state.period}`]) ? leaderboards[`sets_${state.period}`] : [];
        if (state.board === 'users') {
            const sort = state.sort || 'probability';
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
                    capturedAt: Number(source.capturedAt) || Date.now(),
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
                capturedAt: Number(source.capturedAt) || Date.now(),
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
        const query = `/api/rankings/leaderboard?board=users&period=${encodeURIComponent(state.period)}&sort=${encodeURIComponent(state.sort)}`;
        const leaderboard = await apiGet(query);
        state.rows = Array.isArray(leaderboard.rows) ? leaderboard.rows : [];
        state.partialRows = Array.isArray(leaderboard.partialRows) ? leaderboard.partialRows : [];
        state.events = [];
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
                state.partialRows = payload ? payload.partialRows : [];
                state.events = [];
                renderLeaderboard(payload || { rows: [] });
            } else {
                await loadLeaderboard();
            }
            state.loaded = true;
        } catch (error) {
            setStatus(String(error && error.message || error), true);
            state.partialRows = [];
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
        const boardLabel = '用户总览';
        const periodLabel = PERIOD_LABELS[state.period];
        const kicker = $('#rankingsBoardKicker');
        const title = $('#rankingsBoardTitle');
        const updated = $('#rankingsUpdatedAt');
        if (kicker) kicker.textContent = `users · ${state.period}`;
        if (title) title.textContent = `${boardLabel} · ${periodLabel}`;
        if (updated && payload.snapshot) updated.textContent = `更新于 ${formatDate(payload.snapshot.capturedAt)}`;

        const body = $('#rankingsTableBody');
        if (!body) return;
        const visibleRows = state.rows;
        const partialNotice = $('#rankingsPartialNotice');
        if (partialNotice) {
            const incompleteCount = state.rows.filter((row) => row.isPartial).length;
            partialNotice.textContent = incompleteCount
                ? `当前表格中有 ${formatNumber(incompleteCount)} 位用户的估算数据不完整，缺失项保持空白。`
                : '';
            partialNotice.classList.toggle('is-hidden', !incompleteCount);
        }
        if (!visibleRows.length) {
            body.innerHTML = '<tr><td class="rankings-empty" colspan="8">暂无榜单数据</td></tr>';
        } else {
            body.innerHTML = visibleRows.map((row) => {
                const rowClass = [
                    row.isPartial ? 'is-partial' : ''
                ].filter(Boolean).join(' ');
                const avatar = row.avatar
                    ? `<img class="rank-avatar" data-initials="${initials(row.userName)}" src="${escapeHtml(row.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
                    : `<span class="rank-avatar-fallback">${initials(row.userName)}</span>`;
                const status = formatEstimateStatus(row.estimateStatus, row.isPartial);
                return `<tr class="${rowClass}" data-user-id="${escapeHtml(row.userId)}">
                    <td class="rank-number">${row.rank == null ? '—' : formatNumber(row.rank)}</td>
                    <td class="rank-user-cell"><button class="rank-user-button" type="button" data-user-id="${escapeHtml(row.userId)}">${avatar}<span>${escapeHtml(row.userName || row.userId)}</span></button></td>
                    <td>${row.isVip ? '<span class="rank-vip">VIP</span>' : ''}</td>
                    <td class="rank-spend">${formatOptionalUsd(row.spendUsd)}</td>
                    <td class="rank-pulls">${formatOptionalNumber(row.estimatedPulls)}</td>
                    <td class="rank-sets">${formatOptionalNumber(row.exchangeCount)}</td>
                    <td class="rank-probability">${formatOptionalProbability(row.estimatedLegendProbability)}</td>
                    <td class="rank-status ${row.isPartial ? 'is-partial' : ''}">${status}</td>
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

    function renderSummary() {
        const spends = state.rows.map((row) => row.spendUsd).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const pulls = state.rows.map((row) => row.estimatedPulls).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const probabilities = state.rows.map((row) => row.estimatedLegendProbability).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
        const summary = $('#rankingsSummary');
        if (!summary) return;
        const cards = [
            ['用户数', formatNumber(state.rows.length)],
            ['总消费 USD', spends.length ? formatUsd(spends.reduce((a, b) => a + b, 0)) : '—'],
            ['平均估算抽数', pulls.length ? formatDecimal(pulls.reduce((a, b) => a + b, 0) / pulls.length) : '—'],
            ['平均出卡率', probabilities.length ? formatProbability(probabilities.reduce((a, b) => a + b, 0) / probabilities.length) : '—']
        ];
        summary.innerHTML = cards.map(([label, value]) => `<article class="rankings-summary-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
    }

    function renderEvents() {
        const container = $('#rankingsEvents');
        if (!container) return;
        if (state.board === 'users') {
            container.innerHTML = '';
            return;
        }
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
            target.innerHTML = `<div class="rankings-user-summary"><strong>${escapeHtml(latest.userName || latest.userId)}</strong><span>${latest.isVip ? 'VIP' : '普通用户'} · ${escapeHtml(latest.userId)}</span></div><div class="rank-history-list">${rows.slice(0, 40).map((row) => `<div class="rank-history-row"><span>${escapeHtml(row.boardKey)}</span><strong>#${formatNumber(row.rank)}</strong><span>${row.boardKey.startsWith('spend_') ? formatUsd(Number(row.value) / SPEND_VALUE_PER_USD) : formatNumber(row.value)}</span><time>${formatDate(row.capturedAt)}</time></div>`).join('')}</div>`;
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
        $('#rankingsPeriodSelect')?.addEventListener('change', (event) => {
            state.period = event.target.value || 'total';
            if (state.view === 'rankings') loadRankingsView();
        });
        $('#rankingsSortSelect')?.addEventListener('change', (event) => {
            state.sort = event.target.value || 'probability';
            if (state.view === 'rankings') loadRankingsView();
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
