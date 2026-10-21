/**
 * Playwright config for the smoke tests (test/e2e).
 *
 * The webServer step starts the zero-dependency static server
 * (scripts/static-server.js) with the repo root as document root —
 * required by the app's root-absolute importScripts() paths in the
 * toolpath worker (see AGENTS.md).
 */
'use strict';

const { devices } = require('@playwright/test');

module.exports = {
	testDir: 'test/e2e',
	timeout: 60 * 1000,
	expect: { timeout: 10 * 1000 },
	outputDir: 'test-results',
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

	use: {
		baseURL: 'http://127.0.0.1:8123',
		headless: true
	},

	webServer: {
		command: 'node scripts/static-server.js 8123',
		url: 'http://127.0.0.1:8123/index.html',
		reuseExistingServer: !process.env.CI,
		timeout: 15 * 1000
	},

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	]
};
