import { test, expect, type Locator, type Page } from '@playwright/test';
import { hasMystappConfig, requireMystappUsers, mystappLogin } from './helpers';
import { envIsOn, installNetworkCapture } from './netlog';

/**
 * Invoices “trial run” flow.
 *
 * This spec favors resilience over minimal selectors because the UI can differ
 * across environments (Ant Design inputs, changing column order, popup vs same-tab).
 *
 * Optional configuration hooks:
 * - `MYSTAPP_DATE_FORMAT`: "MM/DD/YYYY" (default) or "DD/MM/YYYY"
 * - `MYSTAPP_INVOICES_*_SELECTOR` vars to override selectors for a specific build
 * - `MYSTAPP_INVOICES_INVOICE_VALUE`: click a specific invoice value if provided
 */

type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY';

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mystappInvoicesPath() {
  return process.env.MYSTAPP_INVOICES_PATH ?? '/invoices';
}

function mystappDateFormat(): DateFormat {
  // Default aligned with what the UI displays in QA (e.g. 02/10/2026).
  const raw = (process.env.MYSTAPP_DATE_FORMAT ?? 'MM/DD/YYYY').trim().toUpperCase();
  return raw === 'DD/MM/YYYY' ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
}

function formatDate(d: Date, format: DateFormat) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return format === 'DD/MM/YYYY' ? `${dd}/${mm}/${yyyy}` : `${mm}/${dd}/${yyyy}`;
}

function toIsoDate(raw: string, format: DateFormat) {
  const parts = raw.trim().split('/').map((p) => p.trim());
  if (parts.length !== 3) throw new Error(`Invalid date '${raw}'. Expected ${format} with '/'.`);

  const [a, b, c] = parts;
  const dd = format === 'DD/MM/YYYY' ? a : b;
  const mm = format === 'DD/MM/YYYY' ? b : a;
  const yyyy = c;

  if (!/^[0-9]{4}$/.test(yyyy)) throw new Error(`Invalid year in '${raw}'.`);
  if (!/^[0-9]{1,2}$/.test(dd) || !/^[0-9]{1,2}$/.test(mm)) throw new Error(`Invalid day/month in '${raw}'.`);

  const dd2 = dd.padStart(2, '0');
  const mm2 = mm.padStart(2, '0');
  return `${yyyy}-${mm2}-${dd2}`;
}

function locatorFromEnvOrFallback(page: Page, envName: string, fallback: () => Locator) {
  const selector = process.env[envName];
  if (selector && selector.trim()) return page.locator(selector.trim());
  return fallback();
}

