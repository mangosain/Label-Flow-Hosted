'use strict';
// Deterministic IndexedDB protocol stub for local storage contract tests.
// Does not replace a real Chrome/Edge browser integration test.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
function fakeIndexedDB(){
 const stores=new Map(),indices=new Map();
 const clone=(v)=>v?.handle ? {...v,handle:v.handle} : structuredClone(v); // directory handles are structured-cloneable browser objects

 const db={
   onversionchange:null,
   close(){},
   createObjectStore(name){stores.set(name,new Map());indices.set(name,[]);return {createIndex:(label,field)=>indices.get(name).push({label,field})};},
   transaction(names){
     const tx={pending:0,ended:false,oncomplete:null,onerror:null,onabort:null,error:null,
       abort(){tx.error=Error('Aborted');tx.onabort?.();},
       objectStore(name){
         if(!stores.has(name))throw Error('Missing store '+name);
         const data=stores.get(name);
         const request=(fn)=>{
           const r={result:null,error:null,onsuccess:null,onerror:null};tx.pending++;
           setTimeout(()=>{
             try{r.result=fn();r.onsuccess?.();}
             catch(err){r.error=err;r.onerror?.();}
             tx.pending--;
             setTimeout(()=>{if(tx.pending===0&&!tx.ended){tx.ended=true;tx.oncomplete?.();}},0);
           },0);
           return r;
         };
         const getAll=(predicate)=>request(()=>[...data.values()].filter(predicate).map(v=>clone(v)));
         return {
           get:key=>request(()=>clone(data.get(key))),
           put:val=>request(()=>{data.set(val.id??val.imageId??val.key,clone(val));return val.id??val.key;}),
           delete:key=>request(()=>data.delete(key)),
           getAll:()=>getAll(()=>true),
           index:label=>{
             const idx=indices.get(name).find(x=>x.label===label);
             if(!idx)throw Error('Missing index '+label);
             return {getAll:key=>getAll(v=>Array.isArray(idx.field)?idx.field.every((f,i)=>v[f]===key[i]):v[idx.field]===key)};
           }
         };
       }
     };return tx;
   }
 };
 return {stores,db,indexedDB:{open(){const r={result:db,onupgradeneeded:null,onsuccess:null,onerror:null};setTimeout(()=>{r.onupgradeneeded?.();r.onsuccess?.();},0);return r;}}};
}
async function loadBackend(windowOverride={}){
 const f=fakeIndexedDB();
 const context=vm.createContext({
   indexedDB:f.indexedDB,crypto:webcrypto,structuredClone,Blob,URL,
   navigator:{storage:{persist:async()=>true}},window:{addEventListener(){},...windowOverride},
   console,setTimeout,clearTimeout,TextEncoder,DataView,Uint8Array,Uint32Array,
   location:{origin:'https://labelflow.example'},
   showDirectoryPicker: windowOverride.showDirectoryPicker,
 });
 context.globalThis=context;
 vm.runInContext(readFileSync(path.join(__dirname,'../public/local-backend.js'),'utf8'),context,{filename:'local-backend.js'});
 return {backend:vm.runInContext('LocalBackend',context),stores:f.stores};
}
test('IndexedDB saves persist project/shape/region/status with revision conflict protection',async()=>{
 const {backend,stores}=await loadBackend();
 await backend.ensureInit();
 assert.equal((await backend.api('/api/admin/state')).project,null);
 const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Invoices',labels:['word']})});
 const project=created.project;
 assert.equal((await backend.api('/api/admin/projects')).projects.length,1);
 const img={id:'im1',fileName:'page.png',relativePath:'page.png',projectId:project.id,width:1000,height:800,status:'UNCLAIMED',annotationCount:0,revision:0,order:1};
 stores.get('images').set(img.id,structuredClone(img));
 const p=stores.get('projects').get(project.id);p.imageCount=1;stores.get('projects').set(project.id,p);
 const annotation={id:'shape1',type:'bbox',labelId:project.labels[0].id,rect:{x:.1,y:.2,w:.3,h:.2},line:3};
 const region={id:'region1',line:8,points:[{x:.1,y:.2},{x:.7,y:.2},{x:.7,y:.8}]};
 const save=await backend.api('/api/admin/image/im1/save',{method:'POST',body:JSON.stringify({annotations:[annotation],lineRegions:[region],markComplete:true,expectedRevision:0})});
 assert.equal(save.image.status,'COMPLETED');assert.equal(save.image.revision,1);
 assert.equal((await backend.api('/api/admin/state')).stats.completed,1);
 const loaded=(await backend.api('/api/admin/image/im1')).image;
 assert.equal(loaded.annotations.length,1);assert.equal(loaded.lineRegions[0].line,8);
 await assert.rejects(()=>backend.api('/api/admin/image/im1/save',{method:'POST',body:JSON.stringify({annotations:[],lineRegions:[],expectedRevision:0})}),/modified in another tab/);
 assert.equal((await backend.api('/api/admin/image/im1')).image.annotations.length,1);
 const backup=await backend.backup();assert.equal(backup.annotations[0].annotations[0].line,3);
 const restored=await backend.restore(backup);
 assert.notEqual(restored.id,project.id);
 assert.equal(restored.imageCount,1);
 assert.equal(restored.completedCount,1);
 assert.equal((await backend.api('/api/admin/projects')).projects.length,2);
 const reopen=await backend.api('/api/admin/image/im1/reopen',{method:'POST'});
 assert.equal(reopen.image.status,'CLAIMED');
 assert.equal((await backend.api('/api/admin/state')).stats.completed,0);
 assert.equal((await backend.api('/api/admin/state')).stats.claimed,1);
});
test('Invalid geometry rejected without replacing persisted annotation',async()=>{
 const {backend,stores}=await loadBackend();await backend.ensureInit();
 const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Test'})});
 stores.get('images').set('im',{id:'im',projectId:created.project.id,fileName:'f.png',relativePath:'f.png',width:100,height:100,status:'UNCLAIMED',annotationCount:0,revision:0});
 await assert.rejects(()=>backend.api('/api/admin/image/im/save',{method:'POST',body:JSON.stringify({annotations:[{id:'a',type:'polygon',points:[{x:0,y:0},{x:1,y:0},{x:Infinity,y:1}]}],lineRegions:[],expectedRevision:0})}),/Invalid polygon/);
 assert.equal((await backend.api('/api/admin/image/im')).image.annotationCount,0);
});

