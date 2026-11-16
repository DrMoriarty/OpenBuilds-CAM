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
  // A fresh browser profile has no saved settings, so initLocalStorage() →
  // checkSettingsLocal() opens the "Application Settings" dialog ~1s after
  // boot and its overlay swallows all clicks. Cancel it (saving would fire a
  // harmless images/mch/.png 404 for the not-yet-selected machine type).
  const settingsCancel = page.locator('#settingsmodal .js-dialog-close').first();
  if (await settingsCancel.isVisible().catch(() => false)) {
    await settingsCancel.click();
  }
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

// ===================================================================================
// Interaction scenarios: cross-script global wiring end-to-end (the class of
// breakage neither ESLint's no-undef nor the unit tests can catch — e.g. a
// handler calling a function that no longer exists, or a dialog id that was
// renamed in index.html).
// ===================================================================================

const FIXTURES = path.join(__dirname, '..', 'fixtures');

// viewer-pause.js halts the render loop whenever the window reports blur,
// which happens nondeterministically in headless Chromium — and the loop is
// what moves imported drawings / gcode objects into the three.js scene. Set
// the app's own pause flag back to "focused" (what a real user's window
// guarantees) before any step that waits for scene updates.
async function ensureRenderLoopRunning(page) {
  await page.evaluate(() => {
    if (window.pauseAnimation) {
      // what the app's own focus handler (js/viewer-pause.js) does on focus:
      // clearing the flag is not enough, the rAF chain must be restarted
      window.pauseAnimation = false;
      window.animate();
    }
  });
}

// Import a DXF/SVG drawing through the app's own #file input: readFile() →
// loadFile() → drawDXF() / loadSVGFile() → objectsInScene.push(). Returns the
// objectsInScene index of the freshly imported object.
async function importDrawing(page, fixtureName) {
  const before = await page.evaluate(() => window.objectsInScene.length);
  await page.setInputFiles('#file', path.join(FIXTURES, fixtureName));
  // the app registers the parsed drawing synchronously in objectsInScene —
  // this works even while the render loop is paused
  await expect
    .poll(() => page.evaluate(() => window.objectsInScene.length), { timeout: 20000 })
    .toBeGreaterThan(before);
  // the render loop (which may be paused by viewer-pause.js in headless —
  // nudge it on every attempt) then moves the drawing into the scene's
  // "Documents" group
  await expect
    .poll(async () => {
      await ensureRenderLoopRunning(page);
      return page.evaluate(() => {
        const o = window.objectsInScene[window.objectsInScene.length - 1];
        if (!o) return false;
        let p = o.parent;
        while (p && p !== window.scene) p = p.parent;
        return p === window.scene;
      });
    }, { timeout: 15000 })
    .toBe(true);
  // let the delayed fillTree / resetView chain (setTimeout 250-400ms in
  // loadFile, 250ms in drawFile/drawDXF) finish
  await page.waitForTimeout(700);
  return await page.evaluate(() => window.objectsInScene.length - 1);
}

// Mark every imported vector as selected (what mouse selection does in the
// app) and run the tree's "Create a new operation..." flow: addJob(-1) builds
// a new toolpath from the selected geometry and opens the #statusmodal
// operation dialog. Then pick the operation and click the dialog's
// "Apply and Preview Toolpath" button, which sends the toolpath to the
// toolpath worker and awaits its reply (toolpathPreview → drawToolpath).
async function createToolpathFromImport(page, fixtureName) {
  const idx = await importDrawing(page, fixtureName);
  await page.evaluate((i) => {
    window.objectsInScene[i].traverse((child) => {
      if (child.geometry) child.userData.selected = true;
    });
    window.addJob(-1);
  }, idx);

  // addJob pushes the toolpath immediately, but opens the setup dialog after
  // 800ms — wait for the operation <select> of toolpath 0 to appear
  const select = page.locator('#toperation0');
  await select.waitFor({ state: 'visible', timeout: 15000 });
  await select.selectOption('Laser: Vector (no path offset)');

  await page.click('#previewToolpathBtn');

  // drawToolpath() replaces toolpathsInScene[0] with the worker's inflated
  // reply and clears the userData.worker handle when done
  await expect
    .poll(() => page.evaluate(() => {
      const tp = window.toolpathsInScene[0];
      return !!(tp && tp.userData && tp.userData.inflated && !tp.userData.worker);
    }), { timeout: 30000 })
    .toBe(true);
  return idx;
}

// Wait until the gcode parser worker (parseGcodeInWebWorker →
// litegcodeviewer.js) delivers the gcodeobject into the scene. Fresh page, so
// unlike regenerateGcodeAndWait() no tag is needed to tell generations apart.
async function awaitGcodeObject(page) {
  await expect
    .poll(async () => {
      await ensureRenderLoopRunning(page);
      return page.evaluate(() => {
        const o = window.object;
        return !!(o && o.userData && o.userData.lines && o.userData.lines.length > 1);
      });
    }, { timeout: 30000 })
    .toBe(true);
}

