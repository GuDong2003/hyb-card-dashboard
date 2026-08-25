import { handleRankingsRequest } from './rankings-worker.js';
import { aggregateRankingsDay, previousBeijingDayStart } from './rankings-daily.js';

export async function scheduled(controller, env) {
    const scheduledAt = Number(controller && controller.scheduledTime);
    const dayStartAt = previousBeijingDayStart(
        Number.isFinite(scheduledAt) && scheduledAt > 0 ? scheduledAt : Date.now()
    );
    if (!env || !env.RANKINGS_DB || dayStartAt == null) {
        throw new Error('rankings_daily_database_unavailable');
    }
    try {
        const result = await aggregateRankingsDay(env.RANKINGS_DB, dayStartAt);
        console.log('rankings_daily_aggregated', result);
        return result;
    } catch (error) {
        console.error('rankings_daily_aggregation_failed', {
            dayStartAt,
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
