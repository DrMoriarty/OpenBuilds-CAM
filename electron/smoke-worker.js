// Minimal Web Worker used only by the OBC_SMOKE=1 smoke hook in main.js:
// proves that workers can be spawned from and load scripts over app://.
globalThis.onmessage = (e) => {
	globalThis.postMessage('pong:' + e.data);
};
