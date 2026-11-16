/**
 * OpenBuilds CAM — Electron main process.
 *
 * The app is a dependency-free static web app, so instead of loading it via
 * file:// (which breaks Web Workers and fetch/XHR) we serve the repo root
 * through a custom `app://` protocol with standard-scheme privileges.
 */
const { app, BrowserWindow, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const SCHEME = 'app';
const HOST = 'openbuilds-cam';
const ROOT = path.join(__dirname, '..');

const MIME = {
	'.html': 'text/html',
	'.htm': 'text/html',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.txt': 'text/plain',
	'.xml': 'application/xml',
	'.webmanifest': 'application/manifest+json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.map': 'application/json',
	'.wasm': 'application/wasm',
};

// Must be called before app is ready. `standard` makes the scheme behave like
// http:// (relative URLs, Web Workers, importScripts); `supportFetchAPI`
// allows $.get()/fetch() against app:// URLs (workspace .obc files);
// `corsEnabled` makes the scheme enforce CORS like http:// (cross-origin
// reads against app:// are treated as CORS requests rather than allowed
// unconditionally — GHSA-v3j7-r9gq-3gjw / GHSA-j84w-jfhq-vhvj). Since the
// app itself is same-origin (everything is served from app://…), this does
// not affect its own fetches.
protocol.registerSchemesAsPrivileged([
	{
		scheme: SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true,
			codeCache: true,
		},
	},
]);

function serveFile(absPath) {
	return fs.promises
		.readFile(absPath)
		.then((data) =>
			new Response(data, {
				headers: {
					'content-type': MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream',
				},
			})
		);
}

function notFound(status, message) {
	return new Response(message, {
		status,
		headers: { 'content-type': 'text/plain' },
	});
}

async function handleAppRequest(request) {
	let pathname;
	try {
		({ pathname } = new URL(request.url));
	} catch {
		return notFound(400, 'Bad request');
	}

	let relPath = decodeURIComponent(pathname).replace(/^\/+/, '');
	if (relPath === '') relPath = 'index.html';

	const absPath = path.normalize(path.join(ROOT, relPath));
	if (!absPath.startsWith(ROOT + path.sep) && absPath !== ROOT) {
		return notFound(403, 'Forbidden');
	}

	let stat;
	try {
		stat = await fs.promises.stat(absPath);
	} catch {
		return notFound(404, `Not found: ${relPath}`);
	}

	if (stat.isDirectory()) {
		return serveFile(path.join(absPath, 'index.html'));
	}
	return serveFile(absPath);
}

function createWindow() {
	const win = new BrowserWindow({
		width: 1600,
		height: 960,
		minWidth: 720,
		title: 'OpenBuilds CAM',
		icon: path.join(__dirname, '..', 'build', 'icon.png'),
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false,
		},
	});

	if (process.env.OBC_SMOKE) runSmoke(win);

	win.loadURL(`${SCHEME}://${HOST}/index.html`);
	return win;
}

// Headless smoke check (run with `OBC_SMOKE=1 npx electron .`): verifies that
// the app:// protocol serves index.html, that fetch() works against app://
// (workspace .obc loading path used by $.get) and that Web Workers spawn and
// load scripts over app:// — then exits with 0/1 for CI or upgrade testing.
function runSmoke(win) {
	win.webContents.on('did-fail-load', (_e, code, desc) => {
		console.error(`[smoke] FAILED: did-fail-load ${code} ${desc}`);
		app.exit(1);
	});
	win.webContents.once('did-finish-load', () => {
		const check = `
			(async () => {
				const results = { title: document.title };
				const ws = await (await fetch('${SCHEME}://${HOST}/workspace/helloworld.obc')).json();
				results.workspaceFetch = ws && typeof ws === 'object' ? 'parsed' : 'bad';
				results.worker = await new Promise((resolve) => {
					const w = new Worker('${SCHEME}://${HOST}/electron/smoke-worker.js');
					w.onmessage = (e) => { resolve(e.data); w.terminate(); };
					w.onerror = (e) => { resolve('error: ' + e.message); w.terminate(); };
					w.postMessage('ping');
				});
				return results;
			})()
		`;
		win.webContents
			.executeJavaScript(check, true)
			.then((results) => {
				console.log('[smoke]', JSON.stringify(results));
				const ok =
					results.title === 'OpenBuilds CAM' &&
					results.workspaceFetch === 'parsed' &&
					results.worker === 'pong:ping';
				console.log(ok ? '[smoke] OK' : '[smoke] FAILED');
				app.exit(ok ? 0 : 1);
			})
			.catch((err) => {
				console.error('[smoke] FAILED:', err.message);
				app.exit(1);
			});
	});
}

function blockTelemetry() {
	// Don't phone home when running as a desktop app (Google Analytics / gtag).
	const filter = { urls: ['*://*.googletagmanager.com/*', '*://*.google-analytics.com/*'] };
	session.defaultSession.webRequest.onBeforeRequest(filter, (_details, callback) =>
		callback({ cancel: true })
	);
}

app.whenReady().then(() => {
	protocol.handle(SCHEME, handleAppRequest);
	blockTelemetry();

	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