test('missing image shows a reconnection path; incorrect folder does not replace saved handle',async()=>{
  let pickerCalls=0;
  const wrongFolder={name:'Wrong dataset',kind:'directory',queryPermission:async()=> 'granted',getFileHandle:async()=>{throw Error('NotFoundError');},async *entries(){}};
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>{pickerCalls++;return Promise.resolve(wrongFolder);}});
  await backend.ensureInit();
  const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Images'})});
  stores.get('images').set('im1',{id:'im1',projectId:created.project.id,fileName:'page.jpg',relativePath:'page.jpg',width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0,order:1});
  await assert.rejects(()=>backend.imageURL('im1'),/disconnected/);
  const reconnect=backend.reconnectDatasetForImage('im1');
  assert.equal(pickerCalls,1,'directory picker must be opened before awaiting database reads');
  await assert.rejects(()=>reconnect,/Could not find "page.jpg"/);
  assert.equal(stores.get('handles').size,0,'invalid folder cannot overwrite saved dataset handle');
});

test('editor opens the original JPEG from a saved directory handle, not a thumbnail blob',async()=>{
  const data=new Blob([new Uint8Array([0xff,0xd8,0xff,0xd9])],{type:'image/jpeg'});
  data.name='page.jpg';
  let readCount=0;
  const folder={name:'Dataset',kind:'directory',queryPermission:async()=> 'granted',getFileHandle:async name=>{
    assert.equal(name,'page.jpg');
    return {getFile:async()=>{readCount++;return data;}};
  }};
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>Promise.resolve(folder)});
  await backend.ensureInit();
  const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'JPEG Documents'})});
  stores.get('images').set('jpeg',{id:'jpeg',projectId:created.project.id,fileName:'page.jpg',relativePath:'page.jpg',width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0});
  await backend.api('/api/admin/pick-folder',{method:'POST',body:JSON.stringify({role:'dataset'})});
  const url=await backend.imageURL('jpeg');
  assert.match(url,/^blob:/);
  const content=await (await fetch(url)).arrayBuffer();
  assert.deepEqual([...new Uint8Array(content)],[255,216,255,217]);
  assert.equal(readCount,1);
  backend.revokeURL(url);
});


