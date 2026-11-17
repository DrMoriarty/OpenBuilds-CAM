'use strict';

// Unit tests for the cross-toolpath travel cursor:
//   - the toolpath worker accepts a startPos in its message payload (where
//     the head actually stands: the end of the previously computed toolpath,
//     threaded through by the main thread) and seeds its rapid-ordering with
//     it instead of always assuming the machine origin;
//   - the worker reports back endPos (the last point of its last contour) so
//     the main thread can seed the NEXT toolpath with the real position.
// The ordering algorithm itself is covered by rapid-ordering.test.js.
//
// Note: endPos objects are created inside the vm sandbox, so they must be
// compared field-by-field (assert.deepStrictEqual is prototype-sensitive
// across realms).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createToolpathWorkerSandbox } = require('./helpers/worker-sandbox');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function loadFixture(name) {
	return JSON.parse(fs.readFileSync(path.join(FIXTURES, name + '.json'), 'utf8'));
}

function assertXY(pos, x, y, label) {
	assert.ok(pos && typeof pos.X == 'number' && typeof pos.Y == 'number' && isFinite(pos.X) && isFinite(pos.Y),
		label + ' is a finite {X,Y}: ' + JSON.stringify(pos));
	assert.equal(Math.round(pos.X * 1000) / 1000, x, label + '.X');
	assert.equal(Math.round(pos.Y * 1000) / 1000, y, label + '.Y');
}

// min X of the first drawn contour of the computed toolpath (first z group,
// first line) - tells which entity was visited first
function firstContourMinX(workerResultJson) {
	const parsed = JSON.parse(workerResultJson.toolpath);
	const inf = parsed.object.userData.inflated;
	const line = inf.object.children[0].children[0];
	const geo = inf.geometries.find(function(g) { return g.uuid === line.geometry; }) || line.geometry;
	let minX = Infinity;
	for (let i = 0; i < geo.data.vertices.length; i += 3) {
		minX = Math.min(minX, geo.data.vertices[i]);
	}
	return minX;
}

// --- endPos reporting ---

test('worker reports endPos = last visited drill point, mirrored into the result userData', () => {
	const worker = createToolpathWorkerSandbox();
	const fixture = loadFixture('drill-two-holes'); // holes centred (20,20) and (60,30)
	const msg = worker.runToolpathRaw(fixture.toolpath, 0, false);
	// greedy NN from the origin visits (20,20) first, ends at (60,30)
	assertXY(msg.endPos, 60, 30, 'endPos');
	// the same position must ride inside the serialized toolpath userData -
	// that is where the main thread reads it after loader.parse()
	assertXY(JSON.parse(msg.toolpath).object.userData.endPos, 60, 30, 'userData.endPos');
});

test('worker seeds the drill ordering from the message startPos', () => {
	const worker = createToolpathWorkerSandbox();
	const fixture = loadFixture('drill-two-holes');
	// from (100,0) the nearest hole is (60,30), so it is drilled first and
	// the head ends at (20,20)
	const msg = worker.runToolpathRaw(fixture.toolpath, 0, false, { X: 100, Y: 0 });
	assertXY(msg.endPos, 20, 20, 'endPos');
});

test('worker seeds the union=No entity ordering from the message startPos', () => {
	const worker = createToolpathWorkerSandbox();
	const fixture = loadFixture('cnc-open-nooffset'); // one open polyline near the origin

	// a second open polyline 1000 mm to the right
	const tp = JSON.parse(JSON.stringify(fixture.toolpath));
	tp.geometries.push({
		uuid: 'geo-open2', type: 'Geometry',
		data: { vertices: [1000, 0, 0, 1030, 0, 0, 1030, 40, 0], normals: [], faces: [] }
	});
	const child2 = JSON.parse(JSON.stringify(tp.object.children[0]));
	child2.uuid = 'line-2';
	child2.name = 'POLYLINE1';
	child2.geometry = 'geo-open2';
	tp.object.children.push(child2);

	// from the origin the near entity is visited first...
	const fromOrigin = worker.runToolpathRaw(tp, 0, false);
	assert.ok(firstContourMinX(fromOrigin) < 100,
		'from (0,0) the contour near the origin is cut first, got minX ' + firstContourMinX(fromOrigin));

	// ...but when the head stands at the far entity, THAT one is visited
	// first, instead of running back to the origin-side entity
	const fromFar = worker.runToolpathRaw(tp, 0, false, { X: 1030, Y: 0 });
	assert.ok(firstContourMinX(fromFar) > 900,
		'from (1030,0) the far contour is cut first, got minX ' + firstContourMinX(fromFar));
	// and the reported end is the near entity's last point
	assertXY(fromFar.endPos, 30, 40, 'endPos');
});

test('worker reports a finite endPos for a closed-polygon inflate toolpath (union=Yes)', () => {
	const worker = createToolpathWorkerSandbox();
	const fixture = loadFixture('cnc-square-outside'); // 100x50 square, offset outside
	const msg = worker.runToolpathRaw(fixture.toolpath, 0, false);
	const endPos = msg.endPos;
	assert.ok(endPos && typeof endPos.X == 'number' && typeof endPos.Y == 'number' && isFinite(endPos.X) && isFinite(endPos.Y),
		'endPos is a finite {X,Y}: ' + JSON.stringify(endPos));
	const fromUserData = JSON.parse(msg.toolpath).object.userData.endPos;
	assert.equal(fromUserData.X, endPos.X, 'userData.endPos.X matches the message endPos');
	assert.equal(fromUserData.Y, endPos.Y, 'userData.endPos.Y matches the message endPos');
});

test('worker falls back to the origin when no startPos is sent (old callers / first toolpath)', () => {
	const worker = createToolpathWorkerSandbox();
	const fixture = loadFixture('drill-two-holes');
	// must not throw and must behave exactly like the pre-cursor behaviour
	const msg = worker.runToolpathRaw(fixture.toolpath, 0, false);
	assertXY(msg.endPos, 60, 30, 'endPos');
});
