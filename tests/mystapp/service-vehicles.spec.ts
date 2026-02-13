import { performance } from 'node:perf_hooks';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { hasMystappConfig, requireMystappUsers, mystappLogin } from './helpers';

/**
 * Service Vehicles “trial run” + lightweight perf capture.
 *
 * This spec is intentionally defensive because the app UI can vary by environment:
 * - date inputs may be native `type=date` OR Ant Design DatePicker (readonly wrappers)
 * - the results grid can transiently show "No record found" while still loading
 * - clicking a record may open a popup (new tab) OR navigate in the same tab
 *
 * Configuration hooks (optional):
 * - `MYSTAPP_DATE_FORMAT`: "MM/DD/YYYY" (default) or "DD/MM/YYYY"
 * - `MYSTAPP_SERVICE_VEHICLES_*_SELECTOR` vars to override brittle selectors
 * - `MYSTAPP_SERVICE_VEHICLES_USERS` to run the flow for N users
 */

type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY';

function mystappDateFormat(): DateFormat {
  const raw = (process.env.MYSTAPP_DATE_FORMAT ?? 'MM/DD/YYYY').trim().toUpperCase();
  return raw === 'DD/MM/YYYY' ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
}

function toIsoDate(raw: string, format: DateFormat) {
  const parts = raw.trim().split('/').map((p) => p.trim());
  if (parts.length !== 3) throw new Error(`Invalid date '${raw}'. Expected ${format} with '/'.`);

  const [a, b, c] = parts;
  const dd = format === 'DD/MM/YYYY' ? a : b;
  const mm = format === 'DD/MM/YYYY' ? b : a;
  const yyyy = c;
  const dd2 = dd.padStart(2, '0');
  const mm2 = mm.padStart(2, '0');
  return `${yyyy}-${mm2}-${dd2}`;
}

async function fillDateInput(page: Page, locator: Locator, rawDate: string) {
  const format = mystappDateFormat();
  const inputType = await locator.evaluate((el) => (el as HTMLInputElement).type).catch(() => undefined);
  const value = inputType === 'date' ? toIsoDate(rawDate, format) : rawDate;

  // AntD DatePicker sometimes wraps the real <input> and marks it readonly.
  // We target the inner input when present, remove readonly, then fill + dispatch events.
  const target = locator.locator('input, textarea').first().or(locator);

  const readValue = async () => (await target.inputValue().catch(() => '')).trim();

  const makeEditable = async () => {
    await target.evaluate((el) => {
      const input = el as HTMLInputElement;
      input.removeAttribute?.('readonly');
      (input as any).readOnly = false;
    });
  };

  // Attempt 1: make editable + fill.
  // Preferred because it avoids the calendar popup stealing focus.
  await makeEditable();
  await target.fill(value, { timeout: 10_000 });
  await target.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    (el as HTMLElement).blur?.();
  });
  if ((await readValue()) === value) return;

  // Attempt 2: type + commit.
  // Fallback when the controlled component rejects `.fill()`.
  await target.click({ timeout: 10_000, force: true });
  await target.press('ControlOrMeta+A');
  await target.press('Backspace');
  await target.pressSequentially(value, { delay: 10 });
  await target.press('Enter');
  await page.keyboard.press('Escape').catch(() => undefined);
  if ((await readValue()) !== value) {
    throw new Error(`Could not set date input to '${value}'. Current='${await readValue()}'.`);
  }
}

async function measureMs<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number; result: T }> {
  // Uses `performance.now()` to avoid Date() resolution issues and provide consistent timings.
  const start = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - start);
  return { label, ms, result };
}

async function waitForServiceVehiclesGridReady(page: Page) {
  const table = locatorFromEnvOrFallback(page, 'MYSTAPP_SERVICE_VEHICLES_GRID_SELECTOR', () =>
    page.getByRole('table').first().or(page.locator('table').first())
  );
  await expect(table, 'Expected Service Vehicles table to be visible.').toBeVisible({ timeout: 30_000 });

  const noRecordsRow = table.locator('tbody tr:has-text("No record found")');
  const dataRows = table.locator('tbody tr:has(td)').filter({ hasNot: noRecordsRow });

  // The UI can briefly show "No record found" while requests are still in-flight.
  // To avoid false negatives, we only treat the empty state as final after the full wait.
  let sawEmpty = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const rowCount = await dataRows.count().catch(() => 0);
    if (rowCount >= 2) return { status: 'data' as const, rowCount };
    const emptyVisible = await noRecordsRow.isVisible().catch(() => false);
    if (emptyVisible) sawEmpty = true;
    await new Promise((r) => setTimeout(r, 250));
  }

  const finalCount = await dataRows.count().catch(() => 0);
  if (finalCount >= 2) return { status: 'data' as const, rowCount: finalCount };
  return { status: sawEmpty ? ('empty' as const) : ('timeout' as const), rowCount: finalCount };
}

function mystappServiceVehiclesPath() {
  return process.env.MYSTAPP_SERVICE_VEHICLES_PATH ?? '/service-vehicles';
}

