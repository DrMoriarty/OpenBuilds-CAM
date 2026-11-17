'use strict';

// Unit tests for the rapid-travel ordering in the toolpath worker
// (workers/toolpath/worker/toolpathworker.js):
//   - orderPathsToMinimiseRapids: greedy nearest-neighbour + 2-opt/or-opt
//     post-optimisation, parallel-array permutation sync, entry-point
//     re-rotation, and the opts.entryPoints candidate model.
//   - orderPathsToMinimiseRapidsBestSeed: multi-seed wrapper (machine origin
//     + bounding-box corners) with the drawn-route rapid scorer.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const { createToolpathWorkerSandbox } = require('./helpers/worker-sandbox');

function withWorker(fn) {
	const worker = createToolpathWorkerSandbox();
	return fn(worker.context);
}

// A row of `n` explicitly-closed rectangular slots (5 vertices each) stacked
// along Y with the given step, each slot spanning the full width across x=0
// (like the "Places"/"Stripes" slots of a real workspace).
function slotRow(n, step) {
	const paths = [];
	for (let i = 0; i < n; i++) {
		const y = -(n - 1) * step / 2 + i * step;
		paths.push([
			{ X: -24, Y: y },
			{ X: 24, Y: y },
			{ X: 24, Y: y + 0.9 },
			{ X: -24, Y: y + 0.9 },
			{ X: -24, Y: y },
		]);
	}
	return paths;
}

test('orderPathsToMinimiseRapids: row of slots crossing the origin is cut as a serpentines, no mid-row jump left', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				var paths = ${JSON.stringify(slotRow(12, 5.2))};
				orderPathsToMinimiseRapids(paths, { X: 0, Y: 0 }, {});
				return paths.map(function (p) { return p[0].Y; });
			})()
		`, context);
		// the visit order must be monotonic in Y (a snake from one end of the
		// row), not the greedy "middle out, one long jump between halves"
		const ys = result.map(function(y) { return Math.round(y * 10) / 10; });
		let up = true, down = true;
		for (let i = 1; i < ys.length; i++) {
			if (ys[i] < ys[i - 1]) up = false;
			if (ys[i] > ys[i - 1]) down = false;
		}
		assert.ok(up || down, 'visit order is monotonic along the row, got: ' + ys.join(', '));
		// and no consecutive plunge gap exceeds ~1.6x the row step
		for (let i = 1; i < ys.length; i++) {
			assert.ok(Math.abs(ys[i] - ys[i - 1]) <= 5.2 * 1.6, 'consecutive plunge gap stays within ~1.6x step');
		}
	});
});

test('orderPathsToMinimiseRapids: opts.parallel arrays are permuted with the exact same permutation', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				// unique slots (each spans a distinct X range) so every path has an
				// identity its lead-in can be tagged with
				var paths = [];
				for (var i = 0; i < 8; i++) {
					var x0 = i * 100;
					var y = -(7) * 5.2 / 2 + i * 5.2;
					paths.push([
						{ X: x0, Y: y }, { X: x0 + 48, Y: y },
						{ X: x0 + 48, Y: y + 0.9 }, { X: x0, Y: y + 0.9 },
						{ X: x0, Y: y }
					]);
				}
				var leadIns = paths.map(function (p, i) {
					return [{ X: p[0].X, Y: p[0].Y + 7, tag: i }];
				});
				orderPathsToMinimiseRapids(paths, { X: 0, Y: 0 }, { parallel: [leadIns] });
				// identity of a path = the left edge of its unique X span
				return paths.map(function (p, i) {
					var xs = p.map(function (v) { return v.X; });
					var x0 = Math.min.apply(null, xs);
					return { pathId: Math.round(x0 / 100), leadTag: leadIns[i][0].tag };
				});
			})()
		`, context);
		for (const r of result) {
			assert.equal(r.leadTag, r.pathId,
				'lead-in still index-matched to its own path after reordering');
		}
	});
});

