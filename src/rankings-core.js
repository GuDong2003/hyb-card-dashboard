export const BOARD_KEYS = Object.freeze([
  'sets_total', 'sets_month', 'sets_week', 'sets_today',
  'epic_total', 'epic_month', 'epic_week', 'epic_today',
  'spend_total', 'spend_month', 'spend_week', 'spend_today'
]);

export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
export const MAX_ROWS_PER_BOARD = 100;

const BOARD_KEY_SET = new Set(BOARD_KEYS);

export function normalizeLeaderboardSnapshot(payload, now = Date.now()) {
  const source = payload && payload.data && payload.data.leaderboards
    ? payload.data
    : payload;
  if (!source || typeof source !== 'object') return rejected('invalid_snapshot');

  const season = source.season && typeof source.season === 'object' ? source.season : {};
  const seasonId = String(season.id || '').trim();
  const seasonName = String(season.name || '').trim();
  if (!seasonId || !seasonName) return rejected('missing_season');
  if (source.scope !== 'global') return rejected('invalid_scope');

  const capturedAt = Number(source.capturedAt);
  if (!Number.isInteger(capturedAt) || capturedAt <= 0) return rejected('invalid_captured_at');
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
    for (const rawRow of rows.slice(0, MAX_ROWS_PER_BOARD)) {
      const normalized = normalizeRow(rawRow);
      if (!normalized) continue;
      entries.push({ boardKey, ...normalized });
    }
  }

  return {
    ok: true,
    seasonId,
    seasonName,
    scope: 'global',
    capturedAt,
    capturedBucket: Math.floor(capturedAt / REFRESH_INTERVAL_MS),
    boardKeys,
    entries,
    raw: source
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

export function estimateLegendProbability({ epicTotal, spendTotal, elapsedDays, isVip }) {
  const pulls = Number(spendTotal || 0) / 10
    + Math.max(0, Number(elapsedDays || 0)) * (isVip ? 50 : 30);
  return pulls > 0 ? Number(epicTotal || 0) / pulls : null;
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