test('importing a DXF file adds the drawing to the scene and the document tree', async ({ page }) => {
  const idx = await importDrawing(page, 'import-square.dxf');
  const info = await page.evaluate((i) => {
    const o = window.objectsInScene[i];
    return {
      name: o.name,
      vectors: o.children.length,
      inScene: !!window.scene.getObjectByName(o.name, true)
    };
  }, idx);
  expect(info.name, 'imported object keeps the file name').toBe('import-square.dxf');
  expect(info.vectors, 'one THREE.Line per DXF entity').toBe(4);
  expect(info.inScene, 'object reachable from the three.js scene graph').toBe(true);
  // the document tree (filldoctree) lists the file by name
  await expect(page.locator('#left-tree-view')).toContainText('import-square.dxf');
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});

test('importing an SVG file adds the drawing to the scene and the document tree', async ({ page }) => {
  const idx = await importDrawing(page, 'import-square.svg');
  const info = await page.evaluate((i) => {
    const o = window.objectsInScene[i];
    return {
      name: o.name,
      vectors: o.children.length,
      inScene: !!window.scene.getObjectByName(o.name, true)
    };
  }, idx);
  expect(info.name).toBe('import-square.svg');
  expect(info.vectors, 'the closed path imported as a vector').toBeGreaterThan(0);
  expect(info.inScene).toBe(true);
  await expect(page.locator('#left-tree-view')).toContainText('import-square.svg');
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});

test('a toolpath op configured in the dialog round-trips through the worker', async ({ page }) => {
  await createToolpathFromImport(page, 'import-square.svg');
  const tp = await page.evaluate(() => {
    const t = window.toolpathsInScene[0];
    return {
      name: t.name,
      op: t.userData.camOperation,
      inflatedVecs: t.userData.inflated ? t.userData.inflated.children.length : 0
    };
  });
  expect(tp.op).toBe('Laser: Vector (no path offset)');
  expect(tp.inflatedVecs, 'worker returned the calculated (inflated) toolpath').toBeGreaterThan(0);
  // the worker reply re-enables the Generate G-Code button (drawToolpath)
  await expect(page.locator('#generatetpgcode')).toBeEnabled();
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});

test('generating G-code from the imported drawing produces a program', async ({ page }) => {
  await createToolpathFromImport(page, 'import-square.svg');
  // the ribbon's Generate G-Code button calls makeGcode() — click it rather
  // than invoking the global, so the button wiring is covered too
  await page.click('#generatetpgcode');
  await awaitGcodeObject(page);

  // gcode viewer object is in the scene under the name sim() looks up
  expect(await page.evaluate(() => !!window.scene.getObjectByName('gcodeobject'))).toBe(true);
  // makeGcodeExec stored the per-operation program on the toolpath
  const opGcode = await page.evaluate(() => window.toolpathsInScene[0].userData.gcode);
  expect(typeof opGcode).toBe('string');
  expect(opGcode.length, 'per-op gcode is non-empty').toBeGreaterThan(0);
  // and the export path has the full program (high-level sanity only —
  // byte-level correctness belongs to the golden unit tests)
  const gcode = await page.evaluate(() => window.prepgcodefile());
  expect(typeof gcode).toBe('string');
  expect(gcode.length, 'gcode payload is non-empty').toBeGreaterThan(0);
  expect(gcode).toContain('G1');
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});

// Draw a rectangle through the app's own shape dialog: the ribbon "Shapes"
// dropdown item opens the Metro4 dialog #addShapeRect, and its Create button
// runs addRect() → objectsInScene.push(). Clicking the dropdown <li> needs the
// dropdown to be open first, so toggle it like a user would.
async function addRectangleViaDialog(page, width, height) {
  await ensureRenderLoopRunning(page);
  await page.click('button.ribbon-icon-button:has(span.caption:text-is("Shapes"))');
  await page.click('.ribbon-dropdown li:has(a:text-is("Rectangle"))');
  await page.fill('#rectX', String(width));
  await page.fill('#rectY', String(height));
  await page.click('#CreateRect');
}

async function drawingCount(page) {
  return page.evaluate(() => window.objectsInScene.length);
}

test('undo reverts a drawing action and redo restores it', async ({ page }) => {
  const initial = await drawingCount(page);

  // drawing action 1 — addRect() itself does not snapshot, so undoing past it
  // only works once an app action has called storeUndo() (that is how the app
  // behaves: imports and job edits snapshot before mutating)
  await addRectangleViaDialog(page, 40, 20);
  await expect
    .poll(() => drawingCount(page), { timeout: 10000 })
    .toBe(initial + 1);

  // the same storeUndo() the tree's delete button and addJob() call before
  // mutating — from here on, one undo step must reach this state
  await page.evaluate(() => window.storeUndo());

  // drawing action 2
  await addRectangleViaDialog(page, 60, 30);
  await expect
    .poll(() => drawingCount(page), { timeout: 10000 })
    .toBe(initial + 2);

  // ribbon Undo button → undo() → storeRedo() + parseLoadWorkspace() rebuilds
  // the scene from the pre-action snapshot
  await page.click('button.ribbon-icon-button:has(span.caption:text-is("Undo"))');
  await expect
    .poll(() => drawingCount(page), { timeout: 10000 })
    .toBe(initial + 1);

  // ribbon Redo button → redo() → back to the two-rectangle state
  await page.click('button.ribbon-icon-button:has(span.caption:text-is("Redo"))');
  await expect
    .poll(() => drawingCount(page), { timeout: 10000 })
    .toBe(initial + 2);

  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});
