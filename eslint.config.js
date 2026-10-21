/**
 * ESLint flat config — correctness rules only, no style rules.
 *
 * The codebase is ~11k lines of ES5-era global-sharing legacy code
 * (see AGENTS.md). The value here is no-undef: since all scripts talk
 * through globals, a typo'd global or a broken cross-script dependency
 * is the classic failure mode.
 *
 * ESLint lints every file in isolation, so it cannot see globals declared
 * in *other* scripts. To make no-undef work (and still catch typos), this
 * config scans the codebase itself for:
 *   - top-level var/let/const/function declarations in js/, workers/ and
 *     the inline <script> blocks of index.html  → these are real globals;
 *   - the fixed LEGACY_IMPLICIT_GLOBALS list below — identifiers that
 *     legacy code assigns without ever declaring. Do not extend this
 *     list from new code; declare your variables instead.
 *
 * Anything referenced but declared nowhere still fails no-undef.
 *
 * lib/** is vendored third-party code and is not linted.
 * No style rules on purpose — 11k lines of legacy would be pure noise.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// ---------------------------------------------------------------------------
// Lightweight scanner for top-level declarations (zero dependencies).
// ---------------------------------------------------------------------------

// Remove comments and string/regex-ish literals so their contents can't
// fake declarations. Not a full lexer — good enough for an inventory.
function stripCommentsAndStrings(src) {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const d = src[i + 1];
		if (c === '/' && d === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && d === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') out += '\n';
				i++;
			}
			i += 2;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			const quote = c;
			out += quote;
			i++;
			while (i < src.length) {
				if (src[i] === '\\') { out += 'X'; i += 2; continue; }
				if (src[i] === quote) break;
				if (src[i] === '\n') out += '\n';
				i++;
			}
			out += quote;
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

// Collect identifiers declared at top level (brace depth 0):
//   var/let/const a = 1, b = 2;   function foo() {}
function scanTopLevelDeclarations(src) {
	const names = new Set();
	const clean = stripCommentsAndStrings(src);
	const lines = clean.split('\n');
	let depth = 0;

	for (const line of lines) {
		const lineStartDepth = depth;
		for (const ch of line) {
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
		}
		if (lineStartDepth !== 0) continue;

		let m = line.match(/^\s*(?:var|let|const)\s+(.+)$/);
		if (m) {
			// Split the declaration list on commas/semicolons not nested in
			// parens/brackets/braces, then take the leading identifier of each part.
			let part = '';
			const parts = [];
			let local = 0;
			for (const ch of m[1]) {
				if (ch === '(' || ch === '[' || ch === '{') local++;
				else if (ch === ')' || ch === ']' || ch === '}') local--;
				if (local === 0 && (ch === ',' || ch === ';')) {
					parts.push(part);
					part = '';
					if (ch === ';') break;
				} else {
					part += ch;
				}
			}
			parts.push(part);
			for (const p of parts) {
				const name = p.match(/^\s*([A-Za-z_$][\w$]*)/);
				if (name) names.add(name[1]);
			}
		}

		m = line.match(/^\s*function\s+([A-Za-z_$][\w$]*)/);
		if (m) names.add(m[1]);
	}
	return names;
}

function listJsFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listJsFiles(full));
		else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
	}
	return out;
}

// Globals declared anywhere in first-party code: every js/*.js file,
// the main-thread copy of the toolpath code, and the inline <script>
// blocks of index.html.
function collectCodebaseGlobals() {
	const names = new Set();
	const files = [
		...listJsFiles(path.join(ROOT, 'js')),
		path.join(ROOT, 'workers', 'toolpath', 'toolpath.js')
	];
	for (const file of files) {
		for (const n of scanTopLevelDeclarations(fs.readFileSync(file, 'utf8'))) {
			names.add(n);
		}
	}
	const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
	const inline = html.replace(/<script\b[^>]*\bsrc\s*=[^>]*>[\s\S]*?<\/script>/g, '');
	const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
	let m;
	while ((m = re.exec(inline)) !== null) {
		for (const n of scanTopLevelDeclarations(m[1])) names.add(n);
	}
	return names;
}

// Identifiers that legacy code assigns without declaring (sloppy-mode
// implicit globals shared across files). Derived once from the initial
// no-undef report by checking each name for an assignment somewhere in
// js/ + workers/. Treat as frozen: new code must declare its variables.
const LEGACY_IMPLICIT_GLOBALS = [
	'GeoInToolPath', 'ItemsToSelect', 'Theme', 'WorkingData', 'addCornerActions',
	'alterGeometry', 'animate', 'animateTree', 'arrIndex', 'autoPlaceImportedObject',
	'calcTabIntervals', 'camera', 'changePositionToGeoTranslate', 'clearSceneFlag',
	'clipperPaths', 'cone', 'config', 'controls', 'cutSpeed', 'date',
	'deleteSelectedObjects', 'dirLight', 'disableSim', 'distanceFormula',
	'drawClipperPaths', 'drawClipperPathsWithTool', 'drawDXF', 'drawFile',
	'drawRuler', 'drawWorkspace', 'dxf', 'dxf2', 'emitPathVerticesWithTabs',
	'errorHandlerJS', 'errorcolor', 'fileObject', 'fillTree', 'filldoctree',
	'getClipperPaths', 'getSelectedObjects', 'helpoverlay', 'hemiLight',
	'hoverShapesinScene', 'i', 'idx', 'indexOfMax', 'inflateGrp', 'inflateValUsed',
	'inflatedReplacer', 'init3D', 'initAdvancedCAM', 'initExportworkspace',
	'initLocalStorage', 'initMouseMode', 'initMouseSelect', 'initTree',
	'invokeSaveAsDialog', 'j', 'k', 'lastLine', 'layers', 'leadInPaths', 'lines',
	'loadFile', 'loadLastClosedOnPageload', 'loadSVGFile', 'loadSettingsLocal',
	'loadWorkspace', 'localParams', 'lwsvgparser', 'makeGcode', 'mouseState',
	'mouseVector', 'msgcolor', 'newPointFromDistanceAndAngle', 'numArray',
	'object', 'objectsInScene', 'parseLoadWorkspace', 'parser2', 'paths',
	'pauseAnimation', 'polarPoint', 'prepgcodefile', 'printLog',
	'putFileObjectAtZero', 'pwr', 'raycaster', 'redo', 'redrawGrid', 'renderer',
	'resetView', 'resol', 'row', 'scale', 'scalewindow', 'scene', 'sceneHeight',
	'sceneWidth', 'selectCount', 'selectedGeom', 'selection', 'setOpacity',
	'setupJob', 'shapeFromLine', 'showScaleWindow', 'simstop', 'simstopped',
	'sizexmax', 'sizeymax', 'sortClipperPath', 'sortPolyGons', 'storeUndo',
	'successcolor', 'svgxpos', 'svgypos', 'template', 'toolpathColor',
	'toolpathPreview', 'toolpathWorkersBusy', 'toolpath_IDS', 'toolpathsInScene',
	'toolpathsjson', 'traceFromImg', 'transformDirty', 'trashGcode', 'undo',
	'viewExtents', 'warncolor', 'workerDragknifePath', 'yflip', 'z'
];

const codebaseGlobals = {};
for (const name of collectCodebaseGlobals()) codebaseGlobals[name] = 'writable';

const legacyImplicitGlobals = {};
for (const name of LEGACY_IMPLICIT_GLOBALS) legacyImplicitGlobals[name] = 'writable';

// ---------------------------------------------------------------------------
// Globals provided by vendored libs, loaded via <script> tags in index.html
// (or via importScripts() inside toolpathworker.js). Built by grepping actual
// usage in js/ and workers/; keep in sync with the script tags in index.html.
// ---------------------------------------------------------------------------
const vendorGlobals = {
	// jQuery
	$: 'readonly',
	jQuery: 'readonly',
	// three.js + its plugin scripts (GridRect, OrbitControls, ..., attached to THREE)
	THREE: 'readonly',
	// Clipper (clipper_unminified.js)
	ClipperLib: 'readonly',
	// Metro4 UI framework
	Metro: 'readonly',
	// gl-matrix
	glMatrix: 'readonly',
	vec2: 'readonly',
	vec3: 'readonly',
	vec4: 'readonly',
	mat2: 'readonly',
	mat3: 'readonly',
	mat4: 'readonly',
	quat: 'readonly',
	quat2: 'readonly',
	// tbfleming/web-cam-cpp.js — emscripten module
	Module: 'readonly',
	// potrace.js
	potrace: 'readonly',
	Potrace: 'readonly',
	// lw.svg-parser
	SVGParser: 'readonly',
	// opentype.js
	opentype: 'readonly',
	// rsvp.js
	RSVP: 'readonly',
	// dxf-parser.js
	DxfParser: 'readonly',
	// three-dxf.js
	drawEntity: 'readonly',
	processDXF: 'readonly',
	// gerber/parser.js
	Parser: 'readonly',
	// gerber/gerberparser.js
	parseGerber: 'readonly',
	parseExcellon: 'readonly',
	convertSizes: 'readonly',
	Excellon: 'readonly',
	GCode: 'readonly',
	// TweenMax.min.js (GSAP 1.18.4)
	TweenMax: 'readonly',
	TweenLite: 'readonly',
	Linear: 'readonly',
	// lib/3dview/3dview.js
	parseGcodeInWebWorker: 'readonly'
};

// Identifiers referenced by legacy code but defined NOWHERE (checked against
// js/, workers/, lib/ and index.html). These are pre-existing latent bugs —
// the referencing code would throw a ReferenceError if its path ever runs.
// Enumerated here so the gate stays green while no-undef still catches every
// NEW broken global. Fix the call sites instead of extending this list.
const LATENT_BROKEN_GLOBALS = {
	getInflatePath: 'legacy: called in js/advanced-cam-fillpath.js, defined nowhere',
	showAlert: 'legacy: called in fillpath + toolpathworker, defined nowhere',
	cncVEngMode: 'legacy: called in js/advanced-cam-modal.js, defined nowhere',
	parseBoolean: 'legacy: only exists in lib/dxf/dxf-parser.js.old, not loaded',
	bullseye: 'legacy: used in js/viewer.js without assignment/declaration',
	scaleChange: 'legacy: called in js/unused.js (dead code), defined nowhere',
	printLog: 'legacy: main-thread helper called from toolpathworker',
	warncolor: 'legacy: main-thread variable read in toolpathworker'
};

const latentBrokenGlobals = {};
for (const name of Object.keys(LATENT_BROKEN_GLOBALS)) latentBrokenGlobals[name] = 'writable';

const correctnessRules = {
	'no-undef': 'error',
	'no-unused-vars': 'warn',
	'no-dupe-keys': 'error',
	'no-redeclare': 'off'
};

const browserGlobals = {
	// browser
	document: 'readonly',
	window: 'readonly',
	navigator: 'readonly',
	location: 'readonly',
	history: 'readonly',
	localStorage: 'readonly',
	sessionStorage: 'readonly',
	FileReader: 'readonly',
	File: 'readonly',
	Blob: 'readonly',
	Worker: 'readonly',
	URL: 'readonly',
	URLSearchParams: 'readonly',
	Image: 'readonly',
	Event: 'readonly',
	CustomEvent: 'readonly',
	MouseEvent: 'readonly',
	KeyboardEvent: 'readonly',
	Node: 'readonly',
	Element: 'readonly',
	HTMLElement: 'readonly',
	CSS: 'readonly',
	DOMParser: 'readonly',
	XMLSerializer: 'readonly',
	getComputedStyle: 'readonly',
	matchMedia: 'readonly',
	requestAnimationFrame: 'readonly',
	cancelAnimationFrame: 'readonly',
	ResizeObserver: 'readonly',
	MutationObserver: 'readonly',
	IntersectionObserver: 'readonly',
	XMLHttpRequest: 'readonly',
	fetch: 'readonly',
	Response: 'readonly',
	Request: 'readonly',
	Headers: 'readonly',
	alert: 'readonly',
	confirm: 'readonly',
	prompt: 'readonly',
	screen: 'readonly',
	performance: 'readonly',
	console: 'readonly',
	Promise: 'readonly',
	atob: 'readonly',
	btoa: 'readonly',
	getSelection: 'readonly',
	event: 'readonly',
	setTimeout: 'readonly',
	clearTimeout: 'readonly',
	setInterval: 'readonly',
	clearInterval: 'readonly'
};

module.exports = [
	{
		ignores: [
			'lib/**',
			'dist/**',
			'build/**',
			'node_modules/**',
			'partslib/**' // separate Node project with its own package.json
		]
	},

	// Electron main process — Node/CommonJS environment.
	{
		files: ['electron/**/*.js'],
		languageOptions: {
			sourceType: 'commonjs',
			ecmaVersion: 2022,
			globals: {
				require: 'readonly',
				module: 'writable',
				exports: 'writable',
				process: 'readonly',
				Buffer: 'readonly',
				__dirname: 'readonly',
				__filename: 'readonly',
				console: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
				URL: 'readonly',
				Response: 'readonly'
			}
		},
		rules: correctnessRules
	},

	// Browser scripts: js/ + workers/toolpath/toolpath.js (loaded via <script>
	// in index.html). Cross-file globals declared by first-party code are
	// injected by the scanner above.
	{
		files: ['js/**/*.js', 'workers/toolpath/toolpath.js'],
		languageOptions: {
			sourceType: 'script',
			ecmaVersion: 2022,
			globals: {
				...browserGlobals,
				...vendorGlobals,
				...codebaseGlobals,
				...legacyImplicitGlobals,
				...latentBrokenGlobals
			}
		},
		rules: correctnessRules
	},

	// Web worker: runs only inside new Worker(), where `window` is undefined
	// (the file guards on that itself) and importScripts/self/postMessage exist.
	// The file is historically a copy-paste of main-thread code and shares the
	// same sloppy-mode implicit globals, so it gets the same legacy baseline
	// (which also covers its known broken refs: printLog / warncolor / showAlert).
	// New code here must declare its variables and must not grow this baseline.
	{
		files: ['workers/toolpath/worker/**/*.js'],
		languageOptions: {
			sourceType: 'script',
			ecmaVersion: 2022,
			globals: {
				...vendorGlobals,
				...legacyImplicitGlobals,
				...latentBrokenGlobals,
				self: 'writable',
				postMessage: 'readonly',
				onmessage: 'writable',
				onerror: 'writable',
				importScripts: 'readonly',
				FileReaderSync: 'readonly',
				// the file does `typeof window == "undefined"` before guarding
				window: 'readonly',
				console: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
				Promise: 'readonly',
				Blob: 'readonly',
				URL: 'readonly',
				performance: 'readonly',
				TextEncoder: 'readonly',
				TextDecoder: 'readonly',
				fetch: 'readonly',
				XMLHttpRequest: 'readonly'
			}
		},
		rules: correctnessRules
	}
];
