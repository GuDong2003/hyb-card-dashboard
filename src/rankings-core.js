export const BOARD_KEYS = Object.freeze([
  'sets_total', 'sets_month', 'sets_week', 'sets_today',
  'epic_total', 'epic_month', 'epic_week', 'epic_today',
  'spend_total', 'spend_month', 'spend_week', 'spend_today'
]);

export const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const CAPTURE_BUCKET_MS = 60 * 60 * 1000;
export const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
export const MAX_ROWS_PER_BOARD = 1000;
export const SPEND_VALUE_PER_USD = 500000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const SEASON_START_AT = Date.parse('2026-08-02T04:00:00+08:00');
export const SEASON_DAYS = 90;
export const BOOST_START_AT = Date.parse('2026-08-20T04:00:00+08:00');
export const VIP_DAILY_SPEND_USD = 6000;
export const VIP_DAILY_PAID_PULLS = 600;
export const VIP_DAILY_FREE_PULLS = 50;
export const VIP_DAILY_PULLS = VIP_DAILY_PAID_PULLS + VIP_DAILY_FREE_PULLS;
export const ORDINARY_DAILY_SPEND_USD = 4000;
export const ORDINARY_DAILY_PAID_PULLS = 400;
export const ORDINARY_DAILY_FREE_PULLS = 30;
export const ORDINARY_DAILY_PULLS = ORDINARY_DAILY_PAID_PULLS + ORDINARY_DAILY_FREE_PULLS;
export const BOOST_ORDINARY_DAILY_SPEND_USD = 8000;
export const BOOST_ORDINARY_DAILY_PAID_PULLS = 800;
export const BOOST_ORDINARY_DAILY_FREE_PULLS = 60;
export const BOOST_VIP_DAILY_SPEND_USD = 10000;
export const BOOST_VIP_DAILY_PAID_PULLS = 1000;
export const BOOST_VIP_DAILY_FREE_PULLS = 80;

const BOARD_KEY_SET = new Set(BOARD_KEYS);
const SNAPSHOT_SCOPES = new Set(['global', 'friends']);

export function parseCapturedAt(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeLeaderboardSnapshot(payload, now = Date.now()) {
  const source = payload && payload.data && payload.data.leaderboards
    ? payload.data
    : payload;
  if (!source || typeof source !== 'object') return rejected('invalid_snapshot');

  const season = source.season && typeof source.season === 'object' ? source.season : {};
  const seasonId = String(season.id || '').trim();
  const seasonName = String(season.name || '').trim();
  if (!seasonId || !seasonName) return rejected('missing_season');
  const scope = String(source.scope || '').trim();
  if (!SNAPSHOT_SCOPES.has(scope)) return rejected('invalid_scope');

  const capturedAt = parseCapturedAt(source.capturedAt);
  if (capturedAt == null) return rejected('invalid_captured_at');
  if (capturedAt > now + FUTURE_TOLERANCE_MS) return rejected('future_captured_at');

  const leaderboards = source.leaderboards;
  if (!leaderboards || typeof leaderboards !== 'object' || Array.isArray(leaderboards)) {
    return rejected('missing_leaderboards');
  }

  for (const key of Object.keys(leaderboards)) {
    if (!BOARD_KEY_SET.has(key)) return rejected('unknown_board');
  }
  const boardKeys = BOARD_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(leaderboards, key));
  if (!boardKeys.length) return rejected('missing_leaderboards');

  const entries = [];
  for (const boardKey of boardKeys) {
    const rows = Array.isArray(leaderboards[boardKey]) ? leaderboards[boardKey] : [];
    for (const rawRow of rows) {
      const normalized = normalizeRow(rawRow);
      if (!normalized) continue;
      entries.push({ boardKey, ...normalized });
    }
  }

  return {
    ok: true,
    seasonId,
    seasonName,
    scope,
    capturedAt,
    capturedBucket: Math.floor(capturedAt / CAPTURE_BUCKET_MS),
    boardKeys,
    entries,
    raw: source
  };
}

