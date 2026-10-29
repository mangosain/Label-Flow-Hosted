"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../public");

// Previous releases loaded these as classic scripts. Both import-parsers.js and
// canvas.js declared `const clamp01` in the same global lexical environment;
// the second script threw SyntaxError and AnnotationCanvas was never defined.
// A VM context preserves the same global lexical scope across script loads,
// whereas separate vm.runInNewContext calls would miss this regression.
test("browser importer and annotation canvas load together without global lexical collisions", () => {
  const context = vm.createContext({ window: {}, globalThis: {}, console });
  for (const name of ["import-parsers.js", "canvas.js"]) {
    assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }), name);
  }
  assert.equal(typeof context.globalThis.LabelFlowImport.parseJsonDoc, "function");
  assert.equal(typeof context.window.AnnotationCanvas, "function");
});

test("all production application scripts have explicit, ordered versioned references", () => {
  const pages = ["index.html", "admin.html"];
  const scripts = ["beta-notice.js", "lines.js", "browser-zip.js", "browser-exporter.js", "import-parsers.js", "local-backend.js", "canvas.js", "admin.js"];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    let previous = -1;
    for (const src of scripts) {
      const expected = `src="/${src}?v=3.3"`;
      const at = html.indexOf(expected);
      assert.ok(at > previous, `${page}: missing or incorrectly ordered ${expected}`);
      previous = at;
    }
  }
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  for (const src of scripts) assert.ok(sw.includes(`/${src}?v=3.3`), `Missing versioned service-worker resource ${src}`);
});
