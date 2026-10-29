# LabelFlow 1.1 — implementation and performance audit

## Outcome

The app remains a locally hosted Node application with separate admin and LAN
listeners, manual saving, and the original annotation/export workflows. The UI
now separates browsing, project management, annotation tools, and inspection into
clear regions. Normal desktop dashboard use does not require document scrolling;
long galleries, settings, label lists, and shape lists scroll inside their panels.
Narrow/mobile screens deliberately allow document scrolling to keep controls usable.

## Feature and logic map

| Area | Existing behavior retained | Main implementation |
|---|---|---|
| Projects | Create, list, resume, switch/unload, permanent tracking-data deletion; source folders stay untouched | `server.js`, `lib/store.js`, `public/admin.js` |
| Users | Name-based identity, browser token, resume claimed image, one active claim per user, completion releases claim | `public/app.js`, `lib/store.js` |
| Dataset ingestion | Local folder selection or typed paths, incremental scanning, import progress, optional annotation folder, filename matching | `lib/dialog.js`, `lib/importer.js`, `lib/imagesize.js` |
| Import formats | Own JSON/XML, VOC, LabelMe, COCO, YOLO/class mappings, detector/OCR boxes | `lib/importer.js` |
| Annotation | Boxes, polygons, select/move/resize, labels/autocomplete/history, undo/redo, keyboard tools, zoom/pan | `public/canvas.js` |
| Reading order | Automatic vertical line grouping and left-to-right sequence, manual overrides, region-based lines, recalculate | `lib/lines.js`, `public/canvas.js` |
| Review | Status/search filters, bounded pages, previous/next across page boundaries, shapes/labels filters and highlighting, reopen | `public/admin.js` |
| Save/export | Manual sync, completion, unsaved-change export prompt, single/bulk export, completed-only selection, format-specific coordinates | `server.js`, `lib/exporter.js`, `lib/zip.js` |
| Storage | Atomic replacement, rotating backups, legacy project loading, active-project bookkeeping | `lib/store.js` |
| Access boundary | Admin loopback listener; admin paths unavailable on the LAN listener | `server.js` |

## Confirmed issues and changes

| Finding in original source | Change | Expected effect / tradeoff |
|---|---|---|
| Gallery used `/file` for thumbnails; lazy loading still decoded original images | Dedicated WebP thumbnail endpoint; 320×240 fit, viewport observer detaches offscreen sources, 36-card pagination | Small previews rather than multi-megapixel gallery decodes; initial previews need processing |
| Admin replaced editor DOM without destroying old canvas; labeler exits also lacked complete disposal | Destroy on every editor transition; remove key listener, observer, image source/callbacks, queued frames, canvas backing buffer, geometry/history references | Removes application-held references to previous images/editors; GC timing remains browser-controlled |
| Original images synchronously read in full into server Buffers | Stream files with backpressure, destroy stream on disconnect, originals sent with `no-store` | Avoids whole-file response buffering; returning to an image can require another transfer |
| Canvas assigned width/height on every draw | Reallocate only on size changes, schedule rendering once per animation frame | Avoids repeated backing-store allocation during pointer movement |
| Line numbering recomputed during pan/hover even without geometry changes | Cache against annotation and region collection identity; cache label lookup; coalesce sidebar notifications | Less redundant work; genuinely large geometry changes still require computation |
| Undo count bound alone allowed large snapshots to accumulate | Keep original 100-entry ceiling plus estimated byte-based trimming | Large pages may have fewer undo steps; at least one snapshot is retained |
| Saving one image rewrote all image records up to three times | Validate both arrays first, write one atomic per-image override for save/regions/completion; replay on load | Lower save cost; full `state/` directory must be retained for recovery |
| Image lookup scanned the whole array | ID-indexed Map, rebuilt on project activation/unload | Constant-time lookup for original/preview/save routes |
| Bulk exports assembled an entire ZIP or COCO string | Async generators stream entries/JSON and yield between images | Reduced transient output memory and event-loop blocking; ZIP32 limits remain |
| Import polling rebuilt the whole dashboard every two seconds | Update import/status panels only; do not replace an active editor | Preserves in-progress annotation workspace and avoids repeated thumbnail loading |
| Async list/editor responses could arrive out of order | Abort superseded gallery requests and ignore obsolete editor responses | Rapid search/navigation cannot display an older response |
| Import could continue across project changes | Cancel imports on project transitions; check captured project identity before mutation | Prevents old import data from being appended to a different project |
| README promised empty-image backfill, but scanner skipped all known paths | Re-import only backfills records with zero shapes, preserves existing nonempty shapes | Restores the documented workflow; re-import may inspect more existing files |
| Some import errors bypassed skipped-list cap or were hidden by response mapping | Bound skipped reporting, return error/cancel/backfill fields | Honest import feedback without growing poll payloads indefinitely |
| Dataset/user text was interpolated directly into several UI templates | Escape common filename, project, label, and user text | Names containing HTML characters display correctly; this is not a full security review |