test('orderPathsToMinimiseRapids: open paths are reordered but their vertices are never touched', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				var a = [{ X: 0, Y: 0 }, { X: 10, Y: 0 }];
				var b = [{ X: 50, Y: 50 }, { X: 60, Y: 50 }];
				var paths = [b, a];
				orderPathsToMinimiseRapids(paths, { X: 0, Y: 0 }, {});
				return {
					first: paths[0],
					second: paths[1],
					count: paths.length
				};
			})()
		`, context);
		assert.equal(result.count, 2);
		// the path nearest the origin must be visited first, vertices intact
		assert.deepEqual(JSON.parse(JSON.stringify(result.first)), [{ X: 0, Y: 0 }, { X: 10, Y: 0 }]);
		assert.deepEqual(JSON.parse(JSON.stringify(result.second)), [{ X: 50, Y: 50 }, { X: 60, Y: 50 }]);
	});
});

test('orderPathsToMinimiseRapids: opts.entryPoints override the raw vertices for the cost model', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				// entity A: a small square near the origin whose real (inflated)
				// loop lives far away at (100, 100); entity B: a square at (10,0)
				// whose loop sits right there. With entry points supplied the
				// ordering must visit B first even though A's raw vertices are
				// closer to the machine origin.
				var A = [{ X: 1, Y: 0 }, { X: 2, Y: 0 }, { X: 2, Y: 1 }, { X: 1, Y: 1 }, { X: 1, Y: 0 }];
				var B = [{ X: 10, Y: 0 }, { X: 12, Y: 0 }, { X: 12, Y: 2 }, { X: 10, Y: 2 }, { X: 10, Y: 0 }];
				var paths = [A, B];
				var entryPoints = [
					[{ X: 100, Y: 100 }, { X: 101, Y: 100 }],
					[{ X: 10, Y: 0 }, { X: 12, Y: 0 }]
				];
				orderPathsToMinimiseRapids(paths, { X: 0, Y: 0 }, { entryPoints: entryPoints });
				return paths.map(function (p) { return p[0].X; });
			})()
		`, context);
		assert.equal(result[0], 10, 'entity with the near loop is visited first');
		assert.ok(result[1] === 1 || result[1] === 2, 'the far-loop entity follows (its start vertex may be rotated toward the predecessor)');
	});
});

// --- orderPathsToMinimiseRapidsBestSeed (multi-seed wrapper) ---