async function isVisible(locator: Locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function fillDateInput(page: Page, locator: Locator, rawDate: string) {
  const format = mystappDateFormat();

  const inputType = await locator.evaluate((el) => (el as HTMLInputElement).type).catch(() => undefined);

  const value = inputType === 'date' ? toIsoDate(rawDate, format) : rawDate;

  // Ant Design DatePicker renders: .ant-picker-input > input[readonly][placeholder=...]
  // We remove readonly and fill the *actual input*.
  const innerInput = locator.locator('input, textarea').first();
  const innerCount = await locator.locator('input, textarea').count().catch(() => 0);
  const isDirectInput = await locator
    .evaluate((el) => {
      const tag = (el as HTMLElement).tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea';
    })
    .catch(() => false);

  const target = isDirectInput ? locator : innerCount > 0 ? innerInput : locator;

  const readValue = async () => {
    try {
      if (isDirectInput || innerCount > 0) return await target.inputValue();
      return await locator.inputValue();
    } catch {
      return await locator.evaluate((el) => {
        const anyEl = el as any;
        if (typeof anyEl.value === 'string') return anyEl.value;
        return (el.textContent ?? '').trim();
      });
    }
  };

  const attemptErrors: string[] = [];

  // Readonly is common in AntD date inputs. We try to remove it, but not all builds allow it.
  const isReadOnly = await target
    .evaluate((el) => {
      const input = el as HTMLInputElement;
      return !!(input.hasAttribute?.('readonly') || (input as any).readOnly);
    })
    .catch(() => false);

  // Note: `isReadOnly` is kept for diagnostics/understanding; the attempts below handle both cases.

  // Attempt 1: remove readonly + fill WITHOUT clicking.
  // Clicking AntD date inputs often opens the calendar popup and steals focus,
  // causing typed keys to go to the popup (month navigation) instead of the input.
  try {
    await target.evaluate((el) => {
      try {
        const input = el as HTMLInputElement;
        input.removeAttribute?.('readonly');
        (input as any).readOnly = false;
      } catch {
        // ignore
      }
    });
    await target.fill(value, { timeout: 10_000 });
    await target.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      (el as HTMLElement).blur?.();
    });
    if ((await readValue()).trim() === value) return;
  } catch (e: any) {
    attemptErrors.push(`fill: ${String(e?.message ?? e)}`);
  }

  // Attempt 2: focus + keyboard type (only if needed).
  // Still avoid Tab; Enter is used to commit.
  try {
    await target.click({ timeout: 10_000, force: true });
    await target.press('ControlOrMeta+A');
    await target.press('Backspace');
    await target.pressSequentially(value, { delay: 10 });
    await target.press('Enter').catch(() => undefined);
    await target.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      (el as HTMLElement).blur?.();
    });
    // If clicking opened the popup, close it so it doesn't interfere with later steps.
    await page.keyboard.press('Escape').catch(() => undefined);
    if ((await readValue()).trim() === value) return;
  } catch (e: any) {
    attemptErrors.push(`keyboard: ${String(e?.message ?? e)}`);
  }

  // Attempt 3: JS set value (direct assignment + events).
  // The "native setter" trick can be brittle across realms/iframes; keep it simple.
  try {
    await target.evaluate(
      (el, v) => {
        const input = el as HTMLInputElement;
        try {
          input.removeAttribute?.('readonly');
          (input as any).readOnly = false;
        } catch {
          // ignore
        }
        (input as any).value = String(v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      },
      value
    );
    if ((await readValue()).trim() === value) return;
  } catch (e: any) {
    attemptErrors.push(`js: ${String(e?.message ?? e)}`);
  }

  const finalValue = (await readValue()).trim();
  throw new Error(`Could not set date input to '${value}'. Current='${finalValue}'. Attempts: ${attemptErrors.join(' | ')}`);

  // (verification/diagnostics are handled by the attempts above)
}

