(function () {
    'use strict';

    const DEFAULT_SITE_CONFIG = Object.freeze({
        siteEnabled: true,
        rankingCaptureEnabled: false,
        cloudUploadEnabled: false,
        maintenanceMessage: '',
        updatedAt: 0
    });
    const ADMIN_LOGIN_ENDPOINT = '/api/admin/login';
    const ADMIN_SESSION_ENDPOINT = '/api/admin/session';
    const ADMIN_CONFIG_ENDPOINT = '/api/admin/config';
    const ADMIN_LOGOUT_ENDPOINT = '/api/admin/logout';
    const ADMIN_CSRF_HEADER = 'X-HYB-Admin-CSRF';

    const state = {
        csrfToken: '',
        busy: false,
        config: { ...DEFAULT_SITE_CONFIG }
    };

    const $ = (id) => document.getElementById(id);

    function normalizeConfig(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        return {
            siteEnabled: typeof source.siteEnabled === 'boolean' ? source.siteEnabled : DEFAULT_SITE_CONFIG.siteEnabled,
            rankingCaptureEnabled: typeof source.rankingCaptureEnabled === 'boolean' ? source.rankingCaptureEnabled : DEFAULT_SITE_CONFIG.rankingCaptureEnabled,
            cloudUploadEnabled: typeof source.cloudUploadEnabled === 'boolean' ? source.cloudUploadEnabled : DEFAULT_SITE_CONFIG.cloudUploadEnabled,
            maintenanceMessage: typeof source.maintenanceMessage === 'string' ? source.maintenanceMessage.slice(0, 240) : DEFAULT_SITE_CONFIG.maintenanceMessage,
            updatedAt: Number.isFinite(Number(source.updatedAt)) && Number(source.updatedAt) > 0
                ? Math.floor(Number(source.updatedAt))
                : DEFAULT_SITE_CONFIG.updatedAt
        };
    }

    async function requestJson(path, options = {}) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            cache: 'no-store',
            ...options,
            headers: {
                accept: 'application/json',
                ...(options.body ? { 'content-type': 'application/json' } : {}),
                ...(options.headers || {})
            }
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok === false) {
            const error = new Error(body.message || body.error || `HTTP ${response.status}`);
            error.status = response.status;
            error.code = body.error || '';
            error.retryAfter = Number(response.headers.get('retry-after')) || 0;
            throw error;
        }
        return body;
    }

    function setMessage(element, message, type = '') {
        element.textContent = message || '';
        element.classList.toggle('is-error', type === 'error');
        element.classList.toggle('is-success', type === 'success');
    }

    function setPanel(authenticated) {
        $('adminLoginPanel').hidden = authenticated;
        $('adminConfigPanel').hidden = !authenticated;
    }

    function renderConfig() {
        $('adminSiteEnabled').checked = state.config.siteEnabled;
        $('adminRankingCaptureEnabled').checked = state.config.rankingCaptureEnabled;
        $('adminCloudUploadEnabled').checked = state.config.cloudUploadEnabled;
        $('adminMaintenanceMessage').value = state.config.maintenanceMessage;
    }

    function setBusy(busy) {
        state.busy = Boolean(busy);
        $('adminLoginButton').disabled = state.busy;
        $('adminSaveButton').disabled = state.busy;
        $('adminLogoutButton').disabled = state.busy;
        $('adminPassword').disabled = state.busy;
    }

    function clearSession() {
        state.csrfToken = '';
        state.config = { ...DEFAULT_SITE_CONFIG };
        setPanel(false);
        renderConfig();
    }

    function adminErrorMessage(error, fallback) {
        if (Number(error && error.status) === 429 && Number(error.retryAfter) > 0) {
            return `登录暂时锁定，请约 ${Math.ceil(Number(error.retryAfter) / 60)} 分钟后重试。`;
        }
        if (Number(error && error.status) === 503) return '管理员服务暂时不可用，请稍后重试。';
        return fallback;
    }

    async function restoreSession() {
        try {
            const data = await requestJson(ADMIN_SESSION_ENDPOINT);
            state.csrfToken = String(data.csrfToken || '');
            state.config = normalizeConfig(data.config);
            setPanel(true);
            renderConfig();
        } catch (_) {
            clearSession();
        }
    }

    async function login(event) {
        event.preventDefault();
        const password = String($('adminPassword').value || '');
        if (!password || state.busy) return;
        setMessage($('adminLoginMessage'), '正在登录…');
        setBusy(true);
        try {
            const data = await requestJson(ADMIN_LOGIN_ENDPOINT, {
                method: 'POST',
                body: JSON.stringify({ password })
            });
            state.csrfToken = String(data.csrfToken || '');
            $('adminPassword').value = '';
            const session = await requestJson(ADMIN_SESSION_ENDPOINT);
            state.csrfToken = String(session.csrfToken || state.csrfToken);
            state.config = normalizeConfig(session.config);
            setPanel(true);
            renderConfig();
            setMessage($('adminConfigMessage'), '已登录。', 'success');
        } catch (error) {
            setMessage($('adminLoginMessage'), adminErrorMessage(error, '管理员密码错误或登录失败。'), 'error');
        } finally {
            setBusy(false);
        }
    }

    async function saveConfig(event) {
        event.preventDefault();
        if (!state.csrfToken || state.busy) return;
        const payload = {
            siteEnabled: $('adminSiteEnabled').checked,
            rankingCaptureEnabled: $('adminRankingCaptureEnabled').checked,
            cloudUploadEnabled: $('adminCloudUploadEnabled').checked,
            maintenanceMessage: String($('adminMaintenanceMessage').value || '').slice(0, 240)
        };
        setMessage($('adminConfigMessage'), '正在保存…');
        setBusy(true);
        try {
            const data = await requestJson(ADMIN_CONFIG_ENDPOINT, {
                method: 'POST',
                headers: { [ADMIN_CSRF_HEADER]: state.csrfToken },
                body: JSON.stringify(payload)
            });
            state.config = normalizeConfig(data.config);
            renderConfig();
            setMessage($('adminConfigMessage'), '配置已保存。', 'success');
        } catch (error) {
            if (Number(error && error.status) === 401 || Number(error && error.status) === 403) {
                clearSession();
                setMessage($('adminLoginMessage'), '管理员会话已失效，请重新登录。', 'error');
            } else {
                setMessage($('adminConfigMessage'), '配置保存失败，请稍后重试。', 'error');
            }
        } finally {
            setBusy(false);
        }
    }

    async function logout() {
        if (!state.csrfToken || state.busy) return;
        setBusy(true);
        try {
            await requestJson(ADMIN_LOGOUT_ENDPOINT, {
                method: 'POST',
                headers: { [ADMIN_CSRF_HEADER]: state.csrfToken }
            });
        } catch (_) {
            // Clear the local view even when the session has already expired.
        } finally {
            setBusy(false);
            clearSession();
            setMessage($('adminLoginMessage'), '已退出管理员模式。', 'success');
        }
    }

    $('adminLoginForm').addEventListener('submit', login);
    $('adminConfigForm').addEventListener('submit', saveConfig);
    $('adminLogoutButton').addEventListener('click', logout);
    setPanel(false);
    renderConfig();
    void restoreSession();
})();
