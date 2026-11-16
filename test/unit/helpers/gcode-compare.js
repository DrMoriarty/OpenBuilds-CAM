'use strict';

/**
 * Tolerant (numeric, not byte-exact) comparison of two G-Code programs.
 *
 * The golden tests must not break on cosmetic changes (whitespace, number
 * formatting), but must catch any real change to coordinates, feeds, speeds
 * or command structure. So instead of diffing strings we compare, line by
 * line:
 *   - comment text (after ";") — compared exactly (trimmed): a change to the
 *     human-readable annotations is an intended change and should be reviewed;
 *   - the sequence of words (letter + number) — letters must match exactly
 *     and in order, numbers are compared with an absolute + relative
 *     tolerance.
 *
 * Blank lines are ignored. Returns null when equal, else an array of
 * human-readable diff descriptions (capped).
 */

// Absolute tolerance in G-Code units (mm): coordinates are emitted with
// toFixed(4), so 1e-3 mm is far above float noise and far below anything
// a machine can feel.
const ABS_TOL = 1e-3;
// Relative tolerance on top, so huge coordinates don't get brittle.
const REL_TOL = 1e-6;

function parseGcodeLine(line) {
	const semi = line.indexOf(';');
	let code = line;
	let comment = '';
	if (semi > -1) {
		comment = line.slice(semi + 1).trim();
		code = line.slice(0, semi);
	}
	const words = [];
	const re = /([A-Za-z])\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
	let m;
	while ((m = re.exec(code)) !== null) {
		words.push({ letter: m[1].toUpperCase(), value: parseFloat(m[2]) });
	}
	return { comment: comment, words: words };
}

function numbersClose(a, b) {
	if (a === b) return true;
	const absDiff = Math.abs(a - b);
	if (absDiff <= ABS_TOL) return true;
	return absDiff <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Returns null if the two programs are equivalent, else an array of diff
 * strings (at most `maxDiffs`, default 20).
 */
function compareGcode(actual, expected, maxDiffs) {
	const limit = maxDiffs || 20;
	const diffs = [];

	const actualLines = String(actual).split(/\r?\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
	const expectedLines = String(expected).split(/\r?\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

	if (actualLines.length !== expectedLines.length) {
		diffs.push('line count differs: actual ' + actualLines.length + ' vs expected ' + expectedLines.length);
	}

	const n = Math.min(actualLines.length, expectedLines.length);
	for (let i = 0; i < n; i++) {
		if (diffs.length >= limit) break;
		const a = parseGcodeLine(actualLines[i]);
		const e = parseGcodeLine(expectedLines[i]);

		if (a.comment !== e.comment) {
			diffs.push('line ' + (i + 1) + ': comment "' + e.comment + '" -> "' + a.comment + '"');
			continue;
		}
		if (a.words.length !== e.words.length) {
			diffs.push('line ' + (i + 1) + ': word count ' + e.words.length + ' -> ' + a.words.length + ' ("' + expectedLines[i] + '" -> "' + actualLines[i] + '")');
			continue;
		}
		for (let w = 0; w < a.words.length; w++) {
			const aw = a.words[w];
			const ew = e.words[w];
			if (aw.letter !== ew.letter) {
				diffs.push('line ' + (i + 1) + ' word ' + (w + 1) + ': ' + ew.letter + ew.value + ' -> ' + aw.letter + aw.value);
				break;
			}
			if (!numbersClose(aw.value, ew.value)) {
				diffs.push('line ' + (i + 1) + ' word ' + (w + 1) + ': ' + ew.letter + ew.value + ' -> ' + aw.letter + aw.value);
				break;
			}
		}
	}
	if (diffs.length > limit) diffs.length = limit;
	return diffs.length ? diffs : null;
}

module.exports = { parseGcodeLine, compareGcode, ABS_TOL, REL_TOL };
