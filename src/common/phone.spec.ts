import { normalizeNigerianPhone } from './phone';

describe('normalizeNigerianPhone', () => {
  it.each([
    ['08012345678', '+2348012345678'],
    ['0801 234 5678', '+2348012345678'],
    ['8012345678', '+2348012345678'],
    ['2348012345678', '+2348012345678'],
    ['+234 801 234 5678', '+2348012345678'],
    ['+234-701-234-5678', '+2347012345678'],
    ['09012345678', '+2349012345678'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeNigerianPhone(input)).toBe(expected);
  });

  it.each(['', '12345', '+2341234567890', '0601234567', '+44 7911 123456', 'phone'])(
    'rejects %p',
    (input) => {
      expect(() => normalizeNigerianPhone(input)).toThrow();
    },
  );
});
