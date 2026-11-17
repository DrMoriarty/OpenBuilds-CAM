function toolpathPreview(i, chainKey) {
  trashGcode();
  $('#validGcode').html("<i class='fas fa-times fa-fw fg-red'></i> No G-Code yet")
  $("#savetpgcode").addClass("disabled");
  $("#exportGcodeMenu").addClass("disabled");
  Metro.dialog.close('#statusmodal')
  setTimeout(function() {
    drawToolpath(i, null, chainKey);
  }, 200);
}


// Chains of in-flight batch computations (see drawToolpath): chainKey ->
// promise resolving with the end position of the last toolpath in the batch
var toolpathBatchChains = {};

// End position of the closest preceding toolpath that has already been
// computed - i.e. where the head would actually stand when `index` starts.
// Returns null when that position is unknown (nothing computed before, or
// the predecessor was computed by an older build without endPos tracking).
function previousToolpathEndPos(index) {
  for (var i = index - 1; i >= 0; i--) {
    var tp = toolpathsInScene[i];
    if (!tp || !tp.userData || !tp.userData.inflated) continue; // not computed yet - keep looking back
    var ep = tp.userData.endPos || (tp.userData.inflated.userData && tp.userData.inflated.userData.endPos);
    return (ep && typeof ep.X == "number") ? ep : null; // computed but end unknown -> unknown
  }
  return null;
}

function drawToolpath(index, startPos, chainKey) {
  $("#generatetpgcode").html("<i class='fa fa-spinner fa-spin '></i> Unavailable, please wait");
  $("#generatetpgcode").prop('disabled', true);
  $("#generatetpgcode").removeClass('success');

  var dataToProcess = {
    toolpath: JSON.stringify(toolpathsInScene[index]),
    index: index,
    performanceLimit: $('#performanceLimit').is(":checked"),
    startPos: null // filled in when the toolpath actually launches
  }

  // Launch this toolpath's worker; resolve `done` with the end position of
  // its last contour once the worker replies.
  var launchToolpath = function(headPos, done) {
    var toolPathWorker = new Worker('workers/toolpath/worker/toolpathworker.js');
    toolpathsInScene[index].userData.worker = toolPathWorker
    dataToProcess.startPos = (headPos && typeof headPos.X == "number") ? headPos : {
      X: 0,
      Y: 0
    };
    // a crashed/errored worker must not stall a batch chain waiting on it
    toolPathWorker.onerror = function() {
      done(null);
    };
    toolPathWorker.addEventListener('message', function(e) {
    // console.log(e.data)
    if (e.data.index || e.data.index == 0) {
      // console.log("setting " + e.data.index + " to " + e.data.running)
      if (e.data.running) {
        $('#toolpathSpinner' + e.data.index).show();
      } else {
        $('#toolpathSpinner' + e.data.index).hide();
      }
    }

    if (e.data.toolpath) {
      var loader = new THREE.ObjectLoader();
      var data = JSON.parse(e.data.toolpath);

      var object = loader.parse(data);
      if (object) {
        if (object.userData.inflated) {
          object.userData.inflated = loader.parse(object.userData.inflated);
          if (object.userData.inflated.userData.pretty) {
            object.userData.inflated.userData.pretty = loader.parse(object.userData.inflated.userData.pretty);
          }
        }
        toolpathsInScene[e.data.index] = object
        // fillTree();
        clearSceneFlag = true;
        animate();
        toolPathWorker.terminate();
        toolpathsInScene[index].userData.worker = false;

        if (toolpathWorkersBusy()) {
          $("#generatetpgcode").html("<i class='fa fa-spinner fa-spin '></i> Unavailable, please wait");
          $("#generatetpgcode").prop('disabled', true);
          $("#generatetpgcode").removeClass('success');


        } else {
          $("#generatetpgcode").html("<i class='fa fa-cubes' aria-hidden='true'></i> Generate G-Code");
          $("#generatetpgcode").prop('disabled', false);
          $("#generatetpgcode").addClass('success');


        }
      }
      // hand the end position to whatever queued behind this toolpath
      done(e.data.endPos || null);
    }
    });

    toolPathWorker.postMessage({
      'data': dataToProcess
    });
  };

  if (toolpathsInScene[index].userData.camOperation) {
    if (chainKey) {
      // Batch computation (e.g. a whole loaded workspace): run the toolpaths
      // one after another so each one can be rapid-ordered from the end of
      // the previous one instead of the machine origin
      var chainKeyLocal = chainKey;
      // mark busy already while queued, so the G-Code button waits for it
      toolpathsInScene[index].userData.worker = true;
      var prev = toolpathBatchChains[chainKeyLocal] || Promise.resolve();
      var link = prev.then(function(cursor) {
        return new Promise(function(resolve) {
          launchToolpath(startPos || cursor, resolve);
        });
      });
      toolpathBatchChains[chainKeyLocal] = link;
      link.then(function() {
        if (toolpathBatchChains[chainKeyLocal] === link) delete toolpathBatchChains[chainKeyLocal];
      });
    } else {
      // Standalone preview: seed the ordering from where the previous
      // toolpath in the doctree ends, if that is already known
      launchToolpath(startPos || previousToolpathEndPos(index), function() {});
    }
  }


}




// function drawToolpaths() {
//
//   var toolPathWorker = new Worker('workers/toolpath/worker/toolpathworker.js');
//   toolPathWorker.addEventListener('message', function(e) {
//      console.log(e.data)
//     if (e.data.index || e.data.index == 0) {
//       console.log("setting " + e.data.index + " to " + e.data.running)
//       if (e.data.running) {
//         $('#toolpathSpinner'+e.data.index).show();
//       } else {
//         $('#toolpathSpinner'+e.data.index).hide();
//       }
//     }
//
//     if (e.data.toolpaths) {
//       var loader = new THREE.ObjectLoader();
//       var data = JSON.parse(e.data.toolpaths);
//
//       toolpathsInScene.length = 0;
//       // console.log(data)
//       var newToolpathsInScene = [];
//       for (var key in data) {
//         var object = loader.parse(data[key]);
//         if (object) {
//           if (object.userData.inflated) {
//             object.userData.inflated = loader.parse(object.userData.inflated);
//             if (object.userData.inflated.userData.pretty) {
//               object.userData.inflated.userData.pretty = loader.parse(object.userData.inflated.userData.pretty);
//             }
//           }
//           // console.log(object.userData.inflated.userData.pretty)
//           newToolpathsInScene.push(object)
//         }
//       }
//
//       if (newToolpathsInScene.length > 0) {
//         toolpathsInScene.length = 0;
//         toolpathsInScene = newToolpathsInScene;
//         fillTree();
//         clearSceneFlag = true;
//         animate();
//         toolPathWorker.terminate();
//       }
//     }
//
//   });
//
//   toolPathWorker.postMessage({
//     'data': JSON.stringify(toolpathsInScene)
//   });
//
// }

function toolpathWorkersBusy() {
  var workersRunning = false;
  for (i = 0; i < toolpathsInScene.length; i++) {
    if (toolpathsInScene[i].userData.worker) {
      workersRunning = true;
    }
  }
  if (workersRunning) {
    return true;
  } else {
    return false;
  }
}