test('specific image file picker restores an image when the dataset folder is unavailable',async()=>{
  // JPEG SOF0 segment encodes the dimensions 1258x2048 without decoding pixels.
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x08,0x00,0x04,0xea,0x03,0x01,0x11,0x00,0x02,0x11,0x01,0x03,0x11,0x01,0xff,0xd9]);
  const blob=new Blob([jpeg],{type:'image/jpeg'});blob.name='page.jpg';
  let pickerCalls=0;
  const fileHandle={kind:'file',queryPermission:async()=> 'granted',getFile:async()=>blob};
  const {backend,stores}=await loadBackend({showOpenFilePicker:()=>{pickerCalls++;return Promise.resolve([fileHandle]);}});
  await backend.ensureInit();
  const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Restored page'})});
  stores.get('images').set('relinked',{id:'relinked',projectId:created.project.id,fileName:'page.jpg',relativePath:'nested/page.jpg',width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0});
  await assert.rejects(()=>backend.imageURL('relinked'),/disconnected/);
  const reconnect=backend.reconnectSingleImage('relinked');
  assert.equal(pickerCalls,1,'file picker must open synchronously in click handler');
  assert.equal(await reconnect,'page.jpg');
  const source=await backend.imageSource('relinked');
  assert.equal(source.size,blob.size);assert.equal(source.type,'image/jpeg');
  backend.revokeURL(source.url);
  assert.equal(stores.get('handles').size,1,'only file handle, not original image bytes, persisted');
});

test('incorrect original image is rejected without replacing persisted file handle',async()=>{
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x08,0x00,0x04,0xea,0x03,0x01,0x11,0x00,0x02,0x11,0x01,0x03,0x11,0x01,0xff,0xd9]);
  const blob=new Blob([jpeg],{type:'image/jpeg'});blob.name='different.jpg';
  const {backend,stores}=await loadBackend({showOpenFilePicker:()=>Promise.resolve([{getFile:async()=>blob}])});
  await backend.ensureInit();
  const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Documents'})});
  stores.get('images').set('bad',{id:'bad',projectId:created.project.id,fileName:'page.jpg',relativePath:'page.jpg',width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0});
  await assert.rejects(backend.reconnectSingleImage('bad'),/Incorrect image file/);
  assert.equal(stores.get('handles').size,0);
});

function jpegFile(name='page.jpg',width=1258,height=2048){
  // Minimal JPEG header with SOF0 dimensions; full image decoding is not
  // required to verify our filename/path/geometry protection.
  const bytes=Uint8Array.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,height>>8,height&255,width>>8,width&255,0x03,0x01,0x11,0x00,0x02,0x11,0x01,0x03,0x11,0x01,0xff,0xd9]);
  const f=new Blob([bytes],{type:'image/jpeg'});f.name=name;return f;
}
function fakeFolder(name,contents={}){
  const dir={name,kind:'directory',queryPermission:async()=> 'granted',
    async *entries(){yield* Object.entries(contents);},
    async getDirectoryHandle(part){if(contents[part]?.kind==='directory')return contents[part];throw Error(`NotFoundError: ${part}`);},
    async getFileHandle(part){if(contents[part]?.kind==='file')return contents[part];throw Error(`NotFoundError: ${part}`);}};
  return dir;
}
function fakeFile(name,width=1258,height=2048){return {kind:'file',name,queryPermission:async()=> 'granted',getFile:async()=>jpegFile(name,width,height)};}

