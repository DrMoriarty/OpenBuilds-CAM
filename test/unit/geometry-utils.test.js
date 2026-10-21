'use strict';

// Unit tests for the pure geometry helpers in js/advanced-cam-geometryutils.js.
// The file is loaded in a bare vm context: it has no top-level DOM/THREE
// access (alterGeometry uses THREE only when called), so nothing needs stubbing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScript, evalInContext } = require('./helpers/load-browser-script');
const approx = require('./helpers/approx');

const ctx = loadBrowserScript('js/advanced-cam-geometryutils.js');

test('distanceFormula computes euclidean distance', () => {
	assert.equal(ctx.distanceFormula(0, 3, 0, 4), 5);
	assert.equal(ctx.distanceFormula(1, 1, 1, 1), 0);
	assert.equal(ctx.distanceFormula(0, -3, 0, 4), 5);
	approx(ctx.distanceFormula(0, 1, 0, 1), Math.SQRT2, 1e-12);
});

test('newPointFromDistanceAndAngle walks from a point at an angle', () => {
	// Angles are in degrees, 0 = +x, 90 = +y
	// (compare element-wise: arrays created inside the vm realm have a
	// different Array.prototype than the host realm)
	const p0 = ctx.newPointFromDistanceAndAngle([0, 0], 0, 10);
	approx(p0[0], 10, 1e-9);
	approx(p0[1], 0, 1e-9);
	const p90 = ctx.newPointFromDistanceAndAngle([0, 0], 90, 10);
	approx(p90[0], 0, 1e-9);
	approx(p90[1], 10, 1e-9);
	const p45 = ctx.newPointFromDistanceAndAngle([100, 50], 45, Math.SQRT2 * 10);
	approx(p45[0], 110, 1e-9);
	approx(p45[1], 60, 1e-9);
});

test('calcPolygonArea: square, triangle, empty input', () => {
	const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
	approx(ctx.calcPolygonArea(square), 100, 1e-9);
	// Winding must not matter (shoelace result is absolutised)
	const squareCW = square.slice().reverse();
	approx(ctx.calcPolygonArea(squareCW), 100, 1e-9);
	const triangle = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }];
	approx(ctx.calcPolygonArea(triangle), 6, 1e-9);
	assert.equal(ctx.calcPolygonArea([]), undefined);
	assert.equal(ctx.calcPolygonArea(null), undefined);
});

test('indexOfMax finds the vertex pair with the largest gap', () => {
	// Pairs (i, i+1): the largest distance is between points 1 and 2
	const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 0 }];
	assert.equal(ctx.indexOfMax(pts), 1);
	// Single pair (loop runs from 1 to length-2): largest gap at index 1
	const two = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 7 }];
	assert.equal(ctx.indexOfMax(two), 1);
});

test('Array.prototype.rotateRight rotates circularly without mutating the source', () => {
	// Compare as JSON: the result array lives in the vm realm, so
	// deepStrictEqual would fail on the differing Array.prototype
	const rotated = evalInContext(ctx, '["a","b","c","d"].rotateRight(2)');
	assert.equal(JSON.stringify(rotated), JSON.stringify(['c', 'd', 'a', 'b']));
	assert.equal(JSON.stringify(evalInContext(ctx, '["a","b","c"].rotateRight(0)')), '["a","b","c"]');
	assert.equal(JSON.stringify(evalInContext(ctx, '["a","b","c"].rotateRight(6)')), '["a","b","c"]');
});
