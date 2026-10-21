'use strict';

// Playwright smoke tests: boot the app in headless Chromium over HTTP
// (Web Workers + root-absolute importScripts paths require a real server —
// see AGENTS.md) and assert a clean startup with no page or console errors.

const { test, expect } = require('@playwright/test');
const path = require('path');

// Everything $(document).ready calls from js/main.js — these must exist as
// functions on the page after the full index.html script cascade loads.
const READY_INIT_GLOBALS = [
  'loadSettingsLocal',
  'initLocalStorage',
  'init3D',
  'animate',
  'errorHandlerJS',
  'initTree',
  'initAdvancedCAM',
  'initMouseSelect',
  'initMouseMode',
  'initDragDrop',
  'initExportworkspace'
];

// Cross-file globals the app talks through (spot check of the wiring)
const CORE_GLOBALS = [
  'scene',
  'objectsInScene',
  'toolpathsInScene',
  'loadWorkspace',
  'makeGcode',
  'parseLoadWorkspace'
];

test.beforeEach(async ({ page }) => {
  page._consoleErrors = [];
  page._pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') page._consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    page._pageErrors.push(String(err && err.stack || err));
  });
  await page.goto('/index.html');
  await page.waitForLoadState('load');
  // document.ready handlers + the delayed demo-workspace loads and the
  // first #viewReset click (setTimeout 100-500ms) all happen here
  await page.waitForTimeout(2500);
});

test('app boots without page or console errors', async ({ page }) => {
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});

test('all init functions from js/main.js document.ready are defined', async ({ page }) => {
  const types = await page.evaluate((names) => {
    return names.reduce((acc, name) => {
      acc[name] = typeof window[name];
      return acc;
    }, {});
  }, READY_INIT_GLOBALS);
  expect(types).toEqual(Object.fromEntries(READY_INIT_GLOBALS.map((n) => [n, 'function'])));
});

