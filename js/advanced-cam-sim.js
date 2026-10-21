// Simulation speed multipliers, cycled by the speed button (1x -> 2x -> 4x -> 8x -> 1x ...)
var SIM_SPEED_STEPS = [1, 2, 4, 8];
var timefactor = 1,
  simstopped = true;
var simgcodeobj;

// Feedrate (mm/min) used to simulate rapid (G0) moves.
// G0 moves run at the machine's max rapid rate, not at the modal F word,
// so we don't use the parsed (modal) feedrate for them. This matches the
// rapidSpeed hardcoded in the toolpath G-Code generator (js/advanced-cam-gcode.js).
var SIM_RAPID_FEEDRATE = 1000;
// Minimum simulated *machine* duration (seconds) of any single move / fake
// (comment / M-code) line, so that zero-length moves don't stall the sim loop
var SIM_MIN_MOVE_SEC = 0.01;
// The toolpointer cone is drawn this many mm above the actual Z of the path
var SIM_CONE_Z_LIFT = 20;
// Clamp the real-time delta consumed per tick (seconds) so that a background
// tab / paused ticker doesn't teleport the pointer across the whole part
var SIM_MAX_TICK_SEC = 0.25;

// ---------------------------------------------------------------------------
// Simulation engine
//
// The pointer is NOT animated with one tween per gcode line: curvilinear
// toolpaths consist of hundreds/thousands of tiny segments, and per-tween
// overhead plus the ticker's frame granularity meant the speed multiplier had
// no visible effect on them (a tween can never finish faster than one frame,
// no matter the global time scale).
//
// Instead, all lines are precompiled into a flat list of machine-time segments
// and a single ticker callback advances a "machine clock" at
// (real elapsed time * timefactor), consuming as many segments per frame as
// needed and lerping the cone position inside the active segment. The
// multiplier therefore applies instantly and uniformly to straight *and*
// curvilinear paths.
// ---------------------------------------------------------------------------

// Precompiled segments: { x, y, z, secs, idx } - endpoint, machine-duration in
// seconds, and the index of the gcode line the segment belongs to
var simMoves = [];
// Index of the segment currently being traversed, and machine-seconds already
// spent inside it
var simSegIdx = 0;
var simSegT = 0;
// Timestamp of the previous ticker callback (ticker time, seconds)
var simLastTick = null;
var simTickerActive = false;
// Last gcode line index shown in the #gcodesent counter (avoid DOM churn)
var simLastLineIdx = -1;

function enableSim() {
  $('#runSimBtn').prop('disabled', false)
}

function disableSim() {
  $('#runSimBtn').prop('disabled', true)
}

function toScreenPosition(obj, camera) {
  var vector = new THREE.Vector3(obj.position.x, obj.position.y + 10, obj.position.z + 30);
  var widthHalf = 0.5 * renderer.context.canvas.width;
  var heightHalf = 0.5 * renderer.context.canvas.height;
  vector.project(camera);
  vector.x = (vector.x * widthHalf) + widthHalf;
  vector.y = -(vector.y * heightHalf) + heightHalf;

  return {
    x: vector.x,
    y: vector.y
  };

};


function simstop() {
  simstopped = true;
  if (simTickerActive) {
    TweenLite.ticker.removeEventListener("tick", simTick);
    simTickerActive = false;
  }
  $('#runSimBtn').show()
  $('#stopSimBtn').hide()
  $('#gcodesent').html('0');
  // editor.gotoLine(0)
  cone.material = new THREE.MeshPhongMaterial({
    color: 0x007bff,
    specular: 0x0000ff,
    shininess: 100,
    opacity: 0.9,
    transparent: true
  })
  cone.visible = false;
  clearSceneFlag = true;
}

function simSpeed() {
  // cycle 1x -> 2x -> 4x -> 8x -> 1x ...
  var i = SIM_SPEED_STEPS.indexOf(timefactor);
  if (i < 0) i = 0;
  timefactor = SIM_SPEED_STEPS[(i + 1) % SIM_SPEED_STEPS.length];
  $('#simspeedval').text(timefactor);
  // the ticker reads `timefactor` every frame, so the change applies instantly
}

// Calculate simulated machine duration (seconds) of one parsed gcode line,
// based on the actual distance and feedrate
function simCalcMoveSeconds(line) {
  if (line.args.isFake) {
    // comments / M-codes / empty lines: a brief pause so the sim keeps flowing
    return SIM_MIN_MOVE_SEC;
  }
  var dist = line.p2.dist || 0;
  if (dist <= 0) return SIM_MIN_MOVE_SEC;

  var feedrate;
  if (line.p2.g0) {
    // rapid move: machine max rapid rate (modal F does not apply to G0)
    feedrate = SIM_RAPID_FEEDRATE;
  } else if (line.p2.feedrate > 0) {
    // cutting move: use the programmed feedrate (mm/min), matching the
    // Toolpath settings - no fudge factors
    feedrate = line.p2.feedrate;
  } else {
    feedrate = SIM_RAPID_FEEDRATE;
  }
  // dist (mm) / feedrate (mm/min) * 60 = seconds
  var seconds = (dist / feedrate) * 60;
  return Math.max(seconds, SIM_MIN_MOVE_SEC);
}

