"use strict";
/**
 * Dataset registration: recursively scans a folder for images and -- if the
 * admin opted in -- imports pre-existing annotations onto each newly
 * discovered image, plotting them as editable bboxes/polygons.
 *
 * Two ways annotations get found (mutually exclusive per call):
 *
 *  1. EXPLICIT annotations folder (admin picked one in the UI): every file
 *     under that folder is indexed once by basename (flat -- subfolder
 *     structure inside the annotations folder is ignored), then each new
 *     image looks itself up by its own basename. See buildAnnotationIndex().
 *
 *  2. No folder picked: falls back to the original zero-config behaviour --
 *     a `labels/` folder alongside the dataset root or beside the image,
 *     containing `<basename>.json` / `<basename>.xml`. See findLabelFile().
 *
 * Supported label formats (auto-detected per file, best effort):
 *  - Pascal VOC XML      (<object><bndbox>, optional <polygon>, <line>) --
 *                         also reads this app's own XML export, which adds
 *                         <sequence> and, depending on which coordinate
 *                         system(s) were chosen at export time, may carry
 *                         <bndbox>/<polygon> (pixel), <bndboxNormalized>/
 *                         <polygonNormalized> (0..1), or both -- whichever
 *                         is present is used, so any of the three export
 *                         choices reads back correctly.
 *  - This app's JSON     (an {image, annotations} document; each annotation
 *                         may carry `normalized` coordinates (0..1), `pixels`
 *                         coordinates, or both, again depending on what was
 *                         chosen at export -- read back correctly regardless)
 *  - LabelMe JSON        ({shapes:[{shape_type,points,label}]})
 *  - COCO JSON           (one manifest for the WHOLE dataset: {images,
 *                         annotations, categories}, matched by file_name)
 *  - YOLO txt            (`class_id cx cy w h` per line, normalized; class
 *                         names from classes.txt/obj.names/data.yaml)
 *  - Detector boxes JSON ({filename, image_width, image_height, boxes:
 *                         [{bbox:{x1,y1,x2,y2}, geometry, confidence}]} --
 *                         a text/object-DETECTOR's raw output: pixel boxes
 *                         with a confidence score and NO label. Imported as
 *                         unlabeled shapes for a human to name; confidence
 *                         is read but intentionally not stored or surfaced
 *                         -- every box here is a candidate, not a verdict)
 *  - Generic JSON        ({annotations|shapes|boxes: [{x,y,width,height,label}]}
 *                         in pixels or normalized -- values <= 1 read as normalized)
 *
 * Unparseable / unmatched files are skipped and reported, never fatal.
 *
 * Deliberately NOT handled (documented limitation, not a silent failure):
 *  - COCO RLE (compressed mask) segmentation -- only polygon segmentation
 *    is imported; RLE annotations are dropped without a shape.
 *  - LabelMe shape_type other than "rectangle"/"polygon" (circle, line,
 *    point) -- skipped.
 *  - data.yaml is parsed with two small regexes (inline `names: [...]` and
 *    block `names:\n  - x`), not a real YAML parser -- unusual formatting
 *    may not be picked up.
 *  - If two annotation files share a basename (e.g. both foo.json and
 *    foo.xml exist), priority is JSON > XML > YOLO txt > COCO manifest;
 *    the others are ignored for that image, not merged.
 */

const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { imageSize, IMAGE_EXTENSIONS } = require("./imagesize");
const store = require("./store");

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const stem = (p) => path.basename(p, path.extname(p));

const BATCH_SIZE = 20;