test('core app globals are initialised', async ({ page }) => {
  const state = await page.evaluate((names) => {
    return names.reduce((acc, name) => {
      acc[name] = typeof window[name];
      return acc;
    }, {});
  }, CORE_GLOBALS);
  // scene/three.js objects, workspace containers and the CAM entry points
  expect(state['scene']).toBe('object');
  for (const name of ['objectsInScene', 'toolpathsInScene', 'loadWorkspace', 'makeGcode', 'parseLoadWorkspace']) {
    expect(state[name], name).toBe('object' === state[name] ? 'object' : 'function');
  }
  // No external requests at startup: the app must run fully offline
  expect(await page.evaluate(() => window.performance.getEntriesByType('resource').some((e) => !/^http:\/\/127\.0\.0\.1:8123\//.test(e.name)))).toBe(false);
});

test('all bundled workspace .obc files are served and parse as workspace JSON', async ({ page }) => {
  // js/basic-cad-helloworld.js $.get()s these on demand ("Hello World"
  // menu) — every one must come back as parseable JSON with objects/toolpaths
  const files = [
    'helloworld', 'helloworlddragknife', 'helloworldlaser',
    'helloworldplasma', 'helloworldpen-servo', 'helloworldpen-z'
  ];
  for (const name of files) {
    const ws = await (await page.request.get('/workspace/' + name + '.obc')).json();
    expect(ws, name).toHaveProperty('objects');
    expect(ws, name).toHaveProperty('toolpaths');
  }
});

// Load workspace/helloworld.obc through the app's own #file input and wait
// until the drawing and the toolpath preview workers are done. Shared setup
// for the interactive G-code / simulation / export smoke paths below.
async function loadHelloWorldWorkspace(page) {
  await page.setInputFiles('#file', path.join(__dirname, '..', '..', 'workspace', 'helloworld.obc'));
  // readFile -> loadWorkspace -> parseLoadWorkspace (sync) and the delayed
  // fillTree/makeGcode/toolpathPreview chain (setTimeout 250/500/200ms)
  await expect
    .poll(() => page.evaluate(() => window.objectsInScene.length), { timeout: 15000 })
    .toBeGreaterThan(0);
  // let the toolpath workers triggered by makeGcode() finish
  await page.waitForTimeout(4000);
}

// Trigger a fresh G-code generation and wait until the gcode parser worker
// delivers a new object. Loading the workspace already runs makeGcode() via
// its own delayed chain, so the object built by *this* call is distinguished
// by tagging the previous one (each parse creates a brand-new THREE.Line,
// whose userData cannot carry the tag). While the worker runs, parseGcode
// InWebWorker() sets `object = false`, which the poll tolerates.
async function regenerateGcodeAndWait(page) {
  await page.evaluate(() => {
    if (window.object && window.object.userData) window.object.userData.__e2eSeen = true;
    window.makeGcode();
  });
  await expect
    .poll(() => page.evaluate(() => {
      const o = window.object;
      return !!(o && o.userData && !o.userData.__e2eSeen && o.userData.lines && o.userData.lines.length > 1);
    }), { timeout: 30000 })
    .toBe(true);
}

test('loading a workspace .obc file parses cleanly', async ({ page }) => {
  await loadHelloWorldWorkspace(page);
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});

test('makeGcode() produces a gcodeobject in the scene', async ({ page }) => {
  await loadHelloWorldWorkspace(page);
  await regenerateGcodeAndWait(page);
  // the fresh object was added to the scene under the name sim() looks up
  expect(await page.evaluate(() => !!window.scene.getObjectByName('gcodeobject'))).toBe(true);
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});

test('simulation runs the gcode to completion without page or console errors', async ({ page }) => {
  // Regression for #bb32d406: sim() registers the ticker via
  // TweenLite.ticker.addEventListener (js/advanced-cam-sim.js); the broken
  // TweenLite.ticker.add() call threw right here and killed the whole path.
  await loadHelloWorldWorkspace(page);
  await regenerateGcodeAndWait(page);

  // sim() is synchronous: it precompiles the segments, parks the cone at the
  // start and hands control to the ticker. The helloworld program is ~10
  // minutes of machine time (thousands of tiny segments), so scale the speed
  // multiplier to whatever makes the whole run fit in a few seconds of wall
  // time — the ticker reads `timefactor` every frame, any value works.
  const startState = await page.evaluate(() => {
    var totalSecs = 0;
    window.simBuildMoves();
    for (var i = 0; i < window.simMoves.length; i++) totalSecs += window.simMoves[i].secs;
    window.timefactor = Math.max(1, Math.ceil(totalSecs / 8));
    window.sim();
    return {
      segs: window.simMoves.length,
      stopped: window.simstopped,
      startPos: { x: window.cone.position.x, y: window.cone.position.y, z: window.cone.position.z }
    };
  });
  expect(startState.segs, 'precompiled sim segments').toBeGreaterThan(0);
  expect(startState.stopped, 'sim started (not stopped immediately)').toBe(false);

  // the ticker consumes segments and calls simstop() on its own at the end
  // — no fragile per-segment timing assertions, just "it got there"
  await expect
    .poll(() => page.evaluate(() => window.simstopped && window.simSegIdx >= window.simMoves.length), { timeout: 40000 })
    .toBe(true);

  const endPos = await page.evaluate(() => ({ x: window.cone.position.x, y: window.cone.position.y, z: window.cone.position.z }));
  expect(endPos, 'cone moved along the path').not.toEqual(startState.startPos);

  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});

test('exported gcode (prepgcodefile) contains the generated program', async ({ page }) => {
  await loadHelloWorldWorkspace(page);
  await regenerateGcodeAndWait(page);
  // saveFileGcode()/previewFile() both build their payload via prepgcodefile(),
  // so asserting on its output covers the export code path without native
  // save dialogs or download plumbing
  const gcode = await page.evaluate(() => window.prepgcodefile());
  expect(typeof gcode).toBe('string');
  expect(gcode.startsWith('; GCODE Generated by cam.openbuilds.com')).toBe(true);
  expect(gcode, 'gcode payload has motion commands').toContain('G0');
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});
