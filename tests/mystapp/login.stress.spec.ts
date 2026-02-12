import { test, expect } from '@playwright/test';
import {
  hasMystappConfig,
  mystappMaxLoginMs,
  mystappMaxP95LoginMs,
  mystappMaxP99LoginMs,
  requireMystappUsers,
  withDurationMs,
  mystappLogin,
} from './helpers';

/**
 * How many distinct user credentials to use.
 * You can provide usernames via MYSTAPP_USERS or generate via MYSTAPP_USER_PREFIX.
 */
const USERS_TO_LOGIN = Number(process.env.MYSTAPP_USERS_COUNT ?? '10');

/**
 * Concurrency of the stress run.
 * Each worker creates its own `browser.newContext()` to avoid shared session/cookie bleed.
 */
const CONCURRENCY = Number(process.env.MYSTAPP_LOGIN_CONCURRENCY ?? '10');

test.describe('mystapp - stress login', () => {
  test('login concurrente de N usuarios (solo login) @stress', async ({ browser }) => {
    // Skip when required env vars are missing.
    test.skip(
      !hasMystappConfig(),
      'Missing Mystapp credentials. Set env vars (MYSTAPP_USERS or MYSTAPP_USER/MYSTAPP_USERNAME or MYSTAPP_USER_PREFIX + MYSTAPP_PASSWORD) or create .mystapp.local.json.'
    );

    const users = requireMystappUsers(USERS_TO_LOGIN);

    // Concurrency limiter (keeps memory under control on local runs).
    let next = 0;

    // E2E duration per login attempt (UI flow).
    const timings: number[] = [];

    // Optional API duration/status if MYSTAPP_LOGIN_API_URL_REGEX is set.
    const apiTimings: number[] = [];
    const apiStatuses: number[] = [];

    const worker = async () => {
      while (true) {
        const current = next;
        next += 1;
        if (current >= users.length) return;

        const user = users[current];
        const { durationMs } = await withDurationMs(async () => {
          const context = await browser.newContext();
          const page = await context.newPage();
          const metrics = await mystappLogin(page, user);
          if (typeof metrics.apiMs === 'number') apiTimings.push(metrics.apiMs);
          if (typeof metrics.apiStatus === 'number') apiStatuses.push(metrics.apiStatus);
          await context.close();
        });
        timings.push(durationMs);
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker()));

    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)] ?? 0;
    const p90 = timings[Math.floor(timings.length * 0.9)] ?? 0;
    const p99 = timings[Math.floor(timings.length * 0.99)] ?? 0;

    const maxAllowed = mystappMaxLoginMs();
    const p95Allowed = mystappMaxP95LoginMs();
    const p99Allowed = mystappMaxP99LoginMs();

    const p95 = timings[Math.floor(timings.length * 0.95)] ?? 0;
    const max = timings[timings.length - 1] ?? 0;

    // SLO assertions: only run if thresholds are provided.
    if (typeof maxAllowed === 'number') {
      expect(max, `Max login time exceeded (max=${max}ms > allowed=${maxAllowed}ms). Set MYSTAPP_MAX_LOGIN_MS to tune.`).toBeLessThanOrEqual(
        maxAllowed
      );
    }
    if (typeof p95Allowed === 'number') {
      expect(p95, `P95 login time exceeded (p95=${p95}ms > allowed=${p95Allowed}ms). Set MYSTAPP_MAX_P95_LOGIN_MS to tune.`).toBeLessThanOrEqual(
        p95Allowed
      );
    }
    if (typeof p99Allowed === 'number') {
      expect(p99, `P99 login time exceeded (p99=${p99}ms > allowed=${p99Allowed}ms). Set MYSTAPP_MAX_P99_LOGIN_MS to tune.`).toBeLessThanOrEqual(
        p99Allowed
      );
    }

    test.info().annotations.push({
      type: 'mystapp',
      description: `login timings: count=${timings.length} p50=${p50}ms p90=${p90}ms p95=${p95}ms p99=${p99}ms max=${max}ms`,
    });

    if (apiTimings.length) {
      apiTimings.sort((a, b) => a - b);
      const apiP95 = apiTimings[Math.floor(apiTimings.length * 0.95)] ?? 0;
      const apiMax = apiTimings[apiTimings.length - 1] ?? 0;
      test.info().annotations.push({
        type: 'mystapp',
        description: `login API timings: count=${apiTimings.length} p95=${apiP95}ms max=${apiMax}ms statuses=[${[...new Set(apiStatuses)].sort((a, b) => a - b).join(',')}]`,
      });
    }

    // Minimal assertion: at least we executed all logins.
    expect(timings).toHaveLength(users.length);
  });
});