// The 13 raw "Stripes" slot vectors of a real workspace (layer-4-2026-10-08):
// slots with arc-segmented ends spanning Y -32.5..32.5 across the origin,
// X roughly -24..24. With the fixed (0,0) seed the ordering of their INFLATED
// loops leaves several extra mid-row jumps; a corner seed sweeps the row.
function realStripesVectors() {
	return [
		[{ X: -13, Y: -32.5 }, { X: 13, Y: -32.5 }, { X: 13, Y: -32.5 }, { X: 13.97, Y: -32.46 }, { X: 14.92, Y: -32.34 }, { X: 15.87, Y: -32.13 }, { X: 16.79, Y: -31.84 }, { X: 17.68, Y: -31.46 }, { X: 18.53, Y: -31.02 }, { X: 19.34, Y: -30.49 }, { X: 20.1, Y: -29.9 }, { X: -20.1, Y: -29.9 }, { X: -20.1, Y: -29.9 }, { X: -19.33, Y: -30.49 }, { X: -18.52, Y: -31.02 }, { X: -17.67, Y: -31.46 }, { X: -16.78, Y: -31.84 }, { X: -15.86, Y: -32.13 }, { X: -14.92, Y: -32.34 }, { X: -13.96, Y: -32.46 }, { X: -13, Y: -32.5 }],
		[{ X: 13, Y: 32.49 }, { X: -13, Y: 32.49 }, { X: -13, Y: 32.49 }, { X: -13.96, Y: 32.45 }, { X: -14.92, Y: 32.33 }, { X: -15.86, Y: 32.12 }, { X: -16.78, Y: 31.83 }, { X: -17.67, Y: 31.46 }, { X: -18.52, Y: 31.01 }, { X: -19.33, Y: 30.48 }, { X: -20.1, Y: 29.89 }, { X: 20.1, Y: 29.89 }, { X: 20.1, Y: 29.89 }, { X: 19.34, Y: 30.48 }, { X: 18.53, Y: 31.01 }, { X: 17.68, Y: 31.46 }, { X: 16.79, Y: 31.83 }, { X: 15.87, Y: 32.12 }, { X: 14.92, Y: 32.33 }, { X: 13.97, Y: 32.45 }, { X: 13, Y: 32.49 }],
		[{ X: 22.35, Y: 27.29 }, { X: -22.34, Y: 27.29 }, { X: -22.34, Y: 27.29 }, { X: -22.81, Y: 26.46 }, { X: -23.21, Y: 25.59 }, { X: -23.52, Y: 24.69 }, { X: 23.53, Y: 24.69 }, { X: 23.53, Y: 24.69 }, { X: 23.21, Y: 25.59 }, { X: 22.82, Y: 26.46 }, { X: 22.35, Y: 27.29 }],
		[{ X: 23.53, Y: -24.7 }, { X: -23.52, Y: -24.7 }, { X: -23.52, Y: -24.7 }, { X: -23.21, Y: -25.6 }, { X: -22.81, Y: -26.47 }, { X: -22.34, Y: -27.3 }, { X: 22.35, Y: -27.3 }, { X: 22.35, Y: -27.3 }, { X: 22.82, Y: -26.47 }, { X: 23.21, Y: -25.6 }, { X: 23.53, Y: -24.7 }],
		[{ X: -24, Y: -21.5 }, { X: -24, Y: -21.5 }, { X: -23.98, Y: -22.1 }, { X: 23.99, Y: -22.1 }, { X: 23.99, Y: -22.1 }, { X: 24, Y: -21.5 }, { X: 24, Y: -19.5 }, { X: -24, Y: -19.5 }, { X: -24, Y: -21.5 }],
		[{ X: -24, Y: 21.49 }, { X: -24, Y: 19.49 }, { X: 24, Y: 19.49 }, { X: 24, Y: 21.49 }, { X: 24, Y: 21.49 }, { X: 23.99, Y: 22.09 }, { X: -23.98, Y: 22.09 }, { X: -23.98, Y: 22.09 }, { X: -24, Y: 21.49 }],
		[{ X: 24, Y: 16.89 }, { X: -24, Y: 16.89 }, { X: -24, Y: 14.29 }, { X: 24, Y: 14.29 }, { X: 24, Y: 16.89 }],
		[{ X: 24, Y: -14.3 }, { X: -24, Y: -14.3 }, { X: -24, Y: -16.9 }, { X: 24, Y: -16.9 }, { X: 24, Y: -14.3 }],
		[{ X: 24, Y: 11.69 }, { X: -24, Y: 11.69 }, { X: -24, Y: 9.09 }, { X: 24, Y: 9.09 }, { X: 24, Y: 11.69 }],
		[{ X: 24, Y: 1.3 }, { X: -24, Y: 1.3 }, { X: -24, Y: -1.3 }, { X: 24, Y: -1.3 }, { X: 24, Y: 1.3 }],
		[{ X: 24, Y: -9.1 }, { X: -24, Y: -9.1 }, { X: -24, Y: -11.7 }, { X: 24, Y: -11.7 }, { X: 24, Y: -9.1 }],
		[{ X: 24, Y: 6.5 }, { X: -24, Y: 6.5 }, { X: -24, Y: 3.9 }, { X: 24, Y: 3.9 }, { X: 24, Y: 6.5 }],
		[{ X: 24, Y: -3.9 }, { X: -24, Y: -3.9 }, { X: -24, Y: -6.5 }, { X: 24, Y: -6.5 }, { X: 24, Y: -3.9 }],
	];
}

test('rapidTravelCostOfDrawnRoute: sums the actual lead-in and the polyline end -> start hops', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				var a = [{ X: 10, Y: 0 }, { X: 20, Y: 0 }];
				var b = [{ X: 20, Y: 10 }, { X: 20, Y: 20 }];
				return rapidTravelCostOfDrawnRoute([a, b], 0, 0);
			})()
		`, context);
		// 10 (lead-in to a's start) + 10 (hop from a's end to b's start) = 20;
		// b's own cut length is not a rapid
		assert.equal(Math.round(result * 1000) / 1000, 20);
	});
});

test('orderPathsToMinimiseRapidsBestSeed: seed search finds a shorter route for the stretched slot set of a real workspace', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				importScripts("/lib/clipperjs/clipper_unminified.js");
				var drawnCost = function (paths, sx, sy) {
					var total = 0, cx = sx, cy = sy;
					for (var i = 0; i < paths.length; i++) {
						var p = paths[i];
						if (!p || p.length === 0) continue;
						total += Math.sqrt((p[0].X - cx) * (p[0].X - cx) + (p[0].Y - cy) * (p[0].Y - cy));
						cx = p[p.length - 1].X; cy = p[p.length - 1].Y;
					}
					return total;
				};
				var clip = ${JSON.stringify(realStripesVectors())};
				var simplified = workerSimplifyPolygons(ClipperLib.JS.Clone(clip));
				var a = workerGetInflatePath(ClipperLib.JS.Clone(simplified), -0.95);
				var b = workerGetInflatePath(ClipperLib.JS.Clone(simplified), -0.95);
				orderPathsToMinimiseRapids(a, { X: 0, Y: 0 }, { allClosedPolygons: true });
				orderPathsToMinimiseRapidsBestSeed(b, { X: 0, Y: 0 }, { allClosedPolygons: true });
				return { plain: drawnCost(a, 0, 0), best: drawnCost(b, 0, 0) };
			})()
		`, context);
		assert.ok(result.plain > 0 && result.best > 0, 'both routes scored');
		assert.ok(result.best < result.plain,
			'multi-seed route is strictly shorter: ' + result.best + ' < ' + result.plain);
	});
});

