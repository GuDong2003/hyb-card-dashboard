import { handleRankingsRequest, loadSiteConfig } from './rankings-worker.js';
import { refreshCompactRankings } from './rankings-maintenance.js';
import { fetchWithRankingsCache, purgeRankingsResponseCaches } from './rankings-cache.js';

export { AdminAuth, VisitorCounter } from './rankings-worker.js';

export async function scheduled(controller, env) {
    const scheduledAt = Number(controller && controller.scheduledTime);
    const maintenanceAt = Number.isFinite(scheduledAt) && scheduledAt > 0 ? scheduledAt : Date.now();
    if (env && env.RANKINGS_HOME_CACHE && typeof env.RANKINGS_HOME_CACHE.get === 'function') {
        const siteConfig = await loadSiteConfig(env);
        if (!siteConfig.siteEnabled || !siteConfig.rankingCaptureEnabled) {
            return { skipped: true, reason: 'sync_disabled' };
        }
    }
    if (!env || !env.RANKINGS_DB) {
        throw new Error('rankings_daily_database_unavailable');
    }
    try {
        const result = await refreshCompactRankings(env.RANKINGS_DB, maintenanceAt);
        console.log('rankings_compact_maintenance', result);
        return result;
    } catch (error) {
        console.error('rankings_compact_maintenance_failed', {
            maintenanceAt,
            message: String(error && error.message || error).slice(0, 240)
        });
        throw error;
    }
}

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      const adminUrl = new URL('/admin.html', request.url);
      return env.ASSETS.fetch(new Request(adminUrl, request));
    }
    if (request.method === 'GET' && url.pathname === '/admin.html') {
      return new Response('Not Found', { status: 404 });
    }
    if (url.pathname.startsWith('/api/rankings/')) {
      const response = await fetchWithRankingsCache(request, env, ctx, handleRankingsRequest);
      if (request.method === 'POST' && url.pathname === '/api/rankings/snapshots' && response.status === 200) {
        const body = await response.clone().json().catch(() => null);
        if (body && body.ok === true && Number(body.storedSnapshots) > 0) {
          const purge = purgeRankingsResponseCaches(request);
          if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(purge);
          else await purge;
        }
      }
      return response;
    }
    if (url.pathname.startsWith('/api/')) {
      return handleRankingsRequest(request, env, ctx);
    }
        return env.ASSETS.fetch(request);
    },
    scheduled
};

export default worker;
