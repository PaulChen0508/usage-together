// Native macOS host. This is application source, not desktop automation.
ObjC.import('AppKit');
ObjC.import('WebKit');
ObjC.import('Foundation');
ObjC.import('stdlib');
var panel, web, status, controller, task, serviceInputPipe, compact = false, baseURL, closing = false, lastFit = 0, lastTitle = '', lastTip = '', scriptApp = null, statusMenu = null, failures = 0, resourcesPath = null, pendingMenu = false, lastClick = 0, clickWindow = 0.35;
// Page health: the page reports 'alive' after each good update. If it goes quiet, the page is reloaded or the service restarted.
var lastAlive = 0, showAt = 0, lastRecover = 0, activity = null;
// How often (seconds) the menu bar reads new numbers.
var TICK = 3;
// The main thread never waits on the network. The service writes its numbers to a small private file (statusFile)
// every 2 s, and the app reads that file. The app writes its own heartbeat (beatFile) every tick, so the service
// can tell if the app itself has frozen and restart it. Requests to the service (refresh) run in a separate curl process.
var urlFile = null, statusFile = null, beatFile = null, starting = 0, nextStartAt = 0, startFailures = 0;
var lastTickAt = 0, graceUntil = 0, lastStatusAt = 0, menuOpen = false, helpers = [];
var VALID_URL = /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/;
// CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary:
// the window is on every desktop and over full-screen apps, so it stays put whatever app or desktop you switch to.
var SPACE_BEHAVIOR = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
// Thin native strip at the top of the window that you can drag to move it.
var STRIP = 12;
// Everything inside the window is drawn at this scale, so text and numbers shrink in proportion.
var ZOOM = 0.85;
// Send a request to the local service without waiting for it: a separate curl process does the work,
// so the main thread can never get stuck here (the old synchronous request could hang the whole app).
function post(route) {
  if(!baseURL)return;
  try{
    helpers=helpers.filter(t=>{try{return !!t.running;}catch(e){return false;}});
    if(helpers.length>=4)return;
    const t=$.NSTask.alloc.init; t.launchPath='/usr/bin/curl';
    t.arguments=['-s','-m','5','--noproxy','*','-X','POST','-o','/dev/null',baseURL+route];
    const nul=$.NSFileHandle.fileHandleWithNullDevice;
    t.standardInput=nul; t.standardOutput=nul; t.standardError=nul;
    t.launch; helpers.push(t);
  }catch(e){}
}
// Reading a small local file takes microseconds and cannot hang.
function readFile(p){
  if(!p)return null;
  try{ const s=$.NSString.stringWithContentsOfFileEncodingError(p,$.NSUTF8StringEncoding,null);
    return (s && !s.isNil())?ObjC.unwrap(s):null; }catch(e){ return null; }
}
function removeFile(p){ if(p)try{ $.NSFileManager.defaultManager.removeItemAtPathError(p,null); }catch(e){} }
// Heartbeat for the service's watchdog. menu=1 while the menu is open (the app is waiting on the user, not frozen).
function writeBeat(){
  if(!beatFile)return;
  try{ $(JSON.stringify({at:Date.now(),menu:menuOpen?1:0})).writeToFileAtomicallyEncodingError(beatFile,true,$.NSUTF8StringEncoding,null); }catch(e){}
}
function fresh(p){return !!(p && !p.error && p.fetchedAt && Date.now()/1000-p.fetchedAt<=600);}
// Menu bar shows the 5-hour window only.
function fiveHour(p) {
  const w=p && p.summary && p.summary.session;
  if(!w || typeof w.remaining!=='number')return '—';
  const old=!fresh(p) || (w.resetsAt && w.resetsAt<Date.now()/1000);
  return Math.round(w.remaining)+'%'+(old?'*':'');
}
function screenFrame(){
  const s=(panel && panel.screen && !panel.screen.isNil())?panel.screen:$.NSScreen.mainScreen;
  return (s && !s.isNil())?s.visibleFrame:$.NSMakeRect(0,0,1440,900);
}
// Size the window to its content so it never takes more room than needed.
function fit(height){
  if(!(height>80) || Math.abs(height-lastFit)<2)return;
  lastFit=height;
  const f=panel.frame, vis=screenFrame();
  const contentHeight=Math.min(Math.ceil(height*ZOOM)+STRIP,Number(vis.size.height)-40);
  const target=panel.frameRectForContentRect($.NSMakeRect(0,0,Number(f.size.width),contentHeight));
  const newHeight=Number(target.size.height), top=Number(f.origin.y)+Number(f.size.height);
  let y=top-newHeight; if(y<Number(vis.origin.y))y=Number(vis.origin.y);
  panel.setFrameDisplay($.NSMakeRect(Number(f.origin.x),y,Number(f.size.width),newHeight),true);
}
// If the saved position is on a screen that is no longer there (monitor unplugged, resolution changed),
// the window would "open" where nobody can see it. Move it back to the top-right of the main screen.
function ensureOnScreen(){
  try{
    const f=panel.frame, w=Number(f.size.width), h=Number(f.size.height);
    const cx=Number(f.origin.x)+w/2, top=Number(f.origin.y)+h-6;
    const screens=$.NSScreen.screens, n=Number(screens.count);
    for(let i=0;i<n;i++){
      const s=screens.objectAtIndex(i).frame, x=Number(s.origin.x), y=Number(s.origin.y);
      if(cx>=x && cx<=x+Number(s.size.width) && top>=y && top<=y+Number(s.size.height))return;
    }
    const v=screenFrame();
    panel.setFrameDisplay($.NSMakeRect(Number(v.origin.x)+Number(v.size.width)-w-16,Number(v.origin.y)+Number(v.size.height)-h-8,w,h),true);
  }catch(e){}
}
function reloadPage(){
  if(!web || !baseURL)return;
  lastAlive=Date.now();
  try{ web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(baseURL))); }catch(e){}
}
// The page stopped reporting: restart the service if it has gone quiet too, otherwise just reload the page.
function recover(){
  if(closing)return;
  const now=Date.now(); if(now-lastRecover<10000)return; lastRecover=now;
  if(starting)return;
  if(!task || !task.running || now-lastStatusAt>20000)restartService(); else reloadPage();
}
// Bring the window to whichever desktop (Space) the user is on now.
function show(){
  try{
    ensureOnScreen();
    panel.collectionBehavior=SPACE_BEHAVIOR;
    panel.orderFrontRegardless;
    try{ panel.makeKeyWindow; }catch(e){}
    // If the page has been quiet for a while, load it again now; then make sure it really answered.
    // (Do not call evaluateJavaScript here: a JXA completion handler of null crashes the whole app.)
    showAt=Date.now();
    if(Date.now()-lastAlive>8000)reloadPage();
    controller.performSelectorWithObjectAfterDelay('checkPage:',null,2.5);
  }catch(e){}
}
function openLink(url){ if(/^https:\/\/[^\s]+$/.test(url)) $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url)); }
// System notifications are now shown by the service itself, so the app does not handle them.
// Dark: dark see-through background. Light: same see-through, but white.
var theme='';
function setTheme(t){
  t=t==='light'?'light':'dark'; if(t===theme)return; theme=t;
  panel.backgroundColor=t==='light'?$.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.98,0.98,0.98,0.62):$.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.06,0.07,0.08,0.62);
  try{ panel.appearance=$.NSAppearance.appearanceNamed(t==='light'?'NSAppearanceNameVibrantLight':'NSAppearanceNameVibrantDark'); }catch(e){}
  try{ panel.invalidateShadow; }catch(e){}
}
function perform(name){
  name=String(name||'');
  if(name==='alive'){lastAlive=Date.now();return;}
  if(name==='stale'){recover();return;}
  if(name.indexOf('theme:')===0){setTheme(name.slice(6));return;}
  if(name.indexOf('fit:')===0){fit(Number(name.slice(4)));return;}
  if(name.indexOf('open:')===0){openLink(name.slice(5));return;}
  switch(name){case 'hide':panel.orderOut(null);return;case 'show':show();return;case 'quit':quit();return;default:return;}
}
// Clicks on the menu bar numbers. A transparent view covers the button and receives the mouse-down itself,
// so the click count comes straight from the event: 1 = menu (after a short wait), 2 = open the window.
function log(m){}
function handleClick(ev,right){
  // An error here must never escape into AppKit; a failed click just does nothing.
  try{ handleClickInner(ev,right); }catch(e){ pendingMenu=false; }
}
function handleClickInner(ev,right){
  let count=1; try{count=Number(ev.clickCount)||1;}catch(e){}
  const now=Date.now();
  log('click count='+count+' right='+right+' pending='+pendingMenu+' gap='+(now-lastClick));
  if(right){pendingMenu=false;openMenu();return;}
  if(count>=2 || (pendingMenu && now-lastClick<=clickWindow*1000+80)){pendingMenu=false;lastClick=0;
    // double click toggles: open the window, or put it away if it is already showing
    if(reallyShown())perform('hide'); else show();
    return;}
  lastClick=now;pendingMenu=true;
  controller.performSelectorWithObjectAfterDelay('showMenu:',null,clickWindow);
}
// "Visible" to AppKit is not always visible to the user: the window can be fully covered, on a screen that
// was unplugged, or showing a page that never loaded. Double-click then shows it again instead of hiding it.
function reallyShown(){
  try{
    if(!panel.isVisible)return false;
    const occ=Number(panel.occlusionState); if(!(occ & (1<<1)))return false;
    if(Date.now()-lastAlive>15000)return false;
    return true;
  }catch(e){ return false; }
}
function openMenu(){
  if(!statusMenu)return;
  log('open menu');
  // Show the menu right under the menu bar numbers.
  try{ status.button.highlight(true); }catch(e){}
  // While the menu is open the app waits for the user; tell the watchdog this is not a freeze.
  menuOpen=true; writeBeat();
  try{ status.popUpStatusItemMenu(statusMenu); log('menu closed (popUpStatusItemMenu)'); }
  catch(e){
    log('popUpStatusItemMenu failed: '+e);
    try{ const bt=status.button; const flipped=!!bt.isFlipped; const h=Number(bt.bounds.size.height);
      statusMenu.popUpMenuPositioningItemAtLocationInView(null,$.NSMakePoint(0,flipped?h+5:-5),bt); log('menu closed (positioned)'); }
    catch(e2){ log('positioned failed: '+e2); }
  }
  menuOpen=false; writeBeat();
  try{ status.button.highlight(false); }catch(e){}
}
// Start the local service. It writes its address to a private temp file; this only launches it and returns at once.
function launchService(){
  const resources=resourcesPath, fm=$.NSFileManager.defaultManager;
  const pid=String($.NSProcessInfo.processInfo.processIdentifier);
  const base=ObjC.unwrap($.NSTemporaryDirectory().stringByAppendingPathComponent('usage-together-'+pid));
  urlFile=base+'.url'; statusFile=base+'.status.json'; beatFile=base+'.beat';
  removeFile(urlFile); removeFile(statusFile);
  writeBeat();
  task=$.NSTask.alloc.init;
  task.launchPath=resources+'/runtime/node';
  const args=[resources+'/backend.js'];
  if(fm.fileExistsAtPath(resources+'/DEMO'))args.push('--demo');
  args.push('--native-host','--host-pid',pid,'--url-file',urlFile,'--status-file',statusFile,'--beat-file',beatFile);
  task.arguments=args;
  serviceInputPipe=$.NSPipe.alloc.init;
  task.standardInput=serviceInputPipe.fileHandleForReading;
  task.standardOutput=$.NSFileHandle.fileHandleWithNullDevice;
  task.standardError=$.NSFileHandle.fileHandleWithNullDevice;
  baseURL='';
  starting=Date.now(); lastStatusAt=0;
  task.launch;
}
// True once the service has written its address.
function serviceReady(){
  const s=readFile(urlFile); if(!s)return false;
  const u=s.trim(); if(!VALID_URL.test(u))return false;
  baseURL=u; starting=0; startFailures=0; lastStatusAt=Date.now();
  return true;
}
// Used once at launch: wait (at most 10 s) because the window needs the address before it can show anything.
function startService(){
  launchService();
  for(let i=0;i<200;i++){
    if(serviceReady())return;
    if(!task.running)break;
    $.NSThread.sleepForTimeInterval(0.05);
  }
  try{ if(task.running)task.terminate; }catch(e){}
  starting=0;
  throw Error('服务未启动');
}
function killTask(t){
  try{ if(t && t.running){ const pid=String(t.processIdentifier); t.terminate;
    const k=$.NSTask.alloc.init; k.launchPath='/bin/kill'; k.arguments=['-9',pid]; k.launch; } }catch(e){}
}
// The service stopped or stopped answering: start a fresh one. This never waits; tick() picks up the new address
// and reloads the window. If it keeps failing, wait longer between tries (up to 1 minute).
function restartService(){
  if(closing || !resourcesPath)return;
  const now=Date.now();
  if(starting || now<nextStartAt)return;
  failures=0; lastRecover=now;
  killTask(task);
  try{ launchService(); }catch(e){ starting=0; }
}
function startFailed(){
  killTask(task); starting=0; startFailures++;
  nextStartAt=Date.now()+Math.min(60000,3000*Math.pow(2,startFailures-1));
}
function cleanupFiles(){ removeFile(statusFile); removeFile(beatFile); removeFile(urlFile); }
function stopService(){closing=true;if(task && task.running)task.terminate;cleanupFiles();}
function quit(){if(closing)return;closing=true;try{if(task && task.running)task.terminate;}catch(e){}cleanupFiles();$.exit(0);}
// Only one copy may run. An older copy (even one whose app file was deleted or replaced) would keep its menu bar
// item, and because both share one app ID, opening the app again only woke up the old, broken copy.
function closeOtherCopies(){
  try{
    const me=$.NSRunningApplication.currentApplication, mine=Number(me.processIdentifier);
    const id=me.bundleIdentifier; if(!id || id.isNil())return;
    const list=$.NSRunningApplication.runningApplicationsWithBundleIdentifier(id);
    for(let i=0;i<Number(list.count);i++){
      const other=list.objectAtIndex(i), pid=Number(other.processIdentifier);
      if(pid && pid!==mine){ try{ other.forceTerminate; }catch(e){} }
    }
  }catch(e){}
}
// If this copy's app file was deleted or replaced while it runs, start the installed copy and step aside.
var bundleChecks=0;
function checkBundle(){
  if(!resourcesPath || ++bundleChecks%20)return;
  try{
    const fm=$.NSFileManager.defaultManager;
    if(fm.fileExistsAtPath(resourcesPath+'/backend.js') && fm.fileExistsAtPath(resourcesPath+'/ui.js'))return;
    const me=$.NSRunningApplication.currentApplication;
    const url=$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(me.bundleIdentifier);
    const target=(url && !url.isNil())?ObjC.unwrap(url.path):'';
    if(!target || !fm.fileExistsAtPath(target+'/Contents/Resources/backend.js'))return;
    const t=$.NSTask.alloc.init; t.launchPath='/usr/bin/open'; t.arguments=['-n',target]; t.launch;
    quit();
  }catch(e){}
}
function idle(){try{if(controller && !closing)controller.tick(null);}catch(e){}return TICK;}
function reopen(){if(panel)show();}
ObjC.registerSubclass({name:'UTClickView',superclass:'NSView',methods:{
 'mouseDown:':{types:['void',['id']],implementation:function(ev){
   let right=false; try{right=!!(Number(ev.modifierFlags)&(1<<18));}catch(e){}
   handleClick(ev,right);
 }},
 'rightMouseDown:':{types:['void',['id']],implementation:function(ev){handleClick(ev,true);}},
 'acceptsFirstMouse:':{types:['bool',['id']],implementation:function(){return true;}}
}});
ObjC.registerSubclass({name:'UsageTogetherController',superclass:'NSObject',protocols:['NSWindowDelegate','NSMenuDelegate'],methods:{
 // The page's web process can be shut down by macOS (memory pressure, sleep). Without this the window stays blank forever.
 'webViewWebContentProcessDidTerminate:':{types:['void',['id']],implementation:function(){ try{ reloadPage(); }catch(e){} }},
 // The page could not load (for example while the service was restarting): try again shortly.
 'webView:didFailProvisionalNavigation:withError:':{types:['void',['id','id','id']],implementation:function(){
   try{ controller.performSelectorWithObjectAfterDelay('reloadPage:',null,3); }catch(e){} }},
 'reloadPage:':{types:['void',['id']],implementation:function(){ try{ reloadPage(); }catch(e){} }},
 'checkPage:':{types:['void',['id']],implementation:function(){
   try{ if(!closing && panel.isVisible && lastAlive<showAt)recover(); }catch(e){} }},
 // Menu bar title: one click opens the menu (after waiting to see if a second click comes), double click opens the window.
 'showMenu:':{types:['void',['id']],implementation:function(){ if(!pendingMenu)return; pendingMenu=false; openMenu(); }},
 'menuDidClose:':{types:['void',['id']],implementation:function(){ try{ status.menu=null; }catch(e){} }},

 'userContentController:didReceiveScriptMessage:':{types:['void',['id','id']],implementation:function(_content,message){
   perform(ObjC.unwrap(message.body));
 }},
 'stop:':{types:['void',['id']],implementation:function(){stopService();}},
 'show:':{types:['void',['id']],implementation:function(){show();}},
 'hide:':{types:['void',['id']],implementation:function(){perform('hide');}},
 'refresh:':{types:['void',['id']],implementation:function(){post('refresh');}},
 'quit:':{types:['void',['id']],implementation:function(){quit();}},
 'windowShouldClose:':{types:['bool',['id']],implementation:function(){perform('hide');return false;}},
 'tick:':{types:['void',['id']],implementation:function(){
   if(closing)return;
   try{
     const now=Date.now();
     // A long gap since the last tick means the Mac was asleep: give everything a moment to wake up before judging it.
     if(lastTickAt && now-lastTickAt>15000)graceUntil=now+20000;
     lastTickAt=now;
     writeBeat();
     checkBundle();
     if(starting){
       if(serviceReady()){ reloadPage(); return; }
       if(!task || !task.running || now-starting>15000)startFailed();
       return;
     }
     if(!task || !task.running){restartService();return;}
     // The service rewrites this file every 2 s; reading it can never block.
     const text=readFile(statusFile);
     let snapshot=null; try{ snapshot=text?JSON.parse(text):null; }catch(e){}
     if(snapshot && typeof snapshot.at==='number' && snapshot.at>lastStatusAt)lastStatusAt=snapshot.at;
     // No fresh numbers for 20 s: the service is stuck, start a new one.
     if(now-lastStatusAt>20000){ if(now>graceUntil)restartService(); return; }
     if(!snapshot || !snapshot.state)return;
     // Window open but the page has gone quiet for 30 s: bring it back.
     if(panel.isVisible && now-lastAlive>30000 && now>graceUntil)recover();
     const alerts=snapshot.alerts||[];
     const tibo=alerts.some(a=>a.kind==='tibo' && a.warning!==false), credit=alerts.some(a=>a.kind==='credit');
     const title=(tibo||credit?'⚠︎':'')+'G'+fiveHour(snapshot.state.gpt)+' C'+fiveHour(snapshot.state.claude);
     if(title!==lastTitle){status.button.title=title;lastTitle=title;}
     let tip='5 小时剩余额度：G = GPT，C = Claude（* 表示旧数据）\n单击：菜单　双击：打开窗口';
     if(tibo)tip+='\n⚠︎ '+String(alerts.find(a=>a.kind==='tibo' && a.warning!==false).title||'Tibo 发布了额度重置消息')+'（保留至每周额度重置）';
     if(credit)tip+='\n⏰ 有重置券 3 天内到期';
     if(tip!==lastTip){status.button.toolTip=tip;lastTip=tip;}
   }catch(e){}
 }}
}});
function run(argv) {
  if(panel && task && task.running){show();return;}
  if(argv[0] && /^http:/.test(argv[0]))baseURL=argv[0];
  else {
    resourcesPath=argv[0]==='--resources'?argv[1]:ObjC.unwrap($.NSBundle.mainBundle.resourcePath);
    closeOtherCopies();
    startService();
  }
  if(!VALID_URL.test(baseURL))throw new Error('Invalid local service');
  const app=$.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  // Keep macOS from putting the app to sleep (App Nap) while it sits in the menu bar, which made it slow to respond
  // after a while. The Mac itself can still sleep normally.
  try{ activity=$.NSProcessInfo.processInfo.beginActivityWithOptionsReason(0x00EFFFFF,'用量伴侣在菜单栏显示额度'); }catch(e){}
  controller=$.UsageTogetherController.alloc.init;
  const primary=$.NSScreen.mainScreen;
  const screen=primary && !primary.isNil() ? primary.visibleFrame : $.NSMakeRect(0,0,1440,900);
  const width=216, height=Math.min(214,Number(screen.size.height)-60);
  panel=$.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(Number(screen.origin.x)+Number(screen.size.width)-width-16,Number(screen.origin.y)+Number(screen.size.height)-height-8,width,height),
    $.NSWindowStyleMaskTitled|$.NSWindowStyleMaskClosable|$.NSWindowStyleMaskResizable|(1<<15),$.NSBackingStoreBuffered,false);
  panel.title='用量伴侣';
  panel.releasedWhenClosed=false;
  panel.hidesOnDeactivate=false;
  panel.floatingPanel=true;
  panel.level=$.NSFloatingWindowLevel;
  panel.collectionBehavior=SPACE_BEHAVIOR;
  // Dark, see-through window with no visible title bar.
  try{ panel.appearance=$.NSAppearance.appearanceNamed('NSAppearanceNameVibrantDark'); }catch(e){}
  panel.titlebarAppearsTransparent=true;
  panel.titleVisibility=1;
  panel.opaque=false;
  panel.movableByWindowBackground=true;
  panel.hasShadow=true;
  [0,1,2].forEach(i=>{try{panel.standardWindowButton(i).hidden=true;}catch(e){}});
  panel.minSize=$.NSMakeSize(190,120);
  panel.maxSize=$.NSMakeSize(640,1400);
  panel.delegate=controller;
  panel.setFrameAutosaveName('UsageTogetherWindow24');
  // Fixed dark see-through tint (no live blur), so the look never changes when switching apps or desktops.
  setTheme('dark');
  const glass=$.NSView.alloc.initWithFrame($.NSMakeRect(0,0,width,height));
  glass.autoresizingMask=$.NSViewWidthSizable|$.NSViewHeightSizable;
  panel.contentView=glass;
  const config=$.WKWebViewConfiguration.alloc.init;
  config.websiteDataStore=$.WKWebsiteDataStore.nonPersistentDataStore;
  config.userContentController.addScriptMessageHandlerName(controller,'usageTogether');
  web=$.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0,0,width,height-STRIP),config);
  web.autoresizingMask=$.NSViewWidthSizable|$.NSViewHeightSizable;
  try{ web.setValueForKey($.NSNumber.numberWithBool(false),'drawsBackground'); }catch(e){}
  try{ web.underPageBackgroundColor=$.NSColor.clearColor; }catch(e){}
  web.navigationDelegate=controller;
  reloadPage();
  glass.addSubview(web);
  // Size the page from the window's real size (it may have been restored from last time), so nothing is cut off.
  const b=glass.bounds;
  web.frame=$.NSMakeRect(0,0,Number(b.size.width),Math.max(40,Number(b.size.height)-STRIP));
  try{ if(web.respondsToSelector('setPageZoom:')) web.pageZoom=ZOOM; else ZOOM=1; }catch(e){ ZOOM=1; }
  status=$.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  try{ status.button.font=$.NSFont.monospacedDigitSystemFontOfSizeWeight(14,0.3); }catch(e){}
  status.button.title='G— C—';
  const menu=$.NSMenu.alloc.init;
  menu.autoenablesItems=false;
  [['显示用量窗口','show:'],['隐藏窗口','hide:'],['立即刷新','refresh:'],['退出用量伴侣','quit:']].forEach(row=>{
    const item=$.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(row[0],row[1],'');item.target=controller;menu.addItem(item);
  });
  try{ clickWindow=Math.min(0.5,Math.max(0.25,Number($.NSEvent.doubleClickInterval)||0.35)); }catch(e){}
  statusMenu=menu;
  menu.delegate=controller;
  const catcher=$.UTClickView.alloc.initWithFrame(status.button.bounds);
  catcher.autoresizingMask=$.NSViewWidthSizable|$.NSViewHeightSizable;
  status.button.addSubview(catcher);
  log('started, double-click window '+clickWindow+'s');
  // Applet idle events keep callbacks inside the scripting runtime.
  controller.tick(null);
  show();
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(controller,'stop:',$.NSApplicationWillTerminateNotification,null);
  return;
}
