'use strict';

/**
 * Minimal source scanner used by the lib-API contract test
 * (test/unit/lib-api-contract.test.js).
 *
 * Given first-party sources (js/, workers/), it collects every
 * `Global.member.submember` usage of a known set of vendored-library
 * globals. This closes the gap ESLint's no-undef cannot cover: no-undef
 * checks identifiers only, never their properties, so a member rename or
 * a "code written for GSAP 3, repo vendors GSAP 1" drift is invisible to it.
 *
 * The scanner is deliberately simplistic (same spirit as the one in
 * eslint.config.js): it strips comments and string literals so their
 * contents cannot fake usages, then applies a member-chain regex. Anything
 * the scanner cannot express cleanly belongs in the test's allowlist with
 * a justifying comment — not in more scanner cleverness.
 */

const fs = require('fs');
const path = require('path');

// Remove comments and string/regex-ish literals so their contents can't
// fake member usages. Not a full lexer — good enough for an inventory.
// Newlines inside comments/strings are preserved so line numbers computed
// on the cleaned source still match the original file.
function stripCommentsAndStrings(src) {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const d = src[i + 1];
		if (c === '/' && d === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && d === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') out += '\n';
				i++;
			}
			i += 2;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			const quote = c;
			out += quote;
			i++;
			while (i < src.length) {
				if (src[i] === '\\') { out += 'X'; i += 2; continue; }
				if (src[i] === quote) break;
				if (src[i] === '\n') out += '\n';
				i++;
			}
			out += quote;
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function listJsFilesRecursively(dirRelPath) {
	const out = [];
	const abs = path.join(__dirname, '..', '..', '..', dirRelPath);
	if (!fs.existsSync(abs)) return out;
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		const rel = dirRelPath + '/' + entry.name;
		if (entry.isDirectory()) {
			// Vendored/lib-like subtrees under a scanned root are not first-party.
			if (entry.name === 'lib' || entry.name === 'node_modules' || entry.name === 'vendor') continue;
			out.push(...listJsFilesRecursively(rel));
		} else if (entry.isFile() && entry.name.endsWith('.js')) {
			out.push(rel);
		}
	}
	return out;
}

/**
 * @param {string[]} rootRelPaths e.g. ['js', 'workers']
 * @param {string[]} globalNames  e.g. ['TweenLite', 'TweenMax', 'Linear']
 * @returns {Array<{file: string, line: number, chain: string[]}>}
 *   `chain` is ['TweenLite', 'ticker', 'addEventListener'] for
 *   `TweenLite.ticker.addEventListener`. Each result appears once per
 *   file/chain (duplicates within a file are collapsed).
 */
function scanMemberUsages(rootRelPaths, globalNames) {
	const globalsAlt = globalNames.map(escapeRe).join('|');
	const re = new RegExp('\\b(' + globalsAlt + ')((?:\\.\\$?\\w+)+)', 'g');
	const seen = new Set();
	const results = [];

	for (const root of rootRelPaths) {
		for (const file of listJsFilesRecursively(root)) {
			const clean = stripCommentsAndStrings(fs.readFileSync(path.join(__dirname, '..', '..', '..', file), 'utf8'));
			let m;
			re.lastIndex = 0;
			while ((m = re.exec(clean)) !== null) {
				const line = clean.slice(0, m.index).split('\n').length;
				const chain = m[2].slice(1).split('.');
				const key = file + '::' + chain.join('.');
				if (seen.has(key)) continue;
				seen.add(key);
				results.push({ file, line, chain: [m[1]].concat(chain) });
			}
		}
	}
	return results;
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { stripCommentsAndStrings, scanMemberUsages, listJsFilesRecursively };
