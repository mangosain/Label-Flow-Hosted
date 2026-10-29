"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pub=path.join(__dirname,'..','public');
const admin=fs.readFileSync(path.join(pub,'admin.js'),'utf8');
const canvas=fs.readFileSync(path.join(pub,'canvas.js'),'utf8');
test('Back returns to current project gallery, and no editor Projects button is rendered',()=>{
  for(const html of ['index.html','admin.html'])
    assert.doesNotMatch(fs.readFileSync(path.join(pub,html),'utf8'),/id="go-projects"/);
  assert.match(admin,/Back to gallery/);
  assert.match(admin,/function returnToGallery\(\)/);
  assert.match(admin,/renderDashboard\(\);/);
  assert.match(admin,/addEventListener\("click", returnToGallery\)/);
  assert.match(admin,/data-action="reconnect"/);
  assert.match(admin,/data-action="select-file"/);
  assert.match(admin,/LocalBackend\.reconnectSingleImage\(image\.id\)/);
  assert.match(admin,/LocalBackend\.reconnectDatasetForImage\(image\.id\)/);
  assert.match(admin,/onImageError: imageLoadError/);
  const editor=admin.slice(admin.indexOf('async function openEditor('));
  assert.ok(editor.indexOf('$("#back")?.addEventListener') < editor.indexOf('await LocalBackend.imageSource(image.id)'), 'Back must register before image file read');
});

test('decoded image uses a dedicated DOM layer with transparent annotation overlay',()=>{
  const css=fs.readFileSync(path.join(pub,'style.css'),'utf8');
  assert.match(canvas,/document\.createElement\("img"\)/);
  assert.match(canvas,/this\.container\.insertBefore\(source, this\.canvas\)/);
  assert.match(canvas,/this\._positionSourceImage\(\)/);
  assert.match(canvas,/translate3d\(/);
  assert.doesNotMatch(canvas,/ctx\.drawImage\(this\.img/);
  assert.match(css,/\.canvas-holder > \.anno-canvas \{ position:relative; z-index:1;/);
  assert.match(canvas,/this\.img\.remove\(\)/);
});

test('initial fit defers until canvas container is measurable',()=>{
  assert.match(canvas,/this\._needsFirstFit = true/);
  assert.match(canvas,/this\._needsFirstFit && this\.img\?\.naturalWidth/);
  assert.match(canvas,/if \(!\(cw > 0 && ch > 0 && this\.imgW > 0 && this\.imgH > 0\)\)/);
});

// Guard the regression exposed by a screenshot showing the untouched initial
// status and empty diagnostics: no editor startup exception may prevent the
// Back or native recovery click handlers from being registered.
test('editor recovery and diagnostics initialize before canvas creation and source access',()=>{
  const editor=admin.slice(admin.indexOf('async function openEditor('));
  const pos=(needle)=>{const p=editor.indexOf(needle);assert.notEqual(p,-1,needle);return p;};
  assert.ok(pos('setSourceState("Preparing annotation editor…")') < pos('arrangeEditorWorkspace();'));
  assert.ok(pos('$("#back")?.addEventListener') < pos('arrangeEditorWorkspace();'));
  assert.ok(pos('$("#select-original-image")?.addEventListener') < pos('arrangeEditorWorkspace();'));
  assert.ok(pos('$("#reconnect-original-folder")?.addEventListener') < pos('arrangeEditorWorkspace();'));
  assert.ok(editor.indexOf('editorStartupError(error);',pos('arrangeEditorWorkspace();')) > pos('arrangeEditorWorkspace();'));
  assert.ok(pos('imageWatchdog = setTimeout') < pos('await LocalBackend.imageSource(image.id)'));
  assert.match(editor,/error: message, stack: error\?\.stack/);
  assert.match(editor,/Editor startup failed — inspect Diagnostics/);
});

test('passive image loading never opens a permission prompt without user gesture',()=>{
  const backend=fs.readFileSync(path.join(pub,'local-backend.js'),'utf8');
  const check=backend.slice(backend.indexOf('async function permission('),backend.indexOf('async function selectFolder('));
  assert.match(check,/h\.queryPermission/);
  assert.doesNotMatch(check,/h\.requestPermission\(/);
  assert.match(check,/Click Reconnect folder/);
});

// Regression: the missing global arrangeWorkspace function caused all original
// image loads to fail before a canvas was constructed. The page must own the
// helper directly and must not depend on canvas.js exposing an incidental global.
test('editor workspace arranger is defined in admin.js and safe across script versions', () => {
  assert.match(admin,/function arrangeEditorWorkspace\(\) \{/);
  assert.match(admin,/arrangeEditorWorkspace\(\);/);
  assert.doesNotMatch(admin,/^[ \t]*arrangeWorkspace\(\);/m);
  assert.match(admin,/function arrangeEditorWorkspace[\s\S]*?side\.prepend\(controls\)/);
});
