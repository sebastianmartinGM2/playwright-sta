import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import { readMystappLocalConfig } from './tests/mystapp/localConfig';

const hasTestimCredentials = !!process.env.TESTIM_USERNAME && !!process.env.TESTIM_PASSWORD;
const mystappBaseURL = process.env.MYSTAPP_BASE_URL ?? readMystappLocalConfig()?.baseURL ?? 'https://qa.mystaapp.com';
const slowMo = (() => {
  const raw = process.env.PW_SLOW_MO;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
})();

const mystappWorkers = (() => {
  const raw = process.env.MYSTAPP_WORKERS;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
})();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    trace: 'on-first-retry',
    launchOptions: slowMo ? { slowMo } : undefined,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/demoblaze/**', '**/testim/**', '**/mystapp/**'],
      use: { ...devices['Desktop Chrome'], baseURL: 'https://playwright.dev' },
    },
    {
      name: 'firefox',
      testIgnore: ['**/demoblaze/**', '**/testim/**', '**/mystapp/**'],
      use: { ...devices['Desktop Firefox'], baseURL: 'https://playwright.dev' },
    },
    {
      name: 'webkit',
      testIgnore: ['**/demoblaze/**', '**/testim/**', '**/mystapp/**'],
      use: { ...devices['Desktop Safari'], baseURL: 'https://playwright.dev' },
    },
    {
      name: 'demoblaze-setup',
      testMatch: ['**/demoblaze/auth.setup.ts'],
      workers: 1,
      use: { ...devices['Desktop Chrome'], baseURL: 'https://www.demoblaze.com' },
    },
    {
      name: 'demoblaze-chromium',
      testMatch: ['**/demoblaze/**/*.spec.ts'],
      dependencies: ['demoblaze-setup'],
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'https://www.demoblaze.com',
        storageState: '.auth/demoblaze.json',
      },
    },
    {
      name: 'demoblaze-firefox',
      testMatch: ['**/demoblaze/**/*.spec.ts'],
      dependencies: ['demoblaze-setup'],
      workers: 1,
      use: {
        ...devices['Desktop Firefox'],
        baseURL: 'https://www.demoblaze.com',
        storageState: '.auth/demoblaze.json',
      },
    },
    {
      name: 'demoblaze-webkit',
      testMatch: ['**/demoblaze/**/*.spec.ts'],
      dependencies: ['demoblaze-setup'],
      workers: 1,
      use: {
        ...devices['Desktop Safari'],
        baseURL: 'https://www.demoblaze.com',
        storageState: '.auth/demoblaze.json',
      },
    },
    {
      name: 'testim-setup',
      testMatch: ['**/testim/auth.setup.ts'],
      workers: 1,
      use: { ...devices['Desktop Chrome'], baseURL: 'https://demo.testim.io' },
    },
    {
      name: 'testim-chromium',
      testMatch: ['**/testim/**/*.spec.ts'],
      dependencies: ['testim-setup'],
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'https://demo.testim.io',
        storageState: hasTestimCredentials ? '.auth/testim.json' : undefined,
      },
    },
    {
      name: 'testim-firefox',
      testMatch: ['**/testim/**/*.spec.ts'],
      dependencies: ['testim-setup'],
      workers: 1,
      use: {
        ...devices['Desktop Firefox'],
        baseURL: 'https://demo.testim.io',
        storageState: hasTestimCredentials ? '.auth/testim.json' : undefined,
      },
    },
    {
      name: 'testim-webkit',
      testMatch: ['**/testim/**/*.spec.ts'],
      dependencies: ['testim-setup'],
      workers: 1,
      use: {
        ...devices['Desktop Safari'],
        baseURL: 'https://demo.testim.io',
        storageState: hasTestimCredentials ? '.auth/testim.json' : undefined,
      },
    },
    {
      name: 'mystapp-setup',
      testMatch: ['**/mystapp/auth.setup.ts'],
      workers: 1,
      use: { ...devices['Desktop Chrome'], baseURL: mystappBaseURL },
    },
    {
      name: 'mystapp-chromium',
      testMatch: ['**/mystapp/**/*.spec.ts'],
      workers: mystappWorkers ?? 1,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: mystappBaseURL,
      },
    },
  ],
  outputDir: 'test-results/',
});
