// Native macOS host. This is application source, not desktop automation.
ObjC.import('AppKit');
ObjC.import('WebKit');
ObjC.import('Foundation');
ObjC.import('stdlib');
var panel, web, status, controller, task, serviceInputPipe, compact = false, baseURL, closing = false, lastFit = 0, lastTitle = '', lastTip = '', scriptApp = null, statusMenu = null, failures = 0, resourcesPath = null, pendingMenu = false, lastClick = 0, clickWindow = 0.35;
// CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary:
// the window is on every desktop and over full-screen apps, so it stays put whatever app or desktop you switch to.
var SPACE_BEHAVIOR = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
// Thin native strip at the top of the window that you can drag to move it.
var STRIP = 12;
// Everything inside the window is drawn at this scale, so text and numbers shrink in proportion.
var ZOOM = 0.85;
function post(route) {
  const request=$.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(baseURL+route));
  request.HTTPMethod='POST';
  request.timeoutInterval=1;
  $.NSURLConnection.sendSynchronousRequestReturningResponseError(request,null,null);
}
// Every call to the local service has a short time limit, so a slow or stuck service can never freeze the menu bar or the window.
function getText(route,timeout){
  const request=$.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(baseURL+route));
  request.timeoutInterval=timeout||1.5;
  const data=$.NSURLConnection.sendSynchronousRequestReturningResponseError(request,null,null);
  if(!data || data.isNil())return null;
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding));
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
// Bring the window to whichever desktop (Space) the user is on now.
function show(){
  try{ if(typeof log==='function')log('show() called'); }catch(e){}
  panel.collectionBehavior=SPACE_BEHAVIOR;
  panel.orderFrontRegardless;
  try{ panel.makeKeyWindow; }catch(e){}
  try{post('host/show/'+(panel.isVisible?'1':'0'));}catch(e){}
}
function openLink(url){ if(/^https:\/\/[^\s]+$/.test(url)) $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url)); }
function notify(n){
  const title=String(n.title||'用量伴侣'), body=String(n.body||''), subtitle=String(n.subtitle||'');
  // shown by a separate helper process, so the app itself never waits on it
  try{
    const t=$.NSTask.alloc.init; t.launchPath='/usr/bin/osascript';
    t.arguments=['-e','on run argv','-e','display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name "Glass"','-e','end run',body,title,subtitle];
    t.launch;
  }catch(e){}
}
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
  if(name.indexOf('theme:')===0){setTheme(name.slice(6));return;}
  if(name.indexOf('fit:')===0){fit(Number(name.slice(4)));return;}
  if(name.indexOf('open:')===0){openLink(name.slice(5));return;}
  switch(name){case 'hide':panel.orderOut(null);break;case 'show':show();return;case 'quit':quit();return;default:return;}
  try{post('host/'+name+'/'+(panel.isVisible?'1':'0'));}catch(e){}
}
// Clicks on the menu bar numbers. A transparent view covers the button and receives the mouse-down itself,
// so the click count comes straight from the event: 1 = menu (after a short wait), 2 = open the window.
var dbg=[];
function log(m){return;try{dbg.push(new Date().toISOString().slice(11,23)+' '+m);dbg=dbg.slice(-40);
  $(dbg.join('\n')).writeToFileAtomicallyEncodingError('/Applications/_to_delete/ut-click.log',true,$.NSUTF8StringEncoding,null);}catch(e){}}
