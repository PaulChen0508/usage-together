const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/native.js','utf8');
function setup(){
  const dollar=x=>x;
  dollar.NSApplication={sharedApplication:{isHidden:false,activateIgnoringOtherApps(){}}};
  const c={ObjC:{import(){},registerSubclass(){},unwrap:x=>x},$:dollar,Date,console};
  vm.createContext(c);vm.runInContext(source,c);
  const queue=[];let rebuilt=0;
  c.controller={performSelectorWithObjectAfterDelay(name,token,delay){queue.push({name,token,delay});}};
  const panel=active=>({isVisible:false,isOnActiveSpace:active,collectionBehavior:0,
    orderOut(){this.isVisible=false;},get orderFrontRegardless(){this.isVisible=true;},
    get makeKeyWindow(){},makeKeyAndOrderFront(){this.isVisible=true;this.isOnActiveSpace=true;}});
  c.panel=panel(true);c.log=()=>{};c.windowState=()=>'';c.ensureOnScreen=()=>{};
  c.reloadPage=()=>{};c.lastAlive=Date.now();
  c.createPanel=()=>{rebuilt++;c.panel=panel(rebuilt===1);};
  return {c,queue,panel,rebuilt:()=>rebuilt};
}
{
  const t=setup();t.c.show();const pending=t.queue[0];
  t.c.verifyShow(pending.token);assert.equal(t.rebuilt(),0);
}
{
  const t=setup();t.c.panel.isOnActiveSpace=false;t.c.show();
  t.c.verifyShow(t.queue[0].token);assert.equal(t.rebuilt(),1);
  t.c.verifyShow(t.queue.at(-1).token);assert.equal(t.c.panel.isOnActiveSpace,true);
}
{
  const t=setup();t.c.panel.isOnActiveSpace=false;t.c.show();const token=t.queue[0].token;
  t.c.hide();t.c.verifyShow(token);
  assert.equal(t.rebuilt(),0);assert.equal(t.c.panel.isVisible,false);
}
{
  const t=setup();t.c.show();const old=t.queue[0].token;
  t.c.show();t.c.panel.isOnActiveSpace=false;t.c.verifyShow(old);
  assert.equal(t.rebuilt(),0);
}
{
  const t=setup();t.c.panel.isOnActiveSpace=false;t.c.show();let token=t.queue[0].token;
  t.c.verifyShow(token);t.c.panel.isOnActiveSpace=false;t.c.verifyShow(token);
  assert.equal(t.c.panel.collectionBehavior,t.c.MOVE_HERE);
  assert.equal(t.queue.at(-1).name,'finishWindowMove:');
  t.c.finishWindowMove(token);assert.equal(t.c.panel.collectionBehavior,t.c.SPACE_BEHAVIOR);
}
{
  const t=setup();t.c.handleClickInner({clickCount:3},false);
  assert.equal(t.queue.length,0);
}
console.log('6 window recovery checks passed');
