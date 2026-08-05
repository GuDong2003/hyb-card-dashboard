(function attachStardustRules(global) {
    const MAX_DISSOLVE_PER_DAY = 20;
    const DUST_PER_DISSOLVED_HISTORIC = 50;
    const VIP_FEE_PER_DISSOLVED_HISTORIC = 45;
    const MAX_CRAFT_PER_DAY = 5;
    const SEASON_START_AT = Date.parse('2026-08-02T04:00:00+08:00');
    const SEASON_DAYS = 90;
    const DAILY_PULLS = 650;

    function clamp(value, min, max) {
        const parsed = Number(value);
        return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
    }

    function getSeasonDay(now = Date.now()) {
        const timestamp = Number(now);
        if (!Number.isFinite(timestamp)) return 1;
        const elapsedDays = Math.floor((timestamp - SEASON_START_AT) / 86400000);
        return clamp(elapsedDays + 1, 1, SEASON_DAYS);
    }

    function getDynamicDefaults(now = Date.now()) {
        const currentDay = getSeasonDay(now);
        return {
            currentDay,
            currentTotalDraws: currentDay * DAILY_PULLS,
            dissolveRemaining: 0
        };
    }

    function getPreviousAdditionalCards({ currentCards, currentUsableCards }) {
        const drawn = Math.max(0, Number(currentCards) || 0);
        const usable = Math.max(0, Number(currentUsableCards) || 0);
        return Math.max(0, usable - drawn);
    }

    function getAutomaticDissolveDayState() {
        return {
            usedCards: MAX_DISSOLVE_PER_DAY,
            dustAdded: MAX_DISSOLVE_PER_DAY * DUST_PER_DISSOLVED_HISTORIC,
            cashCost: MAX_DISSOLVE_PER_DAY * VIP_FEE_PER_DISSOLVED_HISTORIC
        };
    }

    function getDissolveDayState({ day, currentDay, dissolveRemaining }) {
        if (day < currentDay) {
            return {
                usedCards: MAX_DISSOLVE_PER_DAY,
                dustAdded: 0,
                cashCost: MAX_DISSOLVE_PER_DAY * VIP_FEE_PER_DISSOLVED_HISTORIC
            };
        }

        if (day === currentDay) {
            const remaining = clamp(dissolveRemaining, 0, MAX_DISSOLVE_PER_DAY);
            const usedCards = MAX_DISSOLVE_PER_DAY - remaining;
            return {
                usedCards,
                dustAdded: remaining * DUST_PER_DISSOLVED_HISTORIC,
                cashCost: usedCards * VIP_FEE_PER_DISSOLVED_HISTORIC
            };
        }

        return {
            usedCards: MAX_DISSOLVE_PER_DAY,
            dustAdded: MAX_DISSOLVE_PER_DAY * DUST_PER_DISSOLVED_HISTORIC,
            cashCost: MAX_DISSOLVE_PER_DAY * VIP_FEE_PER_DISSOLVED_HISTORIC
        };
    }

    function getCraftLimit({ day, currentDay, craftRemaining }) {
        return day === currentDay
            ? clamp(craftRemaining, 0, MAX_CRAFT_PER_DAY)
            : MAX_CRAFT_PER_DAY;
    }

    global.StardustRules = Object.freeze({
        MAX_DISSOLVE_PER_DAY,
        DUST_PER_DISSOLVED_HISTORIC,
        VIP_FEE_PER_DISSOLVED_HISTORIC,
        MAX_CRAFT_PER_DAY,
        SEASON_START_AT,
        SEASON_DAYS,
        DAILY_PULLS,
        getSeasonDay,
        getDynamicDefaults,
        getPreviousAdditionalCards,
        getAutomaticDissolveDayState,
        getDissolveDayState,
        getCraftLimit
    });
}(globalThis));
