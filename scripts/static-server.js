#!/usr/bin/env node
/**
 * Minimal zero-dependency static HTTP server, root = repo root.
 *
 * Exists for the Playwright smoke tests: the app must be served over HTTP,
 * never file:// — it spawns Web Workers and uses root-absolute paths in
 * importScripts() (lib/clipperjs/..., lib/threejs/three.min.js), which only
 * resolve when the server root is the repo root (see AGENTS.md).
 *
 * Usage: node scripts/static-server.js [port]
 * Default port: 8123 (or $PORT).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT || '8123', 10);

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
	'.map': 'application/json',
	'.wasm': 'application/wasm'
};

const server = http.createServer(function(req, res) {
	let urlPath;
	try {
		urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
	} catch {
		res.writeHead(400).end('Bad request');
		return;
	}
	if (urlPath.endsWith('/')) urlPath += 'index.html';

	// Resolve inside ROOT only (no traversal).
	const filePath = path.join(ROOT, urlPath);
	if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
		res.writeHead(403).end('Forbidden');
		return;
	}

	fs.stat(filePath, function(err, stat) {
		if (err || !stat.isFile()) {
			res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + urlPath);
			return;
		}
		res.writeHead(200, {
			'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
			'Content-Length': stat.size,
			'Cache-Control': 'no-store'
		});
		fs.createReadStream(filePath).pipe(res);
	});
});

server.listen(PORT, '127.0.0.1', function() {
	console.log('static-server: serving ' + ROOT + ' at http://127.0.0.1:' + PORT);
});
