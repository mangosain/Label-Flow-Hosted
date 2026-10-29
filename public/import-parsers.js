"use strict";
// Isolate this classic script: all public interfaces are explicitly published
// on window/globalThis. Without isolation, a top-level `const clamp01` here
// collides with the same declaration in another classic script and prevents
// the entire canvas engine from loading.
(() => {
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n)));
const stem = (p) => String(p).split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
function parseVocXml(xml, width, height) {
  const anns = [];
  const objects = xml.match(/<object>[\s\S]*?<\/object>/g) || [];
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*<\\/${name}>`));
    return m ? m[1].trim() : null;
  };
  // XML-unescape: this app's own writer (esc() in lib/exporter.js) escapes
  // &<>"' when generating <name> text, so a label containing any of those
  // characters comes back through `tag()` still literally reading "&quot;"
  // etc. unless reversed here. &amp; must be un-escaped LAST, so something
  // like an originally-escaped "&amp;lt;" doesn't get double-unescaped into
  // "<" instead of the correct "&lt;".
  const unesc = (s) => String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  // Scoped sub-block extraction. Strict VOC only ever has one <bndbox>, but
  // this app's own XML export can carry BOTH <bndbox> (pixel) and
  // <bndboxNormalized> (0..1) side by side (coords="both"), or just one of
  // the two -- scoping xmin/ymin/xmax/ymax lookups to the right sub-block
  // (rather than searching the whole <object>) means the two never get
  // mixed up regardless of which are present or in what order. Same reasoning
  // for <polygon>/<polygonNormalized>.
  const subBlock = (block, name) => {
    const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
    return m ? m[1] : null;
  };
  const readBox = (block) => {
    const xmin = +(tag(block, "xmin") ?? NaN);
    const ymin = +(tag(block, "ymin") ?? NaN);
    const xmax = +(tag(block, "xmax") ?? NaN);
    const ymax = +(tag(block, "ymax") ?? NaN);
    return [xmin, ymin, xmax, ymax].every(isFinite) ? { xmin, ymin, xmax, ymax } : null;
  };
  for (const block of objects) {
    // A required tag can't be left out of strict VOC, so an unlabeled shape
    // is written as the literal text "unlabeled" (see buildImageVoc/
    // buildImageXml) -- read back as no label, not a real label named that.
    const rawName = tag(block, "name");
    const unescapedName = rawName ? unesc(rawName) : null;
    const labelNull = tag(block, "labelNull");
    const labelName = labelNull === "true" ? null :
      labelNull === "false" ? unescapedName :
      unescapedName === "unlabeled" ? null : unescapedName;
    const lineRaw = tag(block, "line");
    const line = lineRaw && isFinite(+lineRaw) && +lineRaw >= 1 ? Math.floor(+lineRaw) : null;

    const pixelPoly = subBlock(block, "polygon");
    const normPoly = subBlock(block, "polygonNormalized");
    if (pixelPoly || normPoly) {
      const fromPixel = !normPoly && !!pixelPoly;
      const pts = [];
      for (const pt of (normPoly || pixelPoly).match(/<pt>[\s\S]*?<\/pt>/g) || []) {
        const x = +(tag(pt, "x") ?? NaN);
        const y = +(tag(pt, "y") ?? NaN);
        if (!isFinite(x) || !isFinite(y)) continue;
        pts.push(fromPixel ? { x: clamp01(x / width), y: clamp01(y / height) } : { x: clamp01(x), y: clamp01(y) });
      }
      if (pts.length >= 3) { anns.push({ type: "polygon", points: pts, labelName, line }); continue; }
    }

    const pixelBox = subBlock(block, "bndbox");
    const normBox = subBlock(block, "bndboxNormalized");
    // Own-format both-coordinate XML prefers full-precision normalized values.
    // VOC-only XML still uses pixel coordinates as before.
    const nbox = normBox ? readBox(normBox) : null;
    if (nbox) {
      anns.push({
        type: "bbox", labelName, line,
        rect: { x: clamp01(nbox.xmin), y: clamp01(nbox.ymin),
          w: clamp01(nbox.xmax - nbox.xmin), h: clamp01(nbox.ymax - nbox.ymin) },
      });
      continue;
    }
    const box = pixelBox ? readBox(pixelBox) : null;
    if (box) {
      anns.push({
        type: "bbox", labelName, line,
        rect: { x: clamp01(box.xmin / width), y: clamp01(box.ymin / height),
          w: clamp01((box.xmax - box.xmin) / width), h: clamp01((box.ymax - box.ymin) / height) },
      });
    }
  }
  return anns;
}

/** LabelMe: {shapes:[{shape_type,points,label}]}. Only fires when a shape
 *  actually carries `shape_type` -- otherwise this app's own/generic JSON
 *  parsers get first refusal (LabelMe polygons look enough like the generic
 *  {points:[...]} shape that we don't want two parsers fighting). */
function parseLabelMeDoc(doc, width, height) {
  if (!doc || !Array.isArray(doc.shapes)) return null;
  if (!doc.shapes.some((s) => s && typeof s.shape_type === "string")) return null;
  const anns = [];
  for (const s of doc.shapes) {
    const labelName = s.label != null ? String(s.label) : null;
    const pts = Array.isArray(s.points) ? s.points : [];
    if (s.shape_type === "rectangle" && pts.length === 2) {
      const [p1, p2] = pts;
      const x1 = Math.min(p1[0], p2[0]), x2 = Math.max(p1[0], p2[0]);
      const y1 = Math.min(p1[1], p2[1]), y2 = Math.max(p1[1], p2[1]);
      anns.push({
        type: "bbox", labelName, line: null,
        rect: { x: clamp01(x1 / width), y: clamp01(y1 / height), w: clamp01((x2 - x1) / width), h: clamp01((y2 - y1) / height) },
      });
    } else if (s.shape_type === "polygon" && pts.length >= 3) {
      anns.push({
        type: "polygon", labelName, line: null,
        points: pts.map(([x, y]) => ({ x: clamp01(x / width), y: clamp01(y / height) })),
      });
    }
    // circle / line / point: no bbox/polygon equivalent -- intentionally skipped.
  }
  return anns;
}

/** Raw detector/OCR output: {boxes:[{bbox:{x1,y1,x2,y2}, geometry, confidence}]}.
 *  No label field by design -- every box is an unreviewed candidate, so it
 *  always imports unlabeled (the existing "name this shape" flow on select
 *  handles the rest). Uses the pixel `bbox` directly; `geometry` (the same
 *  box, normalized) and `confidence` are read but not carried forward. */
function parseDetectorBoxesDoc(doc, width, height) {
  if (!doc || !Array.isArray(doc.boxes) || !doc.boxes.length) return null;
  if (!doc.boxes[0] || typeof doc.boxes[0].bbox !== "object" || doc.boxes[0].bbox === null) return null;
  const anns = [];
  for (const b of doc.boxes) {
    const box = b && b.bbox;
    if (!box) continue;
    const x1 = Number(box.x1), y1 = Number(box.y1), x2 = Number(box.x2), y2 = Number(box.y2);
    if (![x1, y1, x2, y2].every(isFinite)) continue;
    anns.push({
      type: "bbox", labelName: null, line: null,
      rect: {
        x: clamp01(Math.min(x1, x2) / width), y: clamp01(Math.min(y1, y2) / height),
        w: clamp01(Math.abs(x2 - x1) / width), h: clamp01(Math.abs(y2 - y1) / height),
      },
    });
  }
  return anns;
}

/** Resolves one own-format annotation's shape regardless of which
 *  coordinate representation(s) the export included: `normalized` (0..1,
 *  used as-is), `pixels` (divided by the image's width/height as recorded
 *  IN THE EXPORT FILE, so a shape's relative position round-trips
 *  correctly even if the on-disk image has since been resized -- not the
 *  newly-scanned image's current dimensions, which could differ), or the
 *  older flat legacy schema (fields directly on the annotation, already
 *  normalized). Tried in that order; returns null if none match. */
function resolveOwnFormatShape(a, width, height) {
  const isPoly = (a.type || "").toUpperCase().includes("POLY");
  if (a.normalized) {
    if (isPoly && Array.isArray(a.normalized.points) && a.normalized.points.length >= 3) {
      return { points: a.normalized.points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })) };
    }
    if (!isPoly && a.normalized.width != null) {
      return { rect: { x: clamp01(a.normalized.x), y: clamp01(a.normalized.y), w: clamp01(a.normalized.width), h: clamp01(a.normalized.height) } };
    }
  }
  if (a.pixels && width && height) {
    if (isPoly && Array.isArray(a.pixels.points) && a.pixels.points.length >= 3) {
      return { points: a.pixels.points.map((p) => ({ x: clamp01(p.x / width), y: clamp01(p.y / height) })) };
    }
    if (!isPoly && a.pixels.width != null) {
      return {
        rect: {
          x: clamp01(a.pixels.x / width), y: clamp01(a.pixels.y / height),
          w: clamp01(a.pixels.width / width), h: clamp01(a.pixels.height / height),
        },
      };
    }
  }
  // Legacy flat schema: coordinates directly on the annotation, already normalized.
  if (isPoly && Array.isArray(a.points) && a.points.length >= 3) {
    return { points: a.points.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })) };
  }
  if (!isPoly && a.x != null && (a.width != null || a.w != null)) {
    return { rect: { x: clamp01(a.x), y: clamp01(a.y), w: clamp01(a.width ?? a.w), h: clamp01(a.height ?? a.h) } };
  }
  return null;
}

function parseJsonDoc(doc, width, height) {
  const labelMe = parseLabelMeDoc(doc, width, height);
  if (labelMe) return labelMe;

  const detectorBoxes = parseDetectorBoxesDoc(doc, width, height);
  if (detectorBoxes) return detectorBoxes;

  // Own format (barebones export, and the older full-json schema).
  if (doc && Array.isArray(doc.annotations) && (doc.format || doc.image)) {
    // Prefer the width/height recorded in the file itself (present on both
    // the current barebones export and the older full schema) over the
    // newly-scanned image's own dimensions -- see resolveOwnFormatShape.
    const srcWidth = (doc.image && doc.image.width) || width;
    const srcHeight = (doc.image && doc.image.height) || height;
    const anns = [];
    for (const a of doc.annotations) {
      // Barebones export writes `label` as a plain name string (or null);
      // the older schema wrote `{id,name,color}`; a hand-edited or
      // differently-sourced file might use a flat `labelName` -- all three
      // are honored. A literal "unlabeled" string (this app's own XML/VOC
      // sentinel for "no label", since XML's <name> is a required tag) is
      // also treated as no label, in case a VOC-derived JSON carries it too.
      const labelName = typeof a.label === "string"
        ? a.label
        : (a.label?.name ?? a.label?.className ?? a.labelName ?? null);
      const line = typeof a.line === "number" && a.line >= 1 ? Math.floor(a.line) : null;
      const shape = resolveOwnFormatShape(a, srcWidth, srcHeight);
      if (!shape) continue;
      if (shape.points) anns.push({ type: "polygon", points: shape.points, labelName, line });
      else anns.push({ type: "bbox", rect: shape.rect, labelName, line });
    }
    return anns;
  }

  // Generic: {annotations|shapes|boxes: [...]} or a bare array.
  const anns = [];
  const list = Array.isArray(doc) ? doc : doc.annotations || doc.shapes || doc.boxes || [];
  for (const a of list) {
    const labelName = a.label ?? a.name ?? a.class ?? a.className ?? null;
    const px = (v, size) => (v > 1 ? v / size : v); // heuristic: >1 means pixels
    if (Array.isArray(a.points) && a.points.length >= 3) {
      anns.push({
        type: "polygon", labelName, line: null,
        points: a.points.map((p) => ({ x: clamp01(px(p.x ?? p[0], width)), y: clamp01(px(p.y ?? p[1], height)) })),
      });
    } else if (a.x != null && (a.width != null || a.w != null)) {
      anns.push({
        type: "bbox", labelName, line: null,
        rect: {
          x: clamp01(px(a.x, width)), y: clamp01(px(a.y, height)),
          w: clamp01(px(a.width ?? a.w, width)), h: clamp01(px(a.height ?? a.h, height)),
        },
      });
    }
  }
  return anns;
}

function parseJson(text, width, height) {
  return parseJsonDoc(JSON.parse(text), width, height);
}

/** True for a whole-dataset COCO instances/detections manifest, as opposed
 *  to a plain per-image JSON that happens to also be valid JSON. */
function isCocoManifest(doc) {
  return !!doc && Array.isArray(doc.images) && Array.isArray(doc.annotations) && Array.isArray(doc.categories);
}

/** @returns Map<basenameNoExt, draft[]> covering every image referenced by the manifest. */
function parseCocoManifest(doc) {
  const catNames = new Map(doc.categories.map((c) => [c.id, c.name]));
  const imgById = new Map(doc.images.map((im) => [im.id, im]));
  const byBasename = new Map();
  for (const ann of doc.annotations || []) {
    const im = imgById.get(ann.image_id);
    if (!im || !im.file_name || !im.width || !im.height) continue;
    const base = String(im.file_name).replace(/\\/g, "/").replace(/\.[^.]+$/, "").toLowerCase();
    const { width, height } = im;
    const labelName = catNames.has(ann.category_id) ? catNames.get(ann.category_id) : null;

    let draft = null;
    const seg = ann.segmentation;
    if (Array.isArray(seg) && Array.isArray(seg[0]) && seg[0].length >= 6) {
      // Polygon segmentation: [[x1,y1,x2,y2,...]] (first polygon only -- multi-part
      // segmentations collapse to one shape, a known simplification).
      const flat = seg[0];
      const points = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        points.push({ x: clamp01(flat[i] / width), y: clamp01(flat[i + 1] / height) });
      }
      if (points.length >= 3) draft = { type: "polygon", labelName, line: ann.line && Number.isFinite(+ann.line) && +ann.line >= 1 ? Math.floor(+ann.line) : null, points };
    }
    if (!draft && Array.isArray(ann.bbox) && ann.bbox.length === 4) {
      const [x, y, w, h] = ann.bbox;
      draft = { type: "bbox", labelName, line: Number.isInteger(ann.line) && ann.line >= 1 ? ann.line : null, rect: { x: clamp01(x / width), y: clamp01(y / height), w: clamp01(w / width), h: clamp01(h / height) } };
    }
    // RLE segmentation ({counts,size}) with no bbox fallback: unsupported, dropped.
    if (!draft) continue;
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(draft);
  }
  return byBasename;
}

/** classes.txt / obj.names (one name per line) or a minimal data.yaml `names:` read. */
async function parseYoloClasses(root) {
  for (const name of ["classes.txt", "obj.names"]) {
    const p = path.join(root, name);
    try {
      const text = await fsPromises.readFile(p, "utf8");
      const names = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (names.length) return names;
    } catch { /* fall through */ }
  }
  for (const name of ["data.yaml", "data.yml"]) {
    const p = path.join(root, name);
    try {
      const text = await fsPromises.readFile(p, "utf8");
      const inline = text.match(/^\s*names\s*:\s*\[([^\]]*)\]/m);
      if (inline) {
        const names = inline[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        if (names.length) return names;
      }
      const block = text.match(/^\s*names\s*:\s*\n((?:\s*-\s*.+\n?)+)/m);
      if (block) {
        const names = block[1].split(/\r?\n/)
          .map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
        if (names.length) return names;
      }
    } catch { /* fall through */ }
  }
  return null;
}

/** `class_id cx cy w h` (bbox, all normalized) or `class_id x1 y1 x2 y2 ...`
 *  (YOLO-seg polygon, odd token count) per line. */
function parseYoloTxt(text, classNames) {
  const anns = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.some((n) => !isFinite(n)) || parts.length < 5) continue;
    const classId = Math.round(parts[0]);
    const labelName = classNames && classNames[classId] != null ? classNames[classId] : `class_${classId}`;
    if (parts.length === 5) {
      const [, cx, cy, w, h] = parts;
      anns.push({
        type: "bbox", labelName, line: null,
        rect: { x: clamp01(cx - w / 2), y: clamp01(cy - h / 2), w: clamp01(w), h: clamp01(h) },
      });
    } else if (parts.length % 2 === 1) {
      const coords = parts.slice(1);
      const points = [];
      for (let i = 0; i + 1 < coords.length; i += 2) points.push({ x: clamp01(coords[i]), y: clamp01(coords[i + 1]) });
      if (points.length >= 3) anns.push({ type: "polygon", labelName, line: null, points });
    }
  }
  return anns;
}


globalThis.LabelFlowImport = {parseVocXml,parseJsonDoc,parseCocoManifest,parseYoloTxt,isCocoManifest};

})();
