'use strict';

// node:assert has no "approximately"; float maths (mm/inch conversions,
// trigonometry) needs a tolerance helper.

const assert = require('node:assert/strict');

module.exports = function approx(actual, expected, tol, message) {
	tol = tol === undefined ? 1e-9 : tol;
	assert.ok(
		Math.abs(actual - expected) <= tol,
		(message || 'approx') + ': expected ' + actual + ' to be within ' + tol + ' of ' + expected
	);
};
