import { execSync } from 'node:child_process';

/** Applies migrations to the dedicated test database. Never touches the dev database. */
export default async function globalSetup() {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://ojabook:ojabook@localhost:5432/ojabook_test';
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to run integration tests against a non test database: ${url}`);
  }
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
