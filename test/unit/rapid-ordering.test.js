'use strict';

// Unit tests for the rapid-travel ordering in the toolpath worker
// (workers/toolpath/worker/toolpathworker.js):
//   - orderPathsToMinimiseRapids: greedy nearest-neighbour + 2-opt/or-opt
//     post-optimisation, parallel-array permutation sync, entry-point
//     re-rotation, and the opts.entryPoints candidate model.

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
