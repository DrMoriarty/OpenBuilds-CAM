// Automatic placement of newly imported objects (SVG / DXF / bitmap trace /
// text / icon library).
//
// Imported geometry lands wherever the source file's own coordinates put it,
// which usually means somewhere in the middle of the workspace and frequently
// right on top of objects imported earlier. This module repositions every
// newly imported top-level object:
//   1. its bounding box is normalised so the object's lower-left corner sits
//      at the workspace origin (0,0);
//   2. if other objects are already present, a shelf/skyline search finds the
//      closest free spot (bottom row first, left to right, then upward),
//      guaranteeing the new object never overlaps existing ones.

var IMPORT_PLACEMENT_GAP = 0; // mm of clearance between imported objects

function importPlacementGetBox(object) {
  object.updateMatrixWorld(true);
  var box = new THREE.Box3().setFromObject(object);
  return box.isEmpty() ? null : box;
}

// World-space bounding boxes of everything already imported
function importPlacementCollectBoxes() {
  var boxes = [];
  for (var i = 0; i < objectsInScene.length; i++) {
    var box = importPlacementGetBox(objectsInScene[i]);
    if (box) boxes.push(box);
  }
  return boxes;
}

function importPlacementOverlapsX(box, x, width, gap) {
  return box.min.x - gap < x + width && box.max.x + gap > x;
}

// Shelf/skyline packing: for every candidate X (the origin plus the right
// edge of each placed object) compute the lowest Y at which the new object
// clears everything already on the workspace, then keep the placement with
// the lowest Y (ties broken by lowest X). Fills the workspace from the origin
// outwards without ever overlapping existing objects.
function importPlacementFindSpot(width, height, placedBoxes, xmax) {
  var gap = IMPORT_PLACEMENT_GAP;

  var candidates = [0];
  for (var i = 0; i < placedBoxes.length; i++) {
    candidates.push(placedBoxes[i].max.x + gap);
  }
  candidates.sort(function(a, b) {
    return a - b;
  });

  var best = null;
  for (var c = 0; c < candidates.length; c++) {
    var x = candidates[c];
    if (c > 0 && Math.abs(x - candidates[c - 1]) < 1e-9) continue; // dedupe
    var y = 0;
    for (var i = 0; i < placedBoxes.length; i++) {
      var box = placedBoxes[i];
      if (importPlacementOverlapsX(box, x, width, gap)) {
        y = Math.max(y, box.max.y + gap);
      }
    }
    // Prefer placements that stay inside the workspace width: anything
    // spilling past the right edge is demoted below every in-bounds
    // candidate, which makes over-wide rows wrap onto the next row
    var score = y;
    if (xmax && x + width > xmax) score = y + xmax;
    if (best === null || score < best.score - 1e-9 ||
      (Math.abs(score - best.score) < 1e-9 && x < best.x)) {
      best = {
        x: x,
        y: y,
        score: score
      };
    }
  }
  return best;
}

// Move a freshly built (not yet pushed to objectsInScene) import so that it
// sits at the origin, or in the nearest free spot next to existing objects.
// Returns the final world-space bounding box of the object, or null.
function autoPlaceImportedObject(object, opts) {
  opts = opts || {};
  if (!object) return null;

  var box = importPlacementGetBox(object);
  if (!box) return null; // nothing visible to place

  var xmax = parseFloat($('#sizexmax').val()) || 200;
  var ymax = parseFloat($('#sizeymax').val()) || 200;

  // 1. Normalise: lower-left corner of the new object to the workspace origin
  var dx = -box.min.x;
  var dy = -box.min.y;
  object.position.x += dx;
  object.position.y += dy;
  box.min.x += dx;
  box.max.x += dx;
  box.min.y += dy;
  box.max.y += dy;

  // 2. Slide into the nearest free spot if other objects are present
  var placedBoxes = importPlacementCollectBoxes();
  if (placedBoxes.length) {
    var width = box.max.x - box.min.x;
    var height = box.max.y - box.min.y;
    var spot = importPlacementFindSpot(width, height, placedBoxes, xmax);
    if (spot) {
      dx += spot.x - box.min.x;
      dy += spot.y - box.min.y;
      object.position.x += spot.x - box.min.x;
      object.position.y += spot.y - box.min.y;
      box.min.x += spot.x - box.min.x;
      box.max.x += spot.x - box.min.x;
      box.min.y += spot.y - box.min.y;
      box.max.y += spot.y - box.min.y;
    }
  }

  // Warn when the object spills outside the configured workspace
  if (!opts.silent) {
    if (box.max.x > xmax || box.max.y > ymax) {
      Metro.toast.create(
        "Imported object extends past the workspace boundary - it was placed at the origin without overlapping existing objects.",
        null, 8000, 'bg-amber');
    }
  }

  return box;
}
