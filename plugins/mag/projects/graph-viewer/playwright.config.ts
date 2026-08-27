import { defineConfig, devices } from '@playwright/test';
import { createServer } from 'node:net';

// A free port per test run: concurrent runs (several worktrees running the suite at once) must
// never share 5173, and `strictPort` makes a collision fail instead of drifting off the URL.
// Playwright evaluates this config in the runner and again in each worker, so the runner's pick
// is pinned in the environment and every later evaluation reuses it.
const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			if (address === null || typeof address === 'string') return reject(new Error('no port'));
			probe.close(() => resolve(address.port));
		});
	});
const port = Number(process.env.GRAPH_VIEWER_E2E_PORT ?? (process.env.GRAPH_VIEWER_E2E_PORT = String(await freePort())));
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.{ts,js}',
	reporter: 'list',
	use: { baseURL: url },
	// Chromium only: one engine is enough for a smoke test and keeps the browser download small.
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	// The dev server, not a production build: a build takes minutes on a WSL /mnt/c checkout.
	webServer: { command: `bun run dev --port ${port}`, url, reuseExistingServer: false, timeout: 180_000 }
});
