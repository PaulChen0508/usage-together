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
