// Native macOS host. This is application source, not desktop automation.
ObjC.import('AppKit');
ObjC.import('WebKit');
ObjC.import('Foundation');
ObjC.import('stdlib');
var panel, web, status, controller, task, serviceInputPipe, compact = false, baseURL, closing = false;
function resize(compactView) {
  compact=compactView;
  const f=panel.frame;
  const height=compact?520:Math.min(800,Number($.NSScreen.mainScreen.visibleFrame.size.height)-70);
  const currentHeight=Number(f.size.height);
  panel.setFrameDisplayAnimate($.NSMakeRect(Number(f.origin.x),Number(f.origin.y)+currentHeight-height,Number(f.size.width),height),true,true);
  // View state is delivered through the local service; JXA cannot safely bridge WebKit completion blocks.
}
function post(route) {
  const request=$.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(baseURL+route));
  request.HTTPMethod='POST';
  request.timeoutInterval=2;
  $.NSURLConnection.sendSynchronousRequestReturningResponseError(request,null,null);
}
function pct(provider) {
  const rows=(provider && provider.windows || []).filter(w=>typeof w.remaining==='number');
  if(!rows.length)return '—';
  const old=provider.error || !provider.fetchedAt || Date.now()/1000-provider.fetchedAt>600 || rows.some(w=>w.resetsAt && w.resetsAt<Date.now()/1000);
  return Math.round(Math.min.apply(null,rows.map(w=>w.remaining)))+'%'+(old?'*':'');
}
function show(){panel.orderFrontRegardless;try{post('host/show/'+(panel.isVisible?'1':'0'));}catch{}}
function perform(name){switch(name){case 'hide':panel.orderOut(null);break;case 'show':show();return;case 'compact':resize(true);break;case 'expand':resize(false);break;case 'quit':quit();return;default:return;}try{post('host/'+name+'/'+(panel.isVisible?'1':'0'));}catch{}}
function stopService(){closing=true;if(task && task.running)task.terminate;}
function quit(){if(closing)return;closing=true;try{post('action/quit');}catch{}if(task && task.running)task.terminate;$.exit(0);}
function idle(){if(controller && !closing)controller.tick(null);return 1;}
function reopen(){if(panel)show();}
ObjC.registerSubclass({name:'UsageTogetherController',superclass:'NSObject',protocols:['NSWindowDelegate'],methods:{
 'userContentController:didReceiveScriptMessage:':{types:['void',['id','id']],implementation:function(_content,message){
   const name=ObjC.unwrap(message.body);
   perform(name);
 }},
 'stop:':{types:['void',['id']],implementation:function(){stopService();}},
 'show:':{types:['void',['id']],implementation:function(){show();}},
 'hide:':{types:['void',['id']],implementation:function(){perform('hide');}},
 'toggle:':{types:['void',['id']],implementation:function(){perform(compact?'expand':'compact');}},
 'refresh:':{types:['void',['id']],implementation:function(){post('refresh');}},
 'quit:':{types:['void',['id']],implementation:function(){quit();}},
 'windowShouldClose:':{types:['bool',['id']],implementation:function(){perform('hide');return false;}},
 'tick:':{types:['void',['id']],implementation:function(){
   if(closing)return;
   try{
     const data=$.NSData.dataWithContentsOfURL($.NSURL.URLWithString(baseURL+'native'));
     if(!data || data.isNil())return;
     const text=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding));
     const snapshot=JSON.parse(text);
     status.button.title='G '+pct(snapshot.state.gpt)+'  C '+pct(snapshot.state.claude);
     status.button.toolTip='GPT / Claude 最少剩余额度；* 表示旧数据。点击打开菜单。';
     if(snapshot.action)perform(snapshot.action);
   }catch{}
 }}
}});
function run(argv) {
  if(panel && task && task.running){show();return;}
  if(argv[0] && /^http:/.test(argv[0]))baseURL=argv[0];
  else {
    const resources=argv[0]==='--resources'?argv[1]:ObjC.unwrap($.NSBundle.mainBundle.resourcePath);
    task=$.NSTask.alloc.init;
    task.launchPath=resources+'/runtime/node';
    task.arguments=[resources+'/backend.js','--native-host','--host-pid',String($.NSProcessInfo.processInfo.processIdentifier)];
    serviceInputPipe=$.NSPipe.alloc.init;
    task.standardInput=serviceInputPipe.fileHandleForReading;
    const demo=$.NSFileManager.defaultManager.fileExistsAtPath(resources+'/DEMO');
    if(demo)task.arguments=[resources+'/backend.js','--demo','--native-host','--host-pid',String($.NSProcessInfo.processInfo.processIdentifier)];
    const pipe=$.NSPipe.alloc.init; const errors=$.NSPipe.alloc.init; task.standardOutput=pipe;task.standardError=errors;
    task.launch;
    const ready=pipe.fileHandleForReading.availableData;
    baseURL=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ready,$.NSUTF8StringEncoding)).trim();
    if(!baseURL){const details=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(errors.fileHandleForReading.availableData,$.NSUTF8StringEncoding));throw Error('服务未启动：'+details);}
  }
  if(!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/.test(baseURL))throw new Error('Invalid local service');
  const app=$.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  controller=$.UsageTogetherController.alloc.init;
  const primary=$.NSScreen.mainScreen;
  const screen=primary && !primary.isNil() ? primary.visibleFrame : $.NSMakeRect(0,0,1440,900);
  const height=Math.min(800,Number(screen.size.height)-70);
  panel=$.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(Number(screen.origin.x)+Number(screen.size.width)-490,Number(screen.origin.y)+Number(screen.size.height)-height-25,460,height),
    $.NSWindowStyleMaskTitled|$.NSWindowStyleMaskClosable|$.NSWindowStyleMaskResizable,$.NSBackingStoreBuffered,false);
  panel.title='Usage Together · 用量伴侣';
  panel.releasedWhenClosed=false;
  panel.hidesOnDeactivate=false;
  panel.floatingPanel=true;
  panel.level=$.NSFloatingWindowLevel;
  panel.minSize=$.NSMakeSize(460,400);
  panel.maxSize=$.NSMakeSize(720,1200);
  panel.delegate=controller;
  panel.setFrameAutosaveName('UsageTogetherWindow');
  const config=$.WKWebViewConfiguration.alloc.init;
  config.websiteDataStore=$.WKWebsiteDataStore.nonPersistentDataStore;
  config.userContentController.addScriptMessageHandlerName(controller,'usageTogether');
  web=$.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0,0,460,height),config);
  web.autoresizingMask=$.NSViewWidthSizable|$.NSViewHeightSizable;
  web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(baseURL)));
  panel.contentView=web;
  status=$.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  status.button.title='G —  C —';
  const menu=$.NSMenu.alloc.init;
  menu.autoenablesItems=false;
  [['显示用量窗口','show:'],['隐藏窗口','hide:'],['切换紧凑视图','toggle:'],['立即刷新','refresh:'],['退出用量伴侣','quit:']].forEach(row=>{
    const item=$.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(row[0],row[1],'');item.target=controller;menu.addItem(item);
  });
  status.menu=menu;
  // Applet idle events keep callbacks inside the scripting runtime.
  controller.tick(null);
  show();
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(controller,'stop:',$.NSApplicationWillTerminateNotification,null);
  return;
}
