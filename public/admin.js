"use strict";
/**
 * Admin panel. Loopback-only (see server.js) so there is no login: whoever
 * can reach this page IS the admin. Flow: create a project once -> upload a
 * dataset (with an optional, separate annotations folder) -> manage labels
 * -> browse/annotate/export images.
 *
 * The dataset upload panel is the important bit for this feature: choosing
 * an annotations folder is entirely optional. If skipped, images import
 * unlabeled exactly like before. If chosen, lib/importer.js flat-matches
 * every file in that folder to an image by filename and plots whatever it
 * finds as normal, fully editable shapes (same select/drag/resize/relabel
 * tools the labelers use) -- see the "Supports ..." line in the panel for
 * which formats are understood.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
let state = { project: null, stats: null, users: [] };
let imagesPage = { images: [], total: 0, offset: 0, limit: 36, status: "ALL", q: "" };
let uploadState = { datasetPath: "", annotationsPath: "", annotationsPathCleared: false, lastResult: null, importing: false, importProgress: null };
let searchDebounce = null;
let dashboardLabelSearch = "";
// Snapshot of the image list + filters at the moment an editor was opened
// from a gallery row, so Prev/Next can walk it (and lazily fetch adjacent
// pages when you reach an edge) without re-deriving it from scratch.
let editorNav = null;
// The AnnotationCanvas of whichever editor is currently open, if any. Kept
// at module scope (rather than only as openEditor()'s local const) so the
// single global keyboard-shortcut listener below can reach it.
let activeCanvas = null;
let activeImageObjectURL = null;
let autosaveTimer = null;
let galleryObserver = null;
let galleryRequest = null;
let editorRequest = 0;
function disposeGallery() {
  galleryObserver?.disconnect(); galleryObserver = null;
  galleryRequest?.abort(); galleryRequest = null;
  clearTimeout(searchDebounce);
  document.querySelectorAll(".image-card img").forEach((img) => { if(img.dataset.objectUrl) LocalBackend.revokeURL(img.dataset.objectUrl); img.removeAttribute("src"); });
}
function disposeEditor() {
  clearTimeout(autosaveTimer); autosaveTimer=null;
  activeCanvas?.destroy(); activeCanvas = null;
  if (activeImageObjectURL) { LocalBackend.revokeURL(activeImageObjectURL); activeImageObjectURL=null; }
  document.querySelectorAll(".kbd-tooltip").forEach((el) => el.remove());
}

// Tool switching lives here (module scope, added once) so it works whether
// triggered by a button click or a global keyboard shortcut, and so we only
// ever attach ONE keydown listener for the page's lifetime (attaching this
// inside openEditor() would stack a new listener every time an image is opened).
function selectTool(name) {
  if (!activeCanvas) return;
  // "line-lasso" has no [data-tool] button of its own -- it's driven by the
  // "Line annotation" checkbox instead (see wireLineAnnotationToggle) -- so
  // the button lookup below is allowed to come up empty; every OTHER tool
  // still has a real button to highlight.
  document.querySelectorAll("[data-tool]").forEach((x) => x.classList.remove("active"));
  const btn = document.querySelector(`[data-tool="${name}"]`);
  if (btn) btn.classList.add("active");
  activeCanvas.setTool(name);
  const el = $("#holder .anno-canvas");
  if (el) el.classList.toggle("select", name === "select");
  // Keep the checkbox in sync however the tool actually changed -- clicking
  // a normal tool button while it's checked should uncheck it, same as
  // checking it should deactivate the normal tool buttons above.
  const lassoChk = $("#line-annotation-tool");
  if (lassoChk) lassoChk.checked = name === "line-lasso";
}

window.addEventListener("keydown", (e) => {
  if (!activeCanvas || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  const key = e.key.toLowerCase();
  // Shift+Z is a TOGGLE (on -> off -> on), unlike A/S/D which always select
  // their tool outright -- matches the "Line annotation" checkbox's own
  // on/off nature rather than the exclusive Select/Box/Polygon tool group.
  if (key === "z") { e.preventDefault(); selectTool(activeCanvas.tool === "line-lasso" ? "select" : "line-lasso"); return; }
  const map = { a: "select", s: "bbox", d: "polygon" };
  if (map[key]) { e.preventDefault(); selectTool(map[key]); }
});

// Ctrl/Cmd+S saves, same as clicking the Save button -- see app.js for the
// identical labeler-side version and the reasoning (always prevents the
// browser save dialog, works even while a floating input has focus).
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
  e.preventDefault();
  const btn = $("#save");
  if (btn && !btn.disabled) btn.click();
});



async function api(path, opts = {}) {
  return LocalBackend.api(path, opts);
}
async function downloadExport(choice, imageId = null) {
  const result = await LocalBackend.exportData(choice.format, choice.coords || 'both', !!choice.completedOnly, imageId);
  if (result.warnings?.length && !confirm(`Export warnings:\n\n${result.warnings.join('\n\n')}\n\nContinue with this potentially lossy format?`)) return;
  LocalBackend.download(result.blob, result.name);
}

const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
const escAttr = escHtml;

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------- boot / project picker ----------------
async function refreshState() { state = await api("/api/admin/state"); }

async function boot() {
  disposeGallery();
  disposeEditor();
  editorRequest++;
  // A fresh boot always follows create/resume/unload -- never carry stale
  // dataset-path fields or list filters from whichever project was active
  // before into the next one.
  uploadState = { datasetPath: "", annotationsPath: "", annotationsPathCleared: false, lastResult: null, importing: false };
  imagesPage = { images: [], total: 0, offset: 0, limit: 36, status: "ALL", q: "" };
  editorNav = null;

  try { await refreshState(); }
  catch (err) {
    app.innerHTML = `<div class="page"><div class="notice err">Could not read local project database: ${escHtml(err.message)}</div></div>`;
    return;
  }
  $("#proj-name").textContent = state.project ? state.project.name : "";
  if (!state.project) return renderProjectPicker();
  renderDashboard();
}

async function renderProjectPicker(error) {
  let projects = [];
  try { projects = (await api("/api/admin/projects")).projects; } catch { /* show create form regardless */ }

  app.innerHTML = `
    <div class="project-landing">
      <div class="landing-shell">
        <section class="landing-intro" aria-labelledby="landing-title">
          <div class="landing-eyebrow"><span class="eyebrow-dot"></span> IMAGE ANNOTATION WORKSPACE</div>
          <h1 id="landing-title">Bring clarity to<br><span>every annotation.</span></h1>
          <p class="landing-subtitle">An organized workspace for your image datasets. Create a project, open your images and keep your annotation workflow moving.</p>
          <div class="landing-highlights" aria-label="Workspace features">
            <div><span class="highlight-icon" aria-hidden="true">◇</span><span><strong>Precise annotation</strong><small>Boxes, polygons and reading order</small></span></div>
            <div><span class="highlight-icon" aria-hidden="true">▦</span><span><strong>Organized projects</strong><small>Continue exactly where you left off</small></span></div>
            <div><span class="highlight-icon" aria-hidden="true">↗</span><span><strong>Flexible exports</strong><small>Save results in your required format</small></span></div>
          </div>
          <div class="landing-art" aria-hidden="true">
            <div class="art-toolbar"><span></span><span></span><span></span><i></i><b>ANNOTATION PREVIEW</b></div>
            <div class="art-document">
              <div class="art-line art-line-long"></div><div class="art-line"></div>
              <div class="art-mark art-mark-a"><em>TEXT · 01</em></div>
              <div class="art-mark art-mark-b"><em>FIELD · 02</em></div>
              <div class="art-line art-line-mid"></div><div class="art-line art-line-short"></div>
            </div>
            <div class="art-footer"><span class="art-pulse"></span> Annotation tools ready <span class="art-zoom">100%</span></div>
          </div>
        </section>
        <div class="landing-panels">
          <section class="card create-project-card" aria-labelledby="new-project-heading">
            <div class="panel-heading">
              <div class="panel-icon" aria-hidden="true">+</div>
              <div><span class="panel-eyebrow">GET STARTED</span><h2 id="new-project-heading">Create a new project</h2></div>
            </div>
            <p class="panel-description">Set up your workspace in seconds. You'll choose the image folder after creating the project.</p>
            <form id="create-project">
              ${error ? `<div class="notice err" role="alert">${escHtml(error)}</div>` : ""}
              <label class="field-label" for="project-name">Project name <span aria-hidden="true">*</span></label>
              <input id="project-name" class="input" name="name" required autofocus maxlength="160" placeholder="e.g. Invoice OCR — Batch 3" />
              <label class="field-label" for="starting-labels">Starting labels <span class="field-optional">Optional</span></label>
              <input id="starting-labels" class="input" name="labels" placeholder="word, line, table" />
              <p class="field-hint">Separate labels with commas. You can change them later.</p>
              <button class="btn primary create-button" type="submit">Create project <span aria-hidden="true">→</span></button>
            </form>
          </section>
          <section class="card recent-projects-card" aria-labelledby="recent-projects-heading">
            <div class="panel-heading recent-heading">
              <div><span class="panel-eyebrow">YOUR WORKSPACE</span><h2 id="recent-projects-heading">Recent projects</h2></div>
              <span class="project-count">${projects.length} ${projects.length === 1 ? "project" : "projects"}</span>
            </div>
            ${projects.length ? `<div class="project-list">
              ${projects.map((p) => {
                const total = Number(p.imageCount) || 0;
                const completed = Math.max(0, Number(p.completedCount) || 0);
                const percent = total ? Math.min(100, Math.round(completed / total * 100)) : 0;
                return `<div class="project-row">
                  <div class="project-row-top"><span class="project-avatar" aria-hidden="true">▦</span>
                    <div class="project-identity"><strong title="${escAttr(p.name)}">${escHtml(p.name)}</strong><span>${total.toLocaleString()} images · ${completed.toLocaleString()} completed · ${Number(p.labelCount)||0} labels</span></div>
                  </div>
                  <div class="project-progress"><div class="project-progress-track" role="progressbar" aria-label="${escAttr(p.name)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><span>${percent}%</span></div>
                  <div class="project-row-actions"><button class="btn sm primary" data-resume="${escAttr(p.id)}" type="button">Open project <span aria-hidden="true">→</span></button><button class="btn sm project-delete" data-delete="${escAttr(p.id)}" data-delete-name="${escAttr(p.name)}" type="button" aria-label="Delete ${escAttr(p.name)}">Delete</button></div>
                </div>`;
              }).join("")}
            </div>` : `<div class="projects-empty"><span class="empty-illustration" aria-hidden="true">▤</span><strong>No projects yet</strong><span>Once you create a project, it will appear here for quick access.</span></div>`}
          </section>
        </div>
      </div>
    </div>`;

  $("#create-project").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get("name") || "").trim();
    const labels = String(fd.get("labels") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!name) return;
    try {
      await api("/api/admin/project", { method: "POST", body: JSON.stringify({ name, labels }) });
      await boot();
    } catch (err) { renderProjectPicker(err.message); }
  });
  document.querySelectorAll("[data-resume]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Resuming…";
      try {
        await api(`/api/admin/projects/${btn.dataset.resume}/activate`, { method: "POST" });
        await boot();
      } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "Resume"; }
    });
  });
  document.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDeleteProject(btn.dataset.delete, btn.dataset.deleteName);
      if (ok) renderProjectPicker();
    });
  });
}

