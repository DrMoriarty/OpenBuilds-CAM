'use strict';

/**
 * Loads a first-party browser script (js/...) into an isolated vm context so
 * its pure functions can be unit-tested without DOM/jQuery/Metro.
 *
 * Top-level code in these files must survive with only the stubs the caller
 * passes in the sandbox; any function that touches $/document/THREE at load
 * time means the file is not safely loadable this way (yet).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');

function loadBrowserScript(relPath, sandbox) {
	const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
	const context = vm.createContext(Object.assign({
		console: { log: function() {}, warn: function() {}, error: function() {}, group: function() {}, groupEnd: function() {} }
	}, sandbox));
	vm.runInContext(code, context, { filename: relPath });
	return context;
}

// Evaluate an expression inside an already-loaded context (useful for
// built-ins patched on the context realm, e.g. Array.prototype.rotateRight).
function evalInContext(context, expression) {
	return vm.runInContext('(' + expression + ')', context);
}

module.exports = { loadBrowserScript, evalInContext, ROOT };