test('reconnecting a parent folder finds an image in a unique subfolder without changing stored image paths or annotations',async()=>{
  const images=fakeFolder('images',{'page.jpg':fakeFile('page.jpg')});
  const root=fakeFolder('Documents',{images});
  let pickerCalls=0;
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>{pickerCalls++;return Promise.resolve(root);}});
  await backend.ensureInit();
  const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Docs',labels:['word']})});
  const projectId=created.project.id;
  stores.get('images').set('im1',{id:'im1',projectId,fileName:'page.jpg',relativePath:'page.jpg',width:1258,height:2048,status:'CLAIMED',annotationCount:1,revision:2,order:1});
  const shape={id:'box1',type:'bbox',labelId:created.project.labels[0].id,rect:{x:.2,y:.2,w:.3,h:.3},line:2};
  stores.get('annotations').set('im1',{imageId:'im1',projectId,annotations:[shape],lineRegions:[],revision:2});
  const result=backend.reconnectDatasetForImage('im1');
  assert.equal(pickerCalls,1,'folder picker triggered before await');
  assert.equal(await result,'Documents/images');
  assert.equal(stores.get('projects').get(projectId).datasetBasePrefix,'images');
  assert.equal(stores.get('handles').get(`${projectId}:dataset`).handle,root);
  const source=await backend.imageSource('im1');
  assert.equal(source.name,'page.jpg');
  backend.revokeURL(source.url);
  assert.equal(stores.get('images').get('im1').relativePath,'page.jpg','relative path used for exports stays untouched');
  assert.deepEqual(stores.get('annotations').get('im1').annotations,[shape], 'previous annotations remain unchanged');
});

test('reconnect refuses ambiguous filename/dimension matches without changing project handle',async()=>{
  const root=fakeFolder('Parent',{
    a:fakeFolder('a',{'page.jpg':fakeFile('page.jpg')}),
    b:fakeFolder('b',{'page.jpg':fakeFile('page.jpg')})
  });
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>Promise.resolve(root)});
  await backend.ensureInit();
  const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Dupes'})});
  stores.get('images').set('im',{id:'im',projectId:created.project.id,fileName:'page.jpg',relativePath:'page.jpg',width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0});
  await assert.rejects(()=>backend.reconnectDatasetForImage('im'),/Multiple files named/);
  assert.equal(stores.get('handles').size,0,'ambiguous folder never replaces saved handle');
  assert.equal(stores.get('projects').get(created.project.id).datasetBasePrefix,undefined);
});

test('reconnect refuses a file with wrong dimensions at the stored path',async()=>{
  const root=fakeFolder('Wrong',{'page.jpg':fakeFile('page.jpg',1024,768)});
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>Promise.resolve(root)});
  await backend.ensureInit();
  const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Wrong size'})});
  stores.get('images').set('im',{id:'im',projectId:created.project.id,fileName:'page.jpg',relativePath:'page.jpg',width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0});
  await assert.rejects(()=>backend.reconnectDatasetForImage('im'),/dimensions 1024×768/);
  assert.equal(stores.get('handles').size,0);
});

test('subfolder remapping preserves an originally nested dataset relative path',async()=>{
  const original=fakeFolder('pages',{'page.jpg':fakeFile('page.jpg')});
  const root=fakeFolder('Parent',{scans:fakeFolder('scans',{pages:original})});
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>Promise.resolve(root)});
  await backend.ensureInit();
  const created=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Nested Docs'})});
  stores.get('images').set('im',{id:'im',projectId:created.project.id,fileName:'page.jpg',relativePath:'pages/page.jpg',width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0});
  assert.equal(await backend.reconnectDatasetForImage('im'),'Parent/scans');
  const url=await backend.imageURL('im');assert.match(url,/^blob:/);backend.revokeURL(url);
  assert.equal(stores.get('projects').get(created.project.id).datasetBasePrefix,'scans');
});

test('folder reconnection relinks a uniquely matched file even when its subfolder structure changed',async()=>{
  const moved=fakeFile('page.jpg');
  const candidate=fakeFolder('Moved', {other:fakeFolder('other',{subfolder:fakeFolder('subfolder',{'page.jpg':moved})})});
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>Promise.resolve(candidate)});
  await backend.ensureInit();
  const {project}=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Moved images'})});
  stores.get('images').set('im',{id:'im',projectId:project.id,fileName:'page.jpg',relativePath:'old/path/page.jpg',width:1258,height:2048,status:'CLAIMED',annotationCount:0,revision:0});
  const result=await backend.reconnectDatasetForImage('im');
  assert.equal(result,'Moved');
  assert.equal(stores.get('handles').get(`${project.id}:image-file:im`).handle,moved);
  assert.equal(stores.get('images').get('im').relativePath,'old/path/page.jpg');
  const loaded=await backend.imageSource('im');
  assert.equal(loaded.name,'page.jpg');backend.revokeURL(loaded.url);
});

