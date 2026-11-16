'use strict';

/**
 * Test-only harness that runs the REAL toolpath worker
 * (workers/toolpath/worker/toolpathworker.js) and the REAL G-Code generator
 * (js/advanced-cam-gcode.js) inside a single Node vm context, shimming the
 * browser/worker environment (self, importScripts, postMessage, $, document,
 * localStorage) — no refactoring of the generator code.
 *
 * The pipeline mirrors what the app does at runtime:
 *   1. fixture (serialized THREE.Group JSON, exactly the payload the app
 *      posts to the worker)  →  toolpathworker.getToolpaths()
 *   2. serialized result      →  THREE.ObjectLoader.parse() (as
 *      workers/toolpath/toolpath.js does on the main thread)
 *   3. toolpathGrp + settings →  generateGcode()  →  G-Code text
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./load-browser-script');

const G0_G1_DEFAULTS = {
	// Defaults as shipped in the application settings template
	// (js/application-settings-controller.js).
	'#g0command': 'G0',
	'#g1command': 'G1',
	'#scommand': 'S',
	'#scommandscale': '1000',
};

function silentConsole() {
	return { log() {}, warn() {}, error() {}, group() {}, groupEnd() {} };
}

/**
 * vm context with the vendored libs + toolpathworker.js loaded.
 * `self` is aliased to the context global, exactly like in a real Worker,
 * so importScripts-defined globals (ClipperLib, THREE, ...) are visible to
 * the worker code as bare identifiers.
 */
function createToolpathWorkerSandbox() {
	const posted = [];

	const sandbox = {
		console: silentConsole(),
		navigator: { userAgent: 'node', appName: 'Netscape' },
		performance: { now: function() { return Date.now(); } },
		showAlert: function() {},
	};
	const context = vm.createContext(sandbox);

	// In a real Worker `self` IS the global object — alias it the same way.
	vm.runInContext(
		'this.self = this; this.addEventListener = function (type, fn) { this.__onmessage = fn; };',
		context
	);
	sandbox.postMessage = function(data) { posted.push(data); };

	// importScripts shim: load each vendored lib into the same context.
	// web-cam-cpp.js (emscripten, used only for tab placement) is skipped —
	// the worker detects the missing Module and degrades gracefully, same
	// as when the file fails to load in the browser.
	sandbox.importScripts = function(...urls) {
		for (const url of urls) {
			if (url.indexOf('web-cam-cpp') !== -1) continue;
			const rel = url.replace(/^\//, '');
			vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), context, { filename: rel });
		}
	};

	vm.runInContext(
		fs.readFileSync(path.join(ROOT, 'workers/toolpath/worker/toolpathworker.js'), 'utf8'),
		context,
		{ filename: 'workers/toolpath/worker/toolpathworker.js' }
	);

	return {
		context: context,
		sandbox: sandbox,

		/**
		 * Feed a fixture (serialized THREE.Group JSON — the exact shape the app
		 * posts to the worker) through the worker's message handler and return
		 * the parsed result, i.e. the toolpath group with userData.inflated
		 * populated (still serialized, as the worker posts it).
		 */
		runToolpath(toolpathJson, index, performanceLimit) {
			posted.length = 0;
			const handler = sandbox.__onmessage;
			if (typeof handler !== 'function') throw new Error('worker did not register a message handler');
			handler({ data: { data: { toolpath: JSON.stringify(toolpathJson), index: index || 0, performanceLimit: !!performanceLimit } } });
			for (let i = posted.length - 1; i >= 0; i--) {
				if (posted[i].toolpath) return JSON.parse(posted[i].toolpath);
			}
			throw new Error('worker produced no toolpath message');
		},
	};
}

/**
 * Settings stubs for js/advanced-cam-gcode.js. `opts` may override:
 *   jQueryValues: { '#sel': value }   — .val() results (defaults = app defaults)
 *   checked:      { '#sel': bool }    — .is(':checked') results
 *   documentValues: { id: value }     — document.getElementById(id).value
 *   localStorage: { key: value }      — localStorage contents
 */