/**
 * Two-step, deliberately annoying confirmation for an irreversible action:
 * a confirm() explaining exactly what is and isn't deleted, then a prompt()
 * requiring the project's exact name to be typed back. Returns true if the
 * project was actually deleted.
 */
async function confirmDeleteProject(id, name) {
  const step1 = confirm(
    `Permanently delete "${name}"?\n\n` +
    `This removes every image record, annotation, and label this app has for the project, ` +
    `and cannot be undone.\n\n` +
    `The dataset and annotations folders on your disk are NOT touched — only this app's ` +
    `tracking data goes away.`
  );
  if (!step1) return false;
  const typed = prompt(`Type the project name exactly to confirm: "${name}"`);
  if (typed !== name) {
    if (typed !== null) alert("Name didn't match — nothing was deleted.");
    return false;
  }
  try {
    await api(`/api/admin/projects/${id}`, { method: "DELETE" });
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

// ---------------- dashboard shell ----------------
function clearEditorNav() {
  const el = $("#editor-nav");
  if (!el) return;
  el.style.display = "none";
  el.innerHTML = "";
}

function clearImageMeta() {
  const el = $("#image-meta");
  if (!el) return;
  el.style.display = "none";
  $("#meta-inline").innerHTML = "";
  $("#meta-dropdown").innerHTML = "";
}

function setImageMeta(image) {
  const el = $("#image-meta");
  if (!el) return;
  el.style.display = "inline-flex";
  const html = `
    <span class="topbar-file" title="${escAttr(image.fileName)}">${escHtml(image.fileName)}</span>
    <span class="faint"><span id="dims">${image.width}×${image.height}</span> · <span id="shape-count"></span></span>
    <span class="badge ${image.status === "COMPLETED" ? "green" : image.status === "CLAIMED" ? "amber" : "gray"}">${image.status.toLowerCase()}</span>
    ${image.claimedByName ? `<span class="faint">Claimed by ${image.claimedByName}</span>` : ""}
    ${image.importedFrom ? `<span class="faint" style="color:var(--amber);">Pre-labeled from ${escHtml(image.importedFrom)}</span>` : ""}
  `;
  $("#meta-inline").innerHTML = html;
  $("#meta-dropdown").innerHTML = html;
}

const SHORTCUTS_HTML = `
  <div class="section-title" style="margin-bottom:6px;">Shortcuts</div>
  <ul class="kbd-list">
    <li><kbd>Shift</kbd>+<kbd>A</kbd> Select tool</li>
    <li><kbd>Shift</kbd>+<kbd>S</kbd> Box tool</li>
    <li><kbd>Shift</kbd>+<kbd>D</kbd> Polygon tool</li>
    <li><kbd>Shift</kbd>+<kbd>Z</kbd> Toggle line annotation tool</li>
    <li><kbd>Ctrl</kbd>+scroll Zoom</li>
    <li>Scroll Pan (vertical)</li>
    <li><kbd>Shift</kbd>+scroll Pan (horizontal)</li>
    <li><kbd>Del</kbd> Remove shape</li>
    <li><kbd>Ctrl</kbd>+<kbd>S</kbd> Save</li>
    <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> Undo</li>
    <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> Redo</li>
    <li><kbd>Esc</kbd> Cancel drawing</li>
    <li><kbd>Enter</kbd> Finish polygon</li>
  </ul>`;

function wireKbdTrigger() {
  const trigger = $("#kbd-trigger");
  if (!trigger) return;
  let tooltip = null;
  let hideTimer = null;

  function removeTooltip() {
    if (tooltip) { tooltip.remove(); tooltip = null; }
  }

  trigger.addEventListener("mouseenter", () => {
    clearTimeout(hideTimer);
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "kbd-tooltip";
      tooltip.innerHTML = SHORTCUTS_HTML;
      tooltip.style.visibility = "hidden";
      tooltip.style.display = "block";
      document.body.appendChild(tooltip);
      const tr = trigger.getBoundingClientRect();
      const tt = tooltip.getBoundingClientRect();
      let left = tr.left + tr.width / 2 - tt.width / 2;
      let top = tr.top - tt.height - 8;
      if (left < 8) left = 8;
      if (left + tt.width > window.innerWidth - 8) left = window.innerWidth - tt.width - 8;
      if (top < 8) top = tr.bottom + 8;
      if (top + tt.height > window.innerHeight - 8) top = tr.top - tt.height - 8;
      tooltip.style.left = left + "px";
      tooltip.style.top = top + "px";
      tooltip.style.visibility = "";
      tooltip.classList.add("show");
      tooltip.addEventListener("mouseenter", () => clearTimeout(hideTimer));
      tooltip.addEventListener("mouseleave", () => { hideTimer = setTimeout(removeTooltip, 300); });
    }
  });

  trigger.addEventListener("mouseleave", () => {
    hideTimer = setTimeout(removeTooltip, 300);
  });
}

function renderDashboard() {
  editorRequest++;
  disposeEditor();
  disposeGallery();
  clearEditorNav();
  clearImageMeta();
  activeCanvas = null; // leaving the editor (if we were in one) -- shortcuts should go quiet
  if (!uploadState.datasetPath && state.project.datasetPath) uploadState.datasetPath = state.project.datasetPath;
  // Pre-fill from whatever the project already has on file -- but NOT if the
  // user just explicitly cleared this field: without that check, Clear would
  // blank the field and then this exact line (running again on the
  // re-render Clear triggers) would immediately put the old path right back,
  // making the button look completely broken.
  if (!uploadState.annotationsPath && !uploadState.annotationsPathCleared && state.project.annotationsPath) uploadState.annotationsPath = state.project.annotationsPath;

  $("#proj-name").textContent = state.project.name;
  app.innerHTML = `
    <div class="dashboard">
      <div class="dashboard-heading">
        <div class="dashboard-title-group"><div class="eyebrow"><span class="eyebrow-dot"></span> PROJECT WORKSPACE</div><h1>${escHtml(state.project.name)}</h1><p class="dashboard-subtitle">Manage your dataset, annotate images, and export your results.</p></div>
        <div class="dashboard-actions">
          <button id="open-export-modal" class="btn primary" type="button" title="Download annotations as JSON, XML, VOC, COCO or YOLO">↗ Export annotations</button>
          <div class="dashboard-actions-secondary" aria-label="Project actions">
            <button id="backup-project" class="btn sm" title="Download complete project state, including editable regions">↓ Backup</button>
            <button id="restore-project" class="btn sm" title="Restore a previous LabelFlow project backup">Restore</button>
            <button id="backup-folder" class="btn sm" title="Save a backup into the selected dataset folder">Save backup to folder</button>
            <button id="refresh" class="btn sm" title="Refresh image counts and project details">↻ Refresh</button>
            <button id="unload" class="btn sm" type="button" title="Return to your projects; all saved work is kept">← Projects</button>
          </div>
        </div>
      </div>
      ${renderStatsPanel()}
      <div class="dashboard-body">
        ${renderImagesPanel()}
        <aside class="project-inspector" aria-label="Project settings">
          <div class="inspector-heading"><span class="eyebrow">PROJECT TOOLS</span><span class="faint">Configure & organize</span></div>
          ${renderUploadPanel()}
          ${renderLabelsPanel()}
          ${renderExportPanel()}
          <details class="project-danger"><summary>Project maintenance</summary>
            <p class="faint">Deletes this project's tracking data, labels and saved annotations. Source folders are never deleted.</p>
            <button id="delete-project" class="btn sm danger" type="button">Delete project permanently</button>
          </details>
        </aside>
      </div>
    </div>`;

  updateStatsBadges();
  wireDashboard();
  $("#backup-project").onclick=async()=>{try{const data=await LocalBackend.backup();LocalBackend.download(new Blob([JSON.stringify(data)],{type:'application/json'}),`${(state.project.name||'project').replace(/[^a-z0-9_-]/gi,'_')}-backup.json`);}catch(e){alert(e.message);}};
  $("#backup-folder").onclick=async()=>{try{await LocalBackend.saveBackupToFolder();showToast('Backup saved to dataset/.labelflow/backup.json');}catch(e){alert(e.message);}};
  $("#restore-project").onclick=()=>{
    const file=document.createElement('input');file.type='file';file.accept='.json,application/json';
    file.onchange=async()=>{if(!file.files?.[0])return;try{
      const restored=await LocalBackend.restore(JSON.parse(await file.files[0].text()));
      alert(`Restored ${restored.name}. Switch projects to open it and reconnect its dataset folder.`);
    }catch(e){alert(`Restore failed: ${e.message}`);}};file.click();
  };
  loadImages();
}

function renderStatsPanel() {
  return `<section id="stats-panel" class="card" style="padding:20px;"></section>`;
}

function updateStatsBadges() {
  const s = state.stats || { total: 0, unclaimed: 0, claimed: 0, completed: 0 };
  const el = $("#stats-panel");
  if (!el) return;
  const userCount = (state.users || []).length;
  const pct = s.total ? Math.round((s.completed / s.total) * 100) : 0;
  el.innerHTML = `
    <div class="stats-row">
      <div class="stat-item">
        <div class="stat-value">${s.total}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${s.unclaimed}</div>
        <div class="stat-label">Unclaimed</div>
      </div>
      <div class="stat-item">
        <div class="stat-value" style="color:var(--amber);">${s.claimed}</div>
        <div class="stat-label">In progress</div>
      </div>
      <div class="stat-item">
        <div class="stat-value" style="color:var(--green);">${s.completed}</div>
        <div class="stat-label">Completed</div>
      </div>
    </div>
    <div class="row" style="justify-content:space-between; margin-top:10px; padding-top:10px; border-top:1px solid var(--line);">
      <span class="faint">${pct}% complete</span>
      <button type="button" id="users-pill" class="badge gray pill-btn" title="View labelers">${userCount} labeler${userCount === 1 ? "" : "s"}</button>
    </div>`;
  const pill = $("#users-pill");
  if (pill) pill.addEventListener("click", openUsersDialog);
}

// Was a standalone "Labelers" card in the right column; now a click-through
// on the users-pill above (next to the other stat badges) instead, since a
// whole permanent section for what's usually a short, rarely-checked list
// took up more space than it earned -- same info, one click away instead of
// always-on screen real estate.
function openUsersDialog() {
  const users = state.users || [];
  const dlg = document.createElement("dialog");
  dlg.className = "export-coords-dialog users-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>Labelers</h3>
      ${users.length ? `
        <div class="stack" style="margin-top:10px; max-height:320px; overflow-y:auto;">
          ${users.map((u) => `
            <div class="row" style="justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--line);">
              <span>${escHtml(u.name)}</span><span class="faint">${timeAgo(u.lastSeenAt)}</span>
            </div>`).join("")}
        </div>` : `<p class="faint" style="margin-top:10px;">No one has joined yet.</p>`}
      <div class="row" style="justify-content:flex-end; margin-top:16px;">
        <button type="submit" class="btn">Close</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
}

function wireDashboard() {
  $("#refresh").addEventListener("click", async () => { await refreshState(); renderDashboard(); });
  $("#unload").addEventListener("click", async () => {
    if (!confirm("Unload this project? Nothing is deleted — every image, annotation, and label stays exactly as it is, and you can resume from the project picker any time.")) return;
    try { await api("/api/admin/unload", { method: "POST" }); await boot(); }
    catch (err) { alert(err.message); }
  });
  $("#delete-project").addEventListener("click", async () => {
    const ok = await confirmDeleteProject(state.project.id, state.project.name);
    if (ok) await boot();
  });
  wireUploadPanel();
  wireImagesPanel();
  wireLabelsPanel();
  wireExportPanel();
}

// ---------------- upload panel (dataset + optional annotations folder) ----------------
function renderUploadPanel() {
  const prog = uploadState.importProgress;
  const pct = prog && prog.total > 0 ? Math.round(prog.added / prog.total * 100) : 0;
  const btnLabel = uploadState.importing && prog
    ? (prog.total > 0
        ? `Importing… ${prog.added}/${prog.total} (${pct}%)`
        : `Scanning… ${prog.scanned || 0} found`)
    : uploadState.importing ? "Importing…" : "Import dataset";
  return `
    <section id="upload-panel" class="card" style="padding:16px;">
      <h2>Dataset source</h2>
      <p class="faint" style="margin-bottom:12px;">Connect image and annotation folders on this computer.</p>
      <div class="stack">
        <div>
          <label class="faint">Dataset folder</label>
          <div class="row" style="margin-top:4px; flex-wrap:nowrap;">
            <input class="input grow" id="dataset-path" value="${escAttr(uploadState.datasetPath)}" placeholder="Click Browse to authorize a dataset folder" readonly />
            <button class="btn sm" id="browse-dataset" type="button">Browse…</button>
          </div>
        </div>
        <div>
          <label class="faint">Annotations folder <span class="faint">(optional)</span></label>
          <div class="row" style="margin-top:4px; flex-wrap:nowrap;">
            <input class="input grow" id="annotations-path" value="${escAttr(uploadState.annotationsPath)}" placeholder="Optional — click Browse" readonly />
            <button class="btn sm" id="browse-annotations" type="button">Browse…</button>
            ${uploadState.annotationsPath ? `<button class="btn sm" id="clear-annotations" type="button">Clear</button>` : ""}
          </div>
          <details class="import-help"><summary>Formats & matching help</summary><ul class="hint-list" style="margin-top:8px;">
            <li><strong>Formats:</strong> Pascal VOC XML, this app's own JSON, LabelMe JSON, one dataset-wide COCO JSON manifest, and YOLO .txt (reads classes.txt / obj.names / data.yaml for names).</li>
            <li><strong>Detector/OCR output</strong> (<span class="mono">{boxes:[{bbox,confidence}]}</span>) imports as unlabeled boxes — no class names in the source, so a labeler names each one.</li>
            <li><strong>Matching:</strong> ignores subfolders — any file with the same filename (minus extension) as an image is used for it.</li>
          </ul></details>
        </div>
        <button class="btn sm" id="relink-project-images" type="button" title="Reconnect existing images without changing annotations">Repair image links</button>
        <button class="btn primary" id="import-btn" ${uploadState.datasetPath ? "" : "disabled"} ${uploadState.importing ? "disabled" : ""}>
          ${btnLabel}
        </button>
        ${uploadState.importing && prog ? `
          <div style="margin-top:8px;">
            <div class="progress-track ${prog.total > 0 ? "" : "indeterminate"}">
              <div class="progress-fill" style="${prog.total > 0 ? `width:${pct}%` : ""}"></div>
            </div>
            <div class="faint" style="margin-top:3px;">${prog.total > 0
              ? `${prog.added} of ${prog.total} images imported (${pct}%)`
              : `Scanning… ${prog.scanned || 0} images found`}</div>
          </div>
        ` : ""}
        <p class="faint">Safe to re-run: adds new images and fills empty annotations. Existing shapes are preserved.</p>
        ${renderImportResult()}
      </div>
    </section>`;
}

function renderImportResult() {
  const r = uploadState.lastResult;
  if (!r) return "";
  if (r.error) return `<div class="notice err">${escHtml(r.error)}</div>`;
  const formatBits = Object.entries(r.formatCounts || {}).map(([k, v]) => `${v} ${k}`).join(", ");
  const hasIssues = (r.skippedTotal || (r.skipped || []).length) > 0;
  const prog = uploadState.importProgress;
  const importingNotice = uploadState.importing && prog && !prog.done
    ? (prog.total > 0
        ? `<div class="faint" style="margin-top:4px;">Background import running — ${prog.added}/${prog.total} images imported so far. You can start working on the imported images now.</div>`
        : `<div class="faint" style="margin-top:4px;">Scanning the dataset — ${prog.scanned || 0} images found so far.</div>`)
    : "";
  return `
    <div class="notice ${hasIssues ? "warn" : "info"}">
      <div>${r.added} new image(s) of ${r.scanned} scanned · ${r.importedLabels} pre-labeled${formatBits ? ` (${formatBits})` : ""}</div>
      ${r.skipped && r.skipped.length ? `<div style="margin-top:6px;"><strong>${r.skippedTotal || r.skipped.length}</strong> skipped: ${r.skipped.slice(0, 8).map((s) => `${s.name} (${escHtml(s.reason)})`).join("; ")}${(r.skippedTotal || r.skipped.length) > 8 ? "…" : ""}</div>` : ""}
      ${importingNotice}
    </div>`;
}

function wireUploadPanel() {
  $("#dataset-path").addEventListener("change", (e) => { uploadState.datasetPath = e.target.value.trim(); syncImportButton(); });
  $("#annotations-path").addEventListener("change", (e) => { uploadState.annotationsPath = e.target.value.trim(); });
  $("#browse-dataset").addEventListener("click", async () => {
    const p = await browseFolder("dataset");
    if (p) { uploadState.datasetPath = p; renderDashboard(); }
  });
  $("#browse-annotations").addEventListener("click", async () => {
    const p = await browseFolder("annotations");
    if (p) { uploadState.annotationsPath = p; renderDashboard(); }
  });
  const clearBtn = $("#clear-annotations");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    uploadState.annotationsPath = "";
    uploadState.annotationsPathCleared = true;
    renderDashboard();
  });
  $("#import-btn").addEventListener("click", runImport);
  $("#relink-project-images").addEventListener("click", async (event) => {
    const btn=event.currentTarget;
    btn.disabled=true;
    btn.textContent='Finding originals…';
    try {
      const result=await LocalBackend.relinkProjectFolder();
      uploadState.datasetPath=result.folder;
      showToast(`Reconnected ${result.matched}/${result.total} images. Missing: ${result.missing}; ambiguous: ${result.ambiguous}.`,{duration:10000});
      renderDashboard();
    } catch(error) {
      if(error?.name!=='AbortError'){
        alert(`Image repair failed: ${error?.message||String(error)}`);
      }
    } finally {
      if(btn.isConnected){btn.disabled=false;btn.textContent='Repair image links';}
    }
  });
}

