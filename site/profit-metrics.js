(function (root) {
    'use strict';

    function getProfitMetricParts(day, sets, amountText) {
        const normalizedDay = Number(day);
        const normalizedSets = Number(sets);
        const text = String(amountText == null ? '' : amountText).trim();
        if (!Number.isFinite(normalizedDay) || normalizedDay < 1) return null;
        if (!Number.isFinite(normalizedSets) || normalizedSets < 0) return null;
        if (!text) return null;
        return {
            context: `第${Math.floor(normalizedDay)}天 · 第${Math.floor(normalizedSets)}套`,
            amount: text
        };
    }

    function formatProfitMetric(day, sets, amountText) {
        const parts = getProfitMetricParts(day, sets, amountText);
        return parts ? `${parts.context} · ${parts.amount}` : String(amountText == null ? '' : amountText).trim();
    }

    function getSummaryJumpDay(target, days = {}) {
        const value = target === 'breakeven'
            ? days.breakevenDay
            : target === 'drawdown'
                ? days.drawdownDay
                : target === 'max-profit'
                    ? days.maxProfitDay
                    : target === 'last'
                        ? days.lastDay
                        : null;
        const normalized = Number(value);
        return Number.isFinite(normalized) && normalized >= 1 ? Math.floor(normalized) : null;
    }

    root.HYBCardProfitMetrics = Object.freeze({ formatProfitMetric, getProfitMetricParts, getSummaryJumpDay });
}(typeof window !== 'undefined' ? window : globalThis));
