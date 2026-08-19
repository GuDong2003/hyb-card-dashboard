(function attachStardustRules(global) {
    const MAX_DISSOLVE_PER_DAY = 20;
    const DUST_PER_DISSOLVED_HISTORIC = 50;
    const VIP_FEE_PER_DISSOLVED_HISTORIC = 45;
    const MAX_CRAFT_PER_DAY = 5;
    const CRAFT_COST = 1600;
    const DAILY_DUST = MAX_DISSOLVE_PER_DAY * DUST_PER_DISSOLVED_HISTORIC;
    const SEASON_START_AT = Date.parse('2026-08-02T04:00:00+08:00');
    const SEASON_DAYS = 90;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const SEASON_END_AT = SEASON_START_AT + SEASON_DAYS * DAY_MS;
    const BOOST_START_AT = Date.parse('2026-08-20T04:00:00+08:00');
    const BOOST_DEFAULT_END_AT = SEASON_END_AT;
    const BOOST_DEFAULT_DURATION_DAYS = Math.max(
        1,
        Math.floor((BOOST_DEFAULT_END_AT - BOOST_START_AT) / DAY_MS)
    );
    const ORDINARY_DAILY_FREE_PULLS = 30;
    const ORDINARY_DAILY_PAID_PULLS = 400;
    const VIP_EXTRA_DAILY_FREE_PULLS = 20;
    const VIP_EXTRA_DAILY_PAID_PULLS = 200;
    const BOOST_ORDINARY_DAILY_FREE_PULLS = 60;
    const BOOST_ORDINARY_DAILY_PAID_PULLS = 800;
    const BOOST_VIP_DAILY_FREE_PULLS = BOOST_ORDINARY_DAILY_FREE_PULLS + VIP_EXTRA_DAILY_FREE_PULLS;
    const BOOST_VIP_DAILY_PAID_PULLS = BOOST_ORDINARY_DAILY_PAID_PULLS + VIP_EXTRA_DAILY_PAID_PULLS;
    // 保留旧名称作为兼容字段；收益表默认按 VIP 额度演算。
    const DAILY_PULLS = ORDINARY_DAILY_PAID_PULLS + VIP_EXTRA_DAILY_PAID_PULLS
        + ORDINARY_DAILY_FREE_PULLS + VIP_EXTRA_DAILY_FREE_PULLS;
    const BOOST_DAILY_PULLS = BOOST_VIP_DAILY_PAID_PULLS + BOOST_VIP_DAILY_FREE_PULLS;

    function clamp(value, min, max) {
        const parsed = Number(value);
        return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
    }

    function getSeasonDay(now = Date.now()) {
        const timestamp = Number(now);
        if (!Number.isFinite(timestamp)) return 1;
        const elapsedDays = Math.floor((timestamp - SEASON_START_AT) / DAY_MS);
        return clamp(elapsedDays + 1, 1, SEASON_DAYS);
    }

    function normalizeBoostDurationDays(value = BOOST_DEFAULT_DURATION_DAYS) {
        return clamp(
            Math.floor(Number(value) || BOOST_DEFAULT_DURATION_DAYS),
            1,
            BOOST_DEFAULT_DURATION_DAYS
        );
    }

    function getBoostEndAt(durationDays = BOOST_DEFAULT_DURATION_DAYS) {
        return BOOST_START_AT + normalizeBoostDurationDays(durationDays) * DAY_MS;
    }

    function isBoostActiveAt(timestamp, { enabled = true, durationDays = BOOST_DEFAULT_DURATION_DAYS } = {}) {
        const value = Number(timestamp);
        if (!enabled || !Number.isFinite(value)) return false;
        return value >= BOOST_START_AT && value < getBoostEndAt(durationDays);
    }

    function getBoostStatus(now = Date.now(), { enabled = true, durationDays = BOOST_DEFAULT_DURATION_DAYS } = {}) {
        const timestamp = Number(now);
        const normalizedDuration = normalizeBoostDurationDays(durationDays);
        const endAt = getBoostEndAt(normalizedDuration);
        if (!enabled) {
            return {
                state: 'disabled',
                day: 0,
                durationDays: normalizedDuration,
                startAt: BOOST_START_AT,
                endAt,
                active: false
            };
        }
        if (!Number.isFinite(timestamp) || timestamp < BOOST_START_AT) {
            return {
                state: 'upcoming',
                day: 0,
                durationDays: normalizedDuration,
                startAt: BOOST_START_AT,
                endAt,
                active: false
            };
        }
        if (timestamp >= endAt) {
            return {
                state: 'ended',
                day: normalizedDuration,
                durationDays: normalizedDuration,
                startAt: BOOST_START_AT,
                endAt,
                active: false
            };
        }
        return {
            state: 'active',
            day: Math.floor((timestamp - BOOST_START_AT) / DAY_MS) + 1,
            durationDays: normalizedDuration,
            startAt: BOOST_START_AT,
            endAt,
            active: true
        };
    }

    function getDailyQuotaForSeasonDay(day, {
        enabled = true,
        durationDays = BOOST_DEFAULT_DURATION_DAYS,
        vip = true
    } = {}) {
        const seasonDay = clamp(Math.floor(Number(day) || 1), 1, SEASON_DAYS);
        const timestamp = SEASON_START_AT + (seasonDay - 1) * DAY_MS;
        const boosted = isBoostActiveAt(timestamp, { enabled, durationDays });
        const ordinaryFreePulls = boosted ? BOOST_ORDINARY_DAILY_FREE_PULLS : ORDINARY_DAILY_FREE_PULLS;
        const ordinaryPaidPulls = boosted ? BOOST_ORDINARY_DAILY_PAID_PULLS : ORDINARY_DAILY_PAID_PULLS;
        const freePulls = vip
            ? ordinaryFreePulls + VIP_EXTRA_DAILY_FREE_PULLS
            : ordinaryFreePulls;
        const paidPulls = vip
            ? ordinaryPaidPulls + VIP_EXTRA_DAILY_PAID_PULLS
            : ordinaryPaidPulls;
        return {
            seasonDay,
            boosted,
            freePulls,
            paidPulls,
            totalPulls: freePulls + paidPulls,
            paidCost: paidPulls * 10
        };
    }

    function getCumulativePullsThroughDay(day, options = {}) {
        const lastDay = clamp(Math.floor(Number(day) || 1), 1, SEASON_DAYS);
        let total = 0;
        for (let seasonDay = 1; seasonDay <= lastDay; seasonDay += 1) {
            total += getDailyQuotaForSeasonDay(seasonDay, options).totalPulls;
        }
        return total;
    }

    function getDynamicDefaults(now = Date.now()) {
        const currentDay = getSeasonDay(now);
        return {
            currentDay,
            currentTotalDraws: getCumulativePullsThroughDay(currentDay),
            dissolveRemaining: 0
        };
    }

    function getPreviousAdditionalCards({ currentCards, currentUsableCards }) {
        const drawn = Math.max(0, Number(currentCards) || 0);
        const usable = Math.max(0, Number(currentUsableCards) || 0);
        return Math.max(0, usable - drawn);
    }

    function getLegendInventorySummary({ drawnLegendaryCards, heldLegendaryCards, redeemedSets }) {
        const drawn = Math.max(0, Number(drawnLegendaryCards) || 0);
        const held = Math.max(0, Number(heldLegendaryCards) || 0);
        const redeemed = Math.max(0, Math.floor(Number(redeemedSets) || 0));
        const totalAcquiredCards = held + redeemed * 6;
        return {
            totalAcquiredCards,
            previousCraftedCards: Math.max(0, totalAcquiredCards - drawn),
            totalSets: redeemed + Math.floor(held / 6),
            redeemableHeldSets: Math.floor(held / 6)
        };
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

    function getReverseForgeDayState(nextDust) {
        const normalizedDust = Math.max(0, Math.floor(Number(nextDust) || 0));
        for (let craftedToday = 0; craftedToday <= MAX_CRAFT_PER_DAY; craftedToday += 1) {
            const previousDust = normalizedDust - DAILY_DUST + craftedToday * CRAFT_COST;
            if (previousDust >= 0 && previousDust < CRAFT_COST) {
                return { previousDust, craftedToday };
            }
        }
        return {
            previousDust: Math.max(0, normalizedDust - DAILY_DUST),
            craftedToday: 0
        };
    }

    function getForgeProjection({ currentDay, currentStardust, seasonDays = SEASON_DAYS }) {
        const totalDays = clamp(Math.floor(Number(seasonDays) || SEASON_DAYS), 1, SEASON_DAYS);
        const anchorDay = clamp(Math.floor(Number(currentDay) || 1), 1, totalDays);
        const dustByDay = new Array(totalDays + 1).fill(0);
        const craftedTodayByDay = new Array(totalDays + 1).fill(0);
        const craftedByDay = new Array(totalDays + 1).fill(0);

        dustByDay[anchorDay] = Math.max(0, Math.floor(Number(currentStardust) || 0));
        let nextDust = dustByDay[anchorDay];
        for (let day = anchorDay; day >= 1; day -= 1) {
            const state = getReverseForgeDayState(nextDust);
            craftedTodayByDay[day] = state.craftedToday;
            dustByDay[day - 1] = state.previousDust;
            nextDust = state.previousDust;
        }

        let cumulativeCrafted = 0;
        for (let day = 1; day <= totalDays; day += 1) {
            if (day > anchorDay) {
                const availableDust = dustByDay[day - 1] + DAILY_DUST;
                const craftedToday = Math.min(MAX_CRAFT_PER_DAY, Math.floor(availableDust / CRAFT_COST));
                craftedTodayByDay[day] = craftedToday;
                dustByDay[day] = availableDust - craftedToday * CRAFT_COST;
            }
            cumulativeCrafted += craftedTodayByDay[day];
            craftedByDay[day] = cumulativeCrafted;
        }

        return { dustByDay, craftedTodayByDay, craftedByDay };
    }

    global.StardustRules = Object.freeze({
        MAX_DISSOLVE_PER_DAY,
        DUST_PER_DISSOLVED_HISTORIC,
        VIP_FEE_PER_DISSOLVED_HISTORIC,
        MAX_CRAFT_PER_DAY,
        SEASON_START_AT,
        SEASON_DAYS,
        SEASON_END_AT,
        BOOST_START_AT,
        BOOST_DEFAULT_END_AT,
        BOOST_DEFAULT_DURATION_DAYS,
        DAILY_PULLS,
        BOOST_DAILY_PULLS,
        ORDINARY_DAILY_FREE_PULLS,
        ORDINARY_DAILY_PAID_PULLS,
        VIP_EXTRA_DAILY_FREE_PULLS,
        VIP_EXTRA_DAILY_PAID_PULLS,
        BOOST_ORDINARY_DAILY_FREE_PULLS,
        BOOST_ORDINARY_DAILY_PAID_PULLS,
        BOOST_VIP_DAILY_FREE_PULLS,
        BOOST_VIP_DAILY_PAID_PULLS,
        getSeasonDay,
        normalizeBoostDurationDays,
        getBoostEndAt,
        isBoostActiveAt,
        getBoostStatus,
        getDailyQuotaForSeasonDay,
        getCumulativePullsThroughDay,
        getDynamicDefaults,
        getPreviousAdditionalCards,
        getLegendInventorySummary,
        getAutomaticDissolveDayState,
        getDissolveDayState,
        getCraftLimit,
        getForgeProjection
    });
}(globalThis));