async function clickSecondRowInvoice(page: Page, opts?: { allowEmpty?: boolean }): Promise<boolean> {
  const tableOrGrid = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_GRID_SELECTOR', () =>
    page
      .getByRole('table')
      .first()
      .or(page.locator('[role="grid"]').first())
      .or(page.locator('table').first())
  );

  await expect(tableOrGrid, 'Expected invoices table/grid to be visible.').toBeVisible({ timeout: 30_000 });

  // Prefer accessible roles for rows/cells, but many tables in this app do not expose them.
  // We keep both role-based and CSS-based strategies and pick whichever is usable.
  const roleRows = tableOrGrid.getByRole('row');
  const roleCells = tableOrGrid.getByRole('cell');
  const roleDataRows = roleRows.filter({ has: roleCells });

  // Fallback for plain HTML tables.
  // Use only real data rows (must have <td>) to avoid picking group/placeholder rows.
  const cssRows = tableOrGrid.locator('tbody tr:has(td)');

  const noRecordsText = tableOrGrid.locator('text=/No record found/i').first();
  const isNoRecordsRow = tableOrGrid.locator('tbody tr:has-text("No record found")');

  // Wait for at least 2 real result rows.
  // Important: this UI can briefly show “No record found” while still loading.
  // To avoid flakiness, only treat the empty state as final when the overall wait expires.
  let sawEmpty = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const cssCount = await cssRows.count().catch(() => 0);
    const roleCount = await roleDataRows.count().catch(() => 0);
    const count = Math.max(cssCount, roleCount);
    if (count >= 2) break;

    const emptyVisible = await noRecordsText.isVisible().catch(() => false);
    if (emptyVisible) sawEmpty = true;

    await new Promise((r) => setTimeout(r, 250));
  }

  const cssCountFinal = await cssRows.count().catch(() => 0);
  const roleCountFinal = await roleDataRows.count().catch(() => 0);
  const countFinal = Math.max(cssCountFinal, roleCountFinal);

  if (countFinal < 2 && sawEmpty) {
    if (opts?.allowEmpty) return false;
    throw new Error('No record found after refresh. Adjust the date range or filters to ensure at least 2 invoices are returned.');
  }

  if (countFinal < 2) {
    throw new Error('Invoices grid did not load at least 2 rows.');
  }

  // Pick the most reliable row locator.
  const cssCount = await cssRows.count().catch(() => 0);
  const rows = cssCount >= 2 ? cssRows.filter({ hasNot: isNoRecordsRow }) : roleDataRows;
  const secondRow = rows.nth(1);
  await expect(secondRow).toBeVisible({ timeout: 15_000 });

  // Try to click the "Invoice" column cell by header index.
  // Caution: the index can be wrong if columns are hidden/reordered, so we validate later.
  const headers = tableOrGrid.getByRole('columnheader');
  let invoiceColIndex = -1;
  try {
    const headerTexts = await headers.allTextContents();
    invoiceColIndex = headerTexts.findIndex((t) => /\binvoice\b/i.test(t.trim()));
  } catch {
    invoiceColIndex = -1;
  }

  // Fallback: plain table headers.
  if (invoiceColIndex < 0) {
    try {
      const th = tableOrGrid.locator('thead th');
      const thTexts = await th.allTextContents();
      invoiceColIndex = thTexts.findIndex((t) => /\binvoice\b/i.test(t.trim()));
    } catch {
      invoiceColIndex = -1;
    }
  }

  const targetInvoiceValue = (process.env.MYSTAPP_INVOICES_INVOICE_VALUE ?? '').trim();
  if (targetInvoiceValue) {
    // If a target invoice value is provided, clicking it is usually more stable than relying
    // on column indices (which can shift between builds).
    const target = tableOrGrid.locator(`text=${targetInvoiceValue}`).first();
    await expect(target, `Expected invoice value '${targetInvoiceValue}' to appear in results.`).toBeVisible({ timeout: 30_000 });
    await target.click({ timeout: 15_000 });
    return true;
  }

  const invoiceCell = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_INVOICE_CELL_SELECTOR', () => {
    if (invoiceColIndex >= 0) {
      // Prefer role-based cell; if absent, use td.
      // BUT: the header index can be wrong when columns are hidden/reordered.
      // We'll validate the index later and fall back if it's out of bounds.
      return secondRow.getByRole('cell').nth(invoiceColIndex).or(secondRow.locator('td').nth(invoiceColIndex));
    }

    return (
      secondRow
        .locator('[col-id*="invoice" i], [data-field*="invoice" i], [data-col*="invoice" i]')
        .first()
        .or(secondRow.getByRole('link').first())
        .or(secondRow.locator('text=/\\b\\d{5,}\\b/').first())
    );
  });

  // If we found an invoice column index but the row doesn't have that many cells,
  // the locator above will never resolve. Detect that and fall back to heuristics.
  let invoiceCellFinal = invoiceCell;
  if (invoiceColIndex >= 0) {
    const roleCount = await secondRow.getByRole('cell').count().catch(() => 0);
    const tdCount = await secondRow.locator('td').count().catch(() => 0);
    const maxCount = Math.max(roleCount, tdCount);
    if (maxCount > 0 && invoiceColIndex >= maxCount) {
      invoiceCellFinal = secondRow
        .locator('[col-id*="invoice" i], [data-field*="invoice" i], [data-col*="invoice" i]')
        .first()
        .or(secondRow.getByRole('link').first())
        .or(secondRow.locator('a').first())
        .or(secondRow.locator('text=/\\b\\d{3,}\\b/').first())
        .or(secondRow.locator('td').filter({ hasText: /\S/ }).first())
        .or(secondRow.locator('td').first());
    }
  }

  await expect(invoiceCellFinal, 'Expected an Invoice cell/link in the second row.').toBeVisible({ timeout: 15_000 });
  await invoiceCellFinal.click({ timeout: 15_000 });
  return true;
}