function installGcodeStubs(sandbox, opts) {
	const o = opts || {};
	const jQueryValues = Object.assign({}, G0_G1_DEFAULTS, o.jQueryValues);
	const checked = o.checked || {};
	const docValues = o.documentValues || {};
	const store = Object.assign({}, o.localStorage);

	sandbox.document = {
		getElementById: function(id) {
			return { value: docValues[id] !== undefined ? docValues[id] : '' };
		},
	};
	sandbox.localStorage = {
		getItem: function(k) { return k in store ? store[k] : null; },
		setItem: function(k, v) { store[k] = String(v); },
	};
	sandbox.Metro = { toast: function() {} };
	sandbox.$ = function(sel) {
		const el = {
			val: function() {
				if (arguments.length) return el; // setter
				return jQueryValues[sel] !== undefined ? jQueryValues[sel] : '';
			},
			is: function() { return !!checked[sel]; },
		};
		['html', 'prop', 'addClass', 'removeClass', 'show', 'hide', 'empty'].forEach(function(m) {
			el[m] = function() { return el; };
		});
		return el;
	};
	return sandbox;
}

/**
 * Load the G-Code generator (and its geometryutils dependency, which provides
 * Array.prototype.rotateRight / distanceFormula / indexOfMax) into the given
 * context and reconstruct the worker result into live THREE objects, the way
 * workers/toolpath/toolpath.js does on the main thread.
 */
function loadGcodeGenerator(worker) {
	for (const rel of ['js/advanced-cam-geometryutils.js', 'js/advanced-cam-gcode.js']) {
		vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), worker.context, { filename: rel });
	}

	// Reconstruct like the app: parse the toolpath group, then its inflated
	// group (and the pretty preview nested inside it).
	worker.sandbox.__lastWorkerResult = undefined;
	return function(workerResultJson) {
		worker.sandbox.__lastWorkerResult = JSON.stringify(workerResultJson);
		return vm.runInContext(
			'(function () {' +
			'  var loader = new THREE.ObjectLoader();' +
			'  var object = loader.parse(JSON.parse(__lastWorkerResult));' +
			'  if (object.userData.inflated) {' +
			'    object.userData.inflated = loader.parse(object.userData.inflated);' +
			'    if (object.userData.inflated.userData.pretty) {' +
			'      object.userData.inflated.userData.pretty = loader.parse(object.userData.inflated.userData.pretty);' +
			'    }' +
			'  }' +
			'  return object;' +
			'})()',
			worker.context,
			{ filename: 'reconstruct-inflated' }
		);
	};
}

/**
 * Run the full pipeline for one fixture:
 *   fixture = {
 *     toolpath:  {serialized THREE.Group JSON, exactly the worker payload},
 *     gcodeArgs: {cutSpeed, plungeSpeed, spindleRpm, laserPwr, rapidSpeed,
 *                 toolon, tooloff, clearanceHeight, PlasmaIHS, rampplunge},
 *     stubs:     optional overrides for installGcodeStubs
 *   }
 * Returns the generated G-Code text.
 */
function generateGcodeFromFixture(fixture) {
	const worker = createToolpathWorkerSandbox();
	const workerResult = worker.runToolpath(fixture.toolpath, fixture.index, fixture.performanceLimit);

	installGcodeStubs(worker.sandbox, fixture.stubs);
	const reconstruct = loadGcodeGenerator(worker);
	const toolpathObj = reconstruct(workerResult);

	worker.sandbox.toolpathsInScene = [toolpathObj];
	worker.sandbox.j = 0; // makeGcodeExec leaves this global pointing at the current toolpath
	worker.sandbox.gcodeLastHead = null; // makeGcodeExec resets it at the start of every run

	const a = fixture.gcodeArgs || {};
	return worker.sandbox.generateGcode(
		0,
		toolpathObj.userData.inflated,
		a.cutSpeed,
		a.plungeSpeed,
		a.spindleRpm,
		a.laserPwr,
		a.rapidSpeed,
		a.toolon || '',
		a.tooloff || '',
		a.clearanceHeight,
		false, // zoffset, as passed by makeGcodeExec
		a.PlasmaIHS,
		a.rampplunge
	);
}

module.exports = {
	createToolpathWorkerSandbox,
	installGcodeStubs,
	loadGcodeGenerator,
	generateGcodeFromFixture,
	G0_G1_DEFAULTS,
};
