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

test('loading a workspace .obc file parses cleanly', async ({ page }) => {
  await page.setInputFiles('#file', path.join(__dirname, '..', '..', 'workspace', 'helloworld.obc'));
  // readFile -> loadWorkspace -> parseLoadWorkspace (sync) and the delayed
  // fillTree/makeGcode/toolpathPreview chain (setTimeout 250/500/200ms)
  await expect
    .poll(() => page.evaluate(() => window.objectsInScene.length), { timeout: 15000 })
    .toBeGreaterThan(0);
  // let the toolpath workers triggered by makeGcode() finish
  await page.waitForTimeout(4000);
  expect(page._pageErrors, 'uncaught page errors').toEqual([]);
  expect(page._consoleErrors, 'console.error output').toEqual([]);
});
