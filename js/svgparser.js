// Create Parser object
var lwsvgparser = new SVGParser.Parser();

// Register the onTag callback
lwsvgparser.onTag(function(tag) {
  // console.log('onTag:', tag);
});

// Load multiple files (sync)
function loadFiles(files) {
  var file = files.shift();
  loadFile(file).then(function() {
    files.length && loadFiles(files);
  });
}

// CSS `transform-origin` support.
// Some editors (e.g. Boxy SVG) store rotations as a `transform="matrix(...)"`
// attribute plus a `style="transform-origin: X Y"` declaration. Per SVG2/CSS
// the effective transform is translate(origin) * transform * translate(-origin),
// i.e. the rotation happens around (X, Y). lw.svg-parser ignores
// transform-origin and applies the raw matrix around (0,0), which scatters
// sibling groups (each with its own origin) to different places.
// Fix: pre-process the SVG text and fold every transform-origin into the
// transform attribute as translate(ox,oy) ... translate(-ox,-oy), which
// lw.svg-parser already knows how to compose.
function svgCssLengthToUserUnits(value) {
  var m = value.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)$/i);
  if (!m) return null;
  // Convert physical units to px at 90dpi, matching lw.svg-parser's own
  // unit normalisation; px and unit-less values are user units as-is.
  var factors = {
    '': 1, px: 1,
    mm: 90 / 25.4, cm: 90 / 2.54, in: 90,
    pt: 90 / 72, pc: 90 / 6, q: 90 / 25.4 / 4
  };
  var factor = factors[m[2].toLowerCase()];
  if (factor === undefined) return null; // %, em, ... unsupported -> leave tag untouched
  return parseFloat(m[1]) * factor;
}