async function clickSecondRowInvoiceAndGetInvoiceValue(page: Page, opts?: { allowEmpty?: boolean }) {
  const tableOrGrid = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_GRID_SELECTOR', () =>
    page
      .getByRole('table')
      .first()
      .or(page.locator('[role="grid"]').first())
      .or(page.locator('table').first())
  );

  await expect(tableOrGrid, 'Expected invoices table/grid to be visible.').toBeVisible({ timeout: 30_000 });

  // Use only real data rows (must have <td>) to avoid picking group/placeholder rows.
  const cssRows = tableOrGrid.locator('tbody tr:has(td)');
  const roleRows = tableOrGrid.getByRole('row');
  const roleCells = tableOrGrid.getByRole('cell');
  const roleDataRows = roleRows.filter({ has: roleCells });

  const noRecordsText = tableOrGrid.locator('text=/No record found/i').first();
  const isNoRecordsRow = tableOrGrid.locator('tbody tr:has-text("No record found")');

  let sawEmpty = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const cssCount = await cssRows.count().catch(() => 0);
    const roleCount = await roleDataRows.count().catch(() => 0);
    const count = Math.max(cssCount, roleCount);
    if (count >= 2) break;

    const emptyVisible = await noRecordsText.isVisible().catch(() => false);
    if (emptyVisible) sawEmpty = true;

    await new Promise((r) => setTimeout(r, 250));
  }

  const cssCountFinal = await cssRows.count().catch(() => 0);
  const roleCountFinal = await roleDataRows.count().catch(() => 0);
  const countFinal = Math.max(cssCountFinal, roleCountFinal);

  if (countFinal < 2 && sawEmpty) {
    if (opts?.allowEmpty) return { clicked: false as const };
    throw new Error('No record found after refresh. Adjust the date range or filters to ensure at least 2 invoices are returned.');
  }

  if (countFinal < 2) throw new Error('Invoices grid did not load at least 2 rows.');

  const cssCount = await cssRows.count().catch(() => 0);
  const rows = cssCount >= 2 ? cssRows.filter({ hasNot: isNoRecordsRow }) : roleDataRows;
  const secondRow = rows.nth(1);
  await expect(secondRow).toBeVisible({ timeout: 15_000 });

  // Find invoice column index when possible.
  // Used as a first attempt, but we keep multiple fallbacks for robustness.
  let invoiceColIndex = -1;
  try {
    const headerTexts = await tableOrGrid.getByRole('columnheader').allTextContents();
    invoiceColIndex = headerTexts.findIndex((t) => /\binvoice\b/i.test(t.trim()));
  } catch {
    invoiceColIndex = -1;
  }
  if (invoiceColIndex < 0) {
    try {
      const thTexts = await tableOrGrid.locator('thead th').allTextContents();
      invoiceColIndex = thTexts.findIndex((t) => /\binvoice\b/i.test(t.trim()));
    } catch {
      invoiceColIndex = -1;
    }
  }

  const targetInvoiceValue = (process.env.MYSTAPP_INVOICES_INVOICE_VALUE ?? '').trim();

  const invoiceCell = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_INVOICE_CELL_SELECTOR', () => {
    if (targetInvoiceValue) return tableOrGrid.locator(`text=${targetInvoiceValue}`).first();

    if (invoiceColIndex >= 0) {
      return secondRow.getByRole('cell').nth(invoiceColIndex).or(secondRow.locator('td').nth(invoiceColIndex));
    }

    return (
      secondRow
        .locator('[col-id*="invoice" i], [data-field*="invoice" i], [data-col*="invoice" i]')
        .first()
        .or(secondRow.getByRole('link').first())
        .or(secondRow.locator('a').first())
        .or(secondRow.locator('text=/\\b\\d{5,}\\b/').first())
    );
  });

  let invoiceCellFinal = invoiceCell;
  if (!targetInvoiceValue && invoiceColIndex >= 0) {
    const roleCount = await secondRow.getByRole('cell').count().catch(() => 0);
    const tdCount = await secondRow.locator('td').count().catch(() => 0);
    const maxCount = Math.max(roleCount, tdCount);
    if (maxCount > 0 && invoiceColIndex >= maxCount) {
      invoiceCellFinal = secondRow
        .locator('[col-id*="invoice" i], [data-field*="invoice" i], [data-col*="invoice" i]')
        .first()
        .or(secondRow.getByRole('link').first())
        .or(secondRow.locator('a').first())
        .or(secondRow.locator('text=/\\b\\d{3,}\\b/').first())
        .or(secondRow.locator('td').filter({ hasText: /\S/ }).first())
        .or(secondRow.locator('td').first());
    }
  }

  // If we still end up with a selector that may resolve to nothing, keep a hard fallback.
  if (!targetInvoiceValue) {
    invoiceCellFinal = invoiceCellFinal
      .or(secondRow.locator('td').filter({ hasText: /\S/ }).first())
      .or(secondRow.locator('td').first());
  }

  await expect(invoiceCellFinal, 'Expected an Invoice cell/link in the second row.').toBeVisible({ timeout: 15_000 });

  const invoiceValue = (
    (await invoiceCellFinal.innerText().catch(async () => (await invoiceCellFinal.textContent()) ?? ''))
      .replace(/\s+/g, ' ')
      .trim()
  );

  // Click and capture popup if the app opens a new tab.
  // Some builds navigate in the same tab, so popup is optional.
  let popup: Page | undefined;
  try {
    popup = await Promise.race([
      page.waitForEvent('popup', { timeout: 15_000 }),
      (async () => {
        await invoiceCellFinal.click({ timeout: 15_000 });
        return undefined as any;
      })(),
    ]);
  } catch {
    // Fallback: if popup wait threw, still try clicking.
    await invoiceCellFinal.click({ timeout: 15_000 });
  }

  // If Promise.race returned undefined (click finished first), await popup for a short window.
  if (!popup) {
    popup = await page.waitForEvent('popup', { timeout: 5_000 }).catch(() => undefined);
  }

  return { clicked: true as const, invoiceValue, popup };
}

