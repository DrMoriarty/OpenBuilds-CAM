# Golden G-Code fixtures

Each `<case>.json` is a self-contained input for the G-Code generation
pipeline, driven by `test/unit/gcode-golden.test.js` through the test-only
shims in `test/unit/helpers/worker-sandbox.js`:

```
<case>.json
  ├─ toolpath        serialized THREE.Group JSON — byte-shape identical to
  │                  what the app posts to workers/toolpath/worker/
  │                  toolpathworker.js when a toolpath is drawn/previewed
  │                  (geometry as legacy THREE "Geometry" vertex arrays,
  │                  cam* settings in userData)
  ├─ index / performanceLimit   worker message fields, as sent by the app
  ├─ gcodeArgs       the arguments makeGcodeExec() would pass to
  │                  generateGcode() (cutSpeed, plungeSpeed, clearanceHeight, ...)
  └─ stubs           app-settings overrides for the generator's $/localStorage
                     reads (e.g. localStorage.hasSpindle)
```

Pipeline under test (all real code, only the environment is shimmed):

```
toolpath (JSON) → toolpathworker.getToolpaths() → inflated toolpath (JSON)
                → THREE.ObjectLoader.parse (as workers/toolpath/toolpath.js does)
                → js/advanced-cam-gcode.js generateGcode() → G-Code text
```

The resulting G-Code is compared against the checked-in reference
`golden/<case>.nc` with a tolerant numeric comparison
(`test/unit/helpers/gcode-compare.js`): coordinates/feeds/speeds are compared
with a tolerance, so cosmetic changes (whitespace, number formatting) don't
break the gate — but any real change to coordinates, feeds, speeds, command
structure or comments does.

**Intended output changes** must be committed together with refreshed
references, as an explicit diff in the PR:

```
npm run goldens:update
```

The reference files are small; read the diff before committing it.

## Cases

| fixture | operation |
|---|---|
| `cnc-square-outside.json` | CNC outline, endmill offset OUTSIDE a 100×50 square (cutout) |
| `cnc-square-inside.json` | CNC, offset INSIDE a 100×50 square |
| `cnc-open-nooffset.json` | CNC no-offset along an OPEN polyline (open-contour entry optimisation) |
| `drill-two-holes.json` | Drill: Continuous (Centered), two holes |
| `laser-square-nooffset.json` | Laser: Vector (no path offset), S-power branch |