test('orderPathsToMinimiseRapidsBestSeed: never worse than the plain ordering when the origin seed is already optimal', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				var src = ${JSON.stringify(slotRow(12, 5.2))};
				var a = JSON.parse(JSON.stringify(src));
				orderPathsToMinimiseRapids(a, { X: 0, Y: 0 }, { allClosedPolygons: true });
				var b = JSON.parse(JSON.stringify(src));
				orderPathsToMinimiseRapidsBestSeed(b, { X: 0, Y: 0 }, { allClosedPolygons: true });
				return { plain: a, best: b };
			})()
		`, context);
		assert.deepEqual(result.best, result.plain,
			'the winning trial ties with the plain result, so the plain route is kept');
	});
});

test('orderPathsToMinimiseRapidsBestSeed: parallel lead-in arrays carry the winning trial permutation', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				var paths = [];
				for (var i = 0; i < 8; i++) {
					var x0 = i * 100;
					var y = -(7) * 5.2 / 2 + i * 5.2;
					paths.push([
						{ X: x0, Y: y }, { X: x0 + 48, Y: y },
						{ X: x0 + 48, Y: y + 0.9 }, { X: x0, Y: y + 0.9 },
						{ X: x0, Y: y }
					]);
				}
				var leadIns = paths.map(function (p, i) {
					return [{ X: p[0].X, Y: p[0].Y + 7, tag: i }];
				});
				orderPathsToMinimiseRapidsBestSeed(paths, { X: 0, Y: 0 }, { parallel: [leadIns] });
				return paths.map(function (p, i) {
					var xs = p.map(function (v) { return v.X; });
					var x0 = Math.min.apply(null, xs);
					return { pathId: Math.round(x0 / 100), leadTag: leadIns[i][0].tag };
				});
			})()
		`, context);
		for (const r of result) {
			assert.equal(r.leadTag, r.pathId,
				'lead-in still index-matched to its own path after the multi-seed ordering');
		}
	});
});

test('orderPathsToMinimiseRapids: opts.entryPoints stay index-matched to the reordered paths (permuted in place)', () => {
	withWorker(function(context) {
		const result = vm.runInContext(`
			(function () {
				var paths = [];
				for (var i = 0; i < 6; i++) {
					var x0 = i * 100;
					paths.push([
						{ X: x0, Y: 0 }, { X: x0 + 40, Y: 0 },
						{ X: x0 + 40, Y: 10 }, { X: x0, Y: 10 },
						{ X: x0, Y: 0 }
					]);
				}
				var entryPoints = paths.map(function (p, i) {
					return [{ X: p[0].X + 1, Y: 5 }, { X: p[2].X - 1, Y: 5 }];
				});
				orderPathsToMinimiseRapids(paths, { X: 0, Y: 0 }, { entryPoints: entryPoints });
				return paths.map(function (p, i) {
					var xs = p.map(function (v) { return v.X; });
					return {
						spanMin: Math.min.apply(null, xs),
						spanMax: Math.max.apply(null, xs),
						entryX: entryPoints[i][0].X
					};
				});
			})()
		`, context);
		for (const r of result) {
			assert.ok(r.entryX > r.spanMin && r.entryX < r.spanMax,
				'entry candidate ' + r.entryX + ' belongs to its own path span [' + r.spanMin + ', ' + r.spanMax + ']');
		}
	});
});
