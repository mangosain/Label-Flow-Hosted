'use strict';
// BMP decoding is CPU-bound JavaScript; keep it off the HTTP event loop.
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs/promises');
const bmp=require('bmp-js');
const sharp=require('sharp');
sharp.cache(false);sharp.concurrency(1);
(async()=>{
 const stat=await fs.stat(workerData.source);
 if(stat.size>64*1024*1024)throw Error('BMP is too large for a preview');
 const header=await fs.open(workerData.source,'r');
 const bytes=Buffer.alloc(54);
 try{await header.read(bytes,0,54,0)}finally{await header.close()}
 const width=bytes.readUInt32LE(18),height=Math.abs(bytes.readInt32LE(22));
 if(!width||!height||width*height>16000000||bytes.readUInt32LE(46)>256)throw Error('BMP exceeds preview limits');
 const decoded=bmp.decode(await fs.readFile(workerData.source));
 // bmp-js returns ABGR, with zero alpha for ordinary opaque BMP files.
 for(let i=0;i<decoded.data.length;i+=4){const b=decoded.data[i+1],g=decoded.data[i+2],r=decoded.data[i+3];decoded.data[i]=r;decoded.data[i+1]=g;decoded.data[i+2]=b;decoded.data[i+3]=255}
 await sharp(decoded.data,{raw:{width:decoded.width,height:decoded.height,channels:4}}).resize(320,240,{fit:'inside',withoutEnlargement:true}).webp({quality:72}).toFile(workerData.output);
 parentPort.postMessage({ok:true});
})().catch(error=>parentPort.postMessage({error:error.message}));