function syncImportButton() {
  const btn = $("#import-btn");
  if (btn) btn.disabled = !uploadState.datasetPath || uploadState.importing;
}

async function browseFolder(role) {
  try {
    const data = await api("/api/admin/pick-folder", { method: "POST", body: JSON.stringify({ role }) });
    return data.cancelled ? null : data.path;
  } catch (err) {
    alert(err.message);
    return null;
  }
}

async function runImport() {
  uploadState.datasetPath = $("#dataset-path").value.trim();
  uploadState.annotationsPath = $("#annotations-path").value.trim();
  uploadState.importing = true;
  uploadState.lastResult = null;
  uploadState.importProgress = null;
  renderDashboard();
  try {
    const body = { path: uploadState.datasetPath };
    if (uploadState.annotationsPath) body.annotationsPath = uploadState.annotationsPath;
    const result = await api("/api/admin/dataset", { method: "POST", body: JSON.stringify(body) });
    uploadState.lastResult = result;
    uploadState.importProgress = result;
    refreshState();
    if (result.importId && !result.done) {
      pollImport(result.importId);
    } else {
      uploadState.importing = false;
      renderDashboard();
    }
  } catch (err) {
    uploadState.lastResult = { error: err.message };
    uploadState.importing = false;
    renderDashboard();
  }
}

