# AGENTS.md

OpenBuilds CAM: a static web app with zero *runtime* dependencies (browser CAM tool that converts DXF/SVG/bitmap/Gerber to G-Code). Deployed as static files to cam.openbuilds.com (CNAME); the same files are packaged as a desktop app via Electron.

## Running

- **No build step, no bundler**: the app runs from plain static files as-is. The root `package.json` exists only for dev tooling (lint/tests/e2e, devDependencies — run `npm ci` once) and Electron packaging. Don't look for `npm run dev` — it doesn't exist; serving the files is the whole "build".
- To run locally, serve the repo root over HTTP, e.g. `python3 -m http.server 8000` or `node scripts/static-server.js 8000`, then open `http://localhost:8000`. Do **not** open `index.html` via `file://`: the app spawns Web Workers and uses absolute paths, which require HTTP.
- The toolpath worker's `importScripts()` uses root-absolute paths (`/lib/clipperjs/...`, `/lib/threejs/three.min.js`), so the server root must be the repo root.
- Desktop packaging: `npm start` (Electron) / `npm run dist[:win|:mac|:linux]` (electron-builder); builder config lives in the `build` key of `package.json`, main process in `electron/main.js`.

## Quality gates / Testing

- `npm run verify` — one-shot gate: check + lint + check-html.
- `npm run check` — `node --check` over every first-party JS file (`js/`, `workers/`, `electron/`) — `scripts/check-syntax.js`, zero dependencies.
- `npm run lint` — ESLint 9 flat config (`eslint.config.js`), **correctness rules only, no style rules on purpose**. Key rule is `no-undef` across the global-sharing scripts: the config self-scans the codebase for top-level declarations (js/, workers/toolpath/toolpath.js, inline scripts of index.html) to build the globals list. `LEGACY_IMPLICIT_GLOBALS` and `LATENT_BROKEN_GLOBALS` in that config are **frozen baselines** of known legacy debt — never extend them, declare your variables instead. `lib/` and `partslib/` are not linted.
- `npm run check-html` — integrity of `index.html` script tags: every `<script src>` must exist on disk and every `js/*.js` must be either wired into index.html or whitelisted (`js/unused.js`) — "added the file, forgot to connect it" fails loudly (`scripts/check-html.js`).
- `npm test` — unit tests on the built-in `node:test` runner (zero dependencies), files `test/unit/*.test.js`; shared helpers in `test/unit/helpers/` include a browser-script loader for testing globals-bearing files in Node.
- `npm run test:e2e` — Playwright smoke tests (`test/e2e/`, config `playwright.config.js`): the `webServer` step starts `scripts/static-server.js` with the repo root as document root (required by the root-absolute `importScripts`), then boots the app in headless Chromium and asserts a clean startup with no page/console errors.
- CI: `.github/workflows/lint.yml` runs all of the above (incl. Playwright Chromium) on every push to `master` and on PRs; `.github/workflows/release.yml` handles Electron release builds.

## Architecture

- `index.html` is the app shell: it loads ~40 plain `<script>` tags in a **specific order** (vendored libs first, then `js/*`). There are no ES modules — everything communicates via globals, so script order in `index.html` is load-bearing. New files must be added there.
- `js/main.js` is the entrypoint: its `document.ready` calls the `init*()` functions defined across the `js/` files.
- `js/advanced-cam-*.js` — CAM logic (toolpaths, G-code generation, doctree, simulation); `js/basic-cad-*.js` — CAD drawing tools; `js/viewer*.js` — 3D scene.
- `workers/toolpath/worker/toolpathworker.js` (~2000 lines) does toolpath calculation off the main thread; it only runs inside `new Worker(...)` (guarded by `typeof window == "undefined"`) and pulls its own copies of libs via `importScripts`. Changes to G-code/toolpath generation often need edits here, not just in `js/`.
- `lib/` is **vendored third-party code** (three.js, jQuery, Metro4, Clipper, DXF/Gerber parsers...). Don't refactor or update casually; the repo contains stale duplicates (`lib/dxf/dxf-parser.js.old`, `lib/fontawesome5 - backup`), so it's easy to edit the wrong copy.
- UI is built with the **Metro4** framework (`data-role` attributes in `index.html`) plus jQuery — not React/Vue.
- `mobile.html` is a static "screen too small" page; `index.html` redirects there for viewports ≤ 720px.

## Data / support directories

- `workspace/*.obc` are sample "Hello World" workspace files (JSON) loaded at startup via `$.get` with cache-busting — they are served as static files and referenced by name in `js/basic-cad-helloworld.js`.
- `partslib/` is a separate, unrelated Node script (has its own `package.json`) that batch-converts `DXF/` files to SVG and regenerates `data.json` / `Iconsdata.json`. Run `npm install` inside `partslib/` if you actually need it; it is not part of the web app.
- `CHANGELOG.txt` is the project changelog (newest entries first).

## Git

- This checkout is a fork: `origin` = DrMoriarty/OpenBuilds-CAM, `upstream` = OpenBuilds/OpenBuilds-CAM. PRs targeting the real project go upstream.
