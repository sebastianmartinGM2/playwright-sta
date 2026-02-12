import { test } from '@playwright/test';
import {
  ensureMystappAuthDir,
  hasMystappConfig,
  mystappStorageStatePath,
  requireMystappUsers,
} from './helpers';

/**
 * Setup test: logs in N users and writes a per-user storageState file.
 *
 * Output:
 * - `.auth/mystapp/user-01.json`
 * - `.auth/mystapp/user-02.json`
 * - ...
 *
 * This is intended as a reusable foundation for future authenticated tests
 * (each test can pick a storageState by index).
 */
const USERS_TO_LOGIN = Number(process.env.MYSTAPP_USERS_COUNT ?? '10');

/**
 * Parallelism inside this single test.
 * Keep it lower if the app rate-limits or the machine is resource constrained.
 */
const CONCURRENCY = Number(process.env.MYSTAPP_LOGIN_CONCURRENCY ?? '5');

test('mystapp auth setup (login N users + storageState)', async ({ browser }) => {
  // We skip (not fail) when config is missing so local/public runs don't break by default.
  test.skip(
    !hasMystappConfig(),
    'Missing Mystapp credentials. Set env vars (MYSTAPP_USERS or MYSTAPP_USER/MYSTAPP_USERNAME or MYSTAPP_USER_PREFIX + MYSTAPP_PASSWORD) or create .mystapp.local.json.'
  );

  const users = requireMystappUsers(USERS_TO_LOGIN);
  ensureMystappAuthDir();

  // Simple concurrency limiter shared across workers.
  let next = 0;
  const results: Array<{ index: number; loginMs: number; apiMs?: number; apiStatus?: number }> = [];

  const worker = async () => {
    while (true) {
      const current = next;
      next += 1;
      if (current >= users.length) return;

      const user = users[current];
      const index1Based = current + 1;

      const context = await browser.newContext();
      const page = await context.newPage();

      const { mystappLogin } = await import('./helpers');
      const metrics = await mystappLogin(page, user);
      await page.close();

      const storageStatePath = mystappStorageStatePath(index1Based);
      await context.storageState({ path: storageStatePath });
      await context.close();

      results.push({ index: index1Based, loginMs: metrics.totalMs, apiMs: metrics.apiMs, apiStatus: metrics.apiStatus });
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker()));

  // Basic metrics in test output.
  results.sort((a, b) => a.index - b.index);
  const loginMs = results.map((r) => r.loginMs);
  const avg = Math.round(loginMs.reduce((a, b) => a + b, 0) / Math.max(1, loginMs.length));
  const max = Math.max(...loginMs);
  const min = Math.min(...loginMs);

  test.info().annotations.push({
    type: 'mystapp',
    description: `Logged in ${results.length} users. login min=${min}ms avg=${avg}ms max=${max}ms`,
  });
});