function foldTransformOrigins(svgtext) {
  return svgtext.replace(/<[a-zA-Z][^>]*>/g, function(tag) {
    if (!/transform-origin/i.test(tag)) return tag;

    // transform-origin may live in the style attribute or as a presentation attribute
    var origin = null;
    var styleMatch = tag.match(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/);
    var styleVal = styleMatch ? (styleMatch[2] !== undefined ? styleMatch[2] : styleMatch[3]) : '';
    var originMatch = styleVal.match(/transform-origin\s*:\s*([^;"']+)/i);
    if (originMatch) {
      origin = originMatch[1].trim();
    } else {
      var originAttr = tag.match(/(?:^|\s)transform-origin\s*=\s*("([^"]*)"|'([^']*)')/i);
      if (originAttr) origin = (originAttr[2] !== undefined ? originAttr[2] : originAttr[3]).trim();
    }
    if (!origin) return tag;

    var parts = origin.split(/[\s,]+/);
    if (parts.length !== 2) return tag; // keywords / percentages not supported
    var ox = svgCssLengthToUserUnits(parts[0]);
    var oy = svgCssLengthToUserUnits(parts[1]);
    if (ox === null || oy === null) return tag;

    // Fold into the transform attribute: T(o) * transform * T(-o)
    var transformMatch = tag.match(/(^|\s)transform\s*=\s*("([^"]*)"|'([^']*)')/);
    if (!transformMatch) return tag;
    var transform = transformMatch[3] !== undefined ? transformMatch[3] : transformMatch[4];
    if (!transform || !transform.length) return tag;

    var folded = 'translate(' + ox + ',' + oy + ') ' + transform +
                 ' translate(' + (-ox) + ',' + (-oy) + ')';
    return tag.slice(0, transformMatch.index) + transformMatch[1] +
           'transform="' + folded + '"' + tag.slice(transformMatch.index + transformMatch[0].length);
  });
}

// Load one file
function loadSVGFile(file) {
  // Read the file as text so the document units can be detected:
  // lw.svg-parser normalises mm/cm/in/pt/pc units to px at 90dpi,
  // so files whose root width/height use physical units must be
  // imported at 90dpi to keep their real-world size (editors without
  // a fingerprint comment would otherwise fall back to the 96dpi
  // default and import ~6% too small)
  var reader = new FileReader();
  reader.onload = function(e) {
    var svgtext = e.target.result;
    var forcedResol;
    var roottag = svgtext.match(/<svg[^>]*>/i);
    if (roottag) {
      var widthAttr = roottag[0].match(/\swidth\s*=\s*["']([^"']*)["']/i);
      var heightAttr = roottag[0].match(/\sheight\s*=\s*["']([^"']*)["']/i);
      var physicalUnits = /(mm|cm|in|pt|pc)\s*$/i;
      if ((widthAttr && physicalUnits.test(widthAttr[1])) || (heightAttr && physicalUnits.test(heightAttr[1]))) {
        forcedResol = 90;
      }
    }
    // Load SVG from file
    console.log(file)
    svgtext = foldTransformOrigins(svgtext);
    lwsvgparser.loadFromString(svgtext).then(function(element) {
        return lwsvgparser.parse().then(function(tags) {
          drawFile(file.name, tags, false, forcedResol);
        });
      })
      .catch(function(error) {
        // console.error('error:', error);
      });
  };
  reader.readAsText(file);
}


// // Draw ------------------------------------------------------------------------
//
// function addObject(name, obj) {
//   // attachBoundingBox(object);
//   // addUIObject(name, object);
//   obj.name = name;
//   objectsInScene.push(obj)
//   fillTree();
// }

// Some editors (e.g. Boxy SVG) store object/group names as <title> child
// elements instead of id/inkscape:label attributes. Return the tag's own
// <title> (direct child only, so group titles don't leak from subgroups).
function getSVGTagTitle(tag) {
  var el = tag.element;
  if (el && el.children) {
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.nodeName && c.nodeName.toLowerCase() === 'title' && c.textContent) {
        return c.textContent.trim();
      }
    }
  }
  return null;
}

// Walk up the tag tree to find the name of the group/layer this tag sits in:
// inkscape:label or id attribute first, then the group's <title>.
function getSVGLayerName(tag) {
  for (var t = tag; t; t = t.parent) {
    if (t.name === 'g') {
      var label = t.attrs['inkscape:label'] || t.attrs.id || getSVGTagTitle(t);
      if (label) return label;
    }
  }
  return null;
}

function svgtraverse(tag, callback) {

  callback(tag);

  var children = tag.children;

  for (var i = 0, l = children.length; i < l; i++) {

    svgtraverse(children[i], callback);

  }

};

function drawFile(name, tag, flip, forcedResol) {
  var editor = lwsvgparser.editor.name
  var version = parseFloat(lwsvgparser.editor.version)
  console.log(lwsvgparser)
  if (lwsvgparser.tags.attrs["inkscape:version"] != undefined) {
    editor = "inkscape"
    version = parseFloat(lwsvgparser.tags.attrs["inkscape:version"])
  }
  console.log(editor, version)
  if (forcedResol) {
    resol = forcedResol;
  } else if (editor == "inkscape") {
    if (version > 0.91) {
      resol = 90;
    } else if (version > 1.0) {
      resol = 96;
    } else {
      resol = 96;
    }
  } else if (editor == "illustrator") {
    resol = 72
  } else if (editor == "Opentype.js") {
    resol = 57
  } else {
    resol = 96;
  }
  console.log("File: " + name + " was created in " + editor + " version " + version + ".  Setting import resolution to " + resol + "dpi")
  scale = 1 / (resol / 25.4)
  var svgtagobject = new THREE.Object3D();
  svgtagobject.name = name
  var pathCount = 0
  var layerCounts = {}
  svgtraverse(tag, function(child) {
    // console.log(child)
    if (child.paths.length && child.paths[0].length) {

      // child.getShapes().forEach(function(shape) {
      //   shape = drawShape(tag, shape)
      //   shape.userData.layer = child.layer
      //   shape.name = child.name
      //   svgtagobject.add(shape);
      // });

      child.getPaths().forEach(function(path) {
        path = drawSVGLine(tag, path, scale, flip)
        // console.log(child)
        var layer = {
          label: child.layer || getSVGLayerName(child) || "unnamed layer"
        }
        path.userData.layer = layer
        // Prefer the object's own name (id attribute or <title> element).
        // Without one, name it after its layer/group with a per-layer
        // counter, so objects are distinguishable (e.g. "Mount-holes 1").
        var name = child.attrs.id || getSVGTagTitle(child)
        if (!name) {
          if (layer.label !== "unnamed layer") {
            layerCounts[layer.label] = (layerCounts[layer.label] || 0) + 1;
            name = layer.label + " " + layerCounts[layer.label];
          } else {
            name = "path" + (++pathCount);
          }
        }
        path.name = name
        // console.log(path)
        // console.log(path)
        svgtagobject.add(path);
      });
    }
  });

  // Position the new import at the workspace origin (or in the nearest free
  // spot next to already imported objects) before registering it
  autoPlaceImportedObject(svgtagobject, { silent: false });

  objectsInScene.push(svgtagobject)
  fillTree();
}


function drawSVGLine(tag, path, scale, flip) {

  var geometry = new THREE.Geometry();
  var material = this.createSVGLineMaterial(tag);

  path.points.forEach(function(point) {
    // obj.position.y += lwsvgparser.document.height;
    if (flip) {
      geometry.vertices.push(new THREE.Vector3(point.x, point.y + lwsvgparser.document.height, 0));
    } else {
      geometry.vertices.push(new THREE.Vector3(point.x, -point.y + lwsvgparser.document.height, 0));
    }
    // geometry.vertices.push(new THREE.Vector3(point.x, point.y, 0));
  });

  var opt = {
    scale: {
      x: scale,
      y: scale,
      z: 1
    }
  }
  alterGeometry(geometry, opt)

  return new THREE.Line(geometry, material);
}

function createSVGLineMaterial(tag) {
  var opacity = tag.getAttr('stroke-opacity', 1);
  var material = new THREE.LineBasicMaterial({
    color: this.createColor(
      tag.getAttr('stroke', tag.getAttr('fill', 'black'))
    )
  });

  material.depthWrite = false;
  material.depthTest = false;

  if (opacity < 1) {
    material.transparent = true;
    material.opacity = opacity;
  }

  return material;
}

function createSolidMaterial(tag) {
  var opacity = tag.getAttr('fill-opacity', 1);
  var material = new THREE.MeshBasicMaterial({
    color: this.createColor(tag.getAttr('fill', 'black')),
    side: THREE.DoubleSide
  });

  material.depthWrite = false;
  material.depthTest = false;

  if (opacity < 1) {
    material.transparent = true;
    material.opacity = opacity;
  }

  return material;
};

function drawShape(tag, path) {
  let shape = new THREE.Shape(path.outer.points);

  path.holes.forEach(function(hole) {
    shape.holes.push(new THREE.Path(hole.points));
  });

  var geometry = new THREE.ShapeGeometry(shape);
  var material = createSolidMaterial(tag);

  return new THREE.Mesh(geometry, material);
}

function createColor(color) {
  // TODO ...
  if (color === 'none') {
    color = 'black';
  }

  color = new THREE.Color(color);
  var r = color.r * 255;
  var g = color.g * 255;
  var b = color.b * 255;

  /*// Darken too light colors...
    var luma, lumaLimit = 200;

    while (true) {
    luma = (r * 0.3) + (g * 0.59) + (b * 0.11);

    if (luma <= lumaLimit) {
    break;
}

r > 0 && (r -= 1);
g > 0 && (g -= 1);
b > 0 && (b -= 1);
}*/

  // Create color object ([0-255] to [0-1] range)
  color = new THREE.Color(r / 255, g / 255, b / 255);

  // Return the color object
  return color;
}