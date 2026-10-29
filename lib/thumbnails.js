"use strict";
// Disk-backed previews. No originals or decoded images are retained in JS caches.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { Worker } = require('node:worker_threads');
sharp.cache(false);
sharp.concurrency(1);
const ROOT = path.join(process.cwd(), 'state', 'thumbnails');
const MAX_BYTES = 256 * 1024 * 1024;
const jobs = new Map();
let active = 0;
const queue = [];
let maintenance = null;
let lastSweep = 0;

async function acquire() {
  if (active < 2) { active++; return; }
  if (queue.length >= 64) throw Object.assign(new Error('Preview queue busy; try again'), { statusCode: 503 });
  await new Promise(resolve => queue.push(resolve));
}
function release() { const next = queue.shift(); if (next) next(); else active--; }
async function sweep() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.webp')) continue;
    const file = path.join(ROOT, entry.name);
    try { const s = await fs.stat(file); files.push({ file, size: s.size, time: s.mtimeMs }); } catch {}
  }
  let bytes = files.reduce((n, f) => n + f.size, 0);
  files.sort((a,b) => a.time - b.time);
  for (const file of files) {
    if (bytes <= MAX_BYTES) break;
    try { await fs.unlink(file.file); bytes -= file.size; } catch {}
  }
}
function bmpPreview(source,output) {
  return new Promise((resolve,reject) => {
    const worker = new Worker(path.join(__dirname,'bmp-preview-worker.js'), { workerData:{source,output} });
    worker.once('message',message => message.error ? reject(new Error(message.error)) : resolve());
    worker.once('error',reject);
    worker.once('exit',code => { if(code) reject(new Error('BMP decoder exited unexpectedly')); });
  });
}
async function thumbnail(source) {
  const stat = await fs.stat(source);
  const key = crypto.createHash('sha256').update(`${source}\0${stat.size}\0${stat.mtimeMs}\0preview-v1`).digest('hex');
  const file = path.join(ROOT, key + '.webp');
  try { await fs.access(file); return file; } catch {}
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    await acquire();
    const tmp = file + '.tmp';
    try {
      await fs.mkdir(ROOT, { recursive:true });
      if (path.extname(source).toLowerCase() === '.bmp') await bmpPreview(source,tmp);
      else await sharp(source, { limitInputPixels: 100000000, sequentialRead:true, pages:1 })
        .rotate().resize(320, 240, { fit:'inside', withoutEnlargement:true })
        .webp({ quality:72 }).toFile(tmp);
      await fs.rename(tmp, file);
      // Periodic pruning is serialized and off the request path. It may
      // temporarily exceed the disk target between sweeps, never a RAM cache.
      if (!maintenance && Date.now() - lastSweep > 60000) {
        lastSweep = Date.now();
        maintenance = sweep().catch(() => {}).finally(() => { maintenance = null; });
      }
      return file;
    } finally { await fs.unlink(tmp).catch(() => {}); release(); }
  })();
  jobs.set(key, job);
  try { return await job; } finally { jobs.delete(key); }
}
module.exports = { thumbnail };
