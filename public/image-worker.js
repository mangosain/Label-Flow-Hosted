"use strict";
// Separate worker keeps thumbnail decoding/encoding away from canvas input.
self.onmessage=async ({data})=>{
  const {id,file,width,height}=data;
  let bitmap;
  try {
    if(!('OffscreenCanvas' in self) || !('createImageBitmap' in self)) throw Error('Worker image decoder unavailable');
    const scale=Math.min(1,320/width,240/height);
    const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
    bitmap=await createImageBitmap(file,{resizeWidth:w,resizeHeight:h,resizeQuality:'medium',imageOrientation:'from-image'});
    const canvas=new OffscreenCanvas(w,h);
    canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0,w,h);
    bitmap.close();bitmap=null;
    const blob=await canvas.convertToBlob({type:'image/webp',quality:0.72});
    self.postMessage({id,blob});
  }catch(error){self.postMessage({id,error:String(error.message||error)});}
  finally{bitmap?.close();}
};
