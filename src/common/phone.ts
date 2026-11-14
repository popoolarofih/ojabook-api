import { badRequest } from './errors';

/**
 * Normalise Nigerian phone numbers to E.164 before anything else touches them
 * (guide section 4.1). Accepts 0801 234 5678, 801 234 5678, 2348012345678 and +234 801 234 5678.
 * Nigerian mobile numbers are 10 digits after the country code and start with 7, 8 or 9.
 */
export function normalizeNigerianPhone(input: string): string {
  const digits = input.replace(/[\s().-]/g, '');
  let national: string | undefined;

  if (/^\+234\d{10}$/.test(digits)) national = digits.slice(4);
  else if (/^234\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{10}$/.test(digits)) national = digits;

  if (!national || !/^[789]\d{9}$/.test(national)) {
    throw badRequest(
      'INVALID_PHONE',
      'Enter a valid Nigerian mobile number, for example 0801 234 5678.',
    );
  }
  return `+234${national}`;
}