test('direct original-file selection remains available immediately when persisted handle cannot be reread',async()=>{
  const file=jpegFile('page.jpg');
  const fh={kind:'file',queryPermission:async()=> 'denied',getFile:async()=>file};
  const {backend,stores}=await loadBackend({showOpenFilePicker:()=>Promise.resolve([fh])});
  await backend.ensureInit();
  const {project}=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'One image'})});
  stores.get('images').set('im',{id:'im',projectId:project.id,fileName:'page.jpg',relativePath:'page.jpg',width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0});
  await backend.reconnectSingleImage('im');
  const source=await backend.imageSource('im');
  assert.equal(source.name,'page.jpg');backend.revokeURL(source.url);
});

test('dataset import stores per-file handles and reopening works after the original directory root becomes unavailable',async()=>{
  let rootOnline=true;
  const file=jpegFile('page.jpg');
  const original={kind:'file',name:'page.jpg',queryPermission:async()=> 'granted',getFile:async()=>file};
  const folder={name:'Docs',kind:'directory',queryPermission:async()=>rootOnline?'granted':'denied',
    async *entries(){ if(rootOnline)yield ['page.jpg',original]; },
    async getFileHandle(name){if(rootOnline&&name==='page.jpg')return original;throw Error('NotFound');}};
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>Promise.resolve(folder)});
  await backend.ensureInit();
  const {project}=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Imported'})});
  await backend.api('/api/admin/pick-folder',{method:'POST',body:JSON.stringify({role:'dataset'})});
  const {importId}=await backend.api('/api/admin/dataset',{method:'POST',body:'{}'});
  for(let i=0;i<100;i++){
    const status=await backend.api(`/api/admin/import-status?id=${importId}`);
    if(status.done){assert.ok(!status.error,status.error);break;}
    await new Promise(r=>setTimeout(r,5));
  }
  const images=[...stores.get('images').values()];
  assert.equal(images.length,1,'image must be imported');
  const key=`${project.id}:image-file:${images[0].id}`;
  assert.equal(stores.get('handles').get(key)?.handle,original,'the imported image keeps its own FileSystemFileHandle');
  rootOnline=false;
  const source=await backend.imageSource(images[0].id);
  assert.equal(source.name,'page.jpg');backend.revokeURL(source.url);
});

test('bulk relinking repairs existing image handles without overwriting annotations',async()=>{
  const root=fakeFolder('Dataset Moved',{newdir:fakeFolder('newdir',{'page.jpg':fakeFile('page.jpg')})});
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>Promise.resolve(root)});
  await backend.ensureInit();
  const {project}=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Existing',labels:['text']})});
  const image={id:'previous',projectId:project.id,fileName:'page.jpg',relativePath:'old/page.jpg',width:1258,height:2048,status:'CLAIMED',annotationCount:1,revision:3};
  stores.get('images').set('previous',image);
  const originalShape={id:'box1',type:'bbox',labelId:project.labels[0].id,rect:{x:.1,y:.3,w:.5,h:.2},line:null};
  const doc={imageId:image.id,projectId:project.id,annotations:[originalShape],lineRegions:[],revision:3};
  stores.get('annotations').set(image.id,doc);
  const results=await backend.relinkProjectFolder();
  assert.equal(results.matched,1);assert.equal(results.missing,0);
  assert.deepEqual(stores.get('annotations').get(image.id),doc);
  assert.equal(stores.get('images').get(image.id).relativePath,'old/page.jpg');
  const source=await backend.imageSource(image.id);
  assert.equal(source.name,'page.jpg');backend.revokeURL(source.url);
});

test('bulk relinking does not ambiguously map the same file to distinct same-name images',async()=>{
  const root=fakeFolder('Dataset',{'page.jpg':fakeFile('page.jpg')});
  const {backend,stores}=await loadBackend({showDirectoryPicker:()=>Promise.resolve(root)});
  await backend.ensureInit();
  const {project}=await backend.api('/api/admin/project',{method:'POST',body:JSON.stringify({name:'Duplicates'})});
  for(const [id,path] of [['one','a/page.jpg'],['two','b/page.jpg']])
    stores.get('images').set(id,{id,projectId:project.id,fileName:'page.jpg',relativePath:path,width:1258,height:2048,status:'UNCLAIMED',annotationCount:0,revision:0});
  await assert.rejects(()=>backend.relinkProjectFolder(),/No matching originals/);
  assert.equal(stores.get('handles').size,0,'no false connections saved');
});
