'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {normalizeCodex,normalizeClaude,extractToken,fetchCodex,startServer}=require('./backend');
test('all model quota groups, zero usage, null windows, missing percentages and dynamic durations',()=>{
 const result=normalizeCodex({rateLimitsByLimitId:{codex:{secondary:{usedPercent:0,windowDurationMins:10080,resetsAt:1890000000}},
 'gpt-6.1-sol':{limitName:'GPT-6.1 Sol',primary:{usedPercent:42.5,windowDurationMins:60,resetsAt:1890001000},secondary:{windowDurationMins:10080}}}});
 assert.equal(result.windows.length,3);assert.equal(result.windows[0].remaining,100);
 assert.equal(result.windows[1].remaining,57.5);assert.equal(result.windows[1].label,'1 小时');assert.equal(result.windows[2].remaining,null);
 assert.equal(result.windows[1].group,'GPT-6.1 Sol');
});
test('legacy Codex compatibility and absent Pro five-hour window',()=>{
 assert.deepEqual(normalizeCodex({rateLimits:{limitId:'codex',primary:null,secondary:{usedPercent:38,windowDurationMins:10080}}}).windows.map(w=>w.label),['每周']);
 assert.deepEqual(normalizeCodex({}).windows,[]);
});
test('Claude keyed-only response includes every model and Cowork window',()=>{
 const w=normalizeClaude({five_hour:{utilization:0,resets_at:'2026-10-04T03:00:00Z'},seven_day_sonnet:{utilization:61,resets_at:'2026-10-06T03:00:00Z'},seven_day_cowork:{utilization:40,resets_at:null}});
 assert.equal(w.length,3);assert.equal(w[0].remaining,100);assert.equal(w.find(x=>x.id==='seven_day_sonnet').remaining,39);
 assert.equal(w.find(x=>x.id==='seven_day_cowork').resetsAt,null);
});
test('Claude limits array replaces known values without losing keyed-only windows',()=>{
 const w=normalizeClaude({five_hour:{utilization:10,resets_at:'2026-10-04T03:00:00Z'},seven_day_opus:{utilization:41,resets_at:null},
 limits:[{group:'session',percent:25,resets_at:'2026-10-04T04:00:00Z'},{group:'weekly',percent:67,resets_at:null}]});
 assert.equal(w.length,3);assert.equal(w.find(x=>x.id==='five_hour').used,25);assert.equal(w.find(x=>x.id==='seven_day').used,67);
});
test('unknown values remain unknown; out of range percentages are clamped',()=>{
 const w=normalizeCodex({rateLimits:{primary:{usedPercent:-10},secondary:{usedPercent:130}}}).windows;
 assert.deepEqual(w.map(x=>x.remaining),[100,0]);assert.equal(normalizeCodex({rateLimits:{primary:{usedPercent:null}}}).windows[0].used,null);
});
test('Keychain tokens are extracted in memory from known nested JSON',()=>{
 assert.equal(extractToken('{"claudeAiOauth":{"accessToken":"test-only-secret"}}'),'test-only-secret');
 assert.equal(extractToken('not JSON'),null);assert.equal(extractToken('{"scopes":[]}'),null);
});
test('RPC waits for initialize, reads all limits, paginates models and never invokes inference',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-rpc-'));
 const mock=path.join(dir,'codex');
 fs.writeFileSync(mock,`#!${process.execPath}\nconst readline=require('node:readline');let initialized=false;readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');return;}if(m.method==='initialized'){initialized=true;return;}if(!initialized)process.exit(9);let result;if(m.method==='account/rateLimits/read')result={rateLimitsByLimitId:{'gpt-6.1-sol':{primary:{usedPercent:42,windowDurationMins:300}}}};else if(m.method==='model/list')result=m.params.cursor?{data:[{model:'future-model',displayName:'Future',isDefault:false}],nextCursor:null}:{data:[{model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',isDefault:true}],nextCursor:'page2'};else process.exit(8);process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});\n`,{mode:0o755});
 const old=process.env.USAGE_CODEX_PATH;process.env.USAGE_CODEX_PATH=mock;
 try{const r=await fetchCodex();assert.equal(r.windows[0].group,'gpt-6.1-sol');assert.equal(r.models.length,2);assert.equal(r.models[0].name,'GPT-6.1 Sol');assert.equal(r.models[1].id,'future-model');}
 finally{if(old)process.env.USAGE_CODEX_PATH=old;else delete process.env.USAGE_CODEX_PATH;fs.rmSync(dir,{recursive:true});}
});
test('local server rejects invalid capability, host and foreign origin; demo stays separate',async()=>{
 const app=await startServer({demo:true});
 try{const state=await (await fetch(app.url+'state')).json();assert.equal(state.demo,true);assert.equal(state.gpt.windows[0].remaining,62);
 assert.equal((await fetch(app.url.replace(/\/[a-f0-9]{48}\//,'/bad/')+'state')).status,404);
 assert.equal((await fetch(app.url+'state',{headers:{Origin:'https://example.com'}})).status,403);
 const badHost=await new Promise(resolve=>require('node:http').get(app.url+'state',{headers:{Host:'localhost'}},res=>{res.resume();resolve(res.statusCode);}));assert.equal(badHost,403);
 assert.equal((await fetch(app.url+'action/not-an-action',{method:'POST'})).status,400);
 assert.ok((await (await fetch(app.url)).text()).includes('用量伴侣'));
 }finally{app.stop();}
});

test('native backend stops when its host closes the lifetime pipe',async()=>{
 const {spawn}=require('node:child_process');
 const child=spawn(process.execPath,[path.join(__dirname,'backend.js'),'--demo','--native-host'],{stdio:['pipe','pipe','ignore']});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 const exit=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('host cleanup timeout'));},2500);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
 child.stdin.end();assert.equal(await exit,0);
});
test('Quit stops the service and only its explicitly identified native host',async()=>{
 const {spawn}=require('node:child_process');
 const code=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,[${JSON.stringify(path.join(__dirname,'backend.js'))},'--demo','--native-host','--host-pid',String(process.pid)],{stdio:['pipe','pipe','ignore']});c.stdout.on('data',b=>process.stdout.write(b));`;
 const host=spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','ignore']});
 const url=await new Promise((resolve,reject)=>{host.stdout.once('data',b=>resolve(String(b).trim()));host.once('error',reject);});
 const end=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{host.kill();reject(Error('quit timeout'));},3000);host.once('exit',(code,signal)=>{clearTimeout(timer);resolve(signal);});});
 assert.equal((await fetch(url+'action/quit',{method:'POST'})).status,200);
 assert.equal(await end,'SIGTERM');
 await assert.rejects(fetch(url+'state'));
});

test('compact mode changes independently of window visibility and preserves account data',async()=>{
 const app=await startServer({demo:true});
 try{
  const state=async()=> (await fetch(app.url+'state')).json();
  const signal=async(name,visible)=>{assert.equal((await fetch(app.url+'host/'+name+'/'+visible,{method:'POST'})).status,200);return state();};
  const original=(await state()).gpt;
  let s=await signal('compact',1);assert.equal(s.nativeStatus.compact,true);assert.equal(s.nativeStatus.visible,true);
  s=await signal('hide',0);assert.equal(s.nativeStatus.compact,true);assert.equal(s.nativeStatus.visible,false);
  s=await signal('show',1);assert.equal(s.nativeStatus.compact,true);assert.equal(s.nativeStatus.visible,true);
  s=await signal('expand',1);assert.equal(s.nativeStatus.compact,false);assert.deepEqual(s.gpt,original);
 }finally{app.stop();}
});

// 2.3.4: the menu bar app reads a status file instead of calling the service, and the service watches the app's heartbeat.
test('watchdog restarts a frozen menu bar app once, but not a healthy one, an open menu or a Mac waking from sleep (2.3.4)',()=>{
 const {watchHost}=require('./backend');
 const sim=beat=>{let t=0;const r={killed:null,opened:null,t:()=>t};
  const w=watchHost({beatFile:'x',hostPid:42,appPath:'/Applications/Usage Together.app',now:()=>t,readBeat:()=>beat(t),
   kill:p=>{r.killed=p;},open:p=>{r.opened=p;},schedule:()=>0,later:f=>f()});
  r.step=dt=>{t+=dt;return w.check();};return r;};
 let s=sim(t=>({at:t-(t%3000),menu:0}));for(let i=0;i<1440;i++)assert.equal(s.step(5000),false);assert.equal(s.killed,null);
 s=sim(t=>({at:Math.min(t,600000),menu:0}));let fired=null;for(let i=0;i<400&&fired===null;i++)if(s.step(5000))fired=s.t();
 assert.ok(fired-600000>=60000&&fired-600000<=65000);assert.equal(s.killed,42);assert.equal(s.opened,'/Applications/Usage Together.app');
 assert.equal(s.step(5000),false,'fires only once');
 s=sim(()=>({at:0,menu:1}));for(let i=0;i<300;i++)assert.equal(s.step(5000),false,'menu open 25 min is not a freeze');
 // asleep for 2 hours, then the app resumes beating within a few seconds of waking
 let t0=0;const w=watchHost({beatFile:'x',hostPid:1,appPath:'/A.app',now:()=>t0,readBeat:()=>({at:t0<600000?t0:t0<7804000?600000:t0,menu:0}),
  kill:()=>assert.fail('killed after sleep'),open:()=>{},schedule:()=>0,later:()=>{}});
 while(t0<600000){t0+=5000;w.check();}t0=7805000;for(let i=0;i<100;i++){assert.equal(w.check(),false);t0+=5000;}
});
test('native backend writes a fresh status file for the menu bar and removes it on exit (2.3.4)',async()=>{
 const {spawn}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ut-status-'));const status=path.join(dir,'s.json'),url=path.join(dir,'u.url');
 const child=spawn(process.execPath,[path.join(__dirname,'backend.js'),'--demo','--native-host','--host-pid','1','--url-file',url,'--status-file',status,'--beat-file',path.join(dir,'b')],
  {stdio:['pipe','ignore','ignore'],env:{...process.env,USAGE_DATA_DIR:dir}});
 try{
  const read=()=>{try{return JSON.parse(fs.readFileSync(status,'utf8'));}catch{return null;}};
  let first=null;for(let i=0;i<100&&!first;i++){await new Promise(r=>setTimeout(r,50));first=read();}
  assert.ok(first,'status file written');assert.equal(first.state.gpt.summary.session.remaining,76);assert.equal(first.state.claude.summary.session.remaining,54);
  await new Promise(r=>setTimeout(r,2300));assert.ok(read().at>first.at,'status file keeps updating');
 }finally{const gone=new Promise(r=>child.once('exit',r));child.stdin.end();await gone;}
 assert.equal(fs.existsSync(status),false);assert.equal(fs.existsSync(url),false);
 fs.rmSync(dir,{recursive:true,force:true});
});

test('page files are served from memory, so a moved or deleted app still shows its window',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-bundle-'));
 for(const f of ['backend.js','index.html','ui.js','style.css'])fs.copyFileSync(path.join(__dirname,f),path.join(dir,f));
 const {startServer:start}=require(path.join(dir,'backend.js'));
 const app=await start({demo:true});
 try{
  fs.rmSync(dir,{recursive:true,force:true});
  for(const [route,type] of [['','text/html'],['ui.js','text/javascript'],['style.css','text/css']]){
   const r=await fetch(app.url+route);assert.equal(r.status,200,route);assert.match(r.headers.get('content-type'),new RegExp(type));
   assert.ok((await r.text()).length>100);
  }
 }finally{app.stop();}
});
