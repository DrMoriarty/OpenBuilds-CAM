# AGENTS.md

OpenBuilds CAM: a dependency-free static web app (browser CAM tool that converts DXF/SVG/bitmap/Gerber to G-Code). Deployed as static files to cam.openbuilds.com (CNAME).

## Running

- There is **no root `package.json`, no build step, no bundler, no tests, no lint config**. Don't look for `npm run dev` — it doesn't exist.
- To run locally, serve the repo root over HTTP, e.g. `python3 -m http.server 8000`, then open `http://localhost:8000`. Do **not** open `index.html` via `file://`: the app spawns Web Workers and uses absolute paths, which require HTTP.
- The toolpath worker's `importScripts()` uses root-absolute paths (`/lib/clipperjs/...`, `/lib/threejs/three.min.js`), so the server root must be the repo root.

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
