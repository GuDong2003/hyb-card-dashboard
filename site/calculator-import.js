(function (root) {
    'use strict';

    const SOURCE = 'rankings';
    const REQUIRED_QUERY_FIELDS = Object.freeze([
        'currentDay',
        'currentTotalDraws',
        'currentCards'
    ]);
    const QUERY_FIELDS = Object.freeze([
        'source',
        ...REQUIRED_QUERY_FIELDS,
        'currentUsableCards',
        'redeemedSets',
        'stardustBalance'
    ]);
    const UNDO_FIELDS = Object.freeze([
        'currentDay',
        'currentTotalDraws',
        'currentCards',
        'currentUsableCards',
        'redeemedSets',
        'stardustBalance',
        'spPointCap'
    ]);

    function finiteNumber(value) {
        if (value == null || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function roundedNonNegative(value) {
        const number = finiteNumber(value);
        return number == null || number < 0 ? null : Math.round(number);
    }

    function cardCount(value) {
        const number = finiteNumber(value);
        return number == null || number < 0 ? null : Math.floor(number);
    }

    function dayCount(value) {
        const number = finiteNumber(value);
        if (number == null) return null;
        const rounded = Math.round(number);
        return rounded >= 1 && rounded <= 90 ? rounded : null;
    }

    function optionalCount(value) {
        if (value == null || value === '') return 0;
        const count = cardCount(value);
        return count == null ? null : count;
    }

    function deriveCurrentUsableCards(currentCards, redeemedSets) {
        const drawn = Math.max(0, cardCount(currentCards) || 0);
        const redeemed = Math.max(0, cardCount(redeemedSets) || 0);
        return Math.max(0, drawn - redeemed * 6);
    }

    function estimateIsUsable(row) {
        const status = String(row && row.estimateStatus || '').trim();
        if (status === 'complete_days' || status === 'partial_day') return true;
        if (status) return false;
        return row && row.isPartial !== true;
    }

    function normalizeRow(row) {
        if (!row || typeof row !== 'object') return null;
        if (!estimateIsUsable(row)) return null;
        const currentCards = cardCount(row.epicTotal);
        const currentTotalDraws = roundedNonNegative(row.estimatedPulls);
        const currentDay = dayCount(row.estimatedDays);
        if (currentCards == null || currentTotalDraws == null || currentDay == null) return null;

        const redeemedSets = optionalCount(row.exchangeCount);
        if (redeemedSets == null) return null;

        return {
            source: SOURCE,
            currentDay,
            currentTotalDraws,
            currentCards,
            currentUsableCards: deriveCurrentUsableCards(currentCards, redeemedSets),
            redeemedSets,
            stardustBalance: 0
        };
    }

    function canImportRow(row) {
        return normalizeRow(row) !== null;
    }

    function buildImportData(row) {
        return normalizeRow(row);
    }

    function buildQuery(data) {
        const normalized = data && data.source === SOURCE
            ? data
            : null;
        if (!normalized) return '';
        const query = new URLSearchParams();
        QUERY_FIELDS.forEach((field) => {
            const value = normalized[field];
            if (value == null) return;
            query.set(field, String(value));
        });
        return `?${query.toString()}`;
    }

    function readQuery(search) {
        const query = new URLSearchParams(String(search || '').replace(/^\?/, ''));
        if (query.get('source') !== SOURCE) return null;

        const values = {};
        for (const field of REQUIRED_QUERY_FIELDS) {
            const value = cardCount(query.get(field));
            if (value == null) return null;
            values[field] = value;
        }
        const currentDay = dayCount(query.get('currentDay'));
        if (currentDay == null) return null;
        values.currentDay = currentDay;

        for (const field of ['redeemedSets', 'stardustBalance']) {
            const raw = query.get(field);
            values[field] = raw == null || raw === '' ? 0 : cardCount(raw);
            if (values[field] == null) return null;
        }

        return {
            source: SOURCE,
            currentDay: values.currentDay,
            currentTotalDraws: values.currentTotalDraws,
            currentCards: values.currentCards,
            // 兼容旧 URL，但始终按抽出传说与已兑换套数重新计算，避免旧值重复计入。
            currentUsableCards: deriveCurrentUsableCards(values.currentCards, values.redeemedSets),
            redeemedSets: values.redeemedSets,
            stardustBalance: values.stardustBalance
        };
    }

    function captureUndoState(values, search, targetSearch) {
        const snapshotValues = {};
        UNDO_FIELDS.forEach((field) => {
            snapshotValues[field] = String(values && values[field] != null ? values[field] : '');
        });
        return {
            version: 1,
            values: snapshotValues,
            search: String(search || ''),
            targetSearch: String(targetSearch || '')
        };
    }

    function readUndoState(snapshot) {
        if (!snapshot || typeof snapshot !== 'object' || Number(snapshot.version) !== 1) return null;
        if (!snapshot.values || typeof snapshot.values !== 'object') return null;
        if (typeof snapshot.targetSearch !== 'string' || !snapshot.targetSearch) return null;
        const values = {};
        for (const field of UNDO_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(snapshot.values, field)) return null;
            values[field] = String(snapshot.values[field] == null ? '' : snapshot.values[field]);
        }
        return {
            version: 1,
            values,
            search: String(snapshot.search || ''),
            targetSearch: snapshot.targetSearch
        };
    }

    root.HYBCardCalculatorImport = Object.freeze({
        SOURCE,
        canImportRow,
        buildImportData,
        buildQuery,
        readQuery,
        captureUndoState,
        readUndoState
    });
}(typeof window !== 'undefined' ? window : globalThis));
