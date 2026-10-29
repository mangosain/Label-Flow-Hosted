'use strict';
// Verifies the shipped browser build against the same algorithm used by Node.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {TextEncoder,TextDecoder}=require('node:util');
const LFLines=require('../lib/lines');
const source=f=>readFileSync(path.join(__dirname,'../public',f),'utf8');
const context=vm.createContext({TextEncoder,TextDecoder,Blob,Uint8Array,Uint32Array,DataView,LFLines,console});
context.globalThis=context;
for(const file of ['browser-zip.js','browser-exporter.js','import-parsers.js'])vm.runInContext(source(file),context,{filename:file});
const out=context.LabelFlowExport;
const project={name:'Project',labels:[{id:'text',name:'text',color:'#4f46e5'}]};
const image={id:'i1',relativePath:'page.png',fileName:'page.png',width:1000,height:800,status:'COMPLETED',lineRegions:[],annotations:[
  {id:'box',type:'bbox',labelId:'text',rect:{x:.1,y:.1,w:.2,h:.1},line:3},
  {id:'triangle',type:'polygon',labelId:'text',points:[{x:.5,y:.5},{x:.7,y:.5},{x:.7,y:.7}],line:4},
]};
test('browser COCO polygon area is triangle area, not bounding rectangle',()=>{
  const coco=out.buildCocoManifest(project,[image]);
  assert.equal(coco.annotations[0].area,16000);
  assert.equal(coco.annotations[1].area,16000);
  assert.equal(coco.annotations[1].bbox[2]*coco.annotations[1].bbox[3],32000);
  assert.equal(coco.annotations[1].line,4);
});
test('browser exporters agree with Node exporter',()=>{
  const exporter=require('../lib/exporter');
  for(const format of ['json','xml','voc','coco','yolo']){
    assert.equal(out.fileFor(project,image,format).data,exporter.fileFor(project,image,format).data);
  }
});
test('browser ZIP has valid headers and preserves nested source paths',async()=>{
  const a={...image,relativePath:'folder1/page.png'};
  const b={...image,id:'i2',relativePath:'folder2/page.png'};
  const blob=out.buildExportZip(project,[a,b],'json',false,'both');
  const buf=Buffer.from(await blob.arrayBuffer());
  let offset=0;const files=new Map();
  while(buf.readUInt32LE(offset)===0x04034b50){
    const size=buf.readUInt32LE(offset+18),nameLen=buf.readUInt16LE(offset+26),extra=buf.readUInt16LE(offset+28);
    const name=buf.subarray(offset+30,offset+30+nameLen).toString();
    const start=offset+30+nameLen+extra;
    files.set(name,buf.subarray(start,start+size).toString());
    offset=start+size;
  }
  assert(files.has('annotations/folder1/page.json'));
  assert(files.has('annotations/folder2/page.json'));
  assert.equal(JSON.parse(files.get('manifest.json')).imageCount,2);
  assert.equal(JSON.parse(files.get('annotations/folder2/page.json')).annotations.length,2);
});
test('browser importers retain manual line from COCO',()=>{
  const coco=out.buildCocoManifest(project,[image]);
  const map=context.LabelFlowImport.parseCocoManifest(JSON.parse(JSON.stringify(coco)));
  assert.equal(map.get('page')[1].line,4);
});
test('browser own JSON export round trips geometry',()=>{
  const encoded=out.buildImageJson(project,image,'both');
  const decoded=context.LabelFlowImport.parseJsonDoc(encoded,1000,800);
  assert.equal(decoded.length,2);
  assert.equal(decoded[1].points[2].y,.7);
  assert.equal(decoded[0].line,3);
});
