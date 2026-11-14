import { DateTime } from 'luxon';
import { badRequest } from './errors';

export type RangeType = RangePreset;
export type RangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

export interface ResolvedRange {
  preset: RangePreset;
  /** Inclusive start instant. */
  from: Date;
  /** Exclusive end instant. */
  to: Date;
  /** The business local dates this range covers, inclusive, as YYYY-MM-DD. */
  fromDate: string;
  toDate: string;
  timezone: string;
}

const MAX_DAYS = 366;

/**
 * Day boundaries always follow the business timezone, never the server or browser
 * timezone, so the dashboard, reports and exports agree (guide section 4.2).
 */
export function resolveRange(
  input: { preset?: RangePreset; from?: string; to?: string },
  timezone: string,
  now: Date = new Date(),
): ResolvedRange {
  const zone = DateTime.fromJSDate(now, { zone: timezone });
  if (!zone.isValid) throw badRequest('INVALID_TIMEZONE', 'The business timezone is invalid.');
  const today = zone.startOf('day');
  const preset = input.preset ?? (input.from || input.to ? 'custom' : 'today');

  let start: DateTime;
  let endInclusive: DateTime;
  switch (preset) {
    case 'today':
      start = today;
      endInclusive = today;
      break;
    case 'yesterday':
      start = today.minus({ days: 1 });
      endInclusive = start;
      break;
    case 'last7':
      start = today.minus({ days: 6 });
      endInclusive = today;
      break;
    case 'last30':
      start = today.minus({ days: 29 });
      endInclusive = today;
      break;
    case 'custom': {
      if (!input.from || !input.to) {
        throw badRequest('INVALID_RANGE', 'A custom range needs both from and to dates.');
      }
      start = DateTime.fromISO(input.from, { zone: timezone }).startOf('day');
      endInclusive = DateTime.fromISO(input.to, { zone: timezone }).startOf('day');
      if (!start.isValid || !endInclusive.isValid) {
        throw badRequest('INVALID_RANGE', 'Dates must be in the format YYYY-MM-DD.');
      }
      if (endInclusive < start) {
        throw badRequest('INVALID_RANGE', 'The end date must not be before the start date.');
      }
      if (endInclusive.diff(start, 'days').days + 1 > MAX_DAYS) {
        throw badRequest('INVALID_RANGE', `A range can cover at most ${MAX_DAYS} days.`);
      }
      break;
    }
  }

  return {
    preset,
    from: start.toJSDate(),
    to: endInclusive.plus({ days: 1 }).startOf('day').toJSDate(),
    fromDate: start.toISODate()!,
    toDate: endInclusive.toISODate()!,
    timezone,
  };
}

/** Local calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export const localDate = (instant: Date, timezone: string): string =>
  DateTime.fromJSDate(instant, { zone: timezone }).toISODate()!;
