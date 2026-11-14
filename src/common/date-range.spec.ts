import { resolveRange } from './date-range';

describe('resolveRange', () => {
  // 14 Nov 2026 23:30 UTC is already 15 Nov 00:30 in Lagos (UTC+1).
  const now = new Date('2026-11-14T23:30:00Z');

  it('uses the business timezone for day boundaries', () => {
    const r = resolveRange({ preset: 'today' }, 'Africa/Lagos', now);
    expect(r.fromDate).toBe('2026-11-15');
    expect(r.from.toISOString()).toBe('2026-11-14T23:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-11-15T23:00:00.000Z');
  });

  it('computes yesterday and rolling windows', () => {
    expect(resolveRange({ preset: 'yesterday' }, 'Africa/Lagos', now).fromDate).toBe('2026-11-14');
    const week = resolveRange({ preset: 'last7' }, 'Africa/Lagos', now);
    expect(week.fromDate).toBe('2026-11-09');
    expect(week.toDate).toBe('2026-11-15');
    expect(resolveRange({ preset: 'last30' }, 'Africa/Lagos', now).fromDate).toBe('2026-10-17');
  });

  it('treats custom ranges as inclusive of the end date', () => {
    const r = resolveRange({ from: '2026-11-01', to: '2026-11-03' }, 'Africa/Lagos', now);
    expect(r.preset).toBe('custom');
    expect(r.from.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-11-03T23:00:00.000Z');
  });

  it('rejects invalid custom ranges', () => {
    expect(() => resolveRange({ from: '2026-11-03', to: '2026-11-01' }, 'Africa/Lagos')).toThrow();
    expect(() => resolveRange({ from: 'bad', to: '2026-11-01' }, 'Africa/Lagos')).toThrow();
    expect(() => resolveRange({ from: '2024-01-01', to: '2026-01-01' }, 'Africa/Lagos')).toThrow();
    expect(() => resolveRange({ from: '2026-11-01' }, 'Africa/Lagos')).toThrow();
  });
});
