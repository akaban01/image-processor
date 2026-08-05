import { defineConfig, devices } from '@playwright/test';

/**
 * The app is served over HTTP rather than opened from disk because ES modules
 * and workers both require a real origin.
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    // The guided capture needs a camera. 127.0.0.1 counts as a secure origin,
    // so the only thing missing is a device and a granted permission.
    permissions: ['camera'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
          // Sandboxes that ship their own Chromium can point at it with
          // CHROMIUM_PATH instead of downloading a matching build.
          ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
        },
      },
    },
  ],
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
