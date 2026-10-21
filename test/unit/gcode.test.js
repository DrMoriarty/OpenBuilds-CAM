'use strict';

// Unit tests for the pure G-Code helpers in js/advanced-cam-gcode.js:
// estimateGcodeRuntimeSeconds, formatRuntime and indexOfVertexClosestTo.
// The file is loaded in a bare vm context; it only touches $/scene inside
// functions we do not call, so nothing needs stubbing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScript } = require('./helpers/load-browser-script');
const approx = require('./helpers/approx');

const ctx = loadBrowserScript('js/advanced-cam-gcode.js');

test('estimateGcodeRuntimeSeconds: single feed move', () => {
	// 10 mm at 600 mm/min = 1 s
	approx(ctx.estimateGcodeRuntimeSeconds('G1 X10 F600'), 1, 1e-9);
});

test('estimateGcodeRuntimeSeconds: feedrate is modal', () => {
	// F sticks until the next F word
	const gcode = 'G1 F600\nG1 X10\nG1 X20\n';
	// 20 mm at 600 mm/min = 2 s
	approx(ctx.estimateGcodeRuntimeSeconds(gcode), 2, 1e-9);
});

test('estimateGcodeRuntimeSeconds: moves without F yet fall back to the 1000 mm/min rapid rate', () => {
	// 100 mm at 1000 mm/min = 6 s
	approx(ctx.estimateGcodeRuntimeSeconds('G0 X100'), 6, 1e-9);
});

test('estimateGcodeRuntimeSeconds: G20 inch mode scales coordinates and feeds', () => {
	// 1 inch at 60 ipm (= 1524 mm/min after unit scaling) -> 1 second
	approx(ctx.estimateGcodeRuntimeSeconds('G20\nG1 X1 F60'), 1, 1e-9);
});

test('estimateGcodeRuntimeSeconds: G4 dwell adds time (P and S words)', () => {
	approx(ctx.estimateGcodeRuntimeSeconds('G4 P2.5'), 2.5, 1e-9);
	approx(ctx.estimateGcodeRuntimeSeconds('G4 S1.5'), 1.5, 1e-9);
	approx(ctx.estimateGcodeRuntimeSeconds('G4 P1\nG4 S2'), 3, 1e-9);
});

test('estimateGcodeRuntimeSeconds: comments and blank lines are ignored', () => {
	const gcode = '; header comment\n\nG1 X10 F600 ; cut\n(with comment)\n';
	approx(ctx.estimateGcodeRuntimeSeconds(gcode), 1, 1e-9);
});

test('estimateGcodeRuntimeSeconds: 3d distance between consecutive moves', () => {
	// 3-4-12 triangle in mm -> 13 mm at 600 mm/min = 1.3 s
	const gcode = 'G1 X3 Y4 Z12 F600\n';
	approx(ctx.estimateGcodeRuntimeSeconds(gcode), 1.3, 1e-9);
});

test('formatRuntime renders human-readable durations', () => {
	assert.equal(ctx.formatRuntime(0), '0s');
	assert.equal(ctx.formatRuntime(4), '4s');
	assert.equal(ctx.formatRuntime(59), '59s');
	assert.equal(ctx.formatRuntime(60), '1m 00s');
	assert.equal(ctx.formatRuntime(727), '12m 07s');
	assert.equal(ctx.formatRuntime(4327), '1h 12m 07s');
	assert.equal(ctx.formatRuntime(-5), '0s');
});

test('indexOfVertexClosestTo picks the nearest vertex', () => {
	const square = [
		{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
		{ x: 0, y: 0 } // closed contours repeat their start point
	];
	assert.equal(ctx.indexOfVertexClosestTo(square, 9.9, 0.1), 1);
	assert.equal(ctx.indexOfVertexClosestTo(square, 0.1, 9.9), 3);
	// The duplicated last point is excluded from the scan
	assert.equal(ctx.indexOfVertexClosestTo(square, 0, 0), 0);
});

test('indexOfVertexClosestTo handles degenerate inputs', () => {
	assert.equal(ctx.indexOfVertexClosestTo([], 5, 5), 0);
	assert.equal(ctx.indexOfVertexClosestTo([{ x: 1, y: 2 }], 5, 5), 0);
});
