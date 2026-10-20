// Simulation speed multiplier (1x / 10x / 100x / 1000x, cycled by the speed button)
var timefactor = 1,
  simstopped = true;
var simgcodeobj;

// Feedrate (mm/min) used to simulate rapid (G0) moves.
// G0 moves run at the machine's max rapid rate, not at the modal F word,
// so we don't use the parsed (modal) feedrate for them. This matches the
// rapidSpeed hardcoded in the toolpath G-Code generator (js/advanced-cam-gcode.js).
var SIM_RAPID_FEEDRATE = 1000;
// Minimum real-time duration (seconds) of any single simulated move, so that
// zero-length / tiny moves don't stall or flood the tween chain
var SIM_MIN_MOVE_SEC = 0.01;

// Simulation moves must be linear (constant velocity), not eased:
// TweenMax's default ease (Quad.easeOut) starts fast and crawls into every
// corner, which made the tool pointer look jerky and wrong
var SIM_EASE = (typeof Linear !== 'undefined' && Linear.easeNone) ? Linear.easeNone : null;

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
  $('#runSimBtn').show()
  $('#stopSimBtn').hide()
  // restore normal playback speed for any remaining tweens, but keep the
  // user's selected multiplier (timefactor) for the next run
  if (typeof TweenLite !== 'undefined' && TweenLite.globalTimeScale) TweenLite.globalTimeScale(1);
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
  // cycle 1x -> 10x -> 100x -> 1000x -> 1x ...
  timefactor = timefactor * 10;
  if (timefactor > 1000) timefactor = 1;
  $('#simspeedval').text(timefactor);
  // apply immediately to the currently running tween too (not just to the
  // next gcode line), so the multiplier reacts instantly while simulating
  if (!simstopped && typeof TweenLite !== 'undefined' && TweenLite.globalTimeScale) {
    TweenLite.globalTimeScale(timefactor);
  }
}

// Calculate real-time duration (seconds) a machine would need for one parsed
// gcode line, based on the actual distance and feedrate
function simCalcMoveSeconds(line) {
  if (line.args.isFake) {
    // comments / M-codes / empty lines: tiny pause so the sim loop keeps flowing
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

function sim(startindex) {
  if (typeof(object) == 'undefined' || !scene.getObjectByName('gcodeobject')) {
    console.log('No Gcode in Preview yet')
    var message = `No Gcode in Preview yet: Please setup toolpaths, and generate G-Code before running simulation`
    Metro.toast.create(message, null, 10000, 'bg-red');
    simstop()
  } else {
    lastLine = {
      x: 0,
      y: 0,
      z: 0,
      e: 0,
      f: 0,
      feedrate: null,
      extruding: false
    };
    clearSceneFlag = true;
    cone.visible = true
    var posx = object.userData.lines[0].p2.x; //- (sizexmax/2);
    var posy = object.userData.lines[0].p2.y; //- (sizeymax/2);
    var posz = object.userData.lines[0].p2.z + 20;
    cone.position.x = posx;
    cone.position.y = posy;
    cone.position.z = posz;
    cone.material = new THREE.MeshPhongMaterial({
      color: 0x28a745,
      specular: 0x0000ff,
      shininess: 100,
      opacity: 0.9,
      transparent: true
    })

    simstopped = false;
    // apply the (persisted) speed multiplier to playback right away
    if (typeof TweenLite !== 'undefined' && TweenLite.globalTimeScale) TweenLite.globalTimeScale(timefactor);
    $('#simspeedval').text(timefactor);
    var simIdx = startindex;
    $('#runSimBtn').hide()
    $('#stopSimBtn').show()
    $('#editorContextMenu').hide() // sometimes we launch sim(linenum) from the context menu... close it once running
    var runSim = function() {
      if (simstopped == true) {
        simstop();
        return;
      }
      // editor.gotoLine(simIdx + 1)
      $('#gcodesent').html(simIdx + 1);
      // $('#simgcode').html(object.userData.lines[simIdx].args.origtext);
      var line = object.userData.lines[simIdx];
      var posx = line.p2.x; //- (sizexmax/2);
      var posy = line.p2.y; //- (sizeymax/2);
      var posz = line.p2.z;

      var text = line.args.isFake ? line.args.text : line.args.cmd;
      var simTimeInSec = simCalcMoveSeconds(line);
      // the speed multiplier is applied live via TweenLite.globalTimeScale()

      if (line.args.isFake) {
        // no movement: advance to the next line after a short pause
        TweenMax.delayedCall(simTimeInSec, function() {
          if (simstopped == true) {
            simstop();
          } else {
            simIdx++;
            if (simIdx < object.userData.lines.length) {
              runSim();
            } else {
              simstop();
            }
          }
        });
      } else {
        TweenMax.to(cone.position, simTimeInSec, {
          x: posx,
          y: posy,
          z: posz + 20,
          ease: SIM_EASE || undefined,
          onComplete: function() {
            if (simstopped == true) {
              //return
              simstop();
            } else {
              simIdx++;
              if (simIdx < object.userData.lines.length) {
                runSim();
              } else {
                simstop();
              }
            }
          }
        })
      }

    };
    runSim(); //kick it off
  }

}
