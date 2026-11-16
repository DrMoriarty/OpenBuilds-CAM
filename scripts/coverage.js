#!/usr/bin/env node
/**
 * Line-coverage report for the unit-test suite (zero dependencies).
 * Run via `npm run test:coverage`.
 *
 * Why not `node --test --experimental-test-coverage`? The unit tests load
 * first-party browser/worker code (js/*.js, workers/toolpath/worker/*.js)
 * through vm.runInContext (see test/unit/helpers/), and the built-in reporter
 * only accounts for modules the test runner itself loaded — the vm-loaded
 * files never appear in its table, and files no test touches are invisible
 * entirely, which is exactly what we want to quantify. So we do what the
 * built-in does under the hood: run node --test with NODE_V8_COVERAGE and
 * post-process the raw V8 coverage dumps ourselves.
 *
 * What is measured:
 *   - every first-party file under js/ and workers/ (files no test loads
 *     count as 0% — c8's `--all` semantics), line coverage;
 *   - a line counts as covered if, in any test process, its start offset
 *     falls inside the innermost V8 range with count > 0. Blank lines,
 *     comments and closing braces inside executed ranges therefore count as
 *     covered and lines inside never-called functions as uncovered — a
 *     deliberate approximation, but deterministic and monotonic: tests can
 *     only be added, coverage can only go up.
 *
 * Soft floor: TOTAL_LINE_COVERAGE_FLOOR below is the value measured when this
 * script was introduced. `npm run test:coverage` fails (exit 1) if the total
 * line coverage of js/ + workers/ drops below it, so the number cannot
 * silently regress. Raise the floor (never lower it) whenever coverage grows.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Soft floor (% of lines covered across all js/ + workers/ files).
// Baseline measured when this script was introduced: 13.65% (1574/11530
// lines) with the suite as it stands. The floor is the baseline rounded
// down to one decimal, so harmless line-count drift (comments, blank
// lines) in already-uncovered code cannot false-fail the gate.
// Raise the floor (never lower it) whenever coverage grows.
const TOTAL_LINE_COVERAGE_FLOOR = 13.6;

// First-party directories measured (relative to repo root, recursive).
const TARGET_DIRS = ['js', 'workers'];

// Only files matching the unit-test glob are run; node:test discovers
// nothing else, keep the invocation equivalent to `npm test`.
const TEST_GLOB_DIR = path.join(ROOT, 'test', 'unit');

function fail(msg) {
	console.error('coverage: FAIL');
	console.error(msg);
	process.exit(1);
}

// --- 1. First-party file list (recursive, TARGET_DIRS) ----------------------

function listJsFiles(dir) {
	const out = [];
	for (const name of fs.readdirSync(dir).sort()) {
		const full = path.join(dir, name);
		if (fs.statSync(full).isDirectory()) out.push(...listJsFiles(full));
		else if (name.endsWith('.js')) out.push(full);
	}
	return out;
}

const targetFiles = new Set(); // repo-relative posix paths
for (const dir of TARGET_DIRS) {
	for (const full of listJsFiles(path.join(ROOT, dir))) {
		targetFiles.add(path.relative(ROOT, full).split(path.sep).join('/'));
	}
}
if (targetFiles.size === 0) fail('no first-party files found under ' + TARGET_DIRS.join(', '));

// --- 2. Run the unit tests with V8 coverage collection ----------------------

const coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obc-cov-'));
const testFiles = fs
	.readdirSync(TEST_GLOB_DIR)
	.filter((name) => name.endsWith('.test.js'))
	.sort()
	.map((name) => path.join(TEST_GLOB_DIR, name));
if (testFiles.length === 0) fail('no test files found in test/unit/');

const env = Object.assign({}, process.env, { NODE_V8_COVERAGE: coverageDir });
const res = spawnSync(process.execPath, ['--test', ...testFiles], { env, stdio: 'inherit' });
if (res.error) {
	fs.rmSync(coverageDir, { recursive: true, force: true });
	fail('failed to run node --test: ' + res.error.message);
}
if (res.status !== 0) {
	fs.rmSync(coverageDir, { recursive: true, force: true });
	fail('unit tests failed — fix them before looking at coverage');
}

// --- 3. Merge the raw V8 dumps ----------------------------------------------

// Normalize a V8 dump URL to a repo-relative posix path; returns null for
// anything that is not one of our target files (vendored lib/, test/, node:*).
function toTargetRelPath(url) {
	let rel = url.replace(/^file:\/\//, '');
	if (rel.startsWith(ROOT)) rel = path.relative(ROOT, rel);
	rel = rel.split(path.sep).join('/').replace(/^\.\//, '');
	return targetFiles.has(rel) ? rel : null;
}

// ranges per file: { relPath: [{ start, end, count }] } (merged across dumps)
const rangesByFile = new Map();
for (const name of fs.readdirSync(coverageDir)) {
	if (!name.endsWith('.json')) continue;
	const dump = JSON.parse(fs.readFileSync(path.join(coverageDir, name), 'utf8'));
	for (const entry of dump.result || []) {
		const rel = toTargetRelPath(entry.url);
		if (!rel) continue;
		const fns = entry.functions || [];
		let ranges = rangesByFile.get(rel);
		if (!ranges) rangesByFile.set(rel, (ranges = []));
		for (const fn of fns) {
			for (const r of fn.ranges || []) {
				ranges.push({ start: r.startOffset, end: r.endOffset, count: r.count });
			}
		}
	}
}
fs.rmSync(coverageDir, { recursive: true, force: true });

// --- 4. Line coverage per file ----------------------------------------------

// Covered line numbers for one file, given its merged ranges: a line is
// covered when its start offset sits in the innermost range with count > 0.
function coveredLines(source, ranges) {
	const sorted = ranges.slice().sort((a, b) => a.start - b.start || b.end - a.end);
	const starts = [];
	let offset = 0;
	for (const line of source.split('\n')) {
		starts.push(offset);
		offset += line.length + 1;
	}
	const covered = new Set();
	for (let i = 0; i < starts.length; i++) {
		// innermost = smallest range containing starts[i]
		let best = null;
		for (const r of sorted) {
			if (r.start <= starts[i] && starts[i] < r.end) {
				if (!best || r.end - r.start < best.end - best.start) best = r;
			}
		}
		if (best && best.count > 0) covered.add(i);
	}
	return { total: starts.length, covered };
}

const results = [];
for (const rel of Array.from(targetFiles).sort()) {
	const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
	const ranges = rangesByFile.get(rel) || [];
	const { total, covered } = coveredLines(source, ranges);
	results.push({ rel, total, covered, pct: total ? (100 * covered.size) / total : 0 });
}

// --- 5. Report + soft floor ---------------------------------------------------

const totalLines = results.reduce((sum, r) => sum + r.total, 0);
const totalCovered = results.reduce((sum, r) => sum + r.covered.size, 0);
const totalPct = totalLines ? (100 * totalCovered) / totalLines : 0;

const width = Math.max(...results.map((r) => r.rel.length), 'all files (js/ + workers/)'.length);
console.log('');
console.log('Line coverage (unit tests, test/unit/) — js/ + workers/, untested files shown at 0.00:');
for (const r of results) {
	const bar = Math.round(r.pct / 2.5);
	const uncovered = r.total - r.covered.size;
	console.log(
		'  ' + r.rel.padEnd(width) + ' | ' +
		String(r.covered.size).padStart(5) + ' / ' + String(r.total).padStart(5) + ' lines | ' +
		r.pct.toFixed(2).padStart(6) + '% | ' + '█'.repeat(bar) + '·'.repeat(40 - bar) +
		'  (' + uncovered + ' uncovered)'
	);
}
const bar = Math.round(totalPct / 2.5);
console.log('  ' + 'all files (js/ + workers/)'.padEnd(width) + ' | ' +
	String(totalCovered).padStart(5) + ' / ' + String(totalLines).padStart(5) + ' lines | ' +
	totalPct.toFixed(2).padStart(6) + '% | ' + '█'.repeat(bar) + '·'.repeat(40 - bar));
console.log('');

if (totalPct < TOTAL_LINE_COVERAGE_FLOOR) {
	fail(
		'total line coverage ' + totalPct.toFixed(2) + '% is below the floor of ' +
		TOTAL_LINE_COVERAGE_FLOOR.toFixed(2) + '% — coverage regressed. Add tests or, if the ' +
		'drop is intentional (dead code removed etc.), re-measure and lower the floor in ' +
		'scripts/coverage.js only with a good reason.'
	);
}
console.log('coverage: OK — ' + totalPct.toFixed(2) + '% ≥ floor ' + TOTAL_LINE_COVERAGE_FLOOR.toFixed(2) + '%');
