'use strict';

// Lib-API contract test (bug #bb32d406 follow-up).
//
// ESLint's no-undef only checks identifiers, not their properties, so it
// cannot catch drift between first-party code and the *version* of a
// vendored library: js/advanced-cam-sim.js was written against the GSAP 3
// ticker API (TweenLite.ticker.add/.remove) while lib/threejs/TweenMax.min.js
// vendors GSAP 1.18.4, which only has addEventListener/removeEventListener.
// That only surfaced at runtime, in the browser.
//
// This test loads the real vendored library into an isolated vm context,
// scans the first-party sources for `Global.member.submember` usages of
// that library's globals, and asserts every used member exists on the
// vendored object graph. To register another library, add one entry to
// LIB_CONTRACTS below. Only add libraries that load in Node with the
// (documented, load-time-only) stubs they need — do not grow elaborate
// DOM mocks just to tick a box.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScript } = require('./helpers/load-browser-script');
const { scanMemberUsages, stripCommentsAndStrings } = require('./helpers/scan-member-usages');

// ---------------------------------------------------------------------------
// Contract configuration: one entry per vendored library under test.
//   globals    — top-level names the library publishes and first-party code
//                may reference (must match the globals list in
//                eslint.config.js for these identifiers).
//   consumers  — first-party source roots scanned for usages.
//   sandbox    — load-time-only stubs. GSAP 1.x runs its plugin-activation
//                queue at script load and touches setTimeout/navigator/
//                document/window; the stubs below are inert scaffolding so
//                the file can be *loaded* — no library behaviour is ever
//                exercised, the test only reads properties.
//   allowlist  — `file::Global.member...` entries to skip, each with a
//                comment explaining why (use sparingly).
// ---------------------------------------------------------------------------
const LIB_CONTRACTS = [
	{
		name: 'gsap',
		libPath: 'lib/threejs/TweenMax.min.js',
		libVersion: '1.18.4',
		globals: ['TweenLite', 'TweenMax', 'Linear'],
		consumers: ['js', 'workers'],
		sandbox: {
			setTimeout: function () {},
			navigator: { userAgent: 'node-contract-test' },
			document: {
				createElement: function () {
					return { style: {}, width: 0, getAttribute: function () {}, setAttribute: function () {}, removeAttribute: function () {}, children: [], appendChild: function () {} };
				},
				documentElement: { style: {} },
				addEventListener: function () {},
			},
			window: {},
		},
		allowlist: [],
	},
];

function formatUsage(u) {
	return u.file + ':' + u.line + ' → ' + u.chain.join('.');
}

// ---------------------------------------------------------------------------
// Scanner sanity: comments and strings must not fake member usages.
// ---------------------------------------------------------------------------

test('scanMemberUsages: ignores usages inside comments and string literals', () => {
	const src = [
		'// TweenLite.ticker.add(fake)',
		'/* TweenMax.killAll() */',
		"var s = 'TweenLite.ticker.remove(fake)';",
		'var t = "Linear.easeNone(fake)";',
		'TweenLite.ticker.addEventListener("tick", tick);',
	].join('\n');
	const clean = stripCommentsAndStrings(src);
	assert.equal(clean.match(/\bTweenLite\./g).length, 1, 'only the real usage survives stripping');
	assert.equal(clean.match(/\bTweenMax\./g), null);
	assert.equal(clean.match(/\bLinear\./g), null);
});

// ---------------------------------------------------------------------------
// The real contract: every used member exists on the vendored lib.
// ---------------------------------------------------------------------------

for (const contract of LIB_CONTRACTS) {
	test('lib-api contract: ' + contract.name + ' v' + contract.libVersion, () => {
		// Load the real vendored library into an isolated context.
		const ctx = loadBrowserScript(contract.libPath, contract.sandbox);

		for (const globalName of contract.globals) {
			assert.notEqual(
				typeof ctx[globalName],
				'undefined',
				'Vendored ' + contract.name + ' (' + contract.libPath + ', v' + contract.libVersion + ') does not publish the global "' + globalName + '" — update LIB_CONTRACTS and the globals list in eslint.config.js.'
			);
		}

		const usages = scanMemberUsages(contract.consumers, contract.globals)
			// Allowlist entries are `file::Global.member.chain` keys.
			.filter((u) => !contract.allowlist.includes(u.file + '::' + u.chain.join('.')));

		assert.ok(usages.length > 0, 'Scanner found no ' + contract.globals.join('/') + ' usages under ' + contract.consumers.join(', ') + ' — if the consumers moved, update LIB_CONTRACTS.');

		const broken = [];
		for (const usage of usages) {
			// Walk the property chain; report the first missing link.
			let obj = ctx[usage.chain[0]];
			for (let i = 1; i < usage.chain.length; i++) {
				const member = usage.chain[i];
				if (typeof obj[member] === 'undefined') {
					broken.push(
						formatUsage(usage) + '\n' +
						'    "' + usage.chain.slice(0, i + 1).join('.') + '" is undefined on the vendored ' + contract.name + ' (v' + contract.libVersion + ', ' + contract.libPath + ').\n' +
						'    The code was likely written against a different library version — fix the call site or re-vendor, and update eslint globals only if the global name itself changed.'
					);
					break;
				}
				obj = obj[member];
			}
		}

		assert.deepEqual(
			broken,
			[],
			'Vendored-lib API drift detected (' + broken.length + ' broken member usage' + (broken.length === 1 ? '' : 's') + '):\n\n' + broken.join('\n\n')
		);
	});
}
