const SOURCE_ORDER = ['global', 'friends'];

export function isTotalBoard(boardKey) {
  return String(boardKey || '').endsWith('_total');
}

export function mergeMetric(existing, incoming) {
  const next = normalizeMetric(incoming);
  if (!existing) {
    return {
      ...next,
      valueCapturedAt: next.capturedAt,
      valueSnapshotId: next.snapshotId,
      valueScope: next.scope,
      firstCapturedAt: next.capturedAt,
      lastCapturedAt: next.capturedAt,
      lastSnapshotId: next.snapshotId,
      lastScope: next.scope,
      sourceScopes: normalizeScopes(next.sourceScopes || next.scope)
    };
  }

  const current = normalizeMetric(existing);
  if (current.seasonId !== next.seasonId
    || current.userId !== next.userId
    || current.boardKey !== next.boardKey) {
    throw new Error('metric_key_mismatch');
  }

  const valueCapturedAt = Number(current.valueCapturedAt ?? current.capturedAt ?? 0);
  const shouldReplace = isTotalBoard(next.boardKey)
    ? next.value > current.value
      || (next.value === current.value && next.capturedAt >= valueCapturedAt)
    : next.capturedAt > valueCapturedAt
      || (next.capturedAt === valueCapturedAt && next.value >= current.value);
  const latestProfile = next.capturedAt >= Number(current.lastCapturedAt ?? current.capturedAt ?? 0);

  return {
    ...current,
    userName: latestProfile && next.userName ? next.userName : current.userName || next.userName,
    avatar: latestProfile && next.avatar ? next.avatar : current.avatar || next.avatar,
    isVip: Boolean(current.isVip || next.isVip),
    activeNameDecoration: latestProfile && next.activeNameDecoration != null
      ? next.activeNameDecoration
      : current.activeNameDecoration,
    nameDisplayPreference: latestProfile && next.nameDisplayPreference != null
      ? next.nameDisplayPreference
      : current.nameDisplayPreference,
    value: shouldReplace ? next.value : current.value,
    rank: shouldReplace ? next.rank : current.rank,
    valueSnapshotId: shouldReplace ? next.snapshotId : current.valueSnapshotId,
    valueScope: shouldReplace ? next.scope : current.valueScope,
    valueCapturedAt: shouldReplace ? next.capturedAt : valueCapturedAt,
    firstCapturedAt: Math.min(
      Number(current.firstCapturedAt ?? current.capturedAt ?? next.capturedAt),
      next.capturedAt
    ),
    lastCapturedAt: Math.max(
      Number(current.lastCapturedAt ?? current.capturedAt ?? next.capturedAt),
      next.capturedAt
    ),
    lastSnapshotId: latestProfile ? next.snapshotId : current.lastSnapshotId,
    lastScope: latestProfile ? next.scope : current.lastScope,
    sourceScopes: normalizeScopes([current.sourceScopes, next.scope].filter(Boolean).join(','))
  };
}

export function mergeMetricRows(existingRows = [], incomingRows = []) {
  const rows = new Map();
  for (const row of existingRows) rows.set(metricKey(row), normalizeMetric(row));
  for (const row of incomingRows) {
    const key = metricKey(row);
    rows.set(key, mergeMetric(rows.get(key), row));
  }
  return Array.from(rows.values());
}

function metricKey(row) {
  return `${String(row && row.seasonId || '')}\u0000${String(row && row.userId || '')}\u0000${String(row && row.boardKey || '')}`;
}

function normalizeMetric(row = {}) {
  const value = Number(row.value);
  const rank = Number(row.rank);
  const capturedAt = Number(row.capturedAt ?? row.lastCapturedAt);
  return {
    seasonId: String(row.seasonId || '').trim(),
    userId: String(row.userId || '').trim(),
    boardKey: String(row.boardKey || '').trim(),
    userName: String(row.userName || '').trim(),
    avatar: String(row.avatar || '').trim(),
    value: Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0,
    rank: Number.isFinite(rank) && rank > 0 ? Math.floor(rank) : 1,
    isVip: Boolean(row.isVip),
    activeNameDecoration: row.activeNameDecoration == null ? null : String(row.activeNameDecoration),
    nameDisplayPreference: row.nameDisplayPreference == null ? null : String(row.nameDisplayPreference),
    snapshotId: Number(row.snapshotId ?? row.lastSnapshotId) || 0,
    scope: String(row.scope || row.lastScope || '').trim(),
    capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? Math.floor(capturedAt) : 0,
    valueSnapshotId: Number(row.valueSnapshotId ?? row.snapshotId) || 0,
    valueScope: String(row.valueScope || row.scope || '').trim(),
    valueCapturedAt: Number(row.valueCapturedAt ?? row.capturedAt) || 0,
    firstCapturedAt: Number(row.firstCapturedAt ?? row.capturedAt) || 0,
    lastCapturedAt: Number(row.lastCapturedAt ?? row.capturedAt) || 0,
    lastSnapshotId: Number(row.lastSnapshotId ?? row.snapshotId) || 0,
    lastScope: String(row.lastScope || row.scope || '').trim(),
    sourceScopes: normalizeScopes(row.sourceScopes || row.scope)
  };
}

function normalizeScopes(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const unique = new Set(values.map((item) => String(item || '').trim()).filter(Boolean));
  return [
    ...SOURCE_ORDER.filter((scope) => unique.has(scope)),
    ...Array.from(unique).filter((scope) => !SOURCE_ORDER.includes(scope)).sort()
  ].join(',');
}