export function normalizeSnapshotBundle(payload, now = Date.now()) {
  const candidates = Array.isArray(payload && payload.snapshots)
    ? payload.snapshots
    : payload && payload.snapshot
      ? [payload.snapshot]
      : [payload];
  const snapshots = [];
  const errors = [];
  candidates.forEach((candidate, index) => {
    const normalized = normalizeLeaderboardSnapshot(candidate, now);
    if (normalized.ok) snapshots.push(normalized);
    else errors.push({ index, reason: normalized.reason });
  });
  return {
    ok: snapshots.length > 0 && errors.length === 0,
    partial: snapshots.length > 0 && errors.length > 0,
    snapshots,
    errors
  };
}

function normalizeRow(rawRow) {
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) return null;
  const userId = String(rawRow.userId || '').trim();
  if (!userId) return null;
  const value = nonNegativeInteger(rawRow.value);
  const rank = positiveInteger(rawRow.rank);
  if (value == null || rank == null) return null;
  return {
    userId,
    userName: String(rawRow.userName || '').trim(),
    avatar: String(rawRow.avatar || '').trim(),
    value,
    rank,
    isVip: Boolean(rawRow.isVip),
    activeNameDecoration: rawRow.activeNameDecoration == null
      ? null
      : String(rawRow.activeNameDecoration),
    nameDisplayPreference: rawRow.nameDisplayPreference == null
      ? null
      : String(rawRow.nameDisplayPreference),
    raw: rawRow
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
}

function rejected(reason) {
  return { ok: false, reason };
}

export async function computeSnapshotSignature(value) {
  const serialized = JSON.stringify(stableValue(value));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function seasonDayAt(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(SEASON_DAYS, Math.floor((value - SEASON_START_AT) / DAY_MS) + 1));
}

function quotaForSeasonDay(day, { enabled = true, boostEndAt = null, vip = true } = {}) {
  const seasonDay = Math.max(1, Math.min(SEASON_DAYS, Math.floor(Number(day) || 1)));
  const timestamp = SEASON_START_AT + (seasonDay - 1) * DAY_MS;
  const boosted = enabled
    && timestamp >= BOOST_START_AT
    && (boostEndAt == null || timestamp < Number(boostEndAt));
  if (vip) {
    return boosted
      ? { paidCost: BOOST_VIP_DAILY_SPEND_USD, paidPulls: BOOST_VIP_DAILY_PAID_PULLS, freePulls: BOOST_VIP_DAILY_FREE_PULLS }
      : { paidCost: VIP_DAILY_SPEND_USD, paidPulls: VIP_DAILY_PAID_PULLS, freePulls: VIP_DAILY_FREE_PULLS };
  }
  return boosted
    ? { paidCost: BOOST_ORDINARY_DAILY_SPEND_USD, paidPulls: BOOST_ORDINARY_DAILY_PAID_PULLS, freePulls: BOOST_ORDINARY_DAILY_FREE_PULLS }
    : { paidCost: ORDINARY_DAILY_SPEND_USD, paidPulls: ORDINARY_DAILY_PAID_PULLS, freePulls: ORDINARY_DAILY_FREE_PULLS };
}

/**
 * Estimate paid/free/total pulls from a cumulative spend value.
 * Free pulls are allocated against the known season-day schedule. A partial
 * paid day still receives that day's free quota, matching the dashboard's
 * existing "default full free quota" assumption.
 */
