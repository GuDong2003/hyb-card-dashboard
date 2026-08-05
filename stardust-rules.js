(function attachStardustRules(global) {
    const MAX_DISSOLVE_PER_DAY = 20;
    const DUST_PER_DISSOLVED_HISTORIC = 50;
    const VIP_FEE_PER_DISSOLVED_HISTORIC = 45;
    const MAX_CRAFT_PER_DAY = 5;

    function clamp(value, min, max) {
        const parsed = Number(value);
        return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
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
        getDissolveDayState,
        getCraftLimit
    });
}(globalThis));
