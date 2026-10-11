import { defineConfig } from '@playwright/test'

// The Playwright Test example suite (COMPONENT-17): the reference SPA from
// tests/parallel, served per worker, with WireMock behind it, run by two
// workers at once. No Cucumber.
export default defineConfig({
  testDir: __dirname,
  testMatch: '*.pw.ts',
  workers: Number(process.env.WORKERS ?? 2),
  fullyParallel: true,
  forbidOnly: true,
  reporter: 'list',
  use: { browserName: 'chromium' },
})