export function estimatePullsFromSpend(spendValue, isVip, options = {}) {
  if (spendValue == null || spendValue === '') {
    return {
      spendUsd: null,
      estimatedDays: null,
      paidPulls: null,
      freePulls: null,
      estimatedPulls: null,
      estimateStatus: 'missing_spend'
    };
  }
  const rawValue = Number(spendValue);
  if (!Number.isFinite(rawValue) || rawValue < 0) {
    return {
      spendUsd: null,
      estimatedDays: null,
      paidPulls: null,
      freePulls: null,
      estimatedPulls: null,
      estimateStatus: 'missing_spend'
    };
  }
  const spendUsd = rawValue / SPEND_VALUE_PER_USD;
  const capturedAt = Number(options.capturedAt);
  const effectiveCapturedAt = Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : Date.now();
  const boostEnabled = options.boostEnabled !== false;
  const boostEndAt = options.boostEndAt == null ? null : Number(options.boostEndAt);
  const lastSeasonDay = seasonDayAt(effectiveCapturedAt);
  const firstSeasonDay = options.period === 'today' ? lastSeasonDay : 1;
  const firstQuota = quotaForSeasonDay(firstSeasonDay, { enabled: boostEnabled, boostEndAt, vip: Boolean(isVip) });
  if (spendUsd < firstQuota.paidCost) {
    return {
      spendUsd,
      estimatedDays: null,
      paidPulls: null,
      freePulls: null,
      estimatedPulls: null,
      estimateStatus: 'low_sample'
    };
  }
  const paidPulls = spendUsd / 10;
  let remainingSpend = spendUsd;
  let completeDays = 0;
  let partialDay = false;
  let freePulls = 0;
  for (let day = firstSeasonDay; day <= lastSeasonDay; day += 1) {
    const quota = quotaForSeasonDay(day, { enabled: boostEnabled, boostEndAt, vip: Boolean(isVip) });
    if (remainingSpend + 1e-9 >= quota.paidCost) {
      remainingSpend -= quota.paidCost;
      completeDays += 1;
      freePulls += quota.freePulls;
      continue;
    }
    if (remainingSpend > 1e-9) {
      partialDay = true;
      freePulls += quota.freePulls;
    }
    remainingSpend = 0;
    break;
  }
  // If the spend is ahead of the capture window, preserve the old behavior
  // of estimating additional full days using the last known quota.
  while (remainingSpend > 1e-9 && completeDays + (partialDay ? 1 : 0) < SEASON_DAYS * 2) {
    const quota = quotaForSeasonDay(lastSeasonDay + 1, { enabled: boostEnabled, boostEndAt, vip: Boolean(isVip) });
    if (remainingSpend + 1e-9 >= quota.paidCost) {
      remainingSpend -= quota.paidCost;
      completeDays += 1;
      freePulls += quota.freePulls;
    } else {
      partialDay = true;
      freePulls += quota.freePulls;
      remainingSpend = 0;
    }
  }
  const estimatedDays = Math.max(1, completeDays + (partialDay ? 1 : 0));
  const estimatedPulls = paidPulls + freePulls;
  return {
    spendUsd,
    estimatedDays,
    paidPulls,
    freePulls,
    estimatedPulls,
    estimateStatus: partialDay ? 'partial_day' : 'complete_days'
  };
}

export function estimateLegendProbability({ epicTotal, spendValue, isVip, ...options }) {
  const estimate = estimatePullsFromSpend(spendValue, isVip, options);
  return estimate.estimatedPulls > 0 && Number.isFinite(epicTotal)
    ? Number(epicTotal) / estimate.estimatedPulls
    : null;
}

export function pairLeaderboardRows(epicRows = [], spendRows = []) {
  const users = new Map();
  const merge = (rawRow, kind) => {
    if (!rawRow || typeof rawRow !== 'object') return;
    const userId = String(rawRow.userId ?? rawRow.user_id ?? '').trim();
    if (!userId) return;
    const current = users.get(userId) || { userId, epicRow: null, spendRow: null };
    current[`${kind}Row`] = rawRow;
    current[`${kind}Value`] = Number(rawRow.value);
    current.isVip = current.isVip || Boolean(rawRow.isVip ?? rawRow.is_vip);
    users.set(userId, current);
  };
  for (const row of epicRows) merge(row, 'epic');
  for (const row of spendRows) merge(row, 'spend');
  return Array.from(users.values());
}

export function diffBoardRows(previousRows = [], currentRows = []) {
  const previousById = new Map(previousRows.map((row) => [String(row.userId), row]));
  const currentById = new Map(currentRows.map((row) => [String(row.userId), row]));
  const result = [];

  for (const row of currentRows) {
    const previous = previousById.get(String(row.userId));
    if (!previous) {
      result.push({ ...row, previousRank: null, previousValue: null, rankDelta: null, valueDelta: null, event: 'entered' });
      continue;
    }
    const rankDelta = Number(previous.rank) - Number(row.rank);
    const valueDelta = Number(row.value) - Number(previous.value);
    result.push({
      ...row,
      previousRank: Number(previous.rank),
      previousValue: Number(previous.value),
      rankDelta,
      valueDelta,
      event: rankDelta === 0 ? '' : 'moved'
    });
  }

  for (const row of previousRows) {
    if (currentById.has(String(row.userId))) continue;
    result.push({
      ...row,
      previousRank: Number(row.rank),
      previousValue: Number(row.value),
      currentRank: null,
      currentValue: null,
      rankDelta: null,
      valueDelta: null,
      event: 'left'
    });
  }

  return result;
}
