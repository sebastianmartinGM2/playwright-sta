import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type Frame, type Page } from '@playwright/test';
import { readMystappLocalConfig } from './localConfig';

/**
 * Helpers for Mystapp login and stress testing.
 *
 * Design goals:
 * - Reusable login primitive (`mystappLogin`) for future tests.
 * - Configurable via env vars (URL, users, selectors, SLO thresholds).
 * - Optional API-level timing capture without hard-coding endpoints.
 *
 * Why there are a few “defensive” patterns here:
 * - Mystapp’s login UX can vary by environment/build: sometimes it lives in an iframe,
 *   sometimes it uses custom components (not plain `input[type=password]`).
 * - To reduce flakiness, we:
 *   - resolve selectors via a small set of heuristics (label/placeholder/role),
 *   - allow explicit selector overrides via env vars,
 *   - and use a generic post-submit success heuristic (leave the `/login` URL).
 * - API timing capture is optional and regex-based so tests don’t depend on a fixed
 *   endpoint path (which often differs across QA/staging/prod).
 */

export type MystappUser = {
  username: string;
  password: string;
};

export type MystappLoginMetrics = {
  /** End-to-end login time (UI flow), in milliseconds. */
  totalMs: number;
  /** Optional time-to-response for the login API call, in milliseconds. */
  apiMs?: number;
  /** Optional HTTP status of the login API call. */
  apiStatus?: number;
  /** Optional URL of the login API call (first match). */
  apiUrl?: string;
};

export type MystappLoginOptions = {
  /** Optional wait right after clicking submit (debug/visual runs). */
  afterSubmitWaitMs?: number;
};

/** Directory where per-user storageState files are written. */
export const mystappAuthDir = path.join(process.cwd(), '.auth', 'mystapp');

/**
 * StorageState path for a given user index.
 * Example: `.auth/mystapp/user-01.json`
 */
export function mystappStorageStatePath(index1Based: number) {
  const padded = String(index1Based).padStart(2, '0');
  return path.join(mystappAuthDir, `user-${padded}.json`);
}

/** Ensures `.auth/mystapp/` exists (safe to call repeatedly). */
export function ensureMystappAuthDir() {
  fs.mkdirSync(mystappAuthDir, { recursive: true });
}

/**
 * Whether the minimal Mystapp configuration exists to run authenticated flows.
 *
 * Required:
 * - `MYSTAPP_BASE_URL`
 * - credentials via either:
 *   - `MYSTAPP_USERS` (comma-separated) + `MYSTAPP_PASSWORD`, OR
 *   - `MYSTAPP_USER_PREFIX` + `MYSTAPP_PASSWORD`
 */
export function hasMystappConfig() {
  const local = readMystappLocalConfig();

  // In most runs `baseURL` comes from the Playwright project (`mystapp-*`) and may
  // have a default in playwright.config.ts. We still validate a non-empty value to
  // avoid accidental relative navigations (e.g. `about:blank/login`).
  const baseUrl = (process.env.MYSTAPP_BASE_URL ?? local?.baseURL ?? 'https://qa.mystaapp.com').trim();

  // Credentials can come from env vars OR .mystapp.local.json.
  // Supported forms:
  // - `MYSTAPP_USERS` (csv) + `MYSTAPP_PASSWORD`
  // - `MYSTAPP_USER` or `MYSTAPP_USERNAME` + `MYSTAPP_PASSWORD`
  // - `MYSTAPP_USER_PREFIX` + `MYSTAPP_PASSWORD`
  const password = (process.env.MYSTAPP_PASSWORD ?? local?.password ?? '').trim();
  const usersCsv = (process.env.MYSTAPP_USERS ?? '').trim();
  const localUsers = local?.users ?? (local?.user ? [local.user] : undefined);
  const singleUser = (process.env.MYSTAPP_USER ?? process.env.MYSTAPP_USERNAME ?? '').trim();
  const userPrefix = (process.env.MYSTAPP_USER_PREFIX ?? local?.userPrefix ?? '').trim();

  const hasExplicitUsers = (!!usersCsv || (localUsers?.length ?? 0) > 0 || !!singleUser) && !!password;
  const hasGeneratedUsers = !!userPrefix && !!password;
  const hasCredentials = hasExplicitUsers || hasGeneratedUsers;

  return !!baseUrl && hasCredentials;
}

