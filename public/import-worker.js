"use strict";
importScripts('/import-parsers.js');
self.onmessage=({data})=>{
  const {id,text}=data;
  try{
    const doc=JSON.parse(text);
    if(!LabelFlowImport.isCocoManifest(doc))throw Error('Not a COCO manifest');
    const parsed=[...LabelFlowImport.parseCocoManifest(doc).entries()];
    self.postMessage({id,parsed});
  }catch(error){self.postMessage({id,error:String(error.message||error)});}
};