## Visual design

- Navy application header, teal primary actions, neutral surfaces. Existing label
  colors remain distinct because they communicate annotation categories.
- Dashboard: title/actions, horizontal status summary, image gallery, project
  inspector. Export is directly accessible in the heading.
- Editor: actions/tools on the left, image in the center, labels and shapes on the
  right. Tool and inspection lists have independent scrolling.
- Format guidance moves into expandable help. Existing operations and all five
  export formats remain accessible. Keyboard focus styling and input labels were added.
- Full-size image loading and failures have visible canvas messages.

## Memory and data lifetime

1. Opening the dashboard loads a page of image summaries, not annotation arrays
   or original image bytes. Up to 36 cards exist; only visible/nearby previews have
   image sources. The observer removes the source when a preview moves away.
2. Preview generation is disk-backed, deduplicated by source path/size/mtime,
   limited to two active jobs and 64 queued jobs. Native operation caching is
   disabled. BMP decoding runs in a worker so its synchronous decoder cannot
   stall the HTTP event loop.
3. Opening an editor loads that image's annotation record and original image.
   There is no original-image prefetch. The current image stays available while
   the user continues editing after Save, which preserves the existing workflow.
4. Navigating away or completing a labeler task explicitly disposes of the old
   canvas/image. Admin completion intentionally remains on the same image, as
   before; its rebuilt editor first destroys the previous one.
5. The server still retains the active project's metadata and annotations. It
   does not retain every original image or decoded thumbnail. Unloading the
   project drops its image array/index; other caches such as OS page cache and
   browser/native allocator caches are outside the application's direct control.

For scale intuition: a 4000×3000 RGBA decode represents about 45.8 MiB, whereas a
320×240 RGBA preview represents at most 0.293 MiB. These are pixel-buffer sizes,
not total-process RAM measurements or a claimed measured improvement ratio.

## Validation performed

- `npm test`: six automated tests passed. Four compare streamed ZIP contents to
  the original exporter for JSON/XML/VOC/YOLO. Another compares streamed COCO
  structure/IDs/geometry/categories/skipped counts.
- Integration fixture: 10,000 synthetic image records referencing one generated
  2400×3200 PNG, plus a real small folder import. This tests record-count scale,
  not 10,000 independently sized production images. Page listing returned 36
  summaries in approximately 6–10 ms locally; no production latency claim follows.
- Integration checks: PNG/JPEG/WebP/GIF/BMP previews, exact original-byte streaming,
  no-store header, save without full-index rewrite, invalid-region rejection
  without partial annotation update, restart replay, subsequent import checkpoint,
  safe re-import/backfill, and LAN rejection of admin routes.
- Browser exercise: 84 generated document images; gallery searching/paging,
  box drawing and label creation, saving, previous/next, back to dashboard,
  labeler completion. No browser page errors were observed.