export function requireMystappUsers(count: number): MystappUser[] {
  const local = readMystappLocalConfig();

  const password = (process.env.MYSTAPP_PASSWORD ?? local?.password ?? '').trim() || undefined;
  const usersCsv = (process.env.MYSTAPP_USERS ?? '').trim() || undefined;
  const userPrefix = (process.env.MYSTAPP_USER_PREFIX ?? local?.userPrefix ?? '').trim() || undefined;
  const singleUser = (process.env.MYSTAPP_USER ?? process.env.MYSTAPP_USERNAME ?? local?.user ?? '').trim() || undefined;
  const localUsers = local?.users;

  // Resolution strategy summary:
  // 1) Explicit list (env CSV or `users[]` in local config) + shared password.
  // 2) Single user (env/local) + password.
  //    - If `count>1`, we fail by default to avoid shared-session conflicts.
  //    - Set `MYSTAPP_REUSE_SINGLE_USER=1` to intentionally reuse one user.
  // 3) Generated users via prefix + index (e.g. user01, user02, ...).
  //
  // Option A: explicit list: `MYSTAPP_USERS="u1,u2,u3"` + `MYSTAPP_PASSWORD`
  // Option A(local): `users[]` in .mystapp.local.json + password
  const explicitUsernames = usersCsv
    ? usersCsv
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean)
    : (localUsers ?? []).map((u) => String(u).trim()).filter(Boolean);

  if (explicitUsernames.length > 0) {
    if (!password) {
      throw new Error('Missing MYSTAPP_PASSWORD. When using MYSTAPP_USERS, provide a shared password via MYSTAPP_PASSWORD.');
    }

    if (explicitUsernames.length < count) {
      throw new Error(`Mystapp user list has ${explicitUsernames.length} user(s), but ${count} required.`);
    }

    return explicitUsernames.slice(0, count).map((username) => ({ username, password }));
  }

  // Option A0: a single user (env/local) + password.
  // Useful for quick runs; for parallel/stress, prefer multiple users to avoid
  // session invalidation and test interference.
  if (singleUser) {
    if (!password) {
      throw new Error('Missing MYSTAPP_PASSWORD. When using a single user (MYSTAPP_USER/MYSTAPP_USERNAME), provide MYSTAPP_PASSWORD.');
    }

    if (count !== 1) {
      const reuseSingleUser = (process.env.MYSTAPP_REUSE_SINGLE_USER ?? '').trim() === '1';
      if (!reuseSingleUser) {
        throw new Error(
          `A single Mystapp user is configured (${singleUser}), but ${count} required. Provide MYSTAPP_USERS (csv) or MYSTAPP_USER_PREFIX, or set MYSTAPP_REUSE_SINGLE_USER=1 to reuse the same user across multiple sessions.`
        );
      }

      return Array.from({ length: count }, () => ({ username: singleUser, password }));
    }

    return [{ username: singleUser, password }];
  }

  // Option B: generated: `MYSTAPP_USER_PREFIX="user"` + `MYSTAPP_PASSWORD`.
  // Convention: prefix + 2-digit index for stable ordering.
  if (!userPrefix || !password) {
    throw new Error(
      'Missing mystapp credentials. Set either MYSTAPP_USERS (comma-separated) + MYSTAPP_PASSWORD, or MYSTAPP_USER/MYSTAPP_USERNAME + MYSTAPP_PASSWORD, or MYSTAPP_USER_PREFIX + MYSTAPP_PASSWORD, or use .mystapp.local.json.'
    );
  }

  // user01, user02 ... by default: prefix + index
  return Array.from({ length: count }, (_, i) => {
    const index1Based = i + 1;
    const padded = String(index1Based).padStart(2, '0');
    return { username: `${userPrefix}${padded}`, password };
  });
}

