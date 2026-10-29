'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function setup(){
  const raf=[];const canvasCalls=[];const documentListeners = new Map();
  const ctx=new Proxy({measureText:()=>({width:8})},{get(obj,key){return key in obj?obj[key]:(...a)=>{canvasCalls.push([key,...a]);};},set(obj,key,value){obj[key]=value;return true;}});
  const createElement=(tag)=>{
    const el={tagName:tag.toUpperCase(),style:{},className:'',addEventListener(){},removeEventListener(){},removeAttribute(){},remove(){this.removed=true;},classList:{add(){},remove(){},toggle(){}},getBoundingClientRect(){return {left:0,top:0}},querySelector(){return null;}};
    if(tag==='canvas'){el.getContext=()=>ctx;el.width=0;el.height=0;}
    if(tag==='img'){
      el.naturalWidth=0;el.naturalHeight=0;
      Object.defineProperty(el,'src',{set(url){this.source=url;this.naturalWidth=1258;this.naturalHeight=2048;this.complete=true;this.onload?.();},get(){return this.source;}});
    }
    return el;
  };
  const holder={clientWidth:800,clientHeight:600, getBoundingClientRect(){return {left:0,top:0,right:this.clientWidth,bottom:this.clientHeight,width:this.clientWidth,height:this.clientHeight};},children:[],appendChild(n){this.children.push(n);},insertBefore(n,before){this.children.splice(this.children.indexOf(before),0,n);},querySelector(){return null;}};
  const context={window:{devicePixelRatio:1,addEventListener(){},removeEventListener(){}},document:{createElement,body:{appendChild(){}},getElementById(){return null;},addEventListener(type,fn,opts){documentListeners.set(type,{fn,opts});},removeEventListener(type,fn){if(documentListeners.get(type)?.fn===fn)documentListeners.delete(type);}},localStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=> 'uid'},ResizeObserver:class {observe(){} disconnect(){}},requestAnimationFrame(cb){raf.push(cb);return raf.length;},cancelAnimationFrame(){},setTimeout,clearTimeout,confirm:()=>true,LFLines:{computeLineNumbers:()=>new Map()},console};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/canvas.js'),'utf8'),context,{filename:'canvas.js'});
  const drain=()=>{for(let i=0;i<30 && raf.length;i++)raf.splice(0).forEach(fn=>fn());};
  return {holder,ctx,canvasCalls,raf,drain,documentListeners,AnnotationCanvas:context.window.AnnotationCanvas};
}

test('image is visible as a DOM layer, aligned with normalized annotation positions after fit/zoom',()=>{
  const {holder,canvasCalls,drain,AnnotationCanvas}=setup();
  const widget=new AnnotationCanvas(holder,{getLabels:()=>[]});
  let ready=0;
  widget.load('blob:http://localhost:8000/fixture',1258,2048,[],[],{onImageReady:()=>ready++});
  drain();
  assert.equal(ready,1);
  assert.equal(holder.children[0].tagName,'IMG');
  assert.equal(holder.children[1].tagName,'CANVAS');
  const img=holder.children[0];
  assert.equal(img.style.visibility,'visible');
  assert.equal(img.style.width,'1258px');
  assert.equal(img.style.height,'2048px');
  const fitted=Math.min(1,800/1258,600/2048);
  assert.ok(Math.abs(widget.view.scale-fitted)<1e-9);
  assert.match(img.style.transform,/translate3d/);
  assert.ok(!canvasCalls.some(call=>call[0]==='drawImage'),'no repeated full-image bitmap draws on annotation canvas');
  widget.zoomTo(fitted*1.3);drain();
  assert.ok(img.style.transform.includes(`scale(${widget.view.scale})`));
  const p=widget.toCanvas(0,0);
  assert.equal(p.x,widget.view.x);
  assert.equal(p.y,widget.view.y);
  widget.destroy();
  assert.equal(img.removed,true);
  assert.equal(widget.img,null);
});

test('image is not prematurely revealed if the workspace is still zero-sized',()=>{
  const {holder,drain,AnnotationCanvas}=setup();
  holder.clientWidth=0;holder.clientHeight=0;
  const widget=new AnnotationCanvas(holder,{getLabels:()=>[]});
  let ready=0;
  widget.load('blob:http://localhost:8000/fixture',1258,2048,[],[],{onImageReady:()=>ready++});
  drain();
  assert.equal(ready,0);
  assert.equal(widget.img.style.visibility,'hidden');
  holder.clientWidth=800;holder.clientHeight=600;
  widget.fit();drain();
  assert.equal(ready,1);
  assert.equal(widget.img.style.visibility,'visible');
  assert.ok(widget.view.scale > 0 && widget.view.scale < 1);
  widget.destroy();
});

test('Ctrl+wheel inside image prevents browser zoom and changes only canvas scale; outside is untouched',()=>{
  const {holder,drain,documentListeners,AnnotationCanvas}=setup();
  const widget=new AnnotationCanvas(holder,{getLabels:()=>[]});
  widget.load('blob:http://localhost:8000/test',1258,2048,[],[]);drain();
  const listener=documentListeners.get('wheel');
  assert.ok(listener); assert.equal(listener.opts.passive,false); assert.equal(listener.opts.capture,true);
  const oldScale=widget.view.scale;
  const inside={clientX:400,clientY:300,deltaY:-120,deltaX:0,ctrlKey:true,cancelable:true,preventDefault(){this.prevented=true;}};
  listener.fn(inside);drain();
  assert.equal(inside.prevented,true);assert.ok(widget.view.scale>oldScale);
  const outside={clientX:900,clientY:900,deltaY:-120,deltaX:0,ctrlKey:true,cancelable:true,preventDefault(){this.prevented=true;}};
  const after=widget.view.scale;listener.fn(outside);drain();
  assert.equal(outside.prevented,undefined);assert.equal(widget.view.scale,after);
  widget.destroy();assert.equal(documentListeners.has('wheel'),false);
});
