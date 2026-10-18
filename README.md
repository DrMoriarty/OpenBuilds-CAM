# cam.openbuilds.com
OpenBuilds CAM - Cloud based software for converting DXF, SVG, Bitmap (BMP, JPG, PNG, GIF) and Gerber X274 to G-Code


Access it live at [https://cam.openbuilds.com](https://cam.openbuilds.com)

## Running as a website

Serve the repo root over HTTP and open it in a browser (do **not** use `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Running as a desktop app (Electron)

The same static app is packaged as a cross-platform desktop app (Windows / macOS / Linux) via Electron. The Electron main process (`electron/main.js`) serves the repo root through a custom `app://` protocol, so Web Workers, `importScripts` and `$.get` of workspace files keep working unchanged; Google Analytics requests are blocked in the desktop build.

```sh
npm install          # pulls electron + electron-builder (dev-only)
npm start            # launch the desktop app in dev mode
npm run dist         # build installers into dist/ (NSIS for Win, DMG for macOS, AppImage for Linux)
npm run dist:win     # only Windows
npm run dist:mac     # only macOS
npm run dist:linux   # only Linux
```

Notes:

- The app payload is everything except `partslib/` and `node_modules/` (see `build.files` in `package.json`); `partslib/` is an unrelated offline conversion script and is excluded.
- App icon lives at `build/icon.png` (512×512 PNG; electron-builder converts it to `.ico`/`.icns`).
- The web version at cam.openbuilds.com is unaffected — `electron/` and `package.json` are simply ignored by the static hosting.