// Precompile the parsed gcode lines into a flat list of timed segments.
// Fake lines (comments / M-codes) become zero-length pauses at the current
// position; they only consume machine time.
function simBuildMoves() {
  simMoves = [];
  var lines = object.userData.lines;
  var prev = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var p;
    if (line.p2) {
      p = {
        x: line.p2.x,
        y: line.p2.y,
        z: line.p2.z
      };
    } else {
      // line without geometry (fake): hold the previous position
      p = prev || {
        x: 0,
        y: 0,
        z: 0
      };
    }
    simMoves.push({
      x: p.x,
      y: p.y,
      z: p.z,
      secs: simCalcMoveSeconds(line),
      idx: i
    });
    prev = p;
  }
}

// Start position for a segment: endpoint of the previous segment (or the very
// first point for segment 0)
function simSegStart(segIdx) {
  if (segIdx > 0) return simMoves[segIdx - 1];
  return simMoves[0];
}

// Current interpolated pointer position within the active segment
function simCurrentPos() {
  var m = simMoves[simSegIdx];
  var s = simSegStart(simSegIdx);
  var f = m.secs > 0 ? Math.min(simSegT / m.secs, 1) : 1;
  return {
    x: s.x + (m.x - s.x) * f,
    y: s.y + (m.y - s.y) * f,
    z: s.z + (m.z - s.z) * f
  };
}

// Ticker callback: advance the machine clock and move the pointer.
// GSAP 1.x TweenLite.ticker listeners receive no arguments, so the ticker
// time (seconds) is taken from performance.now() on every tick.
function simTick() {
  var time = performance.now() / 1000;
  if (simstopped) return;
  var dt;
  if (simLastTick === null) {
    dt = 0;
  } else {
    dt = time - simLastTick;
    if (dt < 0) dt = 0;
    if (dt > SIM_MAX_TICK_SEC) dt = SIM_MAX_TICK_SEC;
  }
  simLastTick = time;

  // consume machine time; a single frame may span many tiny segments
  var machineDt = dt * timefactor;
  while (machineDt > 0 && simSegIdx < simMoves.length) {
    var remaining = simMoves[simSegIdx].secs - simSegT;
    if (machineDt < remaining) {
      simSegT += machineDt;
      machineDt = 0;
    } else {
      machineDt -= remaining;
      simSegT = 0;
      simSegIdx++;
    }
  }

  if (simSegIdx >= simMoves.length) {
    simstop();
    return;
  }

  var pos = simCurrentPos();
  cone.position.set(pos.x, pos.y, pos.z + SIM_CONE_Z_LIFT);

  // gcode line counter (only touch the DOM when the line actually changes)
  var lineIdx = simMoves[simSegIdx].idx;
  if (lineIdx !== simLastLineIdx) {
    simLastLineIdx = lineIdx;
    $('#gcodesent').html(lineIdx + 1);
    // editor.gotoLine(lineIdx + 1)
  }
}

function sim(startindex) {
  if (typeof(object) == 'undefined' || !scene.getObjectByName('gcodeobject')) {
    console.log('No Gcode in Preview yet')
    var message = `No Gcode in Preview yet: Please setup toolpaths, and generate G-Code before running simulation`
    Metro.toast.create(message, null, 10000, 'bg-red');
    simstop()
  } else {
    clearSceneFlag = true;
    cone.visible = true
    cone.material = new THREE.MeshPhongMaterial({
      color: 0x28a745,
      specular: 0x0000ff,
      shininess: 100,
      opacity: 0.9,
      transparent: true
    })

    simBuildMoves();
    if (simMoves.length === 0) {
      simstop();
      return;
    }

    // optionally start from a given gcode line (context menu "simulate from here")
    var startSeg = 0;
    if (startindex > 0) {
      while (startSeg < simMoves.length && simMoves[startSeg].idx < startindex) startSeg++;
    }
    simSegIdx = startSeg;
    simSegT = 0;
    simLastLineIdx = -1;

    // park the pointer at the start of the first segment to be traversed
    var startPos = simSegStart(startSeg);
    cone.position.set(startPos.x, startPos.y, startPos.z + SIM_CONE_Z_LIFT);
    $('#gcodesent').html(simMoves[startSeg].idx + 1);
    simLastLineIdx = simMoves[startSeg].idx;

    simstopped = false;
    $('#simspeedval').text(timefactor);
    $('#runSimBtn').hide()
    $('#stopSimBtn').show()
    $('#editorContextMenu').hide() // sometimes we launch sim(linenum) from the context menu... close it once running
    simLastTick = null;
    TweenLite.ticker.addEventListener("tick", simTick);
    simTickerActive = true;
  }

}
