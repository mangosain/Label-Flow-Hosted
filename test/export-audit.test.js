'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const {TextEncoder,TextDecoder}=require('node:util');
const LFLines=require('../lib/lines');
const ctx=vm.createContext({TextEncoder,TextDecoder,Blob,Uint8Array,Uint32Array,DataView,LFLines});ctx.globalThis=ctx;
for(const f of ['browser-zip.js','browser-exporter.js','import-parsers.js']) vm.runInContext(readFileSync(join(__dirname,'../public',f),'utf8'),ctx);
const x=ctx.LabelFlowExport, imp=ctx.LabelFlowImport;
const project={id:'p',name:'Audit',labels:[{id:'text',name:'Text',color:'#000000'},{id:'table',name:'T & <B>',color:'#ffffff'}]};
const bbox=(id,labelId='text')=>({id,type:'bbox',labelId,rect:{x:.123456789,y:.156789123,w:.2345678,h:.11345},line:2});
const poly=(id,labelId='table')=>({id,type:'polygon',labelId,points:[{x:.1,y:.1},{x:.35,y:.1},{x:.18,y:.4}],line:3});
const im=(id,path,status,annotations=[])=>({id,relativePath:path,fileName:path.split('/').at(-1),width:10000,height:8000,status,annotations,lineRegions:[]});
function zipNames(buf){const b=Buffer.from(buf),names=[];let i=0;while(i+4<b.length&&b.readUInt32LE(i)===0x04034b50){const n=b.readUInt16LE(i+26),extra=b.readUInt16LE(i+28),size=b.readUInt32LE(i+18);names.push(b.subarray(i+30,i+30+n).toString());i+=30+n+extra+size;}return names;}
test('zero-annotation images are not silently omitted from full and completed exports',async()=>{
 const one=im('one','dir/a.png','COMPLETED',[bbox('a')]),zero=im('zero','dir/b.png','COMPLETED'),pending=im('pending','dir/c.png','UNCLAIMED');
 assert.equal(x.buildCocoManifest(project,[one,zero,pending]).images.length,3);
 assert.equal(JSON.parse(x.buildCocoExportAll(project,[one,zero,pending],true)).images.length,2);
 for(const fmt of ['json','xml','voc','yolo']){
  const all=zipNames(await x.buildExportZip(project,[one,zero,pending],fmt,false).arrayBuffer());
  assert.equal(all.filter(n=>n.startsWith('annotations/')).length,3,fmt);
  const done=zipNames(await x.buildExportZip(project,[one,zero,pending],fmt,true).arrayBuffer());
  assert.equal(done.filter(n=>n.startsWith('annotations/')).length,2,fmt);
 }
});
test('COCO file_name is the relative path, preventing same-basename collisions',()=>{
 const a=im('a','dir-a/page.png','COMPLETED',[bbox('a')]),b=im('b','dir-b/page.png','COMPLETED',[bbox('b')]);
 const coco=x.buildCocoManifest(project,[a,b]);
 assert.deepEqual([...coco.images].map(i=>i.file_name),['dir-a/page.png','dir-b/page.png']);
 const imported=imp.parseCocoManifest(JSON.parse(JSON.stringify(coco)));
 assert.equal(imported.get('dir-a/page').length,1);assert.equal(imported.get('dir-b/page').length,1);
});
test('mixed YOLO annotation types yield homogeneous segmentation rows',async()=>{
 const a=im('a','a.png','COMPLETED',[bbox('box')]);
 const b=im('b','b.png','COMPLETED',[poly('poly')]);
 const archive=await x.buildExportZip(project,[a,b],'yolo',false).arrayBuffer();
 const bfr=Buffer.from(archive);let off=0,manifest,records=[];
 while(off+4<=bfr.length && bfr.readUInt32LE(off)===0x04034b50){const n=bfr.readUInt16LE(off+26),size=bfr.readUInt32LE(off+18),ext=bfr.readUInt16LE(off+28);const name=bfr.subarray(off+30,off+30+n).toString();const data=bfr.subarray(off+30+n+ext,off+30+n+ext+size).toString();if(name==='manifest.json')manifest=JSON.parse(data);if(name.startsWith('annotations/'))records.push(data);off+=30+n+ext+size;}
 assert.equal(manifest.yoloTask,'segmentation');
 assert.equal(records.length,2);
 for(const row of records){const parts=row.trim().split(/\s+/);assert(parts.length>=7 && parts.length%2===1);}
 assert.equal(x.buildYoloTxt(project,a).text.trim().split(/\s+/).length,5);
});
test('XML both-coordinates roundtrip prefers lossless normalized coordinates',()=>{
 const src=im('a','a.png','COMPLETED',[bbox('box'),poly('poly')]);
 const xml=x.buildImageXml(project,src,'both');const decoded=imp.parseVocXml(xml,src.width,src.height);
 assert.equal(decoded.length,2);
 const parsedBox=decoded.find(i=>i.type==='bbox');
 assert(Math.abs(parsedBox.rect.x-.123456789)<1e-12);
 assert(Math.abs(parsedBox.rect.w-.2345678)<1e-12);
 const parsedPoly=decoded.find(i=>i.type==='polygon');
 assert.equal(parsedPoly.labelName,'T & <B>');
 assert.equal(parsedPoly.points[2].y,.4);
});
test('the literal class name "unlabeled" is not confused with a missing label in own JSON/XML',()=>{
  const local={name:'p',labels:[{id:'u',name:'unlabeled'}]};
  const a=im('x','x.png','COMPLETED',[bbox('named','u'),bbox('missing',null)]);
  for(const draft of [imp.parseJsonDoc(x.buildImageJson(local,a),a.width,a.height),imp.parseVocXml(x.buildImageXml(local,a),a.width,a.height)]){
    assert.equal(draft.filter(d=>d.labelName==='unlabeled').length,1);
    assert.equal(draft.filter(d=>d.labelName===null).length,1);
  }
});
