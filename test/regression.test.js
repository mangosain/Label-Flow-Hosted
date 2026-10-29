'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const sharp=require('sharp');
const exporter=require('../lib/exporter');
const {zipChunks}=require('../lib/zip');
const project={labels:[{id:'word',name:'Word'}]};
const example={id:'one',fileName:'page.png',width:1000,height:800,status:'COMPLETED',annotations:[{id:'a',labelId:'word',type:'bbox',rect:{x:.1,y:.2,w:.3,h:.1},line:null},{id:'b',type:'polygon',labelId:'word',points:[{x:.5,y:.5},{x:.7,y:.5},{x:.7,y:.7}]}],lineRegions:[]};
async function collect(gen){const parts=[];for await(const b of gen)parts.push(Buffer.from(b));return Buffer.concat(parts)}
function unzipStored(buffer){const files={};let i=0;while(buffer.readUInt32LE(i)===0x04034b50){const len=buffer.readUInt32LE(i+18),n=buffer.readUInt16LE(i+26),extra=buffer.readUInt16LE(i+28);const name=buffer.subarray(i+30,i+30+n).toString();const start=i+30+n+extra;files[name]=buffer.subarray(start,start+len).toString();i=start+len}return files}
for(const format of ['json','xml','voc','yolo'])test('streamed '+format+' export preserves original contents',async()=>{
 const old=unzipStored(exporter.buildExportZip(project,[example],format,false,'both'));
 const streamed=unzipStored(await collect(zipChunks(exporter.exportEntries(project,[example],format,'both'))));
 assert.deepEqual(streamed,old);
});
test('streamed COCO preserves IDs, skipped count, geometry and categories',async()=>{
 const images=[example,{...example,id:'two',fileName:'second.png',annotations:[...example.annotations,{id:'unlabeled',type:'bbox',rect:{x:0,y:0,w:.1,h:.1}}]}];
 assert.deepEqual(JSON.parse((await collect(exporter.cocoChunks(project,images))).toString()),exporter.buildCocoManifest(project,images));
});
test('10,000-image project: paging, previews, saves, restarts, imports and access boundary',{timeout:120000},async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'labelflow-test-'));
 const root=path.resolve(__dirname,'..');let server;
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const base='http://127.0.0.1:34321';
 async function start(){
   server=spawn(process.execPath,[path.join(root,'server.js')],{cwd,env:{...process.env,ADMIN_PORT:'34321',PORT:'34322'},stdio:['ignore','pipe','pipe']});
   let log='';server.stderr.on('data',d=>log+=d);
   for(let i=0;i<100;i++){try{const r=await fetch(base+'/api/admin/state');if(r.ok)return}catch{}await delay(50)}
   throw Error('Server failed to start: '+log);
 }
 async function stop(){if(server && server.exitCode===null){const closed=once(server,'exit');server.kill();await closed}}
 async function api(url,body,opts={}){const r=await fetch(base+url,{...opts,...(body?{method:'POST',headers:{'content-type':'application/json',...opts.headers},body:JSON.stringify(body)}:{})});assert.equal(r.ok,true,await r.clone().text());return r.json()}
 try{
   const source=path.join(cwd,'sample.png');await sharp({create:{width:2400,height:3200,channels:3,background:'#f0f3f5'}}).png().toFile(source);
   const seed=spawnSync(process.execPath,['-e',`const s=require(${JSON.stringify(path.join(root,'lib/store'))});s.createProject('Scale test',['Word']);for(let i=0;i<10000;i++)s.addImage({fileName:'image-'+String(i).padStart(5,'0')+'.png',path:${JSON.stringify(source)},width:2400,height:3200,annotations:[]});s.saveImages();`],{cwd,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
   await start();
   const started=performance.now();const first=await api('/api/admin/images?limit=36');
   console.log('10k list latency (ms):',Math.round(performance.now()-started));
   assert.equal(first.total,10000);assert.equal(first.images.length,36);assert.equal(first.images[0].annotations,undefined);
   const state=await api('/api/admin/state');const id=first.images[0].id;
   const file=path.join(cwd,'state/projects',state.project.id,'images.json');const before=await fs.readFile(file,'utf8');
   const thumb=await fetch(base+'/api/image/'+id+'/thumbnail');assert.equal(thumb.status,200);
   const bytes=Buffer.from(await thumb.arrayBuffer());const meta=await sharp(bytes).metadata();assert.ok(meta.width<=320 && meta.height<=240);assert.equal(meta.format,'webp');
   const original=await fetch(base+'/api/image/'+id+'/file');assert.equal(original.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await original.arrayBuffer()),await fs.readFile(source));
   const annotations=[{...example.annotations[0],labelId:state.project.labels[0].id}];
   await api('/api/admin/image/'+id+'/save',{annotations,lineRegions:[{id:'region',line:3,points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]}],markComplete:true});
   assert.equal(await fs.readFile(file,'utf8'),before,'single save must not rewrite the entire index');
   assert.equal((await api('/api/admin/image/'+id)).image.annotationCount,1);
   const invalid=await fetch(base+'/api/admin/image/'+id+'/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({annotations:[],lineRegions:'bad'})});assert.equal(invalid.status,400);assert.equal((await api('/api/admin/image/'+id)).image.annotationCount,1);
   assert.equal((await fetch('http://127.0.0.1:34322/api/admin/state')).status,404);
   await stop();await start();
   const restored=(await api('/api/admin/image/'+id)).image;assert.equal(restored.status,'COMPLETED');assert.equal(restored.annotationCount,1);assert.equal(restored.lineRegions[0].line,3);
   const exported=await fetch(base+'/api/admin/export/json?completedOnly=true');const exportedFiles=unzipStored(Buffer.from(await exported.arrayBuffer()));assert.equal(JSON.parse(exportedFiles['manifest.json']).imageCount,1);
   const coco=await api('/api/admin/export/coco?completedOnly=true');assert.equal(coco.images.length,1);assert.equal(coco.annotations.length,1);
   const data=path.join(cwd,'dataset');await fs.mkdir(data);await fs.copyFile(source,path.join(data,'new.png'));
   for(const format of ['jpeg','webp','gif'])await sharp({create:{width:64,height:48,channels:3,background:'#ff8040'}}).toFormat(format).toFile(path.join(data,'preview.'+format));
   const bmp=require('bmp-js');const raw=Buffer.alloc(64*48*4);for(let i=0;i<raw.length;i+=4){raw[i+1]=40;raw[i+2]=80;raw[i+3]=255}await fs.writeFile(path.join(data,'preview.bmp'),bmp.encode({width:64,height:48,data:raw}).data);
   async function importDataset(){const imp=await api('/api/admin/dataset',{path:data});for(let i=0;i<100;i++){const status=await api('/api/admin/import-status?id='+imp.importId);if(status.done){assert.equal(status.error,undefined);return status}await delay(30)}throw Error('Import timeout')}
   assert.equal((await importDataset()).added,5);assert.equal((await importDataset()).added,0);
   await fs.mkdir(path.join(data,'labels'));
   await fs.writeFile(path.join(data,'labels','new.xml'),'<annotation><object><name>Word</name><bndbox><xmin>10</xmin><ymin>20</ymin><xmax>300</xmax><ymax>200</ymax></bndbox></object></annotation>');
   assert.equal((await importDataset()).backfilled,1);
   assert.equal((await importDataset()).backfilled,0,'existing shapes must not be overwritten');assert.equal((await api('/api/admin/images')).total,10005);
   const previews=await api('/api/admin/images?q=preview');
   for(const item of previews.images){const response=await fetch(base+'/api/image/'+item.id+'/thumbnail');assert.equal(response.status,200,item.fileName);assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format,'webp')}
   await stop();await start();assert.equal((await api('/api/admin/image/'+id)).image.annotationCount,1);
   console.log('Preview bytes:',bytes.length,'decoded RGBA ceiling:',320*240*4);
 }finally{await stop();await fs.rm(cwd,{recursive:true,force:true})}
});
