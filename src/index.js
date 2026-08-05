import { handleRankingsRequest } from './rankings-worker.js';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/rankings/')) {
            return handleRankingsRequest(request, env);
        }
        return env.ASSETS.fetch(request);
    }
};
