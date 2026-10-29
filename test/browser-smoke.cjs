const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
let root;
const appRoot=path.resolve(__dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const work=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'labelflow-browser-'));
 root=work;
 await fs.mkdir(root+'/fixtures');
 const sharp=require('sharp');
 for(let i=0;i<84;i++) await sharp({create:{width:1800,height:2400,channels:3,background:'#fffdf8'}}).png().toFile(root+'/fixtures/document-'+String(i+1).padStart(3,'0')+'.png');
 const server=spawn(process.execPath,[appRoot+'/server.js'],{cwd:work,env:{...process.env,ADMIN_PORT:'3201',PORT:'3202'},stdio:['ignore','pipe','pipe']});
 let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
 let browser;
 try {
 const api=async(p,data)=>{let r=await fetch('http://127.0.0.1:3201'+p,data?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{});assert.ok(r.ok,await r.clone().text());return r.json()};
 for(let i=0;i<100;i++){try{await api('/api/admin/state');break}catch{await delay(100)}}
 await api('/api/admin/project',{name:'Document archive',labels:['Heading','Paragraph','Table','Figure']});
 let imp=await api('/api/admin/dataset',{path:root+'/fixtures'});
 for(let i=0;i<100;i++){const status=await api('/api/admin/import-status?id='+imp.importId);if(status.done)break;await delay(100)}
 const list=await api('/api/admin/images?limit=200');assert.equal(list.total,84);
 for(let i=0;i<7;i++)await api('/api/admin/image/'+list.images[i].id+'/save',{annotations:[{id:'box-'+i,labelId:(await api('/api/admin/state')).project.labels[0].id,type:'bbox',rect:{x:.08,y:.05,w:.75,h:.08}}],lineRegions:[],markComplete:true});
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE || undefined,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const requests=[];page.on('request',r=>requests.push(r.url()));
 await page.goto('http://127.0.0.1:3201');await page.waitForSelector('.image-card');
 await page.waitForFunction(()=>[...document.querySelectorAll('.image-card img[src]')].every(i=>i.complete));
 await page.screenshot({path:root+'/dashboard.png'});
 assert.equal(requests.filter(u=>u.endsWith('/file')).length,0,'gallery must never load originals');
 console.log('dashboard',await page.evaluate(()=>({height:innerHeight,body:document.documentElement.scrollHeight,cards:document.querySelectorAll('.image-card').length,loaded:document.querySelectorAll('.image-card img[src]').length})));
 await page.locator('.image-card').first().click();await page.waitForSelector('.anno-canvas');await page.waitForFunction(()=>activeCanvas?.img?.naturalWidth>0);
 await page.screenshot({path:root+'/editor.png'});
 await page.click('[data-tool="bbox"]');
 const holder=await page.locator('#holder').boundingBox();
 await page.mouse.move(holder.x+holder.width*.4,holder.y+holder.height*.35);await page.mouse.down();await page.mouse.move(holder.x+holder.width*.65,holder.y+holder.height*.43);await page.mouse.up();
 await page.waitForSelector('.label-editor input');await page.fill('.label-editor input','New test label');await page.press('.label-editor input','Enter');
 await page.waitForFunction(()=>activeCanvas.annotations.length===2 && activeCanvas.annotations.every(a=>a.labelId));
 await page.keyboard.press('Escape');
 const saveResponse=page.waitForResponse(r=>r.url().endsWith('/save')&&r.request().method()==='POST');await page.click('#save');assert.equal((await saveResponse).status(),200);await page.waitForFunction(()=>!activeCanvas.isDirty());
 const old=await page.evaluate(()=>{window.old=activeCanvas;return activeCanvas.annotations.length});assert.equal(old,2);
 await page.click('#next-image');await page.waitForFunction(()=>activeCanvas && activeCanvas!==window.old);
 assert.equal(await page.evaluate(()=>window.old.img),null);assert.equal(await page.evaluate(()=>window.old.canvas.width),0);assert.equal(await page.evaluate(()=>window.old._destroyed),true);
 await page.click('#back');await page.waitForSelector('.image-card');
 await page.fill('#search','document-084');await page.waitForFunction(()=>document.querySelectorAll('.image-card').length===1);assert.ok((await page.locator('.image-card').innerText()).includes('084'));
 await page.fill('#search','');await page.waitForFunction(()=>document.querySelectorAll('.image-card').length===36);
 for(const vp of [{width:1366,height:768},{width:1024,height:768},{width:390,height:844}]){
 await page.setViewportSize(vp);await page.screenshot({path:root+`/dashboard-${vp.width}.png`});console.log('viewport',vp,await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight})));
 }
 await page.setViewportSize({width:1366,height:768});await page.locator('.image-card').first().click();await page.waitForSelector('.anno-canvas');await page.waitForFunction(()=>activeCanvas?.img?.naturalWidth>0);await page.screenshot({path:root+'/editor-1366.png'});
 // Repeat navigation: live canvases/key handlers must stay bounded.
 for(let i=0;i<15;i++){await page.click('#next-image');await page.waitForFunction(()=>activeCanvas?.img?.naturalWidth>0)}
 console.log('editor resources',await page.evaluate(()=>({canvasCount:document.querySelectorAll('canvas').length,undo:activeCanvas.undoStack.length})));
 const labeler=await browser.newPage({viewport:{width:1366,height:768}});labeler.on('pageerror',e=>errors.push(e.message));
 await labeler.goto('http://127.0.0.1:3202');await labeler.fill('[name=name]','Test Labeler');await labeler.click('#join button');await labeler.waitForSelector('.anno-canvas');await labeler.waitForFunction(()=>canvas?.img?.naturalWidth>0);await labeler.screenshot({path:root+'/labeler.png'});
 await labeler.evaluate(()=>{window.previous=canvas});await labeler.click('#complete');await labeler.waitForSelector('#claim');assert.equal(await labeler.evaluate(()=>window.previous.img),null);
 assert.deepEqual(errors,[]);console.log('PASS browser workflows',JSON.stringify({errors,originalRequests:requests.filter(u=>u.endsWith('/file')).length}));
 } finally{await browser?.close();server.kill();await fs.rm(work,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