async function walkAllFiles(root) {
  const out = [];
  async function walk(dir) {
    let items;
    try { items = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith(".")) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out;
}

/** Finds labels/<basename>.(json|xml) for an image -- the zero-config path,
 *  used only when the admin did NOT pick a separate annotations folder. */
async function findLabelFile(datasetRoot, imageAbs) {
  const base = stem(imageAbs);
  const candidates = [
    path.join(datasetRoot, "labels", `${base}.json`),
    path.join(datasetRoot, "labels", `${base}.xml`),
    path.join(path.dirname(imageAbs), "labels", `${base}.json`),
    path.join(path.dirname(imageAbs), "labels", `${base}.xml`),
  ];
  for (const c of candidates) {
    try { await fsPromises.access(c); return c; } catch { /* not found */ }
  }
  return null;
}

// ---------------- format parsers (return normalized annotation drafts) ----------------

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
    const labelName = unescapedName === "unlabeled" ? null : unescapedName;
    const lineRaw = tag(block, "line");
    const line = lineRaw && isFinite(+lineRaw) && +lineRaw >= 1 ? Math.floor(+lineRaw) : null;

    const pixelPoly = subBlock(block, "polygon");
    const normPoly = subBlock(block, "polygonNormalized");
    if (pixelPoly || normPoly) {
      const fromPixel = !!pixelPoly;
      const pts = [];
      for (const pt of (pixelPoly || normPoly).match(/<pt>[\s\S]*?<\/pt>/g) || []) {
        const x = +(tag(pt, "x") ?? NaN);
        const y = +(tag(pt, "y") ?? NaN);
        if (!isFinite(x) || !isFinite(y)) continue;
        pts.push(fromPixel ? { x: clamp01(x / width), y: clamp01(y / height) } : { x: clamp01(x), y: clamp01(y) });
      }
      if (pts.length >= 3) { anns.push({ type: "polygon", points: pts, labelName, line }); continue; }
    }

    const pixelBox = subBlock(block, "bndbox");
    const normBox = subBlock(block, "bndboxNormalized");
    const box = pixelBox ? readBox(pixelBox) : null;
    if (box) {
      anns.push({
        type: "bbox", labelName, line,
        rect: {
          x: clamp01(box.xmin / width), y: clamp01(box.ymin / height),
          w: clamp01((box.xmax - box.xmin) / width), h: clamp01((box.ymax - box.ymin) / height),
        },
      });
      continue;
    }
    const nbox = normBox ? readBox(normBox) : null;
    if (nbox) {
      anns.push({
        type: "bbox", labelName, line,
        rect: {
          x: clamp01(nbox.xmin), y: clamp01(nbox.ymin),
          w: clamp01(nbox.xmax - nbox.xmin), h: clamp01(nbox.ymax - nbox.ymin),
        },
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
        ? (a.label === "unlabeled" ? null : a.label)
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
    const base = stem(String(im.file_name));
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
      if (points.length >= 3) draft = { type: "polygon", labelName, line: null, points };
    }
    if (!draft && Array.isArray(ann.bbox) && ann.bbox.length === 4) {
      const [x, y, w, h] = ann.bbox;
      draft = { type: "bbox", labelName, line: null, rect: { x: clamp01(x / width), y: clamp01(y / height), w: clamp01(w / width), h: clamp01(h / height) } };
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

// ---------------- annotations-folder index (explicit, flat, basename match) ----------------

/**
 * Walks `root` once and classifies every file. Per-image files (json/xml/txt)
 * are keyed by basename; any JSON recognized as a COCO manifest is parsed
 * separately and merged into its own basename map. A basename collision
 * across manifests is unlikely but if it happens, entries accumulate (both
 * sets of shapes get imported).
 */
async function buildAnnotationIndex(root) {
  const files = await walkAllFiles(root);
  const byBasename = new Map();      // base -> {json:{path,doc}, xml:path, txt:path}
  const cocoFiles = [];              // [{file, doc}]
  const errors = [];                 // [{name, reason}]

  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const base = stem(f);
    if (ext === ".json") {
      let doc;
      try { doc = JSON.parse(await fsPromises.readFile(f, "utf8")); }
      catch (err) { errors.push({ name: path.basename(f), reason: `invalid JSON: ${err.message}` }); continue; }
      if (isCocoManifest(doc)) { cocoFiles.push({ file: f, doc }); continue; }
      if (!byBasename.has(base)) byBasename.set(base, {});
      byBasename.get(base).json = { path: f, doc };
    } else if (ext === ".xml") {
      if (!byBasename.has(base)) byBasename.set(base, {});
      byBasename.get(base).xml = f;
    } else if (ext === ".txt") {
      if (base.toLowerCase() === "classes" || base.toLowerCase() === "obj") continue; // class list, not per-image
      if (!byBasename.has(base)) byBasename.set(base, {});
      byBasename.get(base).txt = f;
    }
  }

  const cocoByBasename = new Map(); // base -> draft[]
  const cocoSource = new Map();     // base -> manifest file name
  for (const { file, doc } of cocoFiles) {
    let m;
    try { m = parseCocoManifest(doc); }
    catch (err) { errors.push({ name: path.basename(file), reason: `could not read COCO manifest: ${err.message}` }); continue; }
    const fname = path.basename(file);
    for (const [base, drafts] of m) {
      if (!cocoByBasename.has(base)) cocoByBasename.set(base, []);
      cocoByBasename.get(base).push(...drafts);
      cocoSource.set(base, fname);
    }
  }

  const classNames = await parseYoloClasses(root);
  return {
    byBasename, cocoByBasename, cocoSource, classNames, errors,
    hasCoco: cocoFiles.length > 0,
    hasYolo: [...byBasename.values()].some((e) => e.txt),
  };
}

/** Priority for a single image basename: JSON > XML > YOLO txt > COCO manifest. */
async function resolveFromIndex(index, base, dims) {
  const entry = index.byBasename.get(base);
  if (entry) {
    if (entry.json) {
      try { return { drafts: parseJsonDoc(entry.json.doc, dims.width, dims.height), sourceName: path.basename(entry.json.path) }; }
      catch (err) { return { error: `JSON parse failed (${path.basename(entry.json.path)}): ${err.message}` }; }
    }
    if (entry.xml) {
      try { return { drafts: parseVocXml(await fsPromises.readFile(entry.xml, "utf8"), dims.width, dims.height), sourceName: path.basename(entry.xml) }; }
      catch (err) { return { error: `XML parse failed (${path.basename(entry.xml)}): ${err.message}` }; }
    }
    if (entry.txt) {
      try { return { drafts: parseYoloTxt(await fsPromises.readFile(entry.txt, "utf8"), index.classNames), sourceName: path.basename(entry.txt) }; }
      catch (err) { return { error: `YOLO txt parse failed (${path.basename(entry.txt)}): ${err.message}` }; }
    }
  }
  if (index.cocoByBasename.has(base)) {
    return { drafts: index.cocoByBasename.get(base), sourceName: index.cocoSource.get(base) || "COCO manifest" };
  }
  return null;
}

// ---------------- registration ----------------

async function importImages(imageList, known, annIndex, root, result) {
  for (const f of imageList) {
    const existing = known.get(f.absolutePath);
    if (existing?.annotations.length) continue;
    const base = stem(f.absolutePath);
    try {
      const dims = await imageSize(f.absolutePath);
      if (!dims || !dims.width || !dims.height) {
        pushSkipped(result, { name: f.relativeName, reason: "could not read image dimensions" });
        continue;
      }

      let resolved = null;
      if (annIndex) {
        resolved = await resolveFromIndex(annIndex, base, dims);
      } else {
        const labelFile = await findLabelFile(root, f.absolutePath);
        if (labelFile) {
          try {
            const text = await fsPromises.readFile(labelFile, "utf8");
            const drafts = labelFile.endsWith(".xml")
              ? parseVocXml(text, dims.width, dims.height)
              : parseJson(text, dims.width, dims.height);
            resolved = { drafts, sourceName: path.basename(labelFile) };
          } catch (err) {
            pushSkipped(result, { name: f.relativeName, reason: `label file unreadable: ${err.message}` });
            continue;
          }
        }
      }

      if (resolved && resolved.error) {
        pushSkipped(result, { name: f.relativeName, reason: resolved.error });
        continue;
      }

      if (result.cancelled || store.getProject()?.id !== result.projectId) return;
      if (existing?.annotations.length) continue; // A labeler may have saved while the file was read.
      let annotations = [];
      let importedFrom = null;
      if (resolved && resolved.drafts && resolved.drafts.length) {
        annotations = resolved.drafts.map((d) => ({
          id: store.newId(),
          labelId: d.labelName ? store.getOrCreateLabel(d.labelName, false).id : null,
          type: d.type, rect: d.rect, points: d.points, line: d.line ?? null,
          createdBy: null, createdByName: "Imported",
        }));
        importedFrom = resolved.sourceName;
      }

      if (existing) {
        if (!annotations.length) continue;
        store.backfillAnnotations(existing, annotations, importedFrom, false);
        result.backfilled++;
      } else {
        const record = store.addImage({
          fileName: f.relativeName, path: f.absolutePath,
          width: dims.width, height: dims.height, annotations, importedFrom,
        });
        known.set(f.absolutePath, record);
        result.added++;
      }
      if (importedFrom) {
        result.importedLabels++;
        const ext = (importedFrom.match(/\.([a-z0-9]+)$/i) || [, "manifest"])[1].toLowerCase();
        result.formatCounts[ext] = (result.formatCounts[ext] || 0) + 1;
      }
    } catch (err) {
      pushSkipped(result, { name: f.relativeName, reason: err.message });
    }
  }
}

let currentImport = null;

// The skipped list is display-only (the frontend shows the first few and a
// count), so don't let it grow without bound -- a dataset with thousands of
// unreadable files would otherwise make every 2s import-status poll
// serialize a giant JSON array and eat memory.
const MAX_SKIPPED_KEPT = 500;
function pushSkipped(result, entry) {
  result.skippedTotal = (result.skippedTotal || 0) + 1;
  if (result.skipped.length < MAX_SKIPPED_KEPT) result.skipped.push(entry);
}

/** Incremental folder walk: yields image files one at a time as they're
 *  found, so a huge dataset starts importing before the whole tree is
 *  scanned. Keeps the same rules as the old walkImages() (skips dotfiles and
 *  any `labels/` subfolder). */
async function* walkImagesGen(root) {
  async function* walk(dir) {
    let items;
    try { items = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith(".")) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (it.name.toLowerCase() === "labels") continue; // annotation files, not images
        yield* walk(full);
      } else if (IMAGE_EXTENSIONS.has(path.extname(it.name).toLowerCase())) {
        yield { absolutePath: full, relativeName: path.relative(root, full) };
      }
    }
  }
  yield* walk(root);
}

/** Runs entirely in the background (see registerDataset): walks the dataset
 *  incrementally, importing images in batches as they're discovered, and
 *  persists so a crash never loses finished work. Persists are THROTTLED to
 *  at most one full-file write per SAVE_INTERVAL_MS: saveImages() rewrites the
 *  whole images.json synchronously, and on a large import doing that every
 *  batch would block the event loop (and stall the app, especially on slower
 *  Windows disks). The final save at the end guarantees everything lands.
 *  Yields to the event loop between batches so the server stays responsive. */
const SAVE_INTERVAL_MS = 1000;

async function runImport(datasetPath, annotationsPath, result) {
  const root = path.resolve(datasetPath);
  const known = new Map(store.getImages().map((r) => [r.path,r]));

  let annIndex = null;
  let annRoot = null;
  if (annotationsPath && String(annotationsPath).trim()) {
    annRoot = path.resolve(String(annotationsPath).trim());
    let stat;
    try { stat = await fsPromises.stat(annRoot); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) {
      result.skipped.push({ name: "(annotations folder)", reason: `Not a folder on this machine: ${annRoot}` });
      annRoot = null;
    } else {
      annIndex = await buildAnnotationIndex(annRoot);
      for (const e of annIndex.errors) pushSkipped(result, e);
    }
  }
  if (result.cancelled || store.getProject()?.id !== result.projectId) return;

  store.setDatasetPath(root);
  if (annRoot) store.setAnnotationsPath(annRoot);
  store.saveProject();

  let lastSaveAt = 0;
  const persistIfDue = () => {
    const now = Date.now();
    if (now - lastSaveAt >= SAVE_INTERVAL_MS) {
      store.saveProject(); // Persist new label definitions before image records reference them.
      store.saveImages();
      lastSaveAt = now;
    }
  };

  let pending = [];
  for await (const f of walkImagesGen(root)) {
    if (result.cancelled || store.getProject()?.id !== result.projectId) return;
    result.scanned++;
    const existing = known.get(f.absolutePath);
    if (existing?.annotations.length) continue;
    pending.push(f);
    if (pending.length >= BATCH_SIZE) {
      await importImages(pending, known, annIndex, root, result);
      pending = [];
      persistIfDue();
      await new Promise((r) => setImmediate(r));
    }
  }
  if (result.cancelled || store.getProject()?.id !== result.projectId) return;
  if (pending.length > 0) {
    await importImages(pending, known, annIndex, root, result);
    persistIfDue();
  }
  result.totalNew = result.scanned;
  result.done = true;
  store.saveImages();
  store.saveProject();
}

/**
 * Scans `datasetPath` and registers every new image, all in the background:
 * the first BATCH_SIZE images appear in the gallery within a couple of
 * seconds, the rest follow in batches. The response returns immediately --
 * nothing in the request blocks -- so a huge dataset never makes the browser
 * show "not responding". Starting a new import cancels any in-progress one.
 *
 * @returns {{importId:string, done:boolean, scanned:number, total:number|null,
 *   added:number, importedLabels:number, skipped:Array, formatCounts:object}}
 */
function registerDataset(datasetPath, annotationsPath) {
  if (currentImport) currentImport.cancelled = true;

  const importId = store.newId();
  const result = {
    projectId: store.getProject()?.id,
    importId,
    done: false, cancelled: false,
    scanned: 0, totalNew: null,
    added: 0, backfilled: 0, importedLabels: 0,
    skipped: [], skippedTotal: 0,
    formatCounts: {},
  };
  currentImport = result;

  setImmediate(() => {
    runImport(datasetPath, annotationsPath, result).catch((err) => {
      console.error("[importer]", err);
      result.error = err.message;
      result.done = true;
    });
  });

  return {
    importId,
    done: false,
    scanned: 0,
    total: null,
    added: 0,
    importedLabels: 0,
    skipped: [], skippedTotal: 0,
    formatCounts: {},
  };
}

function getImportStatus(importId) {
  if (!currentImport || currentImport.importId !== importId) return null;
  return {
    importId: currentImport.importId,
    done: currentImport.done,
    error: currentImport.error,
    cancelled: currentImport.cancelled,
    total: currentImport.totalNew,
    scanned: currentImport.scanned,
    added: currentImport.added,
    backfilled: currentImport.backfilled,
    importedLabels: currentImport.importedLabels,
    skipped: currentImport.skipped,
    skippedTotal: currentImport.skippedTotal,
    formatCounts: currentImport.formatCounts,
  };
}

module.exports = {
  cancelImport() { if (currentImport) { currentImport.cancelled = true; currentImport.done = true; } },
  registerDataset,
  getImportStatus,
  parseVocXml, parseJson, parseJsonDoc,
  parseCocoManifest, isCocoManifest,
  parseYoloTxt, parseYoloClasses,
  parseLabelMeDoc,
  parseDetectorBoxesDoc,
  resolveOwnFormatShape,
  buildAnnotationIndex,
};