- At 1440×900, 1366×768, and 1024×768: document height equaled viewport height on
  the dashboard, and there was no horizontal overflow. At 390×844: responsive
  document scrolling was allowed, with no horizontal overflow.
- Gallery made zero `/file` requests. At 1440×900 the test saw 36 cards and 20
  attached preview sources (including the small prefetch margin).
- Across repeated editor transitions, the previous instance had `img === null`,
  a zero-sized canvas buffer, and `_destroyed === true`; one live canvas remained.
  This establishes resource disposal, not a measured browser-process RSS ceiling.
- Tested runtime: Node 24.22.1, Chromium 134, Linux. Native Windows/macOS folder
  pickers were reviewed in source but were not interactively exercised here.

## Remaining limits and failure cases

- **No universal zero-lag guarantee.** Hardware, disk speed, network latency,
  original resolution, geometry per image, and concurrent clients matter.
- **Metadata residency:** all active-project annotation objects remain in RAM.
  Import checkpoints, project activation, backups, and global label deletion
  still have synchronous JSON/filesystem work. These can pause very large projects.
- **Extremely large originals:** opening one still needs a browser decode at full
  resolution. Use image pyramids/tiles for gigapixel or unusually large scans;
  thumbnail optimization alone cannot solve a single giant editor image.
- **Preview exceptions:** corrupt/unsupported or oversized inputs show a preview
  placeholder; opening the original is still possible. Animated previews use
  one frame. BMP preview limits are deliberately lower because its decoder needs
  a full pixel buffer. A source edit may remain cached in the browser for up to
  five minutes; server thumbnail keys include file size/mtime.
- **Native memory:** the preview queue and application caches are bounded, but
  native decoders and OS allocators can retain memory. Two jobs are a concurrency
  limit, not a hard process-RAM quota. Periodic disk pruning can temporarily exceed
  256 MiB between sweeps.
- **Export limits:** streaming ZIP is ZIP32, not ZIP64 (65,535 entries / 4 GiB
  offsets). Too many entries are rejected before download. An unexpectedly large
  output exceeding byte limits interrupts the download instead of producing a
  valid archive; split the dataset or use COCO. Multiple simultaneous exports can
  multiply work, and one image with enormous geometry can still be expensive.
- **Concurrency:** existing last-writer-wins admin/labeler save semantics remain.
  This update does not add version-conflict resolution, accounts, TLS, or internet
  deployment security. Keep the existing local/trusted-LAN model.
- **Coordinate conventions:** existing import/export and line-order math is
  preserved. EXIF orientation and external annotation coordinate conventions
  should be normalized consistently in the dataset preparation pipeline.
- **Undo:** byte budgeting estimates serialized size; actual JS object overhead
  and the newest snapshot may exceed it. Large pages trade history depth for RAM.

## Alternatives and when to choose them

| Approach | Choose it when | Benefit | Cost |
|---|---|---|---|
| Current incremental JSON store | Thousands of ordinary images, modest annotations, local/team use | Simple installation and compatibility with existing projects | Resident metadata and synchronous maintenance paths |
| SQLite with indexed image/status rows and per-image annotation loading | Hundreds of thousands of images, very dense annotations, frequent writes | Transactional saves, bounded annotation loading, indexed filtering | Database migration and recovery tooling; substantial storage-layer change |
| Tiled image pyramids / region decoding | A single image is too large to decode comfortably | Bounds editor image memory while supporting deep zoom | Tile generation/storage and a new coordinate-aware renderer |
| Offline preview preprocessing | Dataset is mostly static and first-open latency matters | Predictable fast gallery browsing, no live generation cost | Preparation step and stale-preview invalidation |
| PostgreSQL + object storage + background workers | Many remote users or multiple server instances | Shared transactional state, independent compute/storage scaling | Deployment, authentication, monitoring, and operational complexity |

The current implementation deliberately preserves the existing deployment and
file formats. A database migration or tiled renderer should be driven by a
representative dataset and measured peak RAM/frame time on the intended machine.
