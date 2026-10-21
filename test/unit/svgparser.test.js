'use strict';

// Unit tests for the pure SVG import helpers in js/svgparser.js:
// svgCssLengthToUserUnits and foldTransformOrigins.
//
// js/svgparser.js instantiates SVGParser.Parser() at load time, so the vm
// sandbox carries a minimal stub of that vendored global. The parser itself
// is lib/ code and is not exercised here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScript } = require('./helpers/load-browser-script');
const approx = require('./helpers/approx');

const SVGParserStub = {
	Parser: function() {
		this.onTag = function() {};
	}
};

const ctx = loadBrowserScript('js/svgparser.js', { SVGParser: SVGParserStub });

test('svgCssLengthToUserUnits: unit-less and px values pass through', () => {
	assert.equal(ctx.svgCssLengthToUserUnits('42'), 42);
	assert.equal(ctx.svgCssLengthToUserUnits('42px'), 42);
	assert.equal(ctx.svgCssLengthToUserUnits('3.5'), 3.5);
	assert.equal(ctx.svgCssLengthToUserUnits('.5'), 0.5);
	assert.equal(ctx.svgCssLengthToUserUnits('-10px'), -10);
	assert.equal(ctx.svgCssLengthToUserUnits('1e2'), 100);
});

test('svgCssLengthToUserUnits: physical units normalise to px at 90dpi', () => {
	approx(ctx.svgCssLengthToUserUnits('1in'), 90, 1e-9);
	approx(ctx.svgCssLengthToUserUnits('1mm'), 90 / 25.4, 1e-9);
	approx(ctx.svgCssLengthToUserUnits('25.4mm'), 90, 1e-9);
	approx(ctx.svgCssLengthToUserUnits('2cm'), 180 / 2.54, 1e-9);
	approx(ctx.svgCssLengthToUserUnits('72pt'), 90, 1e-9);
	approx(ctx.svgCssLengthToUserUnits('6pc'), 90, 1e-9);
	approx(ctx.svgCssLengthToUserUnits('4q'), 90 / 25.4, 1e-9);
});

test('svgCssLengthToUserUnits: unsupported or malformed values return null', () => {
	assert.equal(ctx.svgCssLengthToUserUnits('50%'), null);
	assert.equal(ctx.svgCssLengthToUserUnits('2em'), null);
	assert.equal(ctx.svgCssLengthToUserUnits(''), null);
	assert.equal(ctx.svgCssLengthToUserUnits('abc'), null);
	assert.equal(ctx.svgCssLengthToUserUnits('10 mm extra'), null);
});

test('foldTransformOrigins: folds origin from style into the transform attribute', () => {
	const input = '<g transform="rotate(90)" style="transform-origin: 10px 20px"><path d="M0 0"/></g>';
	const output = ctx.foldTransformOrigins(input);
	assert.ok(output.includes('translate(10,20) rotate(90) translate(-10,-20)'), 'got: ' + output);
	assert.ok(output.startsWith('<g transform="'), 'transform attribute rewritten in place');
});

test('foldTransformOrigins: also reads transform-origin as a presentation attribute', () => {
	const input = '<rect transform="scale(2)" transform-origin="5mm 5mm"/>';
	const output = ctx.foldTransformOrigins(input);
	const mm = 5 * 90 / 25.4;
	assert.ok(
		output.includes('translate(' + mm + ',' + mm + ') scale(2) translate(' + -mm + ',' + -mm + ')'),
		'got: ' + output
	);
});

test('foldTransformOrigins: leaves unsupported origins untouched', () => {
	// Percentages and keywords are not supported -> tag must survive verbatim
	const percent = '<g transform="rotate(90)" style="transform-origin: 50% 50%"/>';
	assert.equal(ctx.foldTransformOrigins(percent), percent);

	const keyword = '<g transform="rotate(90)" style="transform-origin: center"/>';
	assert.equal(ctx.foldTransformOrigins(keyword), keyword);
});

test('foldTransformOrigins: leaves tags without transform-origin untouched', () => {
	const plain = '<svg width="100" height="100"><path d="M0 0"/></svg>';
	assert.equal(ctx.foldTransformOrigins(plain), plain);

	// origin present, but no transform attribute to fold into
	const noTransform = '<g style="transform-origin: 10px 20px"/>';
	assert.equal(ctx.foldTransformOrigins(noTransform), noTransform);
});

test('foldTransformOrigins: processes each tag independently', () => {
	const input =
		'<g transform="rotate(45)" style="transform-origin: 1px 2px"></g>' +
		'<g transform="scale(3)"></g>';
	const output = ctx.foldTransformOrigins(input);
	assert.ok(output.includes('translate(1,2) rotate(45) translate(-1,-2)'));
	assert.ok(output.includes('<g transform="scale(3)"></g>'));
});