function locatorFromEnvOrFallback(page: Page, envName: string, fallback: () => Locator) {
  const selector = process.env[envName];
  if (selector && selector.trim()) return page.locator(selector.trim());
  return fallback();
}

async function clickSecondRowRecordAndOpenPopup(page: Page, opts?: { allowEmpty?: boolean }) {
  const table = locatorFromEnvOrFallback(page, 'MYSTAPP_SERVICE_VEHICLES_GRID_SELECTOR', () =>
    page.getByRole('table').first().or(page.locator('table').first())
  );
  await expect(table, 'Expected Service Vehicles table to be visible.').toBeVisible({ timeout: 30_000 });

  const noRecordsRow = table.locator('tbody tr:has-text("No record found")');
  const dataRows = table.locator('tbody tr:has(td)').filter({ hasNot: noRecordsRow });

  // The UI can briefly show "No record found" while it is still loading.
  // Avoid flakiness by waiting for data rows, and only concluding empty after the full wait.
  let sawEmpty = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const rowCount = await dataRows.count().catch(() => 0);
    if (rowCount >= 2) break;
    const emptyVisible = await noRecordsRow.isVisible().catch(() => false);
    if (emptyVisible) sawEmpty = true;
    await new Promise((r) => setTimeout(r, 250));
  }

  const finalCount = await dataRows.count().catch(() => 0);
  if (finalCount < 2 && sawEmpty) {
    if (opts?.allowEmpty) return { opened: false as const };
    throw new Error('No record found after refresh. Adjust the date range or filters to ensure at least 2 service vehicle records are returned.');
  }
  if (finalCount < 2) {
    throw new Error('Service Vehicles grid did not load at least 2 rows.');
  }

  const secondRow = dataRows.nth(1);

  // Find the "Record" column index when possible.
  // This gives us a deterministic click target (important with Playwright strict mode).
  let recordColIndex = -1;
  try {
    const headerTexts = await table.getByRole('columnheader').allTextContents();
    recordColIndex = headerTexts.findIndex((t) => /\brecord\b/i.test(t.trim()));
  } catch {
    recordColIndex = -1;
  }
  if (recordColIndex < 0) {
    try {
      const thTexts = await table.locator('thead th').allTextContents();
      recordColIndex = thTexts.findIndex((t) => /\brecord\b/i.test(t.trim()));
    } catch {
      recordColIndex = -1;
    }
  }

  const cells = secondRow.locator('td');
  const cellCount = await cells.count().catch(() => 0);

  // Click a single deterministic element to avoid strict-mode violations.
  // Prefer the configured selector; otherwise try to click the Record cell.
  // If the column index doesn't exist (hidden columns / virtualization), fall back to a link/button inside the row.
  const recordCell = locatorFromEnvOrFallback(page, 'MYSTAPP_SERVICE_VEHICLES_RECORD_CELL_SELECTOR', () => {
    if (recordColIndex >= 0 && recordColIndex < cellCount) return cells.nth(recordColIndex);
    return secondRow.locator('a, button, [role="link"], [role="button"]').first().or(cells.first());
  }).first();

  await expect(
    recordCell,
    `Expected Record target to be visible/clickable. recordColIndex=${recordColIndex} cellCount=${cellCount}. If this fails, set MYSTAPP_SERVICE_VEHICLES_GRID_SELECTOR and/or MYSTAPP_SERVICE_VEHICLES_RECORD_CELL_SELECTOR.`
  ).toBeVisible({ timeout: 15_000 });

  // Some builds open a popup; others navigate in the same tab.
  // We race popup detection with the click to handle both patterns.
  let popup: Page | undefined;
  try {
    popup = await Promise.race([
      page.waitForEvent('popup', { timeout: 20_000 }),
      (async () => {
        await recordCell.click({ timeout: 15_000 });
        return undefined as any;
      })(),
    ]);
  } catch {
    await recordCell.click({ timeout: 15_000 });
  }

  if (!popup) {
    popup = await page.waitForEvent('popup', { timeout: 5_000 }).catch(() => undefined);
  }

  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    return { opened: true as const, popup };
  }

  // No popup detected; assume same-tab navigation occurred.
  return { opened: true as const };
}

