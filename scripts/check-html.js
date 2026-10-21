#!/usr/bin/env node
/**
 * index.html script integrity check (zero dependencies). Run via `npm run check-html`.
 *
 * Verifies two things:
 *   1. Every <script src> referenced in index.html exists on disk.
 *      (Commented-out script tags are ignored; http(s):// URLs are skipped.)
 *   2. Every .js file in js/ is either referenced by index.html or listed
 *      in the exception whitelist below. Script order in index.html is
 *      load-bearing (see AGENTS.md), so "added the file, forgot to wire it
 *      up" must fail loudly.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');

// js/ files intentionally not wired into index.html.
const JS_WHITELIST = new Set(['js/unused.js']);

function fail(msg) {
	console.error('check-html: FAIL');
	console.error(msg);
	process.exit(1);
}

const html = fs.readFileSync(HTML, 'utf8');

// Strip HTML comments so disabled <script> tags don't count either way.
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');

// Collect all script srcs (double- or single-quoted).
const srcs = [];
const re = /<script\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/g;
let m;
while ((m = re.exec(htmlNoComments)) !== null) {
	srcs.push(m[2]);
}

// 1. Every referenced script must exist.
const missing = [];
for (const src of srcs) {
	if (/^https?:\/\//i.test(src)) continue; // external CDN reference
	const file = path.join(ROOT, src);
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
		missing.push(src);
	}
}

// 2. Every js/*.js file must be referenced or whitelisted.
const referenced = new Set(
	srcs.filter((src) => !/^https?:\/\//i.test(src)).map((src) => src.replace(/\\/g, '/'))
);

const jsDir = path.join(ROOT, 'js');
const orphan = [];
for (const name of fs.readdirSync(jsDir).sort()) {
	if (!name.endsWith('.js')) continue;
	const rel = 'js/' + name;
	if (!referenced.has(rel) && !JS_WHITELIST.has(rel)) {
		orphan.push(rel);
	}
}

console.log(`check-html: ${srcs.length} <script src> tags found, ${[...referenced].filter((s) => s.startsWith('js/')).length} local js/ files referenced`);

const problems = [];
if (missing.length > 0) {
	problems.push(
		'Scripts referenced in index.html but missing on disk:\n' +
			missing.map((s) => '  - ' + s).join('\n')
	);
}
if (orphan.length > 0) {
	problems.push(
		'Files in js/ not wired into index.html and not whitelisted:\n' +
			orphan.map((s) => '  - ' + s).join('\n') +
			'\n(If intentionally unused, add the file to JS_WHITELIST in scripts/check-html.js.)'
	);
}

if (problems.length > 0) {
	console.error('');
	fail(problems.join('\n\n'));
}

console.log('check-html: OK');