async function pollImport(importId) {
  const projectId = state.project?.id;
  while (state.project?.id === projectId) {
    await sleep(2000);
    let status;
    try { status = await api(`/api/admin/import-status?id=${importId}`); }
    catch { uploadState.importing = false; break; }
    if (!status || status.importId !== importId || state.project?.id !== projectId) break;
    const previousAdded = uploadState.importProgress?.added || 0;
    uploadState.importProgress = status;
    uploadState.lastResult = { ...status };
    if (status.done || status.cancelled) {
      uploadState.importing = false;
      uploadState.importProgress = null;
    }
    await refreshState();
    if (state.project?.id !== projectId) break;
    // Never replace the workspace while somebody is annotating. Update only
    // the changing dashboard sections, preserving gallery scroll/focus.
    const panel = $("#upload-panel");
    if (panel) { panel.outerHTML = renderUploadPanel(); wireUploadPanel(); }
    updateStatsBadges();
    if ($("#images-panel") && (status.added !== previousAdded || status.done)) await loadImages();
    if (status.done || status.cancelled) break;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- images panel ----------------
function renderImagesPanel() {
  return `
    <section id="images-panel" class="card" style="padding:16px;">
      <div class="row" style="justify-content:space-between; margin-bottom:10px;">
        <div class="gallery-heading"><h2 style="margin:0;">Image library</h2><span class="gallery-count">${imagesPage.total} images</span></div>
        <div class="row">
          <select aria-label="Filter images by status" id="status-filter" class="input" style="width:auto;">
            <option value="ALL">All</option>
            <option value="UNCLAIMED">Unclaimed</option>
            <option value="CLAIMED">In progress</option>
            <option value="COMPLETED">Completed</option>
          </select>
          <input aria-label="Search images by filename" id="search" class="input" style="width:160px;" placeholder="Search images…" value="${escAttr(imagesPage.q)}" />
        </div>
      </div>
      <div id="image-list">${renderImageRows()}</div>
      <div class="pager" style="justify-content:space-between; margin-top:10px;">
        <button id="prev-page" class="btn sm" ${imagesPage.offset === 0 ? "disabled" : ""}>&larr; Prev</button>
        <span class="faint">${imagesPage.total ? imagesPage.offset + 1 : 0}–${Math.min(imagesPage.offset + imagesPage.limit, imagesPage.total)} of ${imagesPage.total}</span>
        <button id="next-page" class="btn sm" ${imagesPage.offset + imagesPage.limit >= imagesPage.total ? "disabled" : ""}>Next &rarr;</button>
      </div>
    </section>`;
}

function renderImageRows() {
  if (!imagesPage.images.length) return `<div class="gallery-empty"><span aria-hidden="true">▧</span><strong>No images to show</strong><p>Import a folder to get started, or try another search or filter.</p></div>`;
  // Sequence number reflects each image's position across the whole
  // filtered/sorted list (offset + index), matching the "X–Y of Z" pager
  // text below -- not just 1..N restarting on every page, which would be
  // confusing to cross-reference against that same pager.
  return `<div class="image-grid">` + imagesPage.images.map((img, i) => `
    <button type="button" class="image-card ${img.status === "COMPLETED" ? "completed" : ""}" data-id="${img.id}">
      <div class="image-card-thumb">
        <img data-image-id="${img.id}" data-src="local:${img.id}" decoding="async" alt="" />
        <span class="image-card-seq">#${imagesPage.offset + i + 1}</span>
        <span class="badge ${img.status === "COMPLETED" ? "green" : img.status === "CLAIMED" ? "amber" : "gray"}">${img.status.toLowerCase()}</span>
      </div>
      <div class="image-card-meta">
        <div class="name" title="${escAttr(img.fileName)}">${escHtml(img.fileName)}</div>
        <div class="faint" style="margin-top:3px;">${img.width}×${img.height} · ${img.annotationCount} shape(s)</div>
      </div>
    </button>`).join("") + `</div>`;
}

async function loadImages() {
  galleryRequest?.abort();
  const request = new AbortController();
  galleryRequest = request;
  const focusedSearch = document.activeElement && document.activeElement.id === "search";
  const caret = focusedSearch ? document.activeElement.selectionStart : null;
  const params = new URLSearchParams({ offset: imagesPage.offset, limit: imagesPage.limit, status: imagesPage.status, q: imagesPage.q });
  let data;
  try { data = await api(`/api/admin/images?${params}`, { signal: request.signal }); }
  catch (err) { if (err.name !== "AbortError") showToast("Could not refresh images. Try Refresh.", { type: "error" }); return; }
  if (request.signal.aborted || galleryRequest !== request) return;
  imagesPage.images = data.images;
  imagesPage.total = data.total;
  state.stats = data.stats;
  const panel = $("#images-panel");
  if (!panel) return;
  galleryObserver?.disconnect();
  panel.querySelectorAll("img").forEach((img) => {
    if (img.dataset.objectUrl) { LocalBackend.revokeURL(img.dataset.objectUrl); delete img.dataset.objectUrl; }
    img.removeAttribute("src");
  });
  panel.outerHTML = renderImagesPanel();
  wireImagesPanel();
  updateStatsBadges();
  if (focusedSearch) {
    const el = $("#search");
    if (el) { el.focus(); el.setSelectionRange(caret, caret); }
  }
}

function wireImagesPanel() {
  const panel = $("#images-panel");
  if (!panel) return;
  galleryObserver?.disconnect();
  galleryObserver = new IntersectionObserver((entries) => {
    for (const { target: img, isIntersecting } of entries) {
      if (isIntersecting && !img.hasAttribute("src") && !img.dataset.loading) {
        img.dataset.loading="1";
        LocalBackend.thumbnailURL(img.dataset.imageId).then(url=>{
          if (img.isConnected && img.dataset.loading) { img.dataset.objectUrl=url; img.src=url; }
          else LocalBackend.revokeURL(url);
        }).catch(()=>{img.style.visibility="hidden";}).finally(()=>{delete img.dataset.loading;});
      } else if (!isIntersecting && img.dataset.objectUrl) {
        LocalBackend.revokeURL(img.dataset.objectUrl); delete img.dataset.objectUrl; img.removeAttribute("src");
      }
    }
  }, { root: panel.querySelector("#image-list"), rootMargin: "100px" });
  panel.querySelectorAll("img[data-src]").forEach((img) => {
    img.addEventListener("error", () => { img.style.visibility = "hidden"; img.parentElement.title = "Preview unavailable. Open the image to annotate."; });
    img.addEventListener("load", () => { img.style.visibility = ""; });
    galleryObserver.observe(img);
  });
  panel.querySelector("#status-filter").value = imagesPage.status;
  panel.querySelector("#status-filter").addEventListener("change", (e) => {
    imagesPage.status = e.target.value; imagesPage.offset = 0; loadImages();
  });
  panel.querySelector("#search").addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    galleryRequest?.abort();
    const v = e.target.value;
    imagesPage.q = v; imagesPage.offset = 0;
    searchDebounce = setTimeout(() => { imagesPage.q = v; imagesPage.offset = 0; loadImages(); }, 300);
  });
  panel.querySelector("#prev-page").addEventListener("click", () => {
    imagesPage.offset = Math.max(0, imagesPage.offset - imagesPage.limit); loadImages();
  });
  panel.querySelector("#next-page").addEventListener("click", () => {
    imagesPage.offset += imagesPage.limit; loadImages();
  });
  panel.querySelectorAll(".image-card[data-id]").forEach((card) => {
    card.addEventListener("click", () => {
      editorNav = {
        ids: imagesPage.images.map((i) => ({ id: i.id, fileName: i.fileName })),
        meta: { offset: imagesPage.offset, limit: imagesPage.limit, status: imagesPage.status, q: imagesPage.q, total: imagesPage.total },
      };
      openEditor(card.dataset.id);
    });
  });
}

