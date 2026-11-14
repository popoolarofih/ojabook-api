// Runs in every integration test worker before modules load.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ojabook:ojabook@localhost:5432/ojabook_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-test-access-secret';
process.env.OTP_PEPPER = 'test-otp-pepper-test-otp-pepper-test-otp-pepper-1234';
process.env.OTP_PROVIDER = 'console';
process.env.WEB_ORIGINS = 'http://localhost:3000';
process.env.REDIS_URL = '';