function handleClick(ev,right){
  let count=1; try{count=Number(ev.clickCount)||1;}catch(e){}
  const now=Date.now();
  log('click count='+count+' right='+right+' pending='+pendingMenu+' gap='+(now-lastClick));
  if(right){pendingMenu=false;openMenu();return;}
  if(count>=2 || (pendingMenu && now-lastClick<=clickWindow*1000+80)){pendingMenu=false;lastClick=0;
    // double click toggles: open the window, or put it away if it is already showing
    let vis=false; try{vis=!!panel.isVisible;}catch(e){}
    if(vis)perform('hide'); else show();
    return;}
  lastClick=now;pendingMenu=true;
  controller.performSelectorWithObjectAfterDelay('showMenu:',null,clickWindow);
}
function openMenu(){
  if(!statusMenu)return;
  log('open menu');
  // Show the menu right under the menu bar numbers.
  try{ status.button.highlight(true); }catch(e){}
  try{ status.popUpStatusItemMenu(statusMenu); log('menu closed (popUpStatusItemMenu)'); }
  catch(e){
    log('popUpStatusItemMenu failed: '+e);
    try{ const bt=status.button; const flipped=!!bt.isFlipped; const h=Number(bt.bounds.size.height);
      statusMenu.popUpMenuPositioningItemAtLocationInView(null,$.NSMakePoint(0,flipped?h+5:-5),bt); log('menu closed (positioned)'); }
    catch(e2){ log('positioned failed: '+e2); }
  }
  try{ status.button.highlight(false); }catch(e){}
}
function startService(){
  const resources=resourcesPath;
  task=$.NSTask.alloc.init;
  task.launchPath=resources+'/runtime/node';
  task.arguments=[resources+'/backend.js','--native-host','--host-pid',String($.NSProcessInfo.processInfo.processIdentifier)];
  serviceInputPipe=$.NSPipe.alloc.init;
  task.standardInput=serviceInputPipe.fileHandleForReading;
  const demo=$.NSFileManager.defaultManager.fileExistsAtPath(resources+'/DEMO');
  if(demo)task.arguments=[resources+'/backend.js','--demo','--native-host','--host-pid',String($.NSProcessInfo.processInfo.processIdentifier)];
  const pipe=$.NSPipe.alloc.init; task.standardOutput=pipe;
  task.standardError=$.NSFileHandle.fileHandleWithNullDevice;
  task.launch;
  const ready=pipe.fileHandleForReading.availableData;
  baseURL=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ready,$.NSUTF8StringEncoding)).trim();
  if(!baseURL)throw Error('服务未启动');
}
// The service stopped or stopped answering: start a fresh one and reload the window.
function restartService(){
  if(closing || !resourcesPath)return;
  failures=0;
  try{ if(task && task.running){ const pid=String(task.processIdentifier); task.terminate;
    const k=$.NSTask.alloc.init; k.launchPath='/bin/kill'; k.arguments=['-9',pid]; k.launch; } }catch(e){}
  try{ startService(); }catch(e){ return; }
  try{ web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(baseURL))); }catch(e){}
}
function stopService(){closing=true;if(task && task.running)task.terminate;}
function quit(){if(closing)return;closing=true;try{post('action/quit');}catch(e){}if(task && task.running)task.terminate;$.exit(0);}
function idle(){if(controller && !closing)controller.tick(null);return 1;}
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
     if(task && !task.running){restartService();return;}
     const text=getText('native',1.5);
     if(!text){ if(++failures>=20)restartService(); return; }
     failures=0;
     const snapshot=JSON.parse(text);
     const alerts=snapshot.alerts||[];
     const tibo=alerts.some(a=>a.kind==='tibo' && a.warning!==false), credit=alerts.some(a=>a.kind==='credit');
     const title=(tibo||credit?'⚠︎':'')+'G'+fiveHour(snapshot.state.gpt)+' C'+fiveHour(snapshot.state.claude);
     if(title!==lastTitle){status.button.title=title;lastTitle=title;}
     let tip='5 小时剩余额度：G = GPT，C = Claude（* 表示旧数据）\n单击：菜单　双击：打开窗口';
     if(tibo)tip+='\n⚠︎ '+String(alerts.find(a=>a.kind==='tibo' && a.warning!==false).title||'Tibo 发布了额度重置消息')+'（保留至每周额度重置）';
     if(credit)tip+='\n⏰ 有重置券 3 天内到期';
     if(tip!==lastTip){status.button.toolTip=tip;lastTip=tip;}
     (snapshot.notifications||[]).forEach(notify);
     if(snapshot.action)perform(snapshot.action);
   }catch(e){}
 }}
}});
function run(argv) {
  if(panel && task && task.running){show();return;}
  if(argv[0] && /^http:/.test(argv[0]))baseURL=argv[0];
  else {
    resourcesPath=argv[0]==='--resources'?argv[1]:ObjC.unwrap($.NSBundle.mainBundle.resourcePath);
    startService();
  }
  if(!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/.test(baseURL))throw new Error('Invalid local service');
  const app=$.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
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
  web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(baseURL)));
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
