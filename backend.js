'use strict';
// Only reads account data. Never starts turns, refreshes OAuth, or consumes resets.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const readline = require('node:readline');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const NOW = () => Date.now() / 1000;
const INTERVAL = 300;
const children = new Set();
function stopChildren(){for(const child of children){child.kill();const t=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},1000);t.unref();}}
function percent(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}
function epoch(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !v) return null;
  const n = Date.parse(v) / 1000; return Number.isFinite(n) ? n : null;
}
function duration(mins, fallback) {
  if (!(mins > 0)) return fallback;
  if (mins === 10080) return '每周';
  if (mins >= 1440 && mins % 1440 === 0) return `${mins / 1440} 天`;
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60} 小时`;
  return `${mins} 分钟`;
}
function normalizeCodex(payload) {
  let buckets = payload?.rateLimitsByLimitId;
  if (!buckets || !Object.keys(buckets).length) {
    buckets = payload?.rateLimits ? {[payload.rateLimits.limitId || 'codex']: payload.rateLimits} : {};
  }
  const windows = [];
  for (const [key, bucket] of Object.entries(buckets)) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [slot, fallback] of [['primary','主要窗口'],['secondary','次要窗口']]) {
      const w = bucket[slot]; if (!w || typeof w !== 'object') continue;
      const used = percent(w.usedPercent);
      windows.push({id: `${key}:${slot}`, bucket: key, group: bucket.limitName || (key === 'codex' ? '共享额度' : key),
        label: duration(w.windowDurationMins, fallback), minutes: w.windowDurationMins ?? null,
        used, remaining: used === null ? null : 100-used, resetsAt: epoch(w.resetsAt)});
    }
  }
  return {windows, plan: Object.values(buckets).find(b=>b?.planType)?.planType || null,
    resetCredits: payload?.rateLimitResetCredits ?? null};
}
const CLAUDE_NAMES = {five_hour:'5 小时', seven_day:'每周',seven_day_opus:'每周 · Opus',
  seven_day_sonnet:'每周 · Sonnet',seven_day_cowork:'每周 · Cowork',seven_day_oauth_apps:'每周 · OAuth apps',
  seven_day_overage_included:'每周 · 额外用量'};
function normalizeClaude(payload) {
  const result = new Map();
  // The legacy keyed response is still common. Keep windows absent from limits[].
  for (const [id, w] of Object.entries(payload || {})) {
    if (!w || typeof w !== 'object' || Array.isArray(w) || !('utilization' in w) || !('resets_at' in w)) continue;
    const used = percent(w.utilization);
    result.set(id, {id,group:'Claude',label: CLAUDE_NAMES[id] || id, used,
      remaining:used===null?null:100-used, resetsAt:epoch(w.resets_at),minutes:id==='five_hour'?300:id.startsWith('seven_day')?10080:null});
  }
  for (const [i,e] of (Array.isArray(payload?.limits) ? payload.limits : []).entries()) {
    if (!e || typeof e !== 'object' || !('percent' in e)) continue;
    const label = e.scope?.surface?.display_name || e.scope?.model?.display_name;
    let id = e.id || e.window_id;
    if (!id && e.group==='session') id='five_hour';
    if (!id && label) id=`seven_day_${label.toLowerCase().replace(/\s+/g,'_')}`;
    if (!id) {
      const matches = [...result.values()].filter(w=>w.used===e.percent && w.resetsAt===epoch(e.resets_at));
      id = matches.length===1 ? matches[0].id : (e.group==='weekly' || e.group==='week' ? 'seven_day' : `limit_${i}`);
    }
    const used=percent(e.percent); const existing=result.get(id);
    result.set(id,{id,group:'Claude',label:CLAUDE_NAMES[id] || (label?`每周 · ${label}`:e.display_name || existing?.label || e.group || id),used,
      remaining:used===null?null:100-used,resetsAt:epoch(e.resets_at),minutes:existing?.minutes || (e.group==='session'?300:id.startsWith('seven_day')?10080:null)});
  }
  return [...result.values()].sort((a,b)=>(a.minutes??Infinity)-(b.minutes??Infinity)||a.id.localeCompare(b.id));
}
function findCodex() {
  const candidates = [process.env.USAGE_CODEX_PATH,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    path.join(os.homedir(),'.local/bin/codex'),'/opt/homebrew/bin/codex','/usr/local/bin/codex',
    ...(process.env.PATH || '').split(':').map(p=>path.join(p,'codex'))];
  return candidates.find(p=>{try {if(!p)return false; fs.accessSync(p,fs.constants.X_OK);return fs.statSync(p).isFile();}catch{return false;}});
}
class RPC {
  constructor(binary) {
    this.child=spawn(binary,['app-server'],{stdio:['pipe','pipe','ignore']}); this.requests=new Map();this.seq=0;children.add(this.child);
    this.lines=readline.createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}
      const request=this.requests.get(m.id); if(!request)return;
      clearTimeout(request.timer);this.requests.delete(m.id);
      m.error ? request.reject(new Error(String(m.error.message || '接口查询失败'))) : request.resolve(m.result);
    });
    this.child.on('error',()=>this.rejectAll(new Error('无法启动 Codex，请更新或重新安装官方应用')));
    this.child.on('exit',()=>{children.delete(this.child);this.rejectAll(new Error('Codex 用量进程已结束'));});
    this.child.stdin.on('error',()=>this.rejectAll(new Error('Codex 连接已中断')));
  }
  rejectAll(error){for(const r of this.requests.values()){clearTimeout(r.timer);r.reject(error);}this.requests.clear();}
  send(msg){this.child.stdin.write(JSON.stringify(msg)+'\n');}
  call(method,params={},timeout=22000) {
    return new Promise((resolve,reject)=>{const id=++this.seq;
      const timer=setTimeout(()=>{this.requests.delete(id);reject(new Error('查询超时，请检查网络后刷新'));},timeout);
      this.requests.set(id,{resolve,reject,timer});this.send({id,method,params});});
  }
  close(){this.rejectAll(new Error('连接已关闭'));this.lines.close();this.child.kill();
    const t=setTimeout(()=>{if(this.child.exitCode===null)this.child.kill('SIGKILL');},2000);t.unref();}
}
async function fetchCodex() {
  const binary=findCodex();if(!binary)throw new Error('未找到 Codex。请安装 ChatGPT/Codex 官方桌面版或 Codex CLI，并登录账户。');
  const rpc=new RPC(binary);
  try {
    await rpc.call('initialize',{clientInfo:{name:'usage_together',title:'Usage Together',version:'2.0.0'}});
    rpc.send({method:'initialized',params:{}});
    const results=await Promise.allSettled([
      rpc.call('account/rateLimits/read'),
      (async()=>{let cursor=null,models=[];const cursors=new Set();for(let p=0;p<20;p++){
        const r=await rpc.call('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}: {})});
        models.push(...(r?.data || []).map(m=>({id:m.model || m.id,name:m.displayName || m.model || m.id,isDefault:!!m.isDefault})));
        if(!r?.nextCursor || cursors.has(r.nextCursor))break;cursor=r.nextCursor;cursors.add(cursor);
      }return models;})()
    ]);
    if(results[0].status==='rejected')throw results[0].reason;
    return {...normalizeCodex(results[0].value),fetchedAt:NOW(),models:results[1].status==='fulfilled'?results[1].value:[],
      note:results[1].status==='rejected'?'本机 Codex 暂未提供模型列表；额度查询仍可用。':null};
  } finally {rpc.close();}
}
function extractToken(blob) {
  let parsed;try{parsed=JSON.parse(blob);}catch{return null;}
  const queue=[parsed];for(let i=0;i<queue.length && i<30;i++){
    const obj=queue[i];if(!obj || typeof obj!=='object')continue;
    const access=obj.accessToken || obj.access_token;
    if(typeof access==='string' && access)return access;
    queue.push(...Object.values(obj).filter(v=>v && typeof v==='object'));
  }return null;
}
async function claudeToken() {
  for (const service of ['Claude Code-credentials','Claude Code','claude-code-credentials']) {
    try {const {stdout}=await exec('/usr/bin/security',['find-generic-password','-s',service,'-w'],{timeout:12000,maxBuffer:128*1024});
      const token=extractToken(stdout);if(token)return token;
    }catch{/* Never log Keychain output, subprocess arguments, or secrets. */}
  }
  throw new Error('未找到 Claude Code 登录信息。请打开 Claude Code 并登录，然后刷新。首次读取钥匙串时 macOS 可能请求授权。');
}
async function fetchClaude() {
  const token=await claudeToken();
  let response;try {response=await fetch('https://api.anthropic.com/api/oauth/usage',{method:'GET',
    headers:{Authorization:`Bearer ${token}`,Accept:'application/json','anthropic-beta':'oauth-2025-04-20'},signal:AbortSignal.timeout(18000),redirect:'error'});
  }catch{throw new Error('Claude 用量查询失败，请检查网络或代理后刷新。');}
  if(!response.ok){
    const messages={401:'Claude 登录已过期。请在 Claude Code 中重新登录，然后刷新。',403:'Claude 登录权限不足。请使用 Claude Code 的正常登录方式。',429:'Claude 接口暂时限流，15 分钟后自动重试。'};
    const error=new Error(messages[response.status] || `Claude 用量接口暂不可用（HTTP ${response.status}）。`);
    if(response.status===429)error.retryAfter=900;throw error;
  }
  let payload;try{payload=await response.json();}catch{throw new Error('Claude 接口返回了无法识别的数据。');}
  const windows=normalizeClaude(payload);if(!windows.length)throw new Error('Claude 暂未返回额度窗口；账户可能不支持，或接口已变更。');
  return {fetchedAt:NOW(),windows,models:[],note:'Claude Code /usage 数据'};
}
function demoState(){const n=NOW();return {gpt:{fetchedAt:n,windows:[
  {id:'codex:secondary',bucket:'codex',group:'共享额度',label:'每周',minutes:10080,used:38,remaining:62,resetsAt:n+86400*2+3600*4+27*60},
  {id:'codex:primary',bucket:'codex',group:'共享额度',label:'5 小时',minutes:300,used:24,remaining:76,resetsAt:n+3600*2+14*60}],
  models:[{id:'gpt-6.1-sol',name:'GPT-6.1 Sol',isDefault:true},{id:'gpt-6-astra',name:'GPT-6 Astra',isDefault:false}],plan:'plus',resetCredits:{availableCount:2,credits:[]}},
  claude:{fetchedAt:n,windows:[{id:'seven_day',group:'Claude',label:'每周',minutes:10080,used:67,remaining:33,resetsAt:n+86400+3600*8+42*60},
  {id:'five_hour',group:'Claude',label:'5 小时',minutes:300,used:46,remaining:54,resetsAt:n+3600+38*60}]}};}
async function startServer(options={}) {
  const demo=options.demo || process.argv.includes('--demo');
  const dataDir=process.env.USAGE_DATA_DIR || path.join(os.homedir(),'Library/Application Support/Usage Together');
  const cacheFile=path.join(dataDir,'usage.json');let state={gpt:{windows:[]},claude:{windows:[]}};
  if(demo)state=demoState();else try{const cached=JSON.parse(fs.readFileSync(cacheFile,'utf8'));for(const p of ['gpt','claude'])if(cached[p]?.windows)state[p]=cached[p];}catch{}
  const busy=new Set(),last=new Map(),retry=new Map();let stopping=false;
  function save(){if(demo)return;try{fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
    fs.writeFileSync(cacheFile+'.tmp',JSON.stringify(state),{mode:0o600});fs.renameSync(cacheFile+'.tmp',cacheFile);}catch{}
  }
  async function update(provider,force=false) {
    const n=NOW();if(stopping || demo || busy.has(provider) || n<(retry.get(provider)||0) || n-(last.get(provider)||0)<(force?30:INTERVAL))return;
    busy.add(provider);last.set(provider,n);
    try{const fresh=await (provider==='gpt'?fetchCodex():fetchClaude());state[provider]={...fresh,error:null};retry.delete(provider);}
    catch(error){state[provider]={...state[provider],error:provider==='gpt'?friendlyCodexError(error):error.message,errorAt:NOW()};
      if(error.retryAfter)retry.set(provider,NOW()+error.retryAfter);}
    finally{busy.delete(provider);save();}
  }
  function refresh(force=false){return Promise.allSettled(['gpt','claude'].map(p=>update(p,force)));}
  const key=crypto.randomBytes(24).toString('hex');const prefix='/'+key+'/';
  const html=fs.readFileSync(path.join(__dirname,'index.html'));
  let requestedAction=null;const nativeStatus={visible:null,compact:null,events:[]};
  const server=http.createServer((req,res)=>{
    const origin=req.headers.origin;
    if(req.headers.host!==`127.0.0.1:${server.address().port}` || (origin && origin!==`http://127.0.0.1:${server.address().port}`)) {res.writeHead(403);res.end();return;}
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(!pathname.startsWith(prefix)){res.writeHead(404);res.end();return;}
    const route=pathname.slice(prefix.length);
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    function json(value){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}
    if(req.method==='GET' && route==='state'){json({...state,demo,refreshing:[...busy],serverTime:NOW(),nativeStatus});return;}
    if(req.method==='POST' && /^host\/(show|hide|compact|expand)\/[01]$/.test(route)){const parts=route.split('/');nativeStatus.visible=parts[2]==='1';if(parts[1]==='compact' || parts[1]==='expand')nativeStatus.compact=parts[1]==='compact';nativeStatus.events.push({action:parts[1],visible:nativeStatus.visible,at:NOW()});nativeStatus.events=nativeStatus.events.slice(-20);json({ok:true});return;}
    if(req.method==='POST' && route==='refresh'){refresh(true);json({ok:true});return;}
    if(req.method==='POST' && route.startsWith('action/')){
      const action=route.slice(7);if(!['hide','show','compact','expand','quit'].includes(action)){res.writeHead(400);res.end();return;}
      json({ok:true});if(action==='quit' && options.onQuit){setTimeout(options.onQuit,80);return;}requestedAction=action;return;
    }
    if(req.method==='GET' && route==='native'){const action=requestedAction;requestedAction=null;json({action,state,refreshing:[...busy]});return;}
    const allowed={'': ['text/html',html],'ui.js':['text/javascript',null],'style.css':['text/css',null]};
    if(req.method==='GET' && Object.hasOwn(allowed,route)) {const [mime,data]=allowed[route];res.setHeader('Content-Type',mime);res.end(data || fs.readFileSync(path.join(__dirname,route)));return;}
    res.writeHead(404);res.end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port || 0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}${prefix}`;
  const timer=setInterval(()=>refresh(),30000);
  const stop=()=>{stopping=true;clearInterval(timer);stopChildren();server.close();};
  if(options.autoRefresh!==false)refresh(true);
  return {url,state,refresh,server,stop};
}
function friendlyCodexError(error){const s=String(error.message || '');
  if(/auth|login|sign.?in|credential|unauthor|401|not logged/i.test(s))return 'Codex 尚未登录或登录已过期。请在 ChatGPT/Codex 中登录，然后刷新。';
  if(/rate.?limit|429/i.test(s))return 'Codex 接口暂时限流，稍后自动重试。';
  if(/not support|method not found|unknown method/i.test(s))return '本机 Codex 版本过旧，请更新官方应用后刷新。';
  // Avoid leaking raw server responses, paths, or credentials to the UI/cache.
  if(['未找到','无法启动','查询超时','连接已','进程已'].some(t=>s.includes(t)))return s;
  return 'Codex 用量查询失败。请检查网络和登录状态，并确认使用的是订阅账户。';
}
module.exports={percent,epoch,duration,normalizeCodex,normalizeClaude,extractToken,RPC,fetchCodex,fetchClaude,startServer,demoState};
if(require.main===module){
let application;
const closeApplication=()=>{
  application?.stop();
  const hostIndex=process.argv.indexOf('--host-pid');
  const hostPid=hostIndex>=0?Number(process.argv[hostIndex+1]):null;
  if(process.argv.includes('--native-host') && Number.isInteger(hostPid) && hostPid>1 && hostPid===process.ppid){
    try{process.kill(hostPid,'SIGTERM');}catch{}
  }
  process.exit(0);
};
startServer({onQuit:closeApplication}).then(app=>{
  application=app;
  process.stdout.write(app.url+'\n');
  if(process.argv.includes('--native-host')){process.stdin.resume();process.stdin.on('end',()=>{app.stop();process.exit(0);});}
  process.on('SIGTERM',()=>{app.stop();process.exit(0);});process.on('SIGINT',()=>{app.stop();process.exit(0);});
}).catch(()=>{process.stderr.write('无法启动本地用量服务。\n');process.exit(1);});

}
