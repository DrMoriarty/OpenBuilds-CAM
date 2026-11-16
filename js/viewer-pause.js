// check if browser window has focus
// window blur/focus (not the bubbling focusin/focusout: those fire on any
// element focus change, killing the animate() loop in Safari when a focused
// element — e.g. the toolpath Name field — is removed on dialog close)
window.addEventListener("focus", function(event) {
  // tween resume() code goes here
  setTimeout(function() {
    pauseAnimation = false;
    animate();
  }, 100);
}, false);
// bind blur event
window.addEventListener("blur", function(event) {
  // tween pause() code goes here
  pauseAnimation = true;
}, false);