// ---------------- labels panel ----------------
function renderLabelsPanel() {
  const labels = state.project.labels || [];
  const q = dashboardLabelSearch.toLowerCase();
  const filtered = labels.filter((l) => l.name.toLowerCase().includes(q));
  return `
    <section id="labels-panel" class="card" style="padding:16px;">
      <div class="row" style="justify-content:space-between;">
        <h2>Labels</h2>
        <input id="dashboard-label-search" class="input" style="width:140px;" placeholder="Search labels…" value="${escAttr(dashboardLabelSearch)}" />
      </div>
      <div class="chips chips-scroll" style="margin:10px 0;">
        ${filtered.length ? filtered.map((l) => `
          <span class="chip"><span class="swatch" style="background:${l.color}"></span>${escHtml(l.name)}<button data-del="${l.id}" title="Delete label" type="button">×</button></span>`).join("")
          : `<p class="faint">${q ? "No labels match." : "No labels yet."}</p>`}
      </div>
      <form id="add-label" class="tag-input-row">
        <input class="input" name="name" placeholder="New label name" />
        <button class="btn sm">Add</button>
      </form>
    </section>`;
}

function wireLabelsPanel() {
  const form = $("#add-label");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("input[name=name]");
    const name = input.value.trim();
    if (!name) return;
    try {
      const res = await api("/api/admin/labels", { method: "POST", body: JSON.stringify({ name }) });
      if (!state.project.labels.some((l) => l.id === res.label.id)) state.project.labels.push(res.label);
      refreshLabelsPanel();
    } catch (err) { alert(err.message); }
  });
  document.querySelectorAll("#labels-panel [data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this label? Shapes using it become unlabeled, everywhere.")) return;
      try {
        await api(`/api/admin/labels/${btn.dataset.del}`, { method: "DELETE" });
        state.project.labels = state.project.labels.filter((l) => l.id !== btn.dataset.del);
        refreshLabelsPanel();
      } catch (err) { alert(err.message); }
    });
  });
  const searchInput = $("#dashboard-label-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      dashboardLabelSearch = e.target.value;
      refreshLabelsPanel();
    });
  }
}

function refreshLabelsPanel() {
  const focusedSearch = document.activeElement && document.activeElement.id === "dashboard-label-search";
  const caret = focusedSearch ? document.activeElement.selectionStart : null;
  const panel = $("#labels-panel");
  if (!panel) return;
  panel.outerHTML = renderLabelsPanel();
  wireLabelsPanel();
  if (focusedSearch) {
    const el = $("#dashboard-label-search");
    if (el) { el.focus(); el.setSelectionRange(caret, caret); }
  }
}

// ---------------- export panel ----------------
// A single "Export" button + modal (askBulkExport, below) replaces what used
// to be 5 separate format buttons plus a standalone checkbox and two dense
// explanation paragraphs -- the format-specific details (what each format
// carries, its fixed coordinate convention, etc.) now live as inline notes
// next to each choice inside the modal itself, where they're read exactly
// once, right when they matter, instead of permanently taking up space here.
function renderExportPanel() {
  return `
    <section id="export-panel" class="card" style="padding:16px;">
      <h2>Export</h2>
      <ul class="hint-list">
        <li><strong>JSON / XML</strong> preserve shape geometry and computed line numbers, with selectable coordinates. Only <strong>Project Backup</strong> also preserves editable line-region geometry, label IDs, project settings and completion progress.</li>
        <li><strong>VOC / COCO / YOLO</strong> are for other tools, each with one fixed coordinate convention by spec — see the note next to each when you export.</li>
      </ul>

    </section>`;
}

function wireExportPanel() {
  $("#open-export-modal").addEventListener("click", async () => {
    const choice = await askBulkExport();
    if (!choice) return; // cancelled
    const params = new URLSearchParams();
    if (choice.completedOnly) params.set("completedOnly", "true");
    // Coordinate system only means anything for this app's own json/xml
    // formats -- VOC/COCO/YOLO each have exactly one convention fixed by
    // their own spec, so the param is simply omitted for those (the server
    // ignores it either way, but there's no reason to send a value the
    // dialog itself just marked "fixed" and disabled).
    if (choice.coords && (choice.format === "json" || choice.format === "xml")) params.set("coords", choice.coords);
    const qs = params.toString();
    try { await downloadExport(choice); } catch (err) { alert(err.message); }
  });
}

/**
 * Bulk-export modal: format (json/xml/voc/coco/yolo) + coordinate system
 * (only meaningful for json/xml -- auto-disabled and replaced with a "fixed
 * by format" note for the other three, same reasoning as askExportCoords()
 * in canvas.js) + completed-only. Resolves to {format, coords, completedOnly}
 * or null if cancelled (Esc, backdrop dismissal, or the Cancel button).
 *
 * Shared by the dashboard's "Export images" button (every image in the
 * project, so completedOnly is a real choice) and the per-image editor's
 * "Export" button (a single, already-open image, where completedOnly is
 * meaningless -- pass showCompletedOnly: false to omit that toggle entirely
 * rather than showing a checkbox with no effect).
 */
