'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const exporter=require('../lib/exporter');
test('Node COCO polygon export uses exact polygon area, not bounding rectangle',()=>{
  const project={name:'area',labels:[{id:'x',name:'Text'}]};
  const image={id:'img',fileName:'test.png',width:100,height:100,annotations:[
    {id:'triangle',type:'polygon',labelId:'x',points:[{x:0,y:0},{x:1,y:0},{x:0,y:1}]}
  ],lineRegions:[]};
  const coco=JSON.parse(exporter.fileFor(project,image,'coco').data);
  assert.equal(coco.annotations[0].area,5000);
  assert.deepEqual(coco.annotations[0].bbox,[0,0,100,100]);
});
