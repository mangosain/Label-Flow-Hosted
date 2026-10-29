"use strict";
// ZIP32 STORE archive. Blob parts permit browsers to retain byte buffers without
// building one giant in-memory Uint8Array. Useful for annotation-only exports.
(() => {
  const enc = new TextEncoder();
  const table = new Uint32Array(256);
  for (let i=0;i<256;i++) { let c=i; for(let k=0;k<8;k++) c=c&1?0xedb88320^(c>>>1):c>>>1; table[i]=c>>>0; }
  function crc32(bytes) { let c=0xffffffff; for(const b of bytes) c=table[(c^b)&255]^(c>>>8); return (c^0xffffffff)>>>0; }
  function header(length) { const b=new Uint8Array(length); return {bytes:b,view:new DataView(b.buffer)}; }
  function buildZip(entries) {
    if(entries.length>65535) throw Error('Too many ZIP files; export fewer images.');
    const parts=[],central=[]; let offset=0, centralSize=0;
    for(const entry of entries) {
      const name=enc.encode(entry.name.replace(/\\/g,'/'));
      const data=typeof entry.data==='string'?enc.encode(entry.data):entry.data;
      if(name.length>65535 || !(data instanceof Uint8Array)) throw Error('Invalid ZIP entry');
      if(offset+30+name.length+data.byteLength>0xffffffff) throw Error('ZIP32 size exceeded.');
      const checksum=crc32(data),local=header(30),c=header(46);
      local.view.setUint32(0,0x04034b50,true);local.view.setUint16(4,20,true);local.view.setUint16(6,0x0800,true);
      local.view.setUint16(12,0x21,true);local.view.setUint32(14,checksum,true);
      local.view.setUint32(18,data.byteLength,true);local.view.setUint32(22,data.byteLength,true);local.view.setUint16(26,name.length,true);
      c.view.setUint32(0,0x02014b50,true);c.view.setUint16(4,20,true);c.view.setUint16(6,20,true);
      c.view.setUint16(8,0x0800,true);c.view.setUint16(14,0x21,true);
      c.view.setUint32(16,checksum,true);c.view.setUint32(20,data.byteLength,true);c.view.setUint32(24,data.byteLength,true);
      c.view.setUint16(28,name.length,true);c.view.setUint32(42,offset,true);
      parts.push(local.bytes,name,data);central.push(c.bytes,name);centralSize+=c.bytes.length+name.length;
      offset+=30+name.length+data.byteLength;
    }
    if(offset+centralSize>0xffffffff) throw Error('ZIP32 size exceeded.');
    const end=header(22);end.view.setUint32(0,0x06054b50,true);end.view.setUint16(8,entries.length,true);
    end.view.setUint16(10,entries.length,true);end.view.setUint32(12,centralSize,true);end.view.setUint32(16,offset,true);
    return new Blob([...parts,...central,end.bytes],{type:'application/zip'});
  }
  globalThis.LabelFlowZip={buildZip};
})();