function askBulkExport({ title = "Export images", showCompletedOnly = true } = {}) {
  const FORMATS = [
    { value: "json", label: "JSON", desc: "Shape geometry and line numbers; project metadata and editable line regions require Backup", coordsFixed: null },
    { value: "xml", label: "XML", desc: "Shape geometry and line numbers in XML; use Backup for full editable state", coordsFixed: null },
    { value: "voc", label: "Pascal VOC", desc: "Standard VOC XML for other tools — polygons degrade to their bounding box", coordsFixed: "Fixed: pixel (absolute), by the VOC spec" },
    { value: "coco", label: "COCO", desc: "One combined manifest for the whole project, not a zip — shapes with no label are left out", coordsFixed: "Fixed: pixel (absolute), by the COCO spec" },
    { value: "yolo", label: "YOLO", desc: "Homogeneous detection or segmentation rows, plus class names — unlabeled shapes require confirmation", coordsFixed: "Fixed: normalized, by the YOLO spec" },
  ];
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "export-coords-dialog bulk-export-dialog";
    dlg.innerHTML = `
      <form method="dialog">
        <h3>${title}</h3>
        <p class="faint">Choose a format and coordinate system.</p>

        <div class="section-title" style="margin-top:10px;">Format</div>
        <div class="coord-choice" id="bx-format">
          ${FORMATS.map((f, i) => `
            <label><input type="radio" name="format" value="${f.value}" ${i === 0 ? "checked" : ""} />
              <span class="format-label"><strong>${f.label}</strong> <span class="faint">${f.desc}</span></span></label>`).join("")}
        </div>

        <div class="section-title" style="margin-top:10px;">Coordinates</div>
        <div class="coord-choice" id="bx-coords">
          <label><input type="radio" name="coords" value="normalized" />
            <span><strong>Normalized</strong><br><span class="faint">0–1, independent of image size</span></span></label>
          <label><input type="radio" name="coords" value="pixel" />
            <span><strong>Absolute</strong><br><span class="faint">actual x / y / width / height</span></span></label>
          <label><input type="radio" name="coords" value="both" checked />
            <span><strong>Both</strong><br><span class="faint">carries either, larger file</span></span></label>
        </div>
        <p class="faint" id="bx-coords-fixed" style="display:none; margin-top:4px; font-size:11.5px;"></p>

        ${showCompletedOnly ? `
        <label id="bx-completed-only-wrap">
          <input type="checkbox" id="bx-completed-only" />
          <span>Completed images only</span>
        </label>` : ""}

        <div class="row" style="justify-content:flex-end; margin-top:10px; gap:8px;">
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="submit" class="btn primary">Download</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);

    const formatChoice = dlg.querySelector("#bx-format");
    const coordsChoice = dlg.querySelector("#bx-coords");
    const coordsFixedNote = dlg.querySelector("#bx-coords-fixed");

    const syncActive = (el) => el.querySelectorAll("label").forEach((l) => l.classList.toggle("active", l.querySelector("input").checked));

    function syncCoordsAvailability() {
      const format = formatChoice.querySelector('input[name="format"]:checked').value;
      const meta = FORMATS.find((f) => f.value === format);
      const disabled = Boolean(meta.coordsFixed);
      coordsChoice.querySelectorAll("input").forEach((inp) => { inp.disabled = disabled; });
      coordsChoice.style.opacity = disabled ? ".45" : "1";
      coordsFixedNote.style.display = disabled ? "block" : "none";
      coordsFixedNote.textContent = meta.coordsFixed || "";
      syncActive(coordsChoice);
    }

    formatChoice.addEventListener("change", () => { syncActive(formatChoice); syncCoordsAvailability(); });
    coordsChoice.addEventListener("change", () => syncActive(coordsChoice));
    syncActive(formatChoice);
    syncCoordsAvailability();

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      dlg.remove();
    };
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => { dlg.close(); finish(null); });
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const completedOnlyEl = dlg.querySelector("#bx-completed-only");
      finish({
        format: formatChoice.querySelector('input[name="format"]:checked').value,
        coords: coordsChoice.querySelector('input[name="coords"]:checked').value,
        completedOnly: completedOnlyEl ? completedOnlyEl.checked : false,
      });
    });
    dlg.addEventListener("cancel", () => finish(null)); // Esc key
    dlg.addEventListener("close", () => finish(null));  // any other dismissal path
    dlg.showModal();
  });
}

// The editor layout must be initialized by the editor itself. Older releases
// defined this helper in canvas.js and assumed the browser had loaded the exact
// matching script. Mixing cached script versions then caused the editor to
// crash with `arrangeWorkspace is not defined` before an image could open.
// Keep this helper local and idempotent; do not depend on another bundle's global.
function arrangeEditorWorkspace() {
  const side = document.querySelector('.workspace .side');
  if (!side) throw new Error('Editor layout is missing its sidebar.');
  let controls = side.querySelector(':scope > .editor-controls');
  if (!controls) {
    controls = document.createElement('div');
    controls.className = 'editor-controls';
    for (const child of [...side.children]) {
      if (!child.querySelector('#labels, #shapes')) controls.appendChild(child);
    }
    side.prepend(controls);
  }
  side.querySelectorAll('input[placeholder]').forEach(input => {
    input.setAttribute('aria-label', input.id.includes('shape') ? 'Filter shapes' : 'Filter labels');
  });
  const shortcuts = document.querySelector('#kbd-trigger');
  if (shortcuts && !shortcuts.dataset.accessibilityWired) {
    shortcuts.dataset.accessibilityWired = 'true';
    shortcuts.title = 'Keyboard shortcuts';
    shortcuts.setAttribute('aria-label', 'Keyboard shortcuts');
    shortcuts.addEventListener('focus', () => shortcuts.dispatchEvent(new Event('mouseenter')));
    shortcuts.addEventListener('blur', () => shortcuts.dispatchEvent(new Event('mouseleave')));
  }
}

// ---------------- per-image editor (admin can edit/complete/reopen any image) ----------------
async function openEditor(imageId) {
  const request = ++editorRequest;
  let data;
  try { data = await api(`/api/admin/image/${imageId}`); }
  catch (err) { alert(err.message); return; }
  if (request !== editorRequest) return;
  disposeGallery();
  disposeEditor();
  const image = data.image;
  if (!image || !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
    showToast('Cannot open image: invalid image dimensions. Please reimport the source image.', {type:'error', duration:6500});
    renderDashboard();
    return;
  }

  const navIdx = editorNav ? editorNav.ids.findIndex((i) => i.id === image.id) : -1;
  const hasPrev = editorNav && (navIdx > 0 || editorNav.meta.offset > 0);
  const hasNext = editorNav && navIdx >= 0 && (navIdx < editorNav.ids.length - 1 || editorNav.meta.offset + editorNav.meta.limit < editorNav.meta.total);
  const navPosition = editorNav && navIdx >= 0 ? `${editorNav.meta.offset + navIdx + 1} of ${editorNav.meta.total}` : "";

  const editorNavEl = $("#editor-nav");
  if (editorNavEl) {
    editorNavEl.style.display = "inline-flex";
    editorNavEl.innerHTML = `
      <button id="back" class="btn sm" type="button" title="Return to this project’s image gallery">&larr; Back to gallery</button>
      ${editorNav ? `
      <button id="prev-image" class="btn sm" type="button" ${hasPrev ? "" : "disabled"}>&larr; Prev</button>
      <button id="next-image" class="btn sm" type="button" ${hasNext ? "" : "disabled"}>Next &rarr;</button>` : ""}
      ${navPosition ? `<span class="faint">${navPosition}</span>` : ""}
    `;
  }

  app.innerHTML = `
    <div class="workspace">
      <aside class="side">
        <div class="tight-stack">
          <button id="save" class="btn" style="width:100%">Save</button>
          <button id="complete" class="btn primary" style="width:100%">Save &amp; Mark Complete</button>
          ${image.status === "COMPLETED" ? `<button id="reopen" class="btn sm" style="width:100%">Reopen</button>` : ""}
          <button type="button" id="export-image-btn" class="btn sm" style="width:100%;">
            <svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M12 3v11m0 0l-4.5-4.5M12 14l4.5-4.5M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Export
          </button>
        </div>
        <div>
          <div class="section-title">Tools</div>
          <div class="tools">
            <button class="btn sm active" data-tool="select">Select<span class="kbd-badge">⇧<span class="kbd-key">+A</span></span></button>
            <button class="btn sm" data-tool="bbox">Box<span class="kbd-badge">⇧<span class="kbd-key">+S</span></span></button>
            <button class="btn sm" data-tool="polygon">Polygon<span class="kbd-badge">⇧<span class="kbd-key">+D</span></span></button>
          </div>
        </div>
        <div class="stack" style="margin-top:0;">
          <label class="row toggle-row" title="Draw a freeform loop over several shapes to give them all the same line number -- fixes line numbers on a skewed page where the automatic top-to-bottom grouping guesses wrong">
            <input type="checkbox" id="line-annotation-tool" />
            <span>Line annotation<span class="kbd-badge">⇧<span class="kbd-key">+Z</span></span></span>
          </label>
          <label class="row toggle-row">
            <input type="checkbox" id="show-line-numbers" />
            <span>Show line &amp; sequence numbers</span>
          </label>
          <label class="row toggle-row">
            <input type="checkbox" id="show-label-input" />
            <span>Show label input box</span>
          </label>
          <button type="button" id="recalc-lines" class="btn sm" style="width:100%;" title="Clear every manual or pre-annotation line number on this page and reapply the tool's own automatic top-to-bottom numbering (any line-annotation regions you've drawn stay in effect). Undoable with Ctrl/Cmd+Z.">
            <svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Recalculate lines
          </button>
        </div>
        <div>
          <div class="row" style="justify-content:space-between;">
            <div class="section-title" style="margin-bottom:0;">Labels</div>
            <input id="editor-label-search" class="input side-search" placeholder="Filter…" />
          </div>
          <div id="labels" class="label-list"></div>
        </div>
        <div>
          <div class="row" style="justify-content:space-between;">
            <div class="section-title" style="margin-bottom:0;">Shapes</div>
            <input id="editor-shape-search" class="input side-search" placeholder="Filter…" />
          </div>
          <div id="shapes" class="shape-list"></div>
        </div>
      </aside>
      <div class="canvas-wrap">
        <div id="holder" class="canvas-holder"></div>
        <div class="image-source-controls" aria-label="Original image controls">
          <span id="image-source-status" role="status">Opening original image…</span>
          <button id="select-original-image" class="btn sm" type="button">Select original image</button>
          <button id="reconnect-original-folder" class="btn sm" type="button">Reconnect folder</button>
          <details class="image-source-diagnostics"><summary>Diagnostics</summary><pre id="image-source-diagnostics"></pre></details>
        </div>
        <button id="kbd-trigger" class="kbd-canvas-btn" type="button">⌨</button>
      </div>
    </div>`;

  // Initialize navigation, diagnostics and recovery handlers before touching the
  // canvas engine. A synchronous startup error used to leave the HTML status
  // unchanged and ALL buttons inert, making a valid image appear inaccessible.
  const holder = $("#holder");
  const sourceStatus = $("#image-source-status");
  const sourceDebug = $("#image-source-diagnostics");
  const sourceInfo = {
    build: "v3.3", image: image.fileName,
    relativePath: image.relativePath || image.fileName,
    expectedDimensions: `${image.width}x${image.height}`,
    phase: "Preparing annotation editor…"
  };
  function setSourceState(phase, extra = {}) {
    sourceInfo.phase = phase;
    Object.assign(sourceInfo, extra);
    if (sourceStatus) sourceStatus.textContent = phase;
    if (sourceDebug) {
      sourceDebug.textContent = JSON.stringify(sourceInfo, null, 2);
      if (/failed|unavailable|timed out/i.test(phase)) sourceDebug.closest('details')?.setAttribute('open', '');
    }
  }
  setSourceState("Preparing annotation editor…");

  let canvas = null;
  function returnToGallery() {
    if (canvas?.isDirty() && !confirm("You have unsaved changes. Return to the image gallery without saving?")) return;
    renderDashboard();
  }
  // 'Back' must never depend on the success of the original file read,
  // annotation canvas construction, or a browser permission prompt.
  $("#back")?.addEventListener("click", returnToGallery);
  $("#prev-image")?.addEventListener("click", () => navigateEditor(image.id, -1, canvas));
  $("#next-image")?.addEventListener("click", () => navigateEditor(image.id, 1, canvas));

  function editorStartupError(error) {
    if (request !== editorRequest) return;
    const message = error?.message || String(error);
    setSourceState("Editor startup failed — inspect Diagnostics", {
      error: message, stack: error?.stack || "Unavailable"
    });
    console.error("LabelFlow editor startup failed", error);
    const existing = holder.querySelector(".image-load-error");
    existing?.remove();
    const layer = document.createElement("div");
    layer.className = "image-load-error";
    layer.setAttribute("role", "alert");
    layer.innerHTML = `<div class="image-load-error-card">
      <h2>Editor could not start</h2>
      <p>${escHtml(message)}</p>
      <p>Your existing annotations have not been changed.</p>
      <div class="image-load-error-actions">
        <button class="btn" type="button" data-action="back">Back to gallery</button>
        <button class="btn" type="button" data-action="retry">Retry editor</button>
      </div>
      <details open class="image-diagnostic-details"><summary>Technical details</summary><pre>${escHtml(error?.stack || message)}</pre></details>
    </div>`;
    holder.appendChild(layer);
    layer.querySelector('[data-action="back"]').addEventListener("click", returnToGallery);
    layer.querySelector('[data-action="retry"]').addEventListener("click", () => openEditor(image.id));
  }

  // Show the native file/folder picker *synchronously* inside each click,
  // without first awaiting IndexedDB or other work; Chrome requires an active
  // user gesture for the picker. These handlers survive editor startup errors.
  $("#select-original-image")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    setSourceState("Selecting original image…");
    try {
      const selected = await LocalBackend.reconnectSingleImage(image.id);
      if (selected) {
        showToast(`Original image linked: ${selected}`);
        await openEditor(image.id);
      } else setSourceState("No file selected");
    } catch (error) {
      if (error?.name !== "AbortError") {
        setSourceState("Original image selection failed — inspect Diagnostics", {error:error?.message||String(error)});
        showToast(error?.message||String(error), {type:"error",duration:8500});
      } else setSourceState("File selection cancelled");
    } finally { if (button.isConnected) button.disabled = false; }
  });
  $("#reconnect-original-folder")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    setSourceState("Selecting dataset folder…");
    try {
      const selected = await LocalBackend.reconnectDatasetForImage(image.id);
      if (selected) {
        showToast(`Dataset connected: ${selected}`);
        await openEditor(image.id);
      } else setSourceState("No folder selected");
    } catch (error) {
      if (error?.name !== "AbortError") {
        setSourceState("Folder reconnection failed — inspect Diagnostics", {error:error?.message||String(error)});
        showToast(error?.message||String(error), {type:"error",duration:8500});
      } else setSourceState("Folder selection cancelled");
    } finally { if (button.isConnected) button.disabled = false; }
  });

  let loadingLayer;
  try {
    arrangeEditorWorkspace();
    if (typeof window.AnnotationCanvas !== "function") throw new Error("Annotation canvas engine was not loaded. Reload the app to update its scripts.");
    canvas = new AnnotationCanvas(holder, {
      getLabels: () => state.project.labels,
      createLabel: async (name) => {
        const res = await api("/api/admin/labels", { method: "POST", body: JSON.stringify({ name }) });
        if (!state.project.labels.some((l) => l.id === res.label.id)) state.project.labels.push(res.label);
        renderLabelChips();
        return res.label;
      },
      onChange: () => {
        refreshMeta(); renderShapesList();
        clearTimeout(autosaveTimer);
        if(activeCanvas?.isDirty()) autosaveTimer=setTimeout(()=>{
          if(activeCanvas===canvas && canvas.isDirty()) doSave(false);
        },1800);
      },
    });
    activeCanvas = canvas;
    loadingLayer = document.createElement("div");
    loadingLayer.className = "image-loading-layer";
    loadingLayer.setAttribute("role", "status");
    loadingLayer.innerHTML = `<span class="image-loading-spinner" aria-hidden="true"></span><strong>Opening image…</strong><span>${escHtml(image.fileName)}</span>`;
    holder.appendChild(loadingLayer);
    setImageMeta(image);
  } catch (error) {
    editorStartupError(error);
    return;
  }
  setSourceState("Opening original image…");
  let imageSourceDetails=null;
  let imageWatchdog=null;
  const clearImageWatchdog=()=>{if(imageWatchdog){clearTimeout(imageWatchdog);imageWatchdog=null;}};
  function imageLoadError(error) {
    if (request !== editorRequest) return;
    clearImageWatchdog();
    setSourceState("Original image unavailable — choose file or reconnect folder", { error: error?.message || String(error) });
    const holder = $("#holder");
    if (!holder) return;
    loadingLayer.remove();
    holder.querySelector(".image-load-error")?.remove();
    const layer = document.createElement("div");
    layer.className = "image-load-error";
    layer.setAttribute("role", "alert");
    layer.innerHTML = `
      <div class="image-load-error-card">
        <div class="image-load-error-icon" aria-hidden="true">!</div>
        <h2>Unable to display this image</h2>
        <p>${escHtml(error?.message || "The image file is unavailable.")}</p>
        <p class="faint">Your annotations are safe in IndexedDB. Cached gallery thumbnails do not guarantee the browser can still open the original file.</p>
        <div class="image-load-error-actions">
          <button type="button" class="btn primary" data-action="select-file">Select original image</button>
          <button type="button" class="btn" data-action="reconnect">Reconnect dataset folder</button>
          <button type="button" class="btn" data-action="retry">Retry image</button>
          <button type="button" class="btn" data-action="back">Back to gallery</button>
        </div>
        <details class="image-diagnostic-details"><summary>Image diagnostics</summary><pre>${escHtml(JSON.stringify({
          build:'v3.3',image:image.fileName,expectedSize:`${image.width}x${image.height}`,
          source:imageSourceDetails ? {bytes:imageSourceDetails.size,type:imageSourceDetails.type} : 'not resolved',
          cause:error?.message||'unknown', browser:navigator.userAgent
        },null,2))}</pre></details>
      </div>`;
    holder.appendChild(layer);
    for (const id of ["save", "complete", "export-image-btn", "reopen"]) {
      const button = document.getElementById(id); if (button) button.disabled = true;
    }
    layer.querySelector('[data-action="back"]').addEventListener("click", returnToGallery);
    layer.querySelector('[data-action="retry"]').addEventListener("click", () => openEditor(image.id));
    layer.querySelector('[data-action="select-file"]').addEventListener("click", async (event) => {
      // Must open the browser picker directly on this click, with no await
      // beforehand, or Chrome/Edge may reject it as lacking user activation.
      const button=event.currentTarget;button.disabled=true;
      try {
        const selected=await LocalBackend.reconnectSingleImage(image.id);
        if(selected){showToast(`Original image linked: ${selected}`);await openEditor(image.id);}
      } catch(err){if(err.name!=='AbortError')imageLoadError(err);}
      finally{button.disabled=false;}
    });
    layer.querySelector('[data-action="reconnect"]').addEventListener("click", async (event) => {
      // Do not await IDB before invoking the picker: it requires a user gesture.
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const folder = await LocalBackend.reconnectDatasetForImage(image.id);
        if (folder) { showToast(`Connected to ${folder}`); await openEditor(image.id); }
      } catch (err) {
        if (err.name !== "AbortError") imageLoadError(err);
      } finally { button.disabled = false; }
    });
  }
  let currentImageURL;
  // This timer must start BEFORE resolving the original FileSystemFileHandle.
  // A browser permission request may remain pending indefinitely after reload.
  imageWatchdog = setTimeout(() => {
    if (request === editorRequest && loadingLayer.isConnected)
      imageLoadError(new Error("Original image access timed out. Select the original image or reconnect its dataset folder."));
  }, 10000);
  try {
    imageSourceDetails = await LocalBackend.imageSource(image.id);
    setSourceState("File found — decoding image…", { source: {bytes: imageSourceDetails.size, type: imageSourceDetails.type, name: imageSourceDetails.name} });
    currentImageURL = imageSourceDetails.url;
    if (request !== editorRequest) { LocalBackend.revokeURL(currentImageURL); return; }
    activeImageObjectURL = currentImageURL;
    canvas.load(currentImageURL, image.width, image.height, image.annotations, image.lineRegions, {
      onImageError: imageLoadError,
      onImageReady: () => {
        clearImageWatchdog();
        setSourceState("Decoded — checking image layout…", { decoded: {width:canvas.img?.naturalWidth,height:canvas.img?.naturalHeight} });
        // A decode can succeed yet be invisible if layout has temporarily
        // collapsed; check the actual pixels' target rectangle once rendered.
        requestAnimationFrame(() => {
          if(request!==editorRequest)return;
          const rect=canvas.img?.getBoundingClientRect();
          if(!rect || rect.width<1 || rect.height<1) imageLoadError(new Error('Image decoded but has no visible layout dimensions. Resize the window, then Retry image.'));
          else {
            setSourceState("Image ready", {visibleRect:{width:Math.round(rect.width),height:Math.round(rect.height)}});
            loadingLayer.remove();
            // The timeout may have displayed recovery controls while a large
            // image was still decoding. A late successful decode is valid.
            const staleError=holder.querySelector('.image-load-error');
            if(staleError){
              staleError.remove();
              for(const id of ['save','complete','export-image-btn','reopen']){
                const button=document.getElementById(id);if(button)button.disabled=false;
              }
            }
          }
        });
      },
    });

  } catch (err) { imageLoadError(err); return; }
  $("#holder .anno-canvas").classList.add("select");
  const lineAnnoChk = $("#line-annotation-tool");
  lineAnnoChk.addEventListener("change", () => selectTool(lineAnnoChk.checked ? "line-lasso" : "select"));
  const showLinesChk = $("#show-line-numbers");
  showLinesChk.checked = canvas.showLineNumbers;
  showLinesChk.addEventListener("change", () => canvas.setShowLineNumbers(showLinesChk.checked));
  const showLabelInputChk = $("#show-label-input");
  showLabelInputChk.checked = canvas.showLabelInput;
  showLabelInputChk.addEventListener("change", () => canvas.setShowLabelInput(showLabelInputChk.checked));

  function renderLabelChips() {
    const el = $("#labels");
    const searchInput = $("#editor-label-search");
    const q = searchInput ? searchInput.value.toLowerCase() : "";
    const filtered = q ? state.project.labels.filter((l) => l.name.toLowerCase().includes(q)) : state.project.labels;
    el.innerHTML = filtered.length ? filtered.map((l) =>
      `<div class="label-item ${canvas.highlightLabelId === l.id ? "active" : ""}">
         <button type="button" class="label-item-main" data-id="${l.id}" title="Click to highlight every shape with this label on the canvas">
           <span class="swatch" style="background:${l.color}"></span><span class="grow">${escHtml(l.name)}</span>
         </button>
         <button type="button" class="label-item-del" data-del="${l.id}" title="Delete this label (unassigns it from every shape, project-wide)">×</button>
       </div>`).join("") : `<p class="faint">${q ? "No labels match." : "No labels yet — draw a shape and name it."}</p>`;
    el.querySelectorAll(".label-item-main").forEach((b) => b.addEventListener("click", () => {
      canvas.setActiveLabel(b.dataset.id);
      canvas.toggleHighlightLabel(b.dataset.id);
      renderLabelChips();
    }));
    el.querySelectorAll(".label-item-del").forEach((b) => b.addEventListener("click", () => deleteLabelFromEditor(b.dataset.del)));
  }

  // Same destructive action as the dashboard's Labels panel (delete label,
  // unassign it from every shape across every image in the project) --
  // offered here too since editing an image is exactly when you're likely
  // to notice a label you want gone. The one thing the dashboard version
  // doesn't need to do: this image's canvas is already loaded in memory, so
  // if any of ITS shapes used the deleted label, sync that locally too
  // (canvas.unassignLabel) instead of leaving a stale label displayed until
  // a reload.
  async function deleteLabelFromEditor(labelId) {
    const label = state.project.labels.find((l) => l.id === labelId);
    if (!confirm(`Delete "${label ? label.name : "this label"}"? Shapes using it become unlabeled, everywhere.`)) return;
    try {
      await api(`/api/admin/labels/${labelId}`, { method: "DELETE" });
      state.project.labels = state.project.labels.filter((l) => l.id !== labelId);
      if (canvas.highlightLabelId === labelId) canvas.highlightLabelId = null;
      canvas.unassignLabel(labelId);
      renderLabelChips();
      renderShapesList();
      showToast("Label deleted");
    } catch (err) { showToast(err.message || "Could not delete label", { type: "error" }); }
  }
  function refreshMeta() {
    const el = $("#shape-count");
    if (el) el.textContent = `${canvas.getAnnotations().length} shapes`;
  }

  function renderShapesList() {
    const el = $("#shapes");
    if (!el) return;
    const searchInput = $("#editor-shape-search");
    const q = searchInput ? searchInput.value.toLowerCase() : "";
    const shapes = canvas.getShapesSummary();
    const filtered = q ? shapes.filter((s) => `L${s.line}-${s.seq} ${(s.labelName || "Unlabeled")}`.toLowerCase().includes(q)) : shapes;
    el.innerHTML = filtered.length ? filtered.map((s) =>
      `<div class="shape-item ${s.id === canvas.selectedId ? "active" : ""}">
         <button type="button" class="shape-item-main" data-id="${s.id}">
           <span class="tag">L${s.line}-${s.seq}</span>
           <span class="swatch" style="background:${s.color}"></span>
           <span class="name">${escHtml(s.labelName || "Unlabeled")}</span>
         </button>
         <button type="button" class="shape-item-del" data-del="${s.id}" title="Delete this shape">×</button>
       </div>`).join("") : `<p class="faint">${q ? "No shapes match." : "No shapes yet — draw a box or polygon."}</p>`;
    el.querySelectorAll(".shape-item-main").forEach((b) => b.addEventListener("click", () => canvas.selectAnnotation(b.dataset.id)));
    el.querySelectorAll(".shape-item-del").forEach((b) => b.addEventListener("click", () => canvas.deleteAnnotation(b.dataset.del)));
  }

  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.addEventListener("click", () => selectTool(b.dataset.tool));
  });
  // Same format + coordinate-system modal as the dashboard's bulk "Export
  // images" button (askBulkExport, defined above) -- just scoped to this
  // one already-open image, so there's no completed-only toggle to show.
  $("#export-image-btn").addEventListener("click", async () => {
    // Export always reads from the server's last-saved copy, never straight
    // off the canvas -- so unsaved edits here would silently export stale
    // numbers. askUnsavedChanges shows exactly what's unsaved (and where) and
    // lets the user save first instead of finding out after the fact.
    if (canvas.isDirty()) {
      const decision = await askUnsavedChanges(canvas);
      if (decision === "cancel") return;
      if (decision === "save") {
        await doSave(false);
        if (canvas.isDirty()) return; // save failed -- doSave already toasted the error
      }
    }
    const choice = await askBulkExport({ title: "Export this image", showCompletedOnly: false });
    if (!choice) return; // cancelled
    const params = new URLSearchParams();
    if (choice.coords && (choice.format === "json" || choice.format === "xml")) params.set("coords", choice.coords);
    const qs = params.toString();
    try { await downloadExport(choice, image.id); } catch (err) { showToast(err.message, {type:"error"}); }
  });
  $("#recalc-lines").addEventListener("click", () => {
    const n = canvas.countManualLineOverrides();
    if (!n) { showToast("Every shape on this page is already automatic — nothing to recalculate."); return; }
    if (!confirm(`Recalculate line & sequence numbers for this page?\n\nThis clears ${n} manual or pre-annotation line number${n === 1 ? "" : "s"} and reapplies the tool's automatic top-to-bottom numbering. Any line-annotation regions you've drawn stay in effect. You can undo this with Ctrl/Cmd+Z.`)) return;
    canvas.resetAllLines();
    showToast("Line numbers recalculated");
  });

  async function doSave(markComplete) {
    return runWorkspaceTask(canvas, () => persistWork(markComplete));
  }
  async function persistWork(markComplete) {
    clearTimeout(autosaveTimer); autosaveTimer=null;
    try {
      await api(`/api/admin/image/${image.id}/save`, {
        method: "POST",
        body: JSON.stringify({ annotations: canvas.getAnnotations(), lineRegions: canvas.getLineRegions(), markComplete, expectedRevision: image.revision }),
      });
      image.revision++;
      canvas.markSaved();
      await refreshState();
      showToast(markComplete ? "Saved & marked complete" : "Saved");
      // Stay on this image instead of bouncing back to the dashboard grid.
      // Re-opening it (rather than leaving the pre-save DOM as-is) refreshes
      // the status badge, claim info, and Reopen button so the sidebar
      // actually reflects "this is now complete" -- same pattern the Reopen
      // button below already uses for the same reason.
      if (markComplete) return openEditor(image.id);
    } catch (err) { showToast(err.message || "Save failed", { type: "error" }); }
  }
  $("#save").addEventListener("click", () => doSave(false));
  $("#complete").addEventListener("click", () => doSave(true));
  const reopenBtn = $("#reopen");
  if (reopenBtn) reopenBtn.addEventListener("click", async () => {
    try { await api(`/api/admin/image/${image.id}/reopen`, { method: "POST" }); await refreshState(); openEditor(image.id); }
    catch (err) { alert(err.message); }
  });

  const editorLabelSearch = $("#editor-label-search");
  if (editorLabelSearch) editorLabelSearch.addEventListener("input", () => renderLabelChips());
  const editorShapeSearch = $("#editor-shape-search");
  if (editorShapeSearch) editorShapeSearch.addEventListener("input", () => renderShapesList());

  wireKbdTrigger();

  setImageMeta(image);
  renderLabelChips();
  renderShapesList();
  refreshMeta();
}

/**
 * Prev/Next within the image list + filters captured when the editor was
 * opened (editorNav). Walks the already-loaded page first; at an edge,
 * lazily fetches the adjacent page from the server (same status/search
 * filter) so navigation crosses page boundaries instead of dead-ending at
 * whatever page size happened to be loaded.
 */
async function navigateEditor(currentImageId, direction, canvas) {
  if (!editorNav) return;
  if (canvas.isDirty() && !confirm("You have unsaved changes. Leave anyway?")) return;

  const idx = editorNav.ids.findIndex((i) => i.id === currentImageId);
  if (idx === -1) return;
  const targetIdx = idx + direction;

  if (targetIdx >= 0 && targetIdx < editorNav.ids.length) {
    return openEditor(editorNav.ids[targetIdx].id);
  }

  // At an edge of the currently loaded page -- fetch the adjacent page
  // (same filters) and jump to its first/last image.
  const { meta } = editorNav;
  const newOffset = direction > 0 ? meta.offset + meta.limit : meta.offset - meta.limit;
  if (newOffset < 0 || newOffset >= meta.total) return; // truly nothing more in that direction

  let data;
  try {
    const params = new URLSearchParams({ offset: newOffset, limit: meta.limit, status: meta.status, q: meta.q });
    data = await api(`/api/admin/images?${params}`);
  } catch (err) { alert(err.message); return; }
  if (!data.images.length) return;

  editorNav = {
    ids: data.images.map((i) => ({ id: i.id, fileName: i.fileName })),
    meta: { offset: newOffset, limit: meta.limit, status: meta.status, q: meta.q, total: data.total },
  };
  const nextImage = direction > 0 ? editorNav.ids[0] : editorNav.ids[editorNav.ids.length - 1];
  return openEditor(nextImage.id);
}

LocalBackend.ensureInit().then(boot).then(()=>{
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.warn);
}).catch(err=>{app.textContent=`Cannot initialize local storage: ${err.message}`;});
