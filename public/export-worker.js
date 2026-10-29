"use strict";
// Builds annotation archives off the input/render thread. No source images cross this worker.
importScripts('/lines.js','/browser-zip.js','/browser-exporter.js');
self.onmessage=({data})=>{
  const {id,project,records,format,coords}=data;
  try{
    let blob;
    if(format==='coco')blob=new Blob([JSON.stringify(LabelFlowExport.buildCocoManifest(project,records),null,2)],{type:'application/json'});
    else blob=LabelFlowExport.buildExportZip(project,records,format,false,coords);
    self.postMessage({id,blob});
  }catch(error){self.postMessage({id,error:String(error.message||error)});}
};