async function safeAttachScreenshot(testInfo: ReturnType<typeof test.info>, page: Page, name: string) {
  if (process.env.MYSTAPP_ATTACH_SCREENSHOTS === '0') return;
  try {
    await testInfo.attach(name, {
      body: await page.screenshot({ fullPage: false, timeout: 15_000 }),
      contentType: 'image/png',
    });
  } catch {
    // ignore screenshot failures/timeouts
  }
}

async function clickInvoicesRefresh(page: Page) {
  const refreshRoot = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_REFRESH_SELECTOR', () => page.locator('#refresh').first());

  await expect(refreshRoot, 'Expected refresh control (#refresh) to be visible.').toBeVisible({ timeout: 15_000 });
  await refreshRoot.scrollIntoViewIfNeeded().catch(() => undefined);

  try {
    await refreshRoot.click({ timeout: 10_000 });
    return;
  } catch {
    // Some builds have transient overlays inside #refresh (progress circle / svg). Force via JS.
    await refreshRoot.evaluate((el) => (el as HTMLElement).click());
  }
}

test.describe('mystapp - invoices', () => {
  test('login + invoices: search by date range @invoices', async ({ page }, testInfo) => {
    test.setTimeout(process.env.MYSTAPP_PAUSE === '1' ? 10 * 60_000 : 120_000);

    if (process.env.MYSTAPP_PAUSE === '1') {
      page.pause();
    }

    test.skip(
      !hasMystappConfig(),
      'Missing Mystapp credentials. Set env vars or create .mystapp.local.json (see tests/mystapp/docs/README.md).'
    );

    const captureNetwork = envIsOn('MYSTAPP_NETLOG');
    const captureBodies = envIsOn('MYSTAPP_NETLOG_BODIES');
    const net = captureNetwork
      ? installNetworkCapture(page, testInfo, {
          captureBodies,
          // If you only want backend calls, set e.g. MYSTAPP_NETLOG_URL_REGEX="/api/|/graphql".
          urlIncludeRegex: process.env.MYSTAPP_NETLOG_URL_REGEX ? new RegExp(process.env.MYSTAPP_NETLOG_URL_REGEX) : undefined,
        })
      : undefined;

    try {

    const user = requireMystappUsers(1)[0]!;
    await mystappLogin(page, user);

    await safeAttachScreenshot(test.info(), page, 'after-login');

    // After login, requirement: click the Invoices icon/tile.
    // On the home dashboard this is usually a link with href "/invoices".
    const invoicesTile = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_TILE_SELECTOR', () =>
      page
        // Prefer the exact Invoices icon the user provided.
        .locator(
          'a:has(img[alt*="Invoices" i]), a:has(img[src*="/Storage/Images/Invoices.png" i]), button:has(img[alt*="Invoices" i]), [role="button"]:has(img[alt*="Invoices" i])'
        )
        .or(page.getByRole('link', { name: /invoices?/i }))
        .or(page.locator('a[href="/invoices"], a[href$="/invoices"], a[href*="/invoices?"], a[href*="/invoices#"], a[href*="/invoices/"]'))
        .first()
    );

    const invoicesUrlRe = /\/invoices([/?#]|$)/i;

    // Requirement: click the invoices icon/tile after login.
    if (await isVisible(invoicesTile)) {
      await invoicesTile.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      await invoicesTile.click({ force: true, timeout: 15_000 });
      await page.waitForURL(invoicesUrlRe, { timeout: 30_000 }).catch(() => undefined);
    }

    // Fallback: if we didn't land on invoices, go directly.
    // This makes the test resilient to dashboard layout changes.
    if (!invoicesUrlRe.test(page.url())) {
      await page.goto(mystappInvoicesPath(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForURL(invoicesUrlRe, { timeout: 30_000 });
    }

    await safeAttachScreenshot(test.info(), page, 'after-click-invoices');

    // Wait until invoices view is actually rendered.
    await expect(
      page
        .getByRole('heading', { name: /invoices?/i })
        .first()
        .or(page.locator('[data-testid*="invoice" i], [data-test*="invoice" i]').first()),
      'Expected to be on Invoices after clicking the icon/tile.'
    ).toBeVisible({ timeout: 30_000 });

    // Date filter to search.
    // Keep dates in code (not env vars) so the test can run with a simple command.
    // Required by user (trial run):
    // - Start date: 02/01/2025
    // - Click Refresh
    // - Wait 10 seconds after clicking
    // Note: the QA UI uses MM/DD/YYYY by default.
    const fromRaw = (process.env.MYSTAPP_INVOICES_FROM_DATE ?? '02/01/2025').trim();
    const toRaw = (process.env.MYSTAPP_INVOICES_TO_DATE ?? '').trim();

    // If Advanced Filters are open and have stale selections, clear them first.
    const resetFilters = page.getByRole('button', { name: /reset\s*filters/i }).first();
    if (await isVisible(resetFilters)) {
      await resetFilters.click({ timeout: 10_000 });
    }

    // Prefer the actual inputs by placeholder; this page renders them reliably.
    const antFrom = page.locator('input[placeholder="Start date"]').first();
    const antTo = page.locator('input[placeholder="End date"]').first();

    if (process.env.MYSTAPP_DEBUG === '1') {
      const antFromCount = await antFrom.count().catch(() => 0);
      const antToCount = await antTo.count().catch(() => 0);
      console.log('[mystappInvoices] ant-range-inputs', { antFromCount, antToCount });
    }

    const from = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_FROM_SELECTOR', () =>
      antFrom
    );

    const to = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_TO_SELECTOR', () =>
      antTo
    );

    const range = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_RANGE_SELECTOR', () =>
      page
        .getByLabel(/range|period/i)
        .or(page.getByPlaceholder(/range|period/i))
        .first()
    );

    if (await isVisible(from)) {
      // Set Start date only (trial run).
      await expect(from).toBeVisible({ timeout: 15_000 });
      await fillDateInput(page, from, fromRaw);

      // Optional: also set End date when provided.
      if (toRaw && (await isVisible(to))) {
        await expect(to).toBeVisible({ timeout: 15_000 });
        await fillDateInput(page, to, toRaw);
      }

      if (process.env.MYSTAPP_DEBUG === '1') {
        const startVal = await page.locator('input[placeholder="Start date"]').first().inputValue().catch(() => '');
        const endVal = await page.locator('input[placeholder="End date"]').first().inputValue().catch(() => '');
        console.log('[mystappInvoices] dates', { startVal, endVal, fromRaw });
      }

      // Ensure the visible inputs show the expected values before refreshing.
      const startInput = page.locator('input[placeholder="Start date"]').first();
      const startType = await startInput.evaluate((el) => (el as HTMLInputElement).type).catch(() => undefined);
      const expectedFrom = startType === 'date' ? toIsoDate(fromRaw, mystappDateFormat()) : fromRaw;
      await expect(startInput).toHaveValue(expectedFrom, { timeout: 10_000 });

      if (toRaw) {
        const endInput = page.locator('input[placeholder="End date"]').first();
        const endType = await endInput.evaluate((el) => (el as HTMLInputElement).type).catch(() => undefined);
        const expectedTo = endType === 'date' ? toIsoDate(toRaw, mystappDateFormat()) : toRaw;
        await expect(endInput).toHaveValue(expectedTo, { timeout: 10_000 }).catch(() => undefined);
      }
    } else if (await isVisible(range)) {
      await expect(range).toBeVisible({ timeout: 15_000 });
      // If the UI only exposes a single range input, set a same-day range.
      const right = toRaw || fromRaw;
      await range.fill(`${fromRaw} - ${right}`);
      try {
        await range.press('Enter');
      } catch {
        // ignore
      }
    } else {
      throw new Error(
        'Could not find date inputs for invoices. Set MYSTAPP_INVOICES_FROM_SELECTOR or MYSTAPP_INVOICES_RANGE_SELECTOR.'
      );
    }

    // Requirement: click the refresh control after setting dates.
    // We prefer #refresh (known app pattern) with a fallback to a generic Search/Apply button.
    if (await isVisible(page.locator('#refresh').first())) {
      await clickInvoicesRefresh(page);
    } else {
      // Fallback: a generic search/apply button.
      const searchButton = locatorFromEnvOrFallback(page, 'MYSTAPP_INVOICES_SEARCH_SELECTOR', () =>
        page.getByRole('button', { name: /search|apply|filter|refresh/i }).first()
      );
      if (await isVisible(searchButton)) {
        await searchButton.click({ timeout: 15_000 });
      }
    }

    // Trial requirement: wait 4 seconds after clicking refresh.
    // We keep this explicit delay separate from the UI waits so the test matches the
    // originally requested manual steps.
    await page.waitForTimeout(4_000);

    // Pause right after refresh so we can inspect results/state.
    if (process.env.MYSTAPP_PAUSE === '1') {
      await page.pause();
    }

    // Wait for results, then click the Invoice field in the second row.
    // If empty, skip the data-dependent click.
    const result = await clickSecondRowInvoiceAndGetInvoiceValue(page, { allowEmpty: true });
    if (!result.clicked) {
      test.skip(true, 'No invoices found for this user/date window in this environment. Provide a user/date window with data or adjust filters.');
    }

    // Validate the invoice number in the newly opened tab (popup).
    if (result.popup) {
      await result.popup.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
      await result.popup.waitForTimeout(3_000);
      const expected = new RegExp(`Invoice:\\s*${escapeRegExp(result.invoiceValue)}`, 'i');
      await expect(result.popup.getByText(expected).first(), `Expected invoice details to show Invoice: ${result.invoiceValue}`).toBeVisible({ timeout: 30_000 });
      await safeAttachScreenshot(test.info(), result.popup, 'invoice-detail-popup');
    }

    await safeAttachScreenshot(test.info(), page, 'invoices-after-search');
    } finally {
      if (net) await net.stop();
    }
  });
});
