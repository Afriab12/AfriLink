// Cursor pagination shape, per ADR-004 §5 (docs/10-decisions/decisions.md)
// and api.md §9: opaque, unsigned base64url cursor carrying the last-seen
// (createdAt, id) — a forged cursor produces a bad/empty page or
// INVALID_CURSOR, never unauthorized data, since authorization is
// re-checked at read time regardless of cursor content.

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(value: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id })).toString('base64url');
}

// Returns null on any malformed input — callers translate that to
// INVALID_CURSOR rather than throwing from here, keeping this a pure
// parsing utility.
export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    const createdAt = new Date((parsed as { createdAt: string }).createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return { createdAt, id: (parsed as { id: string }).id };
  } catch {
    return null;
  }
}

// Server clamps an oversized/invalid limit rather than erroring (api.md §9).
export function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

export interface CursorPageResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Callers fetch `limit + 1` rows ordered by (createdAt desc, id desc) and
// pass them here — this trims the lookahead row and derives nextCursor
// from the last *returned* row, never leaking whether more data exists
// via any other channel.
export function toPage<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): CursorPageResult<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return { data, nextCursor: hasMore && last ? encodeCursor(last) : null, hasMore };
}
