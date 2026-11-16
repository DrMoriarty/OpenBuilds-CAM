'use strict';

// Golden (snapshot) tests for the G-Code generation pipeline:
//
//   test/fixtures/<case>.json  (fixture: serialized THREE toolpath group —
//                               the exact payload the app posts to the
//                               toolpath worker — plus generateGcode args)
//   → workers/toolpath/worker/toolpathworker.js   (real code, vm-shimmed env)
//   → THREE.ObjectLoader.parse                    (real code, vendored lib)
//   → js/advanced-cam-gcode.js generateGcode()    (real code, stubbed $/DOM)
//   → compared against test/fixtures/golden/<case>.nc
//
// The comparison is numeric with a tolerance (see helpers/gcode-compare.js):
// cosmetic changes (whitespace, number formatting) don't break the gate, but
// any real change to coordinates, feeds, speeds or structure does. An
// intended change to the output must be committed together with refreshed
// reference files:
//
//   node test/unit/helpers/generate-goldens.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { generateGcodeFromFixture } = require('./helpers/worker-sandbox');
const { compareGcode, parseGcodeLine } = require('./helpers/gcode-compare');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const GOLDEN_DIR = path.join(FIXTURES_DIR, 'golden');

function fixtureFiles() {
	return fs.readdirSync(FIXTURES_DIR)
		.filter(function(f) { return f.endsWith('.json'); })
		.sort();
}

function loadFixture(name) {
	return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

function loadGolden(name) {
	return fs.readFileSync(path.join(GOLDEN_DIR, name.replace(/\.json$/, '.nc')), 'utf8');
}

// --- One golden test per fixture -------------------------------------------

for (const file of fixtureFiles()) {
	test('golden: ' + file + ' matches reference G-Code', () => {
		const fixture = loadFixture(file);
		const gcode = generateGcodeFromFixture(fixture);
		assert.ok(gcode && gcode.trim().length > 0, 'generator produced empty G-Code');

		const diffs = compareGcode(gcode, loadGolden(file));
		if (diffs) {
			assert.fail(
				'G-Code differs from the checked-in reference ' + file.replace(/\.json$/, '.nc') +
				'. If this change is intended, refresh the reference with ' +
				'`node test/unit/helpers/generate-goldens.js` and commit it in the same PR.\n' +
				diffs.join('\n')
			);
		}
		assert.ok(true);
	});
}

// --- Sanity checks: the goldens must never go vacuous -----------------------
// If the pipeline silently broke and produced garbage (or nothing), the byte
// comparison above would still fail — but these pin the essential semantics
// of each operation independently of the reference files.

function wordsOf(line) {
	return parseGcodeLine(line).words.map(function(w) { return w.letter + w.value; });
}

// first numeric word with the given letter in a line, or undefined
function firstWord(line, letter) {
	return wordsOf(line).filter(function(w) { return w[0] === letter; })[0];
}

function linesOf(gcode) {
	return gcode.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
}

test('sanity: CNC outside offset stays 1.5 mm (half tool) outside the 100x50 square', () => {
	const gcode = generateGcodeFromFixture(loadFixture('cnc-square-outside.json'));
	const moves = linesOf(gcode).filter(function(l) { return /^G1/.test(l); });
	// clipper corner arcs + 4 straight sides: leftmost X must be -1.5, rightmost X 101.5
	const xs = moves.map(function(l) { return firstWord(l, 'X'); }).filter(function(x) { return x !== undefined; });
	assert.ok(xs.some(function(x) { return Math.abs(parseFloat(x.slice(1)) - (-1.5)) < 1e-3; }), 'expected an X-1.5 outside-offset coordinate, moves:\n' + moves.join('\n'));
	assert.ok(xs.some(function(x) { return Math.abs(parseFloat(x.slice(1)) - 101.5) < 1e-3; }), 'expected an X101.5 outside-offset coordinate');
});

test('sanity: CNC inside offset stays 1.5 mm inside the 100x50 square', () => {
	const gcode = generateGcodeFromFixture(loadFixture('cnc-square-inside.json'));
	const moves = linesOf(gcode).filter(function(l) { return /^G1/.test(l); });
	const xs = moves.map(function(l) { return firstWord(l, 'X'); }).filter(function(x) { return x !== undefined; });
	assert.ok(xs.some(function(x) { return Math.abs(parseFloat(x.slice(1)) - 1.5) < 1e-3; }), 'expected X1.5 inside-offset coordinate');
	assert.ok(xs.every(function(x) { return parseFloat(x.slice(1)) > 0 && parseFloat(x.slice(1)) < 100; }), 'all cut X inside the square');
});

test('sanity: drill produces one plunge cycle per hole at the hole centers', () => {
	const gcode = generateGcodeFromFixture(loadFixture('drill-two-holes.json'));
	const text = linesOf(gcode).join('\n');
	// deepest point of each cycle
	assert.match(text, /X20\.0000 Y20\.0000 Z-3\.0000/);
	assert.match(text, /X60\.0000 Y30\.0000 Z-3\.0000/);
	// two full plunge cycles: 2 rapids to Z0 before plunging at feed
	assert.equal(linesOf(gcode).filter(function(l) { return /^G1 F700 Z/.test(l); }).length, 2);
});

test('sanity: laser uses S power words and never starts a spindle', () => {
	const gcode = generateGcodeFromFixture(loadFixture('laser-square-nooffset.json'));
	const text = linesOf(gcode).join('\n');
	assert.doesNotMatch(text, /M3/, 'laser output must not contain M3 (spindle)');
	const cut = linesOf(gcode).filter(function(l) { return /^G1 F3000/.test(l); });
	assert.ok(cut.length > 0);
	for (const l of cut) assert.ok(/\bS1000\b/.test(l), 'cut move carries S power word: ' + l);
});

test('sanity: every CNC program retracts to the clearance height at the end', () => {
	for (const file of ['cnc-square-outside.json', 'cnc-square-inside.json', 'cnc-open-nooffset.json']) {
		const gcode = generateGcodeFromFixture(loadFixture(file));
		const last = linesOf(gcode).pop();
		assert.match(last, /^G0 Z7$/, file + ' must end with a retract to Z7');
	}
});

// --- Comparator behaviour ---------------------------------------------------

test('compareGcode tolerates cosmetic reformatting', () => {
	// different spacing/case/number formatting, same program
	assert.equal(compareGcode(
		'g1 f1000  x10.00000 y20.0000\n',
		'G1 F1000 X10.0 Y20.0000\n'
	), null);
	// extra blank lines are ignored
	assert.equal(compareGcode('G1 X10\n\n\nG1 Y5\n', 'G1 X10\nG1 Y5\n'), null);
});

test('compareGcode catches real changes', () => {
	// coordinate drift beyond tolerance
	assert.ok(compareGcode('G1 X10.002\n', 'G1 X10.000\n') !== null);
	// feed change
	assert.ok(compareGcode('G1 F900 X10\n', 'G1 F1000 X10\n') !== null);
	// missing word
	assert.ok(compareGcode('G1 X10\n', 'G1 X10 Y5\n') !== null);
	// different command
	assert.ok(compareGcode('G0 X10\n', 'G1 X10\n') !== null);
	// changed comment
	assert.ok(compareGcode('G1 X10 ; Direct Plunge\n', 'G1 X10 ; plunge\n') !== null);
	// missing line
	assert.ok(compareGcode('G1 X10\nG1 Y5\n', 'G1 X10\n') !== null);
});
