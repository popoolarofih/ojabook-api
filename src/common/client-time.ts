import { badRequest } from './errors';

const MAX_FUTURE_MS = 5 * 60_000;
const MAX_BACKDATE_DAYS = 30;

/**
 * Offline devices send the time something really happened. Accept that, but never a time in
 * the future (clock drift tolerance 5 minutes) and not older than 30 days, so a wrong device
 * clock cannot quietly rewrite old reporting periods.
 */
export function parseClientTime(value: string | undefined, label = 'time'): Date {
  if (!value) return new Date();
  const d = new Date(value);
  const now = Date.now();
  if (
    Number.isNaN(d.getTime()) ||
    d.getTime() > now + MAX_FUTURE_MS ||
    d.getTime() < now - MAX_BACKDATE_DAYS * 86_400_000
  ) {
    throw badRequest(
      'INVALID_OCCURRED_AT',
      `The ${label} must not be in the future or older than ${MAX_BACKDATE_DAYS} days.`,
    );
  }
  return d;
}