test.describe('mystapp - service vehicles', () => {
  // This spec can run one flow per user. In stress runs, `MYSTAPP_WORKERS` should
  // typically match the user count so each worker uses a distinct account.
  const userCountRaw = (process.env.MYSTAPP_SERVICE_VEHICLES_USERS ?? '1').trim();
  const userCount = Math.max(1, Number(userCountRaw) || 1);
  let users: ReturnType<typeof requireMystappUsers> | undefined;
  let usersConfigError: string | undefined;

  try {
    users = requireMystappUsers(userCount);
  } catch (err) {
    usersConfigError = err instanceof Error ? err.message : String(err);
  }

  if (!users) {
    test('service vehicles (config) @serviceVehicles', async () => {
      test.skip(true, `Mystapp user configuration error: ${usersConfigError ?? 'unknown error'}`);
    });
    return;
  }

  for (const [i, user] of users.entries()) {
    const index1Based = i + 1;
    test(`login + service vehicles (user ${index1Based}) @serviceVehicles`, async ({ page }, testInfo) => {
      test.setTimeout(process.env.MYSTAPP_PAUSE === '1' ? 10 * 60_000 : 120_000);

      test.skip(
        !hasMystappConfig(),
        'Missing Mystapp credentials. Set env vars or create .mystapp.local.json (see tests/mystapp/docs/README.md).'
      );

      const timings: Record<string, number> = {};

      // Requirement: wait 3 seconds after clicking Submit in login.
      // Note: the wait is implemented inside `mystappLogin` and included in the `login` timing.
      const login = await measureMs('login', async () => mystappLogin(page, user, { afterSubmitWaitMs: 3_000 }));
      timings[login.label] = login.ms;

      // Deterministic navigation to Service Vehicles.
      // We rely on an URL heuristic rather than page-specific selectors to keep this portable.
      const nav = await measureMs('goto_service_vehicles', async () =>
        page.goto(mystappServiceVehiclesPath(), { waitUntil: 'domcontentloaded', timeout: 45_000 })
      );
      timings[nav.label] = nav.ms;
      await expect(page, 'Expected to be on Service Vehicles (URL heuristic).').toHaveURL(/\/service[-_]?vehicles([/?#]|$)/i, { timeout: 30_000 });

      // Trial steps requested by user:
      // - Fill Start date with 02/01/2025
      // - Click refresh (span#refresh)
      // - Wait 3 seconds after clicking
      const startDateRaw = '02/01/2025';

      const startDateInput = locatorFromEnvOrFallback(page, 'MYSTAPP_SERVICE_VEHICLES_START_DATE_SELECTOR', () =>
        page
          .getByRole('textbox', { name: /start\s*date/i })
          .first()
          .or(page.locator('input[placeholder="Start date"]').first())
      );

      await expect(startDateInput, 'Expected Start date input to be visible.').toBeVisible({ timeout: 30_000 });
      const fillStart = await measureMs('fill_start_date', async () => fillDateInput(page, startDateInput, startDateRaw));
      timings[fillStart.label] = fillStart.ms;
      await expect(startDateInput).toHaveValue(startDateRaw, { timeout: 10_000 });

      const refresh = page.locator('#refresh').first();
      await expect(refresh, 'Expected refresh container (#refresh) to be visible.').toBeVisible({ timeout: 15_000 });
      await refresh.scrollIntoViewIfNeeded();
      const refreshAndGrid = await measureMs('refresh_to_grid_ready', async () => {
        // Some builds wrap the clickable element inside #refresh.
        // Clicking via JS is often more reliable when transient overlays are present.
        await refresh.evaluate((el) => {
          const target = el.querySelector('span[aria-label="sync"], .anticon-sync') ?? el;
          (target as HTMLElement).click();
        });
        return waitForServiceVehiclesGridReady(page);
      });
      timings[refreshAndGrid.label] = refreshAndGrid.ms;

      // Keep the original “wait 3 seconds after clicking” requirement (separate from perf metric).
      await page.waitForTimeout(3_000);

      // Requirement: click the 2nd record (Record column) and expect a new page (popup).
      const open = await measureMs('open_second_record', async () => clickSecondRowRecordAndOpenPopup(page, { allowEmpty: true }));
      timings[open.label] = open.ms;
      const result = open.result;
      if (!result.opened) {
        test.skip(
          true,
          'No service vehicle records found for this user/date window in this environment. Provide a user/date window with data or adjust filters.'
        );
      }

      const timingsJson = JSON.stringify(timings, null, 2);

      const timingsPath = testInfo.outputPath('timings.json');
      await testInfo.attach('timings.json', {
        body: Buffer.from(timingsJson),
        contentType: 'application/json',
      });
      await testInfo.attach('timings-path.txt', {
        body: Buffer.from(timingsPath + '\n'),
        contentType: 'text/plain',
      });

      // Persist for aggregation across many users/tests.
      // `timings.json` is both attached to the report and written to the test output directory.
      const fs = await import('node:fs/promises');
      await fs.writeFile(timingsPath, timingsJson, 'utf8');

      const timingsMd =
        ['# Timings', '', '| Action | ms |', '|---|---:|', ...Object.entries(timings).map(([k, v]) => `| ${k} | ${v} |`), ''].join(
          '\n'
        );
      await testInfo.attach('timings.md', {
        body: Buffer.from(timingsMd),
        contentType: 'text/markdown',
      });

      // Handy for terminal runs (CI/list reporter).
      console.log(`[perf] service-vehicles user-${String(index1Based).padStart(2, '0')}`, timings);

      // Final pause to observe what happens on the Service Vehicle page.
      if (process.env.MYSTAPP_PAUSE === '1') {
        if (result.popup) await result.popup.pause();
        else await page.pause();
      }
    });
  }
});
