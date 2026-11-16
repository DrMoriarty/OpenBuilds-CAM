'use strict';

/**
 * Regenerates the golden reference G-Code files in test/fixtures/golden/.
 *
 * Run manually and commit the result when an INTENDED change to G-Code
 * generation is being made (the golden tests in test/unit/gcode-golden.test.js
 * will fail otherwise):
 *
 *   node test/unit/helpers/generate-goldens.js
 *
 * Each fixture in test/fixtures/*.json is pushed through the real pipeline
 * (toolpathworker → THREE.ObjectLoader → generateGcode) via the
 * test-only shims in helpers/worker-sandbox.js.
 */

const fs = require('fs');
const path = require('path');
const { generateGcodeFromFixture } = require('./worker-sandbox');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures');
const GOLDEN_DIR = path.join(FIXTURES_DIR, 'golden');

fs.mkdirSync(GOLDEN_DIR, { recursive: true });

const files = fs.readdirSync(FIXTURES_DIR).filter(function(f) {
	return f.endsWith('.json') && !f.endsWith('.golden.json');
}).sort();

for (const file of files) {
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
	const gcode = generateGcodeFromFixture(fixture);
	const out = path.join(GOLDEN_DIR, file.replace(/\.json$/, '.nc'));
	fs.writeFileSync(out, gcode);
	console.log(file, '->', path.relative(process.cwd(), out), '(' + gcode.split('\n').length + ' lines)');
}
