"use strict";
/** Local-only IndexedDB implementation of the existing admin API contract.
 * No HTTP requests, hosted database, server path access or image uploads.
 * One project's metadata and each image's annotations update transactionally.
 */
const LocalBackend=(()=>{
  const DB_NAME='labelflow-local-v2',VERSION=1;
  const PALETTE=['#4f46e5','#0891b2','#059669','#d97706','#db2777','#7c3aed','#2563eb','#e11d48','#0d9488','#9333ea'];
  let dbPromise,activeId=null,importStatus=null,importToken=0,writerLockPromise=null;
  function writerLock(){
    if(!navigator.locks)return Promise.resolve(true); // revision checks still protect image saves
    if(!writerLockPromise)writerLockPromise=new Promise((resolve)=>{
      navigator.locks.request('labelflow-single-writer',{ifAvailable:true},async lock=>{
        if(!lock){resolve(false);return;}
        resolve(true);
        await new Promise(done=>window.addEventListener('pagehide',done,{once:true}));
      }).catch(()=>resolve(false));
    });
    return writerLockPromise;
  }
  const urls=new Set(),previewPending=new Map(),previewQueue=[],sessionFolders=new Map(),sessionImageFiles=new Map();
  let previewBusy=false, worker=null,workerSequence=0,thumbnailWrites=0;
  const uuid=()=>crypto.randomUUID();
  const req=(r)=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const transactionDone=(t)=>new Promise((resolve,reject)=>{t.oncomplete=()=>resolve();t.onabort=()=>reject(t.error||Error('Transaction aborted'));t.onerror=()=>reject(t.error||Error('Transaction failed'));});
  function openDB(){
    if(!dbPromise) dbPromise=new Promise((resolve,reject)=>{
      const r=indexedDB.open(DB_NAME,VERSION);
      r.onupgradeneeded=()=>{
        const db=r.result;
        db.createObjectStore('projects',{keyPath:'id'});
        const im=db.createObjectStore('images',{keyPath:'id'});
        im.createIndex('project','projectId');
        im.createIndex('project_status',['projectId','status']);
        im.createIndex('project_order',['projectId','order']);
        db.createObjectStore('annotations',{keyPath:'imageId'});
        db.createObjectStore('handles',{keyPath:'key'});
        const th=db.createObjectStore('thumbnails',{keyPath:'imageId'});
        th.createIndex('accessed','accessed');
        db.createObjectStore('settings',{keyPath:'key'});
      };
      r.onsuccess=()=>{const db=r.result;db.onversionchange=()=>{db.close();alert('LabelFlow was updated in another tab. Reload this page.');};resolve(db);};
      r.onerror=()=>reject(r.error);
      r.onblocked=()=>reject(Error('Close other LabelFlow tabs to upgrade the database.'));
    });
    return dbPromise;
  }
  async function get(store,key){const db=await openDB();return req(db.transaction(store,'readonly').objectStore(store).get(key));}
  async function put(store,value){const db=await openDB();const t=db.transaction(store,'readwrite');t.objectStore(store).put(value);await transactionDone(t);}
  async function all(store){const db=await openDB();return req(db.transaction(store).objectStore(store).getAll());}
  async function forProject(id){const db=await openDB();return req(db.transaction('images').objectStore('images').index('project').getAll(id));}
  function summary(i){return {id:i.id,fileName:i.fileName,relativePath:i.relativePath||i.fileName,width:i.width,height:i.height,status:i.status,
    savedAt:i.savedAt||null,annotationCount:i.annotationCount||0,importedFrom:i.importedFrom||null,revision:i.revision||0};}
  const stats=(p)=>({total:p.imageCount||0,unclaimed:(p.imageCount||0)-(p.completedCount||0)-(p.inProgressCount||0),claimed:p.inProgressCount||0,completed:p.completedCount||0});
  async function project(){return activeId?get('projects',activeId):null;}
  function noProject(){if(!activeId) throw Error('Select a project first');}
  async function ensureInit(){if(!(await writerLock()))throw Error('LabelFlow is already open in another tab. Close the other tab before editing.');await openDB();const entry=await get('settings','active');activeId=entry?.value||null;
    if(activeId && !(await get('projects',activeId)))activeId=null;
    try{await navigator.storage.persist();}catch{}
  }
  function validateGeometry(annotations, regions){
    const finite01=(v)=>Number.isFinite(v)&&v>=0&&v<=1;
    const points=(arr)=>Array.isArray(arr)&&arr.length>=3&&arr.length<=100000&&arr.every(p=>p&&finite01(p.x)&&finite01(p.y));
    if(!Array.isArray(annotations)||annotations.length>100000||!Array.isArray(regions)||regions.length>10000) throw Error('Invalid annotation payload');
    const ids=new Set();
    for(const a of annotations){
      if(!a||typeof a.id!=='string'||ids.has(a.id))throw Error('Duplicate or missing annotation ID');ids.add(a.id);
      if(a.type==='bbox'){
        const r=a.rect;
        if(!r||![r.x,r.y,r.w,r.h].every(finite01)||r.w<=0||r.h<=0||r.x+r.w>1.000001||r.y+r.h>1.000001)throw Error('Bounding box is outside the image');
      }else if(a.type==='polygon'){
        if(!points(a.points))throw Error('Invalid polygon coordinates');
      }else throw Error('Unknown shape type');
      if(a.line!=null&&(!Number.isSafeInteger(a.line)||a.line<1))throw Error('Invalid manual line');
    }
    for(const r of regions)if(!r||!points(r.points)||!Number.isSafeInteger(r.line)||r.line<1)throw Error('Invalid line region');
  }
  async function updateImage(imageId,annotations,regions,markComplete=false,reopen=false,expectedRevision=null){
    noProject();
    const db=await openDB(),t=db.transaction(['images','annotations','projects'],'readwrite');
    const done=transactionDone(t),im=t.objectStore('images'),an=t.objectStore('annotations'),ps=t.objectStore('projects');
    try{
      const image=await req(im.get(imageId)),p=await req(ps.get(activeId));
      if(!image||image.projectId!==activeId||!p)throw Error('Image or project changed; reload it');
      if(!reopen && expectedRevision!=null && image.revision!==expectedRevision)throw Error('Image was modified in another tab. Reload before saving to avoid data loss.');
      let oldStatus=image.status;
      if(reopen){image.status='CLAIMED';}
      else {
        validateGeometry(annotations,regions);
        const validLabels=new Set(p.labels.map(l=>l.id));
        if(annotations.some(a=>a.labelId!=null&&!validLabels.has(a.labelId)))throw Error('One or more annotation labels no longer exist. Refresh the image and retry.');
        image.annotationCount=annotations.length;
        image.savedAt=new Date().toISOString();
        image.status=markComplete?'COMPLETED':(image.status==='COMPLETED'?'COMPLETED':'CLAIMED');
        an.put({imageId,projectId:activeId,annotations:structuredClone(annotations),lineRegions:structuredClone(regions),revision:(image.revision||0)+1});
      }
      if(oldStatus!==image.status){
        if(oldStatus==='COMPLETED')p.completedCount--;
        if(oldStatus==='CLAIMED')p.inProgressCount--;
        if(image.status==='COMPLETED')p.completedCount++;
        if(image.status==='CLAIMED')p.inProgressCount++;
      }
      image.revision=(image.revision||0)+1;
      p.updatedAt=new Date().toISOString();
      im.put(image);ps.put(p);
      await done;
      return {image:summary(image)};
    }catch(e){try{t.abort();}catch{}await done.catch(()=>{});throw e;}
  }
  async function handle(role){noProject();return sessionFolders.get(`${activeId}:${role}`)||(await get('handles',`${activeId}:${role}`))?.handle||null;}
  async function setHandle(role,h){noProject();await put('handles',{key:`${activeId}:${role}`,projectId:activeId,role,handle:h});}
  async function clearFolder(role){noProject();sessionFolders.delete(`${activeId}:${role}`);const db=await openDB();const t=db.transaction('handles','readwrite');t.objectStore('handles').delete(`${activeId}:${role}`);await transactionDone(t);}
  async function permission(h,mode='read'){
    if(!h)throw Error('Dataset folder is disconnected. Reconnect the original image folder to continue.');
    if(h.__virtual){if(mode!=='read')throw Error('This browser cannot write directly into selected folders. Download a project backup instead.');return;}
    // This is intentionally passive. requestPermission() MUST NOT run during
    // image auto-open: its browser prompt requires a user gesture and can hang
    // or reject after reload, leaving a permanently pending editor. The
    // Reconnect buttons invoke native pickers directly from the user's click.
    try {
      if((await h.queryPermission({mode}))==='granted')return;
    } catch(error) {
      throw Error(`Cannot check original folder access. Click Reconnect folder to select it again. (${error.message || error})`);
    }
    throw Error('Original folder permission has expired. Click Reconnect folder and choose the dataset folder again.');
  }
  async function selectFolder(role){
    if(window.showDirectoryPicker){
      const h=await showDirectoryPicker({id:`labelflow-${role}`,mode:'read'});
      await setHandle(role,h);sessionFolders.delete(`${activeId}:${role}`);
      const p=await project();p[role==='dataset'?'datasetPath':'annotationsPath']=h.name;
      if(role==='dataset')p.datasetBasePrefix='';
      await put('projects',p);
      return h.name;
    }
    // Firefox/Safari fallback: files are referenced for this session only.
    // Their File objects cannot persist as reusable directory permissions.
    const files=await new Promise((resolve,reject)=>{
      const input=document.createElement('input');input.type='file';input.multiple=true;input.webkitdirectory=true;
      input.onchange=()=>resolve([...input.files]);input.oncancel=()=>resolve([]);input.click();
    });
    if(!files.length)return null;
    const top=files[0].webkitRelativePath.split('/')[0]||'Selected dataset';
    function directory(name){
      const children=new Map();
      return {__virtual:true,kind:'directory',name,children,
        async *entries(){yield* children.entries();},
        async getDirectoryHandle(part){const h=children.get(part);if(h?.kind!=='directory')throw Error('Folder missing: '+part);return h;},
        async getFileHandle(part){const h=children.get(part);if(h?.kind!=='file')throw Error('File missing: '+part);return h;}};
    }
    const root=directory(top);
    for(const file of files){
      const parts=file.webkitRelativePath.split('/').slice(1);let cursor=root;
      for(const part of parts.slice(0,-1)){
        if(!cursor.children.has(part))cursor.children.set(part,directory(part));
        cursor=cursor.children.get(part);
      }
      cursor.children.set(file.name,{kind:'file',name:file.name,getFile:async()=>file});
    }
    sessionFolders.set(`${activeId}:${role}`,root);
    return `${top} (reselect after restart)`;
  }
  // Imported images retain their original dataset-relative paths for exports.
  // A reconnected parent directory may contain that original dataset in a
  // child folder (e.g. saved "81186.jpg", selected parent has "images/81186.jpg").
  // Keep the new filesystem prefix on the PROJECT rather than modifying image
  // records or normalized annotation coordinates.
  function validatedPath(path) {
    const parts=String(path||'').split('/');
    if(!parts.length || parts.some(p=>!p||p==='.'||p==='..'||p.includes('\\')))
      throw Error(`Invalid stored image path: ${path}`);
    return parts;
  }
  async function fileFromRoot(root,image,prefix=''){
    const relativePath=image.relativePath||image.fileName;
    const parts=validatedPath(relativePath);
    const prefixParts=prefix ? validatedPath(prefix) : [];
    const fullPath=[...prefixParts,...parts].join('/');
    let dir=root;
    try {
      for(const part of [...prefixParts,...parts.slice(0,-1)])dir=await dir.getDirectoryHandle(part);
      return await (await dir.getFileHandle(parts.at(-1))).getFile();
    } catch(error) {
      throw Error(`Cannot find "${relativePath}" inside selected dataset folder "${root?.name||'unknown'}" (looked for "${fullPath}"). The original may be in a subfolder, or the selected dataset root has changed. Reconnect folder or select the exact original image. (${error.message||error})`);
    }
  }
  // Search ONLY on a deliberate "Reconnect folder" click, never on image
  // navigation, and never replace a saved handle until the candidate is
  // validated. Bounded traversal and cooperative yields keep the UI responsive.
  async function findUniqueImagePath(root,image){
    const MAX_FILES=20000,MAX_DEPTH=32;
    let visited=0, matches=[];
    const target=image.fileName.toLowerCase();
    async function scan(dir,path='',depth=0){
      if(depth>MAX_DEPTH)throw Error('Dataset nesting is too deep; choose the image directory directly.');
      for await(const [name,h] of dir.entries()){
        if(matches.length>1)return;
        visited++;
        if(visited>MAX_FILES)throw Error(`Folder search exceeded ${MAX_FILES} entries. Select the folder containing ${image.fileName} directly.`);
        if(visited%128===0)await new Promise(resolve=>setTimeout(resolve,0));
        const candidate=path?`${path}/${name}`:name;
        if(h.kind==='directory'){
          if(!name.startsWith('.')&&name!=='.labelflow')await scan(h,candidate,depth+1);
        }else if(h.kind==='file'&&name.toLowerCase()===target){
          try {
            const file=await h.getFile();
            const [width,height]=await dimensions(file);
            if(width===image.width&&height===image.height)matches.push({path:candidate,handle:h});
          }catch(err){console.warn('Could not inspect candidate image',candidate,err);}
        }
      }
    }
    await scan(root);
    if(matches.length>1)throw Error(`Multiple files named "${image.fileName}" have the expected ${image.width}×${image.height} dimensions in the selected folder. Choose the exact original image or a narrower dataset folder; the project was not changed.`);
    if(!matches.length)throw Error(`Could not find "${image.fileName}" (${image.width}×${image.height}) in the selected directory or its subfolders. Choose the folder containing the originals, or use Select original image. The project was not changed.`);
    const stored=image.relativePath||image.fileName;
    const found=matches[0],discovered=found.path;
    // A renamed or moved parent folder is valid if the file is unambiguous
    // and the source dimensions match. An exact file handle is stored for the
    // image; no annotation geometry, image ID or exported path is rewritten.
    const prefix=discovered===stored ? '' : discovered.endsWith('/'+stored)
      ? discovered.slice(0,-stored.length-1) : null;
    return {prefix,path:discovered,handle:found.handle};
  }
  async function fileFor(image){
    // A specific file chosen with the editor's recovery picker is authoritative
    // for that image. This avoids losing work when the original directory
    // handle is revoked, moved, or no longer points at a renamed folder.
    const key=`${activeId}:image-file:${image.id}`;
    const session=sessionImageFiles.get(key);
    if(session)return session;
    const stored=(await get('handles',key))?.handle;
    let storedError=null;
    if(stored){
      try {await permission(stored);return await stored.getFile();}
      catch(err){storedError=err;console.warn('Previously linked image needs reconnection',image.fileName,err);}
    }
    try {
      const root=await handle('dataset');await permission(root);
      const p=await project();
      return await fileFromRoot(root,image,p?.datasetBasePrefix||'');
    } catch(error) {
      if(storedError)throw Error(`Stored image handle failed (${storedError.message||storedError}); dataset folder fallback also failed (${error.message||error}). Use Select original image or Reconnect folder.`);
      throw error;
    }
  }
  // The file picker is started BEFORE the first await: browsers require a
  // user gesture to grant a direct file handle. No image bytes are copied
  // into IndexedDB; only a FileSystemFileHandle is persisted when available.
  async function reconnectSingleImage(id){
    noProject();
    let h=null,selected=null;
    if(typeof window.showOpenFilePicker==='function'){
      const chosen=await window.showOpenFilePicker({id:'labelflow-original-image',multiple:false,
        types:[{description:'Image files',accept:{'image/*':['.png','.jpg','.jpeg','.bmp','.gif','.webp']}}]});
      if(!chosen.length)return null;
      h=chosen[0];selected=await h.getFile();
    }else{
      selected=await new Promise(resolve=>{
        const input=document.createElement('input');input.type='file';
        input.accept='.png,.jpg,.jpeg,.bmp,.gif,.webp';
        input.onchange=()=>resolve(input.files?.[0]||null);
        input.oncancel=()=>resolve(null);
        input.click();
      });
      if(!selected)return null;
    }
    const image=await get('images',id);
    if(!image||image.projectId!==activeId)throw Error('Image or project changed. Return to the gallery and retry.');
    if(selected.name.toLowerCase()!==image.fileName.toLowerCase())
      throw Error(`Incorrect image file: expected "${image.fileName}", selected "${selected.name}". No change was made.`);
    const [w,hgt]=await dimensions(selected);
    if(w!==image.width||hgt!==image.height)
      throw Error(`Image dimensions differ: selected ${w}×${hgt}, annotations expect ${image.width}×${image.height}. No change was made.`);
    const key=`${activeId}:image-file:${id}`;
    // Always retain the user-selected File for this tab, so opening succeeds
    // immediately even if the browser refuses to persist the handle or its
    // permission is not granted after the picker closes.
    sessionImageFiles.set(key,selected);
    if(h) {
      try {await put('handles',{key,projectId:activeId,role:'single-image',handle:h});}
      catch(error){console.warn('Could not persist file handle; image remains available for this session',error);}
    }
    return selected.name;
  }
  // Must be invoked synchronously by a real button click: showDirectoryPicker()
  // requires transient user activation. Validate the candidate BEFORE replacing
  // the persisted handle; selecting the wrong folder must not corrupt the project.
  async function reconnectDatasetForImage(id){
    noProject();
    if(window.showDirectoryPicker){
      // Native picker MUST be invoked before the first await (user activation).
      const candidate=await window.showDirectoryPicker({id:'labelflow-dataset',mode:'read'});
      const image=await get('images',id);
      if(!image||image.projectId!==activeId)throw Error('Image or project changed.');
      await permission(candidate);
      let prefix='',individualHandle=null;
      try {
        const direct=await fileFromRoot(candidate,image);
        const [w,h]=await dimensions(direct);
        if(w!==image.width||h!==image.height)
          throw Error(`The image at "${image.relativePath||image.fileName}" has dimensions ${w}×${h}, but annotations expect ${image.width}×${image.height}. Select the correct originals folder; no change was made.`);
        const parts=validatedPath(image.relativePath||image.fileName);
        let parent=candidate;
        for(const part of parts.slice(0,-1))parent=await parent.getDirectoryHandle(part);
        individualHandle=await parent.getFileHandle(parts.at(-1));
      }catch(error){
        if(!/Cannot find/.test(error.message||''))throw error;
        const found=await findUniqueImagePath(candidate,image);
        // Even if image subdirectories were reorganized, keep a verified
        // per-image handle and leave project export paths unchanged.
        prefix=found.prefix||'';
        individualHandle=found.handle;
      }
      // Image handle and folder state are persisted atomically. The current
      // image can now open even if sibling images live in different subfolders.
      const db=await openDB(),t=db.transaction(['projects','handles'],'readwrite');
      const done=transactionDone(t);
      try {
        const p=await req(t.objectStore('projects').get(activeId));
        if(!p)throw Error('Project changed during reconnect');
        p.datasetPath=candidate.name;
        p.datasetBasePrefix=prefix;
        t.objectStore('projects').put(p);
        t.objectStore('handles').put({key:`${activeId}:dataset`,projectId:activeId,role:'dataset',handle:candidate});
        t.objectStore('handles').put({key:`${activeId}:image-file:${image.id}`,projectId:activeId,role:'single-image',handle:individualHandle});
        await done;
      }catch(error){try{t.abort();}catch{}await done.catch(()=>{});throw error;}
      sessionFolders.delete(`${activeId}:dataset`);
      return prefix ? `${candidate.name}/${prefix}` : candidate.name;
    }
    // File-input fallback works for the current session only.
    const previous=sessionFolders.get(`${activeId}:dataset`);
    const name=await selectFolder('dataset');
    if(!name)return null;
    const image=await get('images',id);
    try {await fileFor(image);}
    catch(error){
      if(previous)sessionFolders.set(`${activeId}:dataset`,previous);
      else sessionFolders.delete(`${activeId}:dataset`);
      throw error;
    }
    return name;
  }
  // Repair existing projects without reimporting or modifying annotations.
  // Explicit directory selection is required. Match by exact relative path
  // first, otherwise by unique filename AND original image dimensions.
  async function relinkProjectFolder(){
    noProject();
    if(typeof window.showDirectoryPicker!=='function')
      throw Error('Bulk image relinking requires Chrome or Edge desktop directory access. Use Select original image in the editor.');
    // Invoke native picker before any await to retain user activation.
    const candidate=await window.showDirectoryPicker({id:'labelflow-dataset',mode:'read'});
    await permission(candidate);
    const projectId=activeId, images=await forProject(projectId);
    if(!images.length)throw Error('This project has no indexed images. Import the dataset first.');
    const byName=new Map(), candidateMatches=new Map();
    for(const im of images){
      const name=im.fileName.toLowerCase(), group=byName.get(name)||[];
      group.push(im);byName.set(name,group);
    }
    let scanned=0;
    for await(const entry of walk(candidate)){
      if(activeId!==projectId)throw Error('Project changed during relinking. No links were saved.');
      if(++scanned%100===0)await new Promise(resolve=>setTimeout(resolve,0));
      if(scanned>100000)throw Error('The selected folder contains over 100,000 files. Choose a narrower dataset directory.');
      const targets=byName.get(entry.name.toLowerCase());if(!targets)continue;
      const file=await entry.handle.getFile();
      let width,height;
      try{[width,height]=await dimensions(file);}catch{continue;}
      for(const im of targets){
        if(im.width!==width||im.height!==height)continue;
        const options=candidateMatches.get(im.id)||[];
        options.push(entry);candidateMatches.set(im.id,options);
      }
    }
    const matched=[];let ambiguous=0,missing=0;
    for(const im of images){
      const options=candidateMatches.get(im.id)||[];
      if(!options.length){missing++;continue;}
      // Prefer the original exact project-relative path when available.
      const exact=options.filter(e=>e.path===im.relativePath);
      const sameNameAndSize=(byName.get(im.fileName.toLowerCase())||[])
        .filter(candidate=>candidate.width===im.width&&candidate.height===im.height);
      // Do not silently assign one physical file to multiple annotation
      // records which share a basename and dimensions.
      const chosen=exact.length===1?exact[0]:
        (options.length===1&&sameNameAndSize.length===1?options[0]:null);
      if(!chosen){ambiguous++;continue;}
      matched.push({image:im,handle:chosen.handle});
    }
    if(!matched.length)throw Error(`No matching originals found in "${candidate.name}". Expected files include "${images[0].relativePath}" (${images[0].width}×${images[0].height}). Existing project data was not changed.`);
    // Existing image paths, geometry and annotation rows are never modified.
    // Project and all verified handles are committed in one transaction.
    const db=await openDB(),t=db.transaction(['projects','handles'],'readwrite'),done=transactionDone(t);
    try{
      const p=await req(t.objectStore('projects').get(projectId));
      if(!p)throw Error('Project was deleted while relinking.');
      p.datasetPath=candidate.name;p.datasetBasePrefix='';
      t.objectStore('projects').put(p);
      t.objectStore('handles').put({key:`${projectId}:dataset`,projectId,role:'dataset',handle:candidate});
      for(const {image,handle} of matched)t.objectStore('handles').put({key:`${projectId}:image-file:${image.id}`,projectId,role:'single-image',handle});
      await done;
    }catch(err){try{t.abort();}catch{}await done.catch(()=>{});throw err;}
    sessionFolders.delete(`${projectId}:dataset`);
    return {folder:candidate.name,matched:matched.length,missing,ambiguous,total:images.length};
  }
  async function imageFile(id){const image=await get('images',id);if(!image||image.projectId!==activeId)throw Error('Image not found');return fileFor(image);}
  function trackURL(blob){const u=URL.createObjectURL(blob);urls.add(u);return u;}
  function revokeURL(url){if(urls.delete(url))URL.revokeObjectURL(url);}
  async function imageSource(id){
    const file=await imageFile(id);
    return {url:trackURL(file),name:file.name,size:file.size,type:file.type||'unknown',lastModified:file.lastModified||null};
  }
  async function imageURL(id){return (await imageSource(id)).url;}
  async function makeThumb(file,width,height){
    if(typeof Worker==='undefined')return null;
    if(!worker){worker=new Worker('/image-worker.js');worker.onmessage=({data})=>{
      const pending=previewPending.get(data.id);if(!pending)return;
      previewPending.delete(data.id);pending(data.blob||null);previewBusy=false;consumePreview();
    };worker.onerror=()=>{for(const r of previewPending.values())r(null);for(const item of previewQueue)item.resolve(null);previewQueue.length=0;previewPending.clear();previewBusy=false;worker.terminate();worker=null;};}
    return new Promise(resolve=>{previewQueue.push({file,width,height,resolve});consumePreview();});
  }
  function consumePreview(){if(previewBusy||!previewQueue.length||!worker)return;
    const item=previewQueue.shift();previewBusy=true;const id=++workerSequence;
    previewPending.set(id,item.resolve);worker.postMessage({id,file:item.file,width:item.width,height:item.height});
  }
  async function thumbnailURL(id){
    let cached=await get('thumbnails',id);
    if(cached?.blob)return trackURL(cached.blob);
    const image=await get('images',id);if(!image||image.projectId!==activeId)throw Error('Image not found');
    const blob=await makeThumb(await fileFor(image),image.width,image.height);
    if(!blob)throw Error('Preview unavailable in this browser');
    // cache max ~150 small thumbnails, independent of full-size dataset storage
    const db=await openDB(),t=db.transaction('thumbnails','readwrite');
    t.objectStore('thumbnails').put({imageId:id,blob,accessed:Date.now()});
    try{await transactionDone(t);}catch(err){console.warn('Thumbnail cache quota exceeded',err);}
    if (++thumbnailWrites % 25 === 0) pruneThumbnails().catch(err => console.warn('Thumbnail pruning failed',err));
    return trackURL(blob);
  }
  async function pruneThumbnails(){const db=await openDB(),t=db.transaction('thumbnails','readwrite');
    const store=t.objectStore('thumbnails');const count=await req(store.count());
    if(count>150){let toRemove=count-120;await new Promise((resolve,reject)=>{const c=store.index('accessed').openCursor();c.onsuccess=()=>{
      const cursor=c.result;if(!cursor||toRemove--<=0)return resolve();cursor.delete();cursor.continue();};c.onerror=()=>reject(c.error);});}
    await transactionDone(t);
  }
  async function* walk(dir,prefix=''){
    for await(const [name,h] of dir.entries()){
      if(name.startsWith('.')||name==='.labelflow')continue;
      const path=prefix?`${prefix}/${name}`:name;
      if(h.kind==='directory')yield* walk(h,path);
      else yield {name,path,handle:h};
    }
  }
  async function dimensions(file){
    // Cheap header-only dimensions: avoid decoding a 50+ megapixel image just to index it.
    const b=new DataView(await file.slice(0,262144).arrayBuffer());
    const n=b.byteLength;const ext=file.name.split('.').pop().toLowerCase();
    if(ext==='png'&&n>=24&&b.getUint32(0)===0x89504e47)return [b.getUint32(16),b.getUint32(20)];
    if(ext==='gif'&&n>=10)return [b.getUint16(6,true),b.getUint16(8,true)];
    if(ext==='bmp'&&n>=26)return [Math.abs(b.getInt32(18,true)),Math.abs(b.getInt32(22,true))];
    if(['jpg','jpeg'].includes(ext)&&n>=4){
      let p=2;while(p+9<n){if(b.getUint8(p)!==255){p++;continue;}const marker=b.getUint8(p+1);
        if(marker===0xd8||marker===0xd9||marker===0x01){p+=2;continue;}
        if(marker===0xda)break;const len=b.getUint16(p+2);
        if(len<2||p+2+len>n)break;
        if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb].includes(marker))return [b.getUint16(p+7),b.getUint16(p+5)];
        p+=len+2;
      }
    }
    if(ext==='webp'&&n>=30){
      const type=String.fromCharCode(...new Uint8Array(b.buffer.slice(12,16)));
      if(type==='VP8X')return [1+b.getUint8(24)+(b.getUint8(25)<<8)+(b.getUint8(26)<<16),1+b.getUint8(27)+(b.getUint8(28)<<8)+(b.getUint8(29)<<16)];
      if(type==='VP8L')return [1+(b.getUint8(21)|((b.getUint8(22)&63)<<8)),1+((b.getUint8(22)>>6)|(b.getUint8(23)<<2)|((b.getUint8(24)&15)<<10))];
      if(type==='VP8 '&&n>=30)return [b.getUint16(26,true)&0x3fff,b.getUint16(28,true)&0x3fff];
    }
    // Unrecognized header: decode only when necessary, return dimensions.
    const bitmap=await createImageBitmap(file);try{return [bitmap.width,bitmap.height];}finally{bitmap.close();}
  }
  let parseWorker=null,parseWorkId=0;
  async function parseLargeCoco(text){
    if(typeof Worker==='undefined'||text.length<1000000)
      return LabelFlowImport.parseCocoManifest(JSON.parse(text));
    if(!parseWorker)parseWorker=new Worker('/import-worker.js');
    return new Promise((resolve,reject)=>{
      const id=++parseWorkId;
      function response({data}){
        if(data.id!==id)return;
        parseWorker.removeEventListener('message',response);
        parseWorker.removeEventListener('error',failed);
        if(data.error)reject(Error(data.error));else resolve(new Map(data.parsed));
      }
      function failed(e){parseWorker.removeEventListener('message',response);parseWorker.removeEventListener('error',failed);reject(Error(e.message||'Import worker failed'));}
      parseWorker.addEventListener('message',response);parseWorker.addEventListener('error',failed);
      parseWorker.postMessage({id,text});
    });
  }
  async function annotationIndex(root){
    if(!root)return {byName:new Map(),byPath:new Map(),coco:new Map(),classes:[]};
    await permission(root);
    const byName=new Map(),byPath=new Map(),coco=new Map(),files=[];let classes=[];
    for await(const entry of walk(root)){
      const ext=entry.name.split('.').pop().toLowerCase();if(['json','xml','txt','names','yaml'].includes(ext))files.push(entry);
    }
    for(const entry of files){
      if(!/^(classes\.txt|obj\.names)$/i.test(entry.name))continue;
      classes=(await (await entry.handle.getFile()).text()).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    }
    for(const entry of files){
      const ext=entry.name.split('.').pop().toLowerCase();
      if(ext==='yaml' && !classes.length){const txt=await (await entry.handle.getFile()).text();
        const inline=txt.match(/names:\s*\[([^\]]+)\]/);
        if(inline)classes=inline[1].split(',').map(x=>x.trim().replace(/^['"]|['"]$/g,''));
        else classes=[...txt.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map(m=>m[1].trim());
      }
      if(!['json','xml','txt'].includes(ext)||/^(classes\.txt|obj\.txt)$/i.test(entry.name))continue;
      const base=entry.name.replace(/\.[^.]+$/,'').toLowerCase();
      const rel=entry.path.replace(/\.[^.]+$/,'').toLowerCase();
      try{
        const text=await (await entry.handle.getFile()).text();
        if(ext==='json'){
          // Large COCO JSON is parsed exclusively in a worker when supported.
          // Smaller manifests remain cheap enough to parse inline.
          let parsed=null;
          if(text.length>1000000 && typeof Worker!=='undefined'){
            try{parsed=await parseLargeCoco(text);}catch{}
          }
          if(!parsed){
            const doc=JSON.parse(text);
            if(LabelFlowImport.isCocoManifest(doc))parsed=LabelFlowImport.parseCocoManifest(doc);
          }
          if(parsed){
            for(const [key,drafts] of parsed){
              const k=key.toLowerCase();coco.set(k,[...(coco.get(k)||[]),...drafts]);
            }
            continue;
          }
        }
        const priority={json:0,xml:1,txt:2};
        const record={ext,text};
        if(!byPath.has(rel)||priority[ext]<priority[byPath.get(rel).ext])byPath.set(rel,record);
        if(!byName.has(base))byName.set(base,record);
        else if(byName.get(base)!==null){
          // Do not overwrite ambiguous same-stem annotations from different directories.
          if(rel!==base || (byPath.get(base)&&byPath.get(base)!==record))byName.set(base,null);
          else if(priority[ext]<priority[byName.get(base).ext])byName.set(base,record);
        }
      }catch(e){console.warn('Skipped annotations',entry.path,e);}
    }
    return {byName,byPath,coco,classes};
  }
  function parseAnnotations(index,fileName,width,height){
    const path=fileName.replace(/\.[^.]+$/,'').toLowerCase();
    const base=fileName.split('/').pop().replace(/\.[^.]+$/,'').toLowerCase(),entry=index.byPath.get(path)||index.byName.get(base);
    try{
      if(entry){
        if(entry.ext==='json')return LabelFlowImport.parseJsonDoc(JSON.parse(entry.text),width,height);
        if(entry.ext==='xml')return LabelFlowImport.parseVocXml(entry.text,width,height);
        return LabelFlowImport.parseYoloTxt(entry.text,index.classes);
      }
      return index.coco.get(path)||index.coco.get(base)||[];
    }catch(err){console.warn('Could not parse annotations for',fileName,err);return [];}
  }
  function normalizeDrafts(drafts,p){
    const out=[];
    for(const d of drafts){
      const labelName=String(d.labelName||'').trim();let labelId=null;
      if(labelName){let label=p.labels.find(l=>l.name.toLowerCase()===labelName.toLowerCase());
        if(!label){label={id:uuid(),name:labelName,color:PALETTE[p.labels.length%PALETTE.length]};p.labels.push(label);}
        labelId=label.id;
      }
      const shape={id:uuid(),type:d.type,labelId,line:d.line??null};
      if(d.type==='bbox')shape.rect=d.rect;else shape.points=d.points;
      try{validateGeometry([shape],[]);out.push(shape);}catch{}
    }
    return out;
  }
  async function importDataset(){
    noProject();const projectId=activeId,token=++importToken,root=await handle('dataset');await permission(root);
    const annRoot=await handle('annotations');
    const id=uuid();importStatus={importId:id,scanned:0,total:0,added:0,backfilled:0,importedLabels:0,skippedTotal:0,skipped:[],formatCounts:{},done:false};
    (async()=>{
      try{
        const index=await annotationIndex(annRoot);
        const existing=await forProject(projectId),known=new Map(existing.map(x=>[x.relativePath,x]));
        const p=await get('projects',projectId);const db=await openDB();let order=existing.reduce((max,x)=>Math.max(max,x.order||0),0)+1;
        const batch=[];
        const flush=async()=>{
          if(token!==importToken||activeId!==projectId)throw Error('Import stopped after project switch');
          if(!batch.length)return;
          const t=db.transaction(['projects','images','annotations','handles'],'readwrite'),done=transactionDone(t);
          const ps=t.objectStore('projects'),im=t.objectStore('images'),an=t.objectStore('annotations');
          const current=await req(ps.get(projectId));
          if(!current)throw Error('Project was deleted during import');
          // If a label was created while importing, preserve it and remap
          // imported shapes to its ID rather than writing dangling label IDs.
          const remap=new Map();
          for(const label of p.labels){
            const match=current.labels.find(x=>x.name.toLowerCase()===label.name.toLowerCase());
            if(match)remap.set(label.id,match.id);
            else {current.labels.push(label);remap.set(label.id,label.id);}
          }
          let addedNow=0;
          for(const {image,anns,old,fileHandle} of batch){
            if(old){
              // A human may have saved shapes while this background import
              // was parsing. Never replace their newer annotation revision.
              const latest=await req(im.get(image.id));
              if(!latest||latest.annotationCount>0||latest.revision!==image.revision){
                importStatus.backfilled=Math.max(0,importStatus.backfilled-1);
                continue;
              }
            }
            im.put(image);
            // Persist a filesystem handle for each imported image. This is
            // metadata, NOT a copy of its pixels. It removes dependence on
            // reconstructing paths through one mutable dataset root.
            // Virtual fallback handles cannot be cloned into IndexedDB.
            if(!root.__virtual && fileHandle?.kind==='file'){
              try{t.objectStore('handles').put({key:`${projectId}:image-file:${image.id}`,projectId,role:'single-image',handle:fileHandle});}
              catch(err){console.warn('Could not persist an imported file handle',image.fileName,err);}
            }
            if(anns.length)an.put({imageId:image.id,projectId,annotations:anns.map(a=>({...a,labelId:remap.get(a.labelId)||a.labelId})),lineRegions:[],revision:0});
            if(!old)addedNow++;
          }
          current.imageCount+=addedNow;
          p.labels=current.labels;
          current.updatedAt=new Date().toISOString();ps.put(current);await done;batch.length=0;
        };
        for await(const entry of walk(root)){
          if(token!==importToken||activeId!==projectId)throw Error('Import interrupted by project switch');
          if(!/\.(png|jpg|jpeg|bmp|gif|webp)$/i.test(entry.name))continue;
          importStatus.scanned++;importStatus.total=importStatus.scanned;
          const old=known.get(entry.path);
          if(old&&old.annotationCount){
            // An existing annotation must never be overwritten by reimport.
            // Refresh only the original file handle when the saved path matches.
            if(!root.__virtual){
              try{await put('handles',{key:`${projectId}:image-file:${old.id}`,projectId,role:'single-image',handle:entry.handle});}
              catch(err){console.warn('Cannot refresh imported file handle',entry.path,err);}
            }
            continue;
          }
          try{
            const file=await entry.handle.getFile();
            const [width,height]=old?[old.width,old.height]:await dimensions(file);
            if(!width||!height||width>100000||height>100000)throw Error('Invalid image dimensions');
            let drafts=parseAnnotations(index,entry.path,width,height);
            // Default labels/ subdirectory next to dataset is used when explicit annotation folder absent.
            if(!annRoot&&!drafts.length){const parent=entry.path.includes('/')?entry.path.slice(0,entry.path.lastIndexOf('/')):'';
              for(const annPath of [parent?`${parent}/labels`: 'labels','labels']){
                try{let h=root;for(const part of annPath.split('/'))h=await h.getDirectoryHandle(part);
                  for(const ext of ['json','xml']){
                    try{const f=await (await h.getFileHandle(entry.name.replace(/\.[^.]+$/ ,'.'+ext))).getFile();
                      drafts=ext==='json'?LabelFlowImport.parseJsonDoc(JSON.parse(await f.text()),width,height):LabelFlowImport.parseVocXml(await f.text(),width,height);break;
                    }catch{}
                  }
                  if(drafts.length)break;
                }catch{}
              }
            }
            const anns=normalizeDrafts(drafts,p);
            if(old){if(anns.length){old.annotationCount=anns.length;batch.push({image:old,anns,old:true,fileHandle:entry.handle});importStatus.backfilled++;}}
            else{const image={id:uuid(),projectId,relativePath:entry.path,fileName:entry.name,width,height,status:'UNCLAIMED',annotationCount:anns.length,
              order:order++,savedAt:null,revision:0,importedFrom:anns.length?'preannotation':null};
              batch.push({image,anns,old:false,fileHandle:entry.handle});known.set(entry.path,image);importStatus.added++;
            }
            importStatus.importedLabels+=anns.length;
          }catch(err){importStatus.skippedTotal++;if(importStatus.skipped.length<10)importStatus.skipped.push({name:entry.name,reason:String(err.message||err)});}
          if(batch.length>=20)await flush();
          if(importStatus.scanned%20===0)await new Promise(r=>setTimeout(r,0));
        }
        await flush();importStatus.done=true;
      }catch(e){importStatus.error=e.message;importStatus.done=true;}
    })();
    return {importId:id,...importStatus};
  }
  async function serializeInWorker(project,records,format,coords){
    if(typeof Worker==='undefined')return format==='coco'
      ?new Blob([JSON.stringify(LabelFlowExport.buildCocoManifest(project,records),null,2)],{type:'application/json'})
      :LabelFlowExport.buildExportZip(project,records,format,false,coords);
    const w=new Worker('/export-worker.js');
    return new Promise((resolve,reject)=>{
      w.onmessage=({data})=>{w.terminate();if(data.error)reject(Error(data.error));else resolve(data.blob);};
      w.onerror=(e)=>{w.terminate();reject(Error(e.message||'Export worker failed'));};
      w.postMessage({id:1,project,records,format,coords});
    });
  }
  // Export and backup must snapshot images, labels, and annotations in one
  // readonly transaction. Otherwise an import/save during hundreds of
  // sequential IndexedDB gets can produce an internally inconsistent export.
  async function projectSnapshot(imageId=null,completedOnly=false){
    noProject();
    const db=await openDB(),tx=db.transaction(['projects','images','annotations'],'readonly'),done=transactionDone(tx);
    const ps=tx.objectStore('projects'),im=tx.objectStore('images'),an=tx.objectStore('annotations');
    try{
      const [p,allImages]=await Promise.all([
        req(ps.get(activeId)),
        imageId?req(im.get(imageId)).then(item=>item?[item]:[]):req(im.index('project').getAll(activeId)),
      ]);
      if(!p)throw Error('The active project no longer exists');
      if(imageId && !allImages.length)throw Error('Requested image no longer exists');
      const images=allImages.filter(i=>i.projectId===activeId&&(!completedOnly||i.status==='COMPLETED'));
      const docs=await Promise.all(images.map(i=>req(an.get(i.id))));
      await done;
      return {p,images,docs};
    }catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
  }
  async function exportData(format,coords,completedOnly,imageId){
    if(!['json','xml','voc','coco','yolo'].includes(format))throw Error('Unsupported export format');
    if(!['normalized','pixel','both'].includes(coords))throw Error('Invalid coordinate option');
    const {p,images:ims,docs}=await projectSnapshot(imageId,completedOnly);
    if(format==='yolo'&&(!p.labels.length||p.labels.some(l=>/[\r\n]/.test(l.name))))
      throw Error('YOLO needs at least one class, and class names cannot contain line breaks.');
    const records=[];
    for(let i=0;i<ims.length;i++){
      const im=ims[i],doc=docs[i];
      if(im.annotationCount && (!doc || doc.annotations?.length !== im.annotationCount))
        throw Error(`Annotation data is inconsistent for ${im.relativePath || im.fileName}. Export stopped to prevent data loss. Restore a backup or repair this project.`);
      const annotations=doc?.annotations||[],lineRegions=doc?.lineRegions||[];
      validateGeometry(annotations,lineRegions);
      if(!Number.isSafeInteger(im.width)||!Number.isSafeInteger(im.height)||im.width<=0||im.height<=0)
        throw Error(`Invalid image dimensions for ${im.fileName}. Export stopped.`);
      if(typeof im.relativePath!=='string'||im.relativePath.startsWith('/')||im.relativePath.includes('\\')||im.relativePath.split('/').some(part=>!part||part==='..'||part==='.') )
        throw Error(`Invalid image path for ${im.fileName}. Export stopped.`);
      records.push({...im,annotations,lineRegions});
    }
    const safe=(p.name||'project').replace(/[^a-zA-Z0-9_-]/g,'_');
    let blob,name;
    if(format==='coco'){
      blob=await serializeInWorker(p,records,format,coords);
      name=`${safe}-coco.json`;
    }else if(imageId&&format!=='yolo'){
      const f=LabelFlowExport.fileFor(p,records[0],format,coords);blob=new Blob([f.data],{type:'text/plain'});name=f.name;
    }else{
      // Archive contains text annotations, not the potentially enormous source images.
      blob=await serializeInWorker(p,records,format,coords);
      name=`${safe}-${format}.zip`;
    }
    const labelIds=new Set(p.labels.map(l=>l.id));
    const unlabeled=records.reduce((sum,im)=>sum+im.annotations.filter(a=>!labelIds.has(a.labelId)).length,0);
    const polygons=records.reduce((sum,im)=>sum+im.annotations.filter(a=>a.type==='polygon').length,0);
    const boxes=records.reduce((sum,im)=>sum+im.annotations.filter(a=>a.type==='bbox').length,0);
    const regions=records.reduce((sum,im)=>sum+im.lineRegions.length,0);
    const warnings=[];
    if ((format==='coco'||format==='yolo')&&unlabeled)warnings.push(`${unlabeled} unlabeled shapes cannot be represented in ${format.toUpperCase()} and would be omitted. Label them first, or export JSON/XML/Backup.`);
    if (format==='voc'&&polygons)warnings.push(`${polygons} polygons become bounding rectangles in Pascal VOC.`);
    if (format==='yolo'&&polygons&&boxes)warnings.push(`${boxes} bounding boxes are converted to four-point polygons for a consistent YOLO segmentation dataset.`);
    if(regions)warnings.push(`${regions} editable reading-order regions are not preserved by this annotation format. Use Project Backup to preserve them.`);
    return {blob,name,warnings,imageCount:records.length,annotationCount:records.reduce((sum,im)=>sum+im.annotations.length,0)};
  }
  async function backup(){
    const {p,images,docs}=await projectSnapshot();
    const annotations=[];
    for(let i=0;i<images.length;i++){
      const doc=docs[i];
      if(images[i].annotationCount && (!doc || doc.annotations?.length!==images[i].annotationCount))
        throw Error(`Cannot back up ${images[i].fileName}: annotation record is missing or inconsistent.`);
      if(doc)annotations.push(doc);
    }
    return {format:'labelflow-project-backup',version:1,createdAt:new Date().toISOString(),project:p,images,annotations};
  }
  async function restore(content){
    if(!content||content.format!=='labelflow-project-backup'||content.version!==1||!content.project||!Array.isArray(content.images)||!Array.isArray(content.annotations))throw Error('Unsupported or invalid LabelFlow backup');
    const p=structuredClone(content.project);
    if(!Array.isArray(p.labels)||typeof p.name!=='string'||p.name.length>200||content.images.length>100000)throw Error('Invalid project backup metadata');
    for(const l of p.labels){
      if(!l||typeof l.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(l.id)||typeof l.name!=='string'||l.name.length>200)throw Error('Invalid label in backup');
      if(!/^#[0-9a-f]{6}$/i.test(l.color||''))l.color='#4f46e5';
    }
    p.id=uuid();p.name=`${p.name} (restored)`;
    p.imageCount=0;p.completedCount=0;p.inProgressCount=0;
    const oldProjectId=content.project.id, ids=new Map(), newImages=[], newDocs=[];
    for(const im of content.images){if(im.projectId!==oldProjectId||typeof im.relativePath!=='string'||im.relativePath.startsWith('/')||im.relativePath.split('/').some(part=>!part||part==='..'||part==='.')||im.relativePath.includes('\\'))throw Error('Invalid image path in backup');
      const item={...im,id:uuid(),projectId:p.id};ids.set(im.id,item.id);
      p.imageCount++;if(item.status==='COMPLETED')p.completedCount++;if(item.status==='CLAIMED')p.inProgressCount++;
      newImages.push(item);
    }
    for(const doc of content.annotations){if(!ids.has(doc.imageId))continue;
      validateGeometry(doc.annotations||[],doc.lineRegions||[]);
      if((doc.annotations||[]).some(a=>!/^[a-zA-Z0-9_-]{1,100}$/.test(a.id))||(doc.lineRegions||[]).some(r=>!/^[a-zA-Z0-9_-]{1,100}$/.test(r.id)))throw Error('Invalid annotation identifiers');
      newDocs.push({...doc,projectId:p.id,imageId:ids.get(doc.imageId)});
    }
    const db=await openDB(),t=db.transaction(['projects','images','annotations'],'readwrite');const done=transactionDone(t);
    t.objectStore('projects').put(p);
    for(const im of newImages)t.objectStore('images').put(im);
    for(const doc of newDocs)t.objectStore('annotations').put(doc);
    await done;
    return p;
  }
  function download(blob,name){const url=trackURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>revokeURL(url),30000);}
  async function saveBackupToFolder(){const h=await handle('dataset');await permission(h,'readwrite');
    const dir=await h.getDirectoryHandle('.labelflow',{create:true});
    const data=JSON.stringify(await backup());const file=await dir.getFileHandle('backup.json',{create:true});
    const w=await file.createWritable();try{await w.write(data);await w.close();}catch(e){await w.abort();throw e;}
    return data.length;
  }
  async function api(path,opts={}){
    const url=new URL(path,location.origin),segments=url.pathname.split('/').filter(Boolean),method=opts.method||'GET';
    const body=opts.body?JSON.parse(opts.body):{};
    const p=await project();
    if(url.pathname==='/api/admin/state')return {project:p,stats:p?stats(p):null,users:[]};
    if(url.pathname==='/api/admin/projects'){
      const projects=await all('projects');return {projects:projects.map(p=>({id:p.id,name:p.name,imageCount:p.imageCount||0,completedCount:p.completedCount||0,labelCount:p.labels.length}))};
    }
    if(url.pathname==='/api/admin/project'&&method==='POST'){
      const name=String(body.name||'').trim();if(!name)throw Error('Project name required');
      const labels=[...new Set((body.labels||[]).map(x=>String(x).trim()).filter(Boolean))].map((name,i)=>({id:uuid(),name,color:PALETTE[i%PALETTE.length]}));
      const record={id:uuid(),name,labels,imageCount:0,completedCount:0,inProgressCount:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      await put('projects',record);activeId=record.id;await put('settings',{key:'active',value:activeId});return {project:record};
    }
    if(segments[2]==='projects'&&segments[4]==='activate'){
      const target=await get('projects',segments[3]);if(!target)throw Error('Project not found');
      importToken++;activeId=target.id;await put('settings',{key:'active',value:activeId});return {project:target,stats:stats(target)};
    }
    if(url.pathname==='/api/admin/unload'){
      importToken++;activeId=null;await put('settings',{key:'active',value:null});return {ok:true};
    }
    if(segments[2]==='projects'&&method==='DELETE'){
      const id=segments[3],db=await openDB(),images=await forProject(id);
      const t=db.transaction(['projects','images','annotations','handles','thumbnails','settings'],'readwrite');const done=transactionDone(t);
      t.objectStore('projects').delete(id);
      for(const im of images){t.objectStore('images').delete(im.id);t.objectStore('annotations').delete(im.id);t.objectStore('thumbnails').delete(im.id);t.objectStore('handles').delete(`${id}:image-file:${im.id}`);}
      t.objectStore('handles').delete(`${id}:dataset`);t.objectStore('handles').delete(`${id}:annotations`);
      if(activeId===id){t.objectStore('settings').put({key:'active',value:null});activeId=null;importToken++;}
      await done;return {ok:true};
    }
    noProject();
    if(url.pathname==='/api/admin/pick-folder'){
      try{return {path:await selectFolder(body.role||'dataset')};}catch(e){if(e.name==='AbortError')return {cancelled:true};throw e;}
    }
    if(url.pathname==='/api/admin/dataset'&&method==='POST'){
      const record=await get('projects',activeId);record.datasetPath=(await handle('dataset'))?.name||'';
      record.annotationsPath=(await handle('annotations'))?.name||'';
      await put('projects',record);return importDataset();
    }
    if(url.pathname==='/api/admin/import-status')return importStatus?.importId===url.searchParams.get('id')?{...importStatus}:{done:true,error:'Import no longer available'};
    if(url.pathname==='/api/admin/labels'&&method==='POST'){
      const name=String(body.name||'').trim();if(!name)throw Error('Label name required');
      let label=p.labels.find(l=>l.name.toLowerCase()===name.toLowerCase());
      if(!label){label={id:uuid(),name,color:PALETTE[p.labels.length%PALETTE.length]};p.labels.push(label);await put('projects',p);}
      return {label};
    }
    if(segments[2]==='labels'&&method==='DELETE'){
      p.labels=p.labels.filter(l=>l.id!==segments[3]);
      const db=await openDB(),images=await forProject(activeId),t=db.transaction(['projects','annotations'],'readwrite'),done=transactionDone(t);
      t.objectStore('projects').put(p);
      const an=t.objectStore('annotations');
      for(const im of images){const doc=await req(an.get(im.id));if(doc?.annotations.some(x=>x.labelId===segments[3])){
        doc.annotations=doc.annotations.map(x=>x.labelId===segments[3]?{...x,labelId:null}:x);an.put(doc);
      }}
      await done;return {ok:true};
    }
    if(url.pathname==='/api/admin/images'){
      const list=await forProject(activeId),status=url.searchParams.get('status')||'ALL',q=(url.searchParams.get('q')||'').toLowerCase();
      const filtered=list.filter(im=>(status==='ALL'||im.status===status)&&(!q||im.fileName.toLowerCase().includes(q)));
      filtered.sort((a,b)=>a.order-b.order);
      const offset=Math.max(0,+url.searchParams.get('offset')||0),limit=Math.min(200,Math.max(1,+url.searchParams.get('limit')||50));
      return {total:filtered.length,images:filtered.slice(offset,offset+limit).map(summary),stats:stats(p)};
    }
    if(segments[2]==='image'){
      const id=segments[3],im=await get('images',id);if(!im||im.projectId!==activeId)throw Error('Image not found');
      if(method==='GET'){const doc=await get('annotations',id);return {image:{...summary(im),annotations:doc?.annotations||[],lineRegions:doc?.lineRegions||[],revision:im.revision||0}};}
      if(segments[4]==='reopen')return updateImage(id,[],[],false,true);
      if(segments[4]==='save')return updateImage(id,body.annotations,body.lineRegions||[],body.markComplete,false,body.expectedRevision);
    }
    throw Error(`Unsupported local operation: ${method} ${url.pathname}`);
  }
  return {ensureInit,api,download,imageURL,imageSource,thumbnailURL,revokeURL,reconnectDatasetForImage,reconnectSingleImage,relinkProjectFolder,pruneThumbnails,exportData,backup,restore,saveBackupToFolder,clearFolder};
})();
