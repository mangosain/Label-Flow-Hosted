"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..", "public");
const script = fs.readFileSync(path.join(root,"beta-notice.js"),"utf8");

function runNotice() {
  let now = 1000;
  const callbacks = new Map();
  let nextTimer = 1;
  const makeEl = () => ({
    open: false,
    listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    click() { this.listeners.click?.(); },
    focus() { this.focused = true; },
    setAttribute(name) { if (name === "open") this.open = true; },
    showModal() { this.open = true; this.showCount = (this.showCount || 0) + 1; },
    close() { this.open = false; this.listeners.close?.(); },
  });
  const dialog = makeEl(), xButton = makeEl(), gotIt = makeEl(), seconds = {textContent:"5"};
  const elems = new Map([
    ["beta-notice",dialog], ["beta-notice-close",xButton],
    ["beta-notice-confirm",gotIt], ["beta-seconds",seconds],
  ]);
  const context = {
    document: {getElementById: id => elems.get(id)},
    performance: {now:()=>now},
    setTimeout(callback, delay) { const id = nextTimer++; callbacks.set(id,{callback,delay,kind:"timeout"}); return id; },
    setInterval(callback, delay) { const id = nextTimer++; callbacks.set(id,{callback,delay,kind:"interval"}); return id; },
    clearTimeout(id) {callbacks.delete(id);},
    clearInterval(id) {callbacks.delete(id);},
  };
  vm.runInNewContext(script, context, {filename:"beta-notice.js"});
  return {
    dialog,xButton,gotIt,seconds,callbacks,
    tickTo(millis) { now = 1000 + millis; for (const item of [...callbacks.values()]) if (item.kind === "interval") item.callback(); },
    expire() { const item=[...callbacks.values()].find(item=>item.kind==="timeout"&&item.delay===5000); assert.ok(item, "must schedule five second dismissal"); item.callback(); },
  };
}

test("beta notice appears every load, is accessible and closes after five seconds",()=>{
  const index = fs.readFileSync(path.join(root,"index.html"),"utf8");
  const admin = fs.readFileSync(path.join(root,"admin.html"),"utf8");
  for (const html of [index,admin]) {
    assert.match(html, /<dialog id="beta-notice"/);
    assert.match(html, /aria-labelledby="beta-notice-title"/);
    assert.match(html, /report it to the maintainer/);
    assert.match(html, /Chrome or Edge/);
    assert.match(html, /<script src="\/beta-notice\.js(?:\?v=[\w.-]+)?"><\/script>/);
  }
  const a = runNotice();
  assert.equal(a.dialog.open,true);
  assert.equal(a.dialog.showCount,1);
  assert.equal(a.gotIt.focused,true);
  a.tickTo(2000);
  assert.equal(a.seconds.textContent,"3");
  a.expire();
  assert.equal(a.dialog.open,false);
  const reload=runNotice();
  assert.equal(reload.dialog.open,true, "no once-per-user storage suppression");
  reload.xButton.click();
  assert.equal(reload.dialog.open,false);
  const third=runNotice();
  third.gotIt.click();
  assert.equal(third.dialog.open,false);
});

test("UI cleanup does not alter export actions or include the removed tagline",()=>{
  const admin = fs.readFileSync(path.join(root,"admin.js"),"utf8");
  assert.ok(!admin.includes("Local-first · private on this device"));
  for (const id of ["open-export-modal","backup-project","restore-project","backup-folder","refresh","unload","create-project","status-filter","image-list"]) {
    assert.ok(admin.includes(id), `must preserve ${id}`);
  }
  const sw=fs.readFileSync(path.join(root,"sw.js"),"utf8");
  assert.ok(sw.includes("/beta-notice.js"));
});
