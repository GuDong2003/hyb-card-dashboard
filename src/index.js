import { handleRankingsRequest } from './rankings-worker.js';
import { refreshCompactRankings } from './rankings-maintenance.js';

export async function scheduled(controller, env) {
    const scheduledAt = Number(controller && controller.scheduledTime);
    const maintenanceAt = Number.isFinite(scheduledAt) && scheduledAt > 0 ? scheduledAt : Date.now();
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
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/rankings/')) {
            return handleRankingsRequest(request, env);
        }
        return env.ASSETS.fetch(request);
    },
    scheduled
};

export default worker;
