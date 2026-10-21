#!/usr/bin/env node
/**
 * Syntax check: runs `node --check` over every first-party JS file
 * (js/, workers/, electron/) so the build fails on any syntax error,
 * not just the one in electron/main.js.
 *
 * Zero dependencies. Run via `npm run check`.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Glob directories to scan for *.js files, relative to repo root.
const TARGET_DIRS = ['js', 'workers', 'electron'];

function listJsFiles(dir) {
	const out = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listJsFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.js')) {
			out.push(full);
		}
	}
	return out;
}

const files = TARGET_DIRS
	.map((dir) => path.join(ROOT, dir))
	.filter((dir) => fs.existsSync(dir))
	.flatMap((dir) => listJsFiles(dir))
	.sort();

if (files.length === 0) {
	console.error('check-syntax: no .js files found under ' + TARGET_DIRS.join(', '));
	process.exit(1);
}

const failures = [];
for (const file of files) {
	const rel = path.relative(ROOT, file);
	const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
	if (res.status !== 0) {
		failures.push({ file: rel, output: (res.stderr || res.stdout || '').trim() });
	}
}

console.log(`check-syntax: ${files.length} files checked`);

if (failures.length > 0) {
	console.error(`\ncheck-syntax: ${failures.length} file(s) failed:\n`);
	for (const f of failures) {
		console.error(`--- ${f.file}`);
		console.error(f.output + '\n');
	}
	process.exit(1);
}

console.log('check-syntax: OK');