/**
 * Login path relative to `baseURL`.
 * Override with `MYSTAPP_LOGIN_PATH` (default: `/login`).
 */
export function mystappLoginPath() {
  return process.env.MYSTAPP_LOGIN_PATH ?? '/login';
}

/**
 * Optional regex (as a string) to match the login HTTP request for API timing.
 *
 * Example:
 * - `MYSTAPP_LOGIN_API_URL_REGEX="/api/auth/login|/oauth/token"`
 */
export function mystappLoginApiUrlRegex(): RegExp | undefined {
  const raw = process.env.MYSTAPP_LOGIN_API_URL_REGEX;
  if (!raw || !raw.trim()) return undefined;
  // Interpreted as a JavaScript RegExp pattern.
  // Tip: use alternation for multiple endpoints: "/api/auth/login|/oauth/token".
  return new RegExp(raw.trim());
}

/** Optional hard max for a single login run (stress test assertion). */
export function mystappMaxLoginMs() {
  const raw = process.env.MYSTAPP_MAX_LOGIN_MS;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Optional p95 threshold for login timings (stress test assertion). */
export function mystappMaxP95LoginMs() {
  const raw = process.env.MYSTAPP_MAX_P95_LOGIN_MS;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Optional p99 threshold for login timings (stress test assertion). */
export function mystappMaxP99LoginMs() {
  const raw = process.env.MYSTAPP_MAX_P99_LOGIN_MS;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Allows overriding selectors from env vars, while keeping a reasonable default.
 *
 * Supported overrides:
 * - `MYSTAPP_USERNAME_SELECTOR`
 * - `MYSTAPP_PASSWORD_SELECTOR`
 * - `MYSTAPP_SUBMIT_SELECTOR`
 */
function locatorFromEnvOrFallback(page: Page, envName: string, fallback: () => ReturnType<Page['locator']>) {
  const selector = process.env[envName];
  if (selector && selector.trim()) return page.locator(selector.trim());
  return fallback();
}

async function firstVisibleLocator(candidates: Array<ReturnType<Page['locator']>>) {
  // Pick one deterministic, visible target to avoid strict-mode violations.
  // Some candidates may throw while the DOM is in transition; treat those as "not visible".
  for (const candidate of candidates) {
    const loc = candidate.first();
    try {
      if (await loc.isVisible()) return loc;
    } catch {
      // ignore
    }
  }
  return undefined;
}

async function mystappFindLoginRoot(page: Page): Promise<Page | Frame> {
  // Some environments render login inside an iframe, and not all of them use
  // native input[type=password] (custom components / role=textbox).
  // We first check the main page, then scan frames, so tests work in both models.
  const looksLikeLoginUi = async (root: Page | Frame) => {
    const hasPassword = await root.locator('input[type="password"]').first().isVisible().catch(() => false);
    const hasTextbox = await root.getByRole('textbox').first().isVisible().catch(() => false);
    const hasUsernameLabel = await root
      .getByLabel(/user(name)?|email|usuario|id|c[oó]digo|legajo/i)
      .or(root.getByPlaceholder(/user(name)?|email|usuario|id|c[oó]digo|legajo/i))
      .first()
      .isVisible()
      .catch(() => false);
    return hasPassword || hasTextbox || hasUsernameLabel;
  };

  if (await looksLikeLoginUi(page)) return page;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (await looksLikeLoginUi(frame)) return frame;
  }

  return page;
}

/**
 * Reusable login flow.
 *
 * What it does:
 * - Navigates to `MYSTAPP_LOGIN_PATH` (default `/login`)
 * - Fills username/password
 * - Clicks submit
 * - Waits until the page is no longer on the login URL (generic success heuristic)
 *
 * Metrics:
 * - Always returns end-to-end duration (`totalMs`).
 * - If `MYSTAPP_LOGIN_API_URL_REGEX` is provided, also captures `apiMs/apiStatus/apiUrl`.
 */
export async function mystappLogin(page: Page, user: MystappUser, options?: MystappLoginOptions) {
  const start = Date.now();

  const apiRegex = mystappLoginApiUrlRegex();
  let apiMs: number | undefined;
  let apiStatus: number | undefined;
  let apiUrl: string | undefined;

  const apiWaitPromise = apiRegex
    ? (async () => {
        const apiStart = Date.now();
        try {
          // Optional metric: time-to-first-response for the first request whose URL matches
          // the configured regex. This is intentionally endpoint-agnostic.
          const response = await page.waitForResponse((r) => apiRegex.test(r.url()), { timeout: 20_000 });
          apiMs = Date.now() - apiStart;
          apiStatus = response.status();
          apiUrl = response.url();
        } catch {
          // Optional metric; no hard fail. If the app does not do a network request,
          // or it doesn't match the regex, we'll just omit apiMs/apiStatus/apiUrl.
        }
      })()
    : undefined;

  // Some environments redirect /login if already authenticated.
  // `waitUntil: 'commit'` makes this fast and avoids waiting for full SPA hydration.
  await page.goto(mystappLoginPath(), { waitUntil: 'commit', timeout: 45_000 }).catch(() => undefined);

  const loginRegex = new RegExp(`${escapeRegex(mystappLoginPath())}($|[?#])`);

  // If we're already logged in, don't try to fill the form.
  // This keeps re-runs fast and avoids flakiness from transient login UI states.
  if (!loginRegex.test(page.url())) {
    await apiWaitPromise;
    return {
      totalMs: Date.now() - start,
      apiMs,
      apiStatus,
      apiUrl,
    } satisfies MystappLoginMetrics;
  }

  // Wait briefly for the login UI to actually render (SPA/iframes can be slow).
  // This is a bounded polling loop rather than a single selector wait because the
  // login can appear in the main document or inside an iframe.
  const renderDeadline = Date.now() + 20_000;
  while (Date.now() < renderDeadline) {
    const onPage = await page
      .getByLabel(/user(name)?|email|usuario|id|c[oó]digo|legajo/i)
      .or(page.getByPlaceholder(/user(name)?|email|usuario|id|c[oó]digo|legajo/i))
      .first()
      .isVisible()
      .catch(() => false);
    const pw = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    const tb = await page.getByRole('textbox').first().isVisible().catch(() => false);
    if (onPage || pw || tb) break;

    let inFrame = false;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const fOnPage = await frame
        .getByLabel(/user(name)?|email|usuario|id|c[oó]digo|legajo/i)
        .or(frame.getByPlaceholder(/user(name)?|email|usuario|id|c[oó]digo|legajo/i))
        .first()
        .isVisible()
        .catch(() => false);
      const fPw = await frame.locator('input[type="password"]').first().isVisible().catch(() => false);
      const fTb = await frame.getByRole('textbox').first().isVisible().catch(() => false);
      if (fOnPage || fPw || fTb) {
        inFrame = true;
        break;
      }
    }
    if (inFrame) break;

    await page.waitForTimeout(250);
  }

  const root = await mystappFindLoginRoot(page);

  // Some login screens use TWO password inputs:
  // first = masked username/code, second = password.
  // We handle this by (optionally) re-resolving the second password field after filling username.
  const passwordInputs = root.locator('input[type="password"]');
  const passwordInputsCount = await passwordInputs.count().catch(() => 0);

  const usernameFromEnv = process.env.MYSTAPP_USERNAME_SELECTOR?.trim();
  const passwordFromEnv = process.env.MYSTAPP_PASSWORD_SELECTOR?.trim();
  const submitFromEnv = process.env.MYSTAPP_SUBMIT_SELECTOR?.trim();

  const usernameCandidates = [
    ...(usernameFromEnv ? [root.locator(usernameFromEnv)] : []),
    ...(passwordInputsCount >= 1 ? [passwordInputs.nth(0)] : []),
    root
      .getByLabel(/user(name)?|email|usuario|id|c[oó]digo|legajo/i)
      .or(root.getByPlaceholder(/user(name)?|email|usuario|id|c[oó]digo|legajo/i)),
    root.getByRole('textbox').first(),
    root.locator('input[type="email"], input[type="text"], input[type="tel"], input[type="number"], input:not([type])'),
  ];

  const passwordCandidates = [
    ...(passwordFromEnv ? [root.locator(passwordFromEnv)] : []),
    ...(passwordInputsCount >= 2 ? [passwordInputs.nth(1)] : []),
    root.getByLabel(/password|clave/i).or(root.getByPlaceholder(/password|clave/i)),
    root.getByRole('textbox').nth(1),
    root.locator('input[type="password"]'),
  ];

  const submitCandidates = [
    ...(submitFromEnv ? [root.locator(submitFromEnv)] : []),
    root.getByRole('button', { name: /log\s*in|sign\s*in|submit|ingresar|entrar|acceder/i }),
    root.locator('button[type="submit"], input[type="submit"], [role="button"][type="submit"]'),
  ];

  const username = await firstVisibleLocator(usernameCandidates);
  let password = await firstVisibleLocator(passwordCandidates);
  const submit = await firstVisibleLocator(submitCandidates);

  if (!username) {
    throw new Error('Could not find username/email field. Set MYSTAPP_USERNAME_SELECTOR to override.');
  }
  if (!password) {
    throw new Error('Could not find password field. Set MYSTAPP_PASSWORD_SELECTOR to override.');
  }

  await expect(username).toBeVisible({ timeout: 15_000 });

  // If we only saw one password input initially and there is no explicit override,
  // the second password input may appear only after filling username.
  if (!passwordFromEnv && passwordInputsCount === 1) {
    password = undefined;
  }

  await username.fill(user.username);

  if (!password) {
    await expect(passwordInputs, 'Expected second password input to appear after filling username.').toHaveCount(2, { timeout: 10_000 }).catch(() => undefined);
    const refreshedCount = await passwordInputs.count().catch(() => 0);
    if (refreshedCount >= 2) {
      password = passwordInputs.nth(1);
    }
  }

  if (!password) {
    throw new Error('Could not find password field after filling username. Set MYSTAPP_PASSWORD_SELECTOR to override.');
  }

  await expect(password).toBeVisible({ timeout: 15_000 });
  await password.fill(user.password);

  if (submit) {
    // Prefer clicking submit if we found a deterministic element; fall back to Enter if click is intercepted.
    await submit.click({ force: true, timeout: 5_000 }).catch(async () => {
      await password!.focus({ timeout: 2_000 }).catch(() => undefined);
      await page.keyboard.press('Enter', { delay: 10 }).catch(() => undefined);
    });
  } else {
    // If we can't find a submit button reliably, submitting via Enter is typically accepted.
    await password.focus({ timeout: 2_000 }).catch(() => undefined);
    await page.keyboard.press('Enter', { delay: 10 }).catch(() => undefined);
  }

  const afterSubmitWaitMs = options?.afterSubmitWaitMs;
  if (typeof afterSubmitWaitMs === 'number' && Number.isFinite(afterSubmitWaitMs) && afterSubmitWaitMs > 0) {
    await page.waitForTimeout(afterSubmitWaitMs);
  }

  // Generic success heuristic: leave the login page (or the app navigates somewhere else).
  // We don't assert a specific post-login element here because that varies across tenants/pages.
  await expect(page).not.toHaveURL(loginRegex, { timeout: 20_000 });

  await apiWaitPromise;

  return {
    totalMs: Date.now() - start,
    apiMs,
    apiStatus,
    apiUrl,
  } satisfies MystappLoginMetrics;
}

/**
 * Convenience helper for future tests: returns a logged-in context.
 * (Not used by the current stress spec, but kept as a building block.)
 */
export async function createLoggedInContext(browser: Browser, user: MystappUser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await mystappLogin(page, user);
  await page.close();
  return context;
}

export async function withDurationMs<T>(fn: () => Promise<T>) {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
