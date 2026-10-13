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
const VERSION='2.3.3';
const INTERVAL = 300;            // usage refresh, seconds
const TIBO_INTERVAL = 600;       // Tibo check, seconds
const HOUR = 3600, DAY = 86400;
const CREDIT_WINDOW = 3 * DAY;   // start reminding 3 days before expiry
const CREDIT_EVERY = 12 * HOUR;  // then every 12 hours
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const children = new Set();
function stopChildren(){for(const child of children){child.kill();const t=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},1000);t.unref();}}
function percent(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}
function epoch(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v / 1000 : v;
  if (typeof v !== 'string' || !v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return epoch(Number(v));
  const n = Date.parse(v) / 1000; return Number.isFinite(n) ? n : null;
}
function duration(mins, fallback) {
  if (!(mins > 0)) return fallback;
  if (mins === 10080) return '每周';
  if (mins >= 1440 && mins % 1440 === 0) return `${mins / 1440} 天`;
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60} 小时`;
  return `${mins} 分钟`;
}
function left(s){s=Math.max(0,Math.round(s));const d=Math.floor(s/DAY),h=Math.floor(s%DAY/HOUR),m=Math.floor(s%HOUR/60);
  return d?`${d} 天 ${h} 小时`:h?`${h} 小时 ${m} 分`:`${m} 分钟`;}
function when(t){return new Date(t*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}

/* ---------- HTTP: macOS networking first (follows system proxy, Safari-like TLS), Node fetch as fallback ---------- */
const HTTP_HELPER = `ObjC.import('Foundation');
function run(){
 var input=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
 var spec=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input,$.NSUTF8StringEncoding)));
 var req=$.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(spec.url));
 req.HTTPMethod=spec.method||'GET';req.timeoutInterval=spec.timeout||20;req.HTTPShouldHandleCookies=false;
 req.cachePolicy=$.NSURLRequestReloadIgnoringLocalCacheData;
 var h=spec.headers||{};for(var k in h)req.setValueForHTTPHeaderField(String(h[k]),k);
 if(spec.body)req.HTTPBody=$(String(spec.body)).dataUsingEncoding($.NSUTF8StringEncoding);
 var resp=Ref(),err=Ref();
 var data=$.NSURLConnection.sendSynchronousRequestReturningResponseError(req,resp,err);
 var status=0,body='',error=null;
 try{if(resp[0]&&!resp[0].isNil())status=Number(resp[0].statusCode)||0;}catch(e){}
 try{if(data&&!data.isNil()){var s=$.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding);if(s&&!s.isNil())body=ObjC.unwrap(s);}}catch(e){}
 try{if(err[0]&&!err[0].isNil())error=ObjC.unwrap(err[0].localizedDescription);}catch(e){}
 return JSON.stringify({status:status,body:body,error:error});
}`;
function nativeRequest(spec){
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/osascript',['-l','JavaScript','-e',HTTP_HELPER],{stdio:['pipe','pipe','ignore']});children.add(child);
    let out='';const timer=setTimeout(()=>child.kill('SIGKILL'),((spec.timeout||20)+10)*1000);
    child.stdout.on('data',d=>{out+=d;});
    child.on('error',e=>{clearTimeout(timer);children.delete(child);reject(e);});
    child.on('close',()=>{clearTimeout(timer);children.delete(child);try{resolve(JSON.parse(out.trim()));}catch{reject(new Error('native http failed'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(spec));
  });
}
async function request(url,{headers={},method='GET',body=null,timeout=20}={}){
  if(process.platform==='darwin'){
    try{const r=await nativeRequest({url,headers,method,body,timeout});if(r.status)return r;}catch{}
  }
  try{const r=await fetch(url,{method,headers,body,signal:AbortSignal.timeout(timeout*1000)});return {status:r.status,body:await r.text(),error:null};}
  catch{const e=new Error('network');e.network=true;throw e;}
}
const looksHTML=s=>/^\s*</.test(s||'');

/* ---------- GPT / Codex ---------- */
const isReserved=(...names)=>names.some(n=>/reserv/i.test(String(n||'')));
function normalizeCodex(payload) {
  let buckets = payload?.rateLimitsByLimitId;
  if (!buckets || !Object.keys(buckets).length) {
    buckets = payload?.rateLimits ? {[payload.rateLimits.limitId || 'codex']: payload.rateLimits} : {};
  }
  const keys=Object.keys(buckets).filter(k=>!isReserved(k,buckets[k]?.limitName));
  const mainId = [payload?.rateLimits?.limitId, 'codex', keys[0]].find(k=>k && keys.includes(k)) || null;
  const windows = [];
  for (const key of keys) {
    const bucket=buckets[key];
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [slot, fallback] of [['primary','主要窗口'],['secondary','次要窗口']]) {
      const w = bucket[slot]; if (!w || typeof w !== 'object') continue;
      const used = percent(w.usedPercent);
      windows.push({id: `${key}:${slot}`, bucket: key, main: key===mainId, group: bucket.limitName || (key === 'codex' ? '共享额度' : key),
        label: duration(w.windowDurationMins, fallback), minutes: w.windowDurationMins ?? null,
        used, remaining: used === null ? null : 100-used, resetsAt: epoch(w.resetsAt)});
    }
  }
  return {windows, plan: Object.values(buckets).find(b=>b?.planType)?.planType || null,
    resetCredits: normalizeCredits(payload?.rateLimitResetCredits ?? null)};
}
function normalizeCredits(rc){
  if(!rc || typeof rc!=='object')return null;
  const credits=(Array.isArray(rc.credits)?rc.credits:[]).map((c,i)=>({...c,
    id:c.id ?? c.creditId ?? c.credit_id ?? null, status:c.status ?? null,
    expiresAt:epoch(c.expiresAt ?? c.expires_at ?? c.expiry ?? null)}));
  const count=typeof rc.availableCount==='number'?rc.availableCount:typeof rc.available_count==='number'?rc.available_count:
    credits.filter(usable).length;
  return {availableCount:count,credits};
}
const usable=c=>!c.status || /avail|active|unused|valid/i.test(String(c.status));
function findCodex() {
  const candidates = [process.env.USAGE_CODEX_PATH,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
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
    await rpc.call('initialize',{clientInfo:{name:'usage_together',title:'Usage Together',version:VERSION}});
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

/* ---------- Claude ---------- */
const CLAUDE_NAMES = {five_hour:'5 小时', seven_day:'每周',seven_day_opus:'每周 · Opus',
  seven_day_sonnet:'每周 · Sonnet',seven_day_cowork:'每周 · Cowork',seven_day_oauth_apps:'每周 · OAuth apps',
  seven_day_overage_included:'每周 · 额外用量'};
function normalizeClaude(payload) {
  const result = new Map();
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
// Claude may report reset credits under different names; look for any credit list with expiry dates.
function claudeCredits(payload){
  const queue=[[payload,'']];
  for(let i=0;i<queue.length && i<200;i++){
    const [obj,key]=queue[i];if(!obj || typeof obj!=='object')continue;
    if(/credit/i.test(key)){
      const list=Array.isArray(obj)?obj:Array.isArray(obj.credits)?obj.credits:null;
      if(list && list.some(c=>c && typeof c==='object' && (c.expires_at || c.expiresAt)))
        return normalizeCredits(Array.isArray(obj)?{credits:obj}:obj);
    }
    for(const [k,v] of Object.entries(obj))if(v && typeof v==='object')queue.push([v,k]);
  }
  return null;
}
function extractOAuth(blob) {
  let parsed;try{parsed=JSON.parse(blob);}catch{return null;}
  const queue=[parsed];for(let i=0;i<queue.length && i<30;i++){
    const obj=queue[i];if(!obj || typeof obj!=='object')continue;
    const access=obj.accessToken || obj.access_token;
    if(typeof access==='string' && access)return {token:access,expiresAt:epoch(obj.expiresAt ?? obj.expires_at ?? null)};
    queue.push(...Object.values(obj).filter(v=>v && typeof v==='object'));
  }return null;
}
const extractToken=blob=>extractOAuth(blob)?.token || null;
async function claudeCodeCredentials() {
  for (const service of ['Claude Code-credentials','Claude Code','claude-code-credentials']) {
    try {const {stdout}=await exec('/usr/bin/security',['find-generic-password','-s',service,'-w'],{timeout:12000,maxBuffer:128*1024});
      const c=extractOAuth(stdout);if(c)return c;
    }catch{/* Never log Keychain output, subprocess arguments, or secrets. */}
  }
  const dirs=[process.env.CLAUDE_CONFIG_DIR,path.join(os.homedir(),'.claude'),path.join(os.homedir(),'.config/claude')].filter(Boolean);
  for(const d of dirs){try{const c=extractOAuth(fs.readFileSync(path.join(d,'.credentials.json'),'utf8'));if(c)return c;}catch{}}
  return null;
}
function claudeResult(payload,source){
  const windows=normalizeClaude(payload);if(!windows.length)throw new Error(`${source}：Claude 暂未返回额度窗口。`);
  return {fetchedAt:NOW(),windows,models:[],source,resetCredits:claudeCredits(payload),note:null};
}
async function fetchClaudeOAuth(cred){
  if(cred.expiresAt && cred.expiresAt<NOW()+60)throw new Error('Claude Code 的登录已过期（打开一次 Claude Code 就会自动续期）。');
  let r;try{r=await request('https://api.anthropic.com/api/oauth/usage',{headers:{Authorization:`Bearer ${cred.token}`,Accept:'application/json',
    'anthropic-beta':'oauth-2025-04-20','User-Agent':`usage-together/${VERSION}`},timeout:18});}
  catch{throw new Error('Claude Code 用量查询失败，请检查网络。');}
  if(r.status!==200){
    const messages={401:'Claude Code 登录已过期，请重新登录 Claude Code。',403:'Claude Code 登录权限不足。',429:'Claude Code 用量接口暂时限流。'};
    const error=new Error(messages[r.status] || `Claude Code 用量接口暂不可用（HTTP ${r.status}）。`);
    if(r.status===429)error.retryAfter=900;throw error;
  }
  let payload;try{payload=JSON.parse(r.body);}catch{throw new Error('Claude Code 接口返回了无法识别的数据。');}
  return claudeResult(payload,'Claude Code');
}
// --- Claude desktop app login (reads its own cookie store; nothing is written or sent anywhere except claude.ai) ---
let safeStoragePassword=null;
async function desktopPassword(){
  if(safeStoragePassword)return safeStoragePassword;
  try{const {stdout}=await exec('/usr/bin/security',['find-generic-password','-s','Claude Safe Storage','-w'],{timeout:60000,maxBuffer:64*1024});
    safeStoragePassword=stdout.replace(/\n$/,'');return safeStoragePassword;}
  catch{throw new Error('读取 Claude 桌面版登录需要钥匙串授权：弹窗出现时请点「始终允许」，然后点刷新。');}
}
function desktopCookieFiles(){
  const base=path.join(os.homedir(),'Library/Application Support/Claude');
  const list=[path.join(base,'Cookies'),path.join(base,'Network/Cookies')];
  try{for(const p of fs.readdirSync(path.join(base,'Partitions')))list.push(path.join(base,'Partitions',p,'Cookies'),path.join(base,'Partitions',p,'Network/Cookies'));}catch{}
  return list.filter(f=>{try{return fs.statSync(f).isFile();}catch{return false;}})
    .sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
}
async function sqliteJSON(file,sql){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'usage-together-'));
  try{
    for(const s of ['','-wal','-shm'])try{fs.copyFileSync(file+s,path.join(tmp,'db'+s));}catch{}
    const {stdout}=await exec('/usr/bin/sqlite3',['-json',path.join(tmp,'db'),sql],{timeout:15000,maxBuffer:8*1024*1024});
    return stdout.trim()?JSON.parse(stdout):[];
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
}
function decryptCookie(hex,password,host,version){
  const buf=Buffer.from(hex||'','hex');if(!buf.length)return '';
  if(buf.subarray(0,3).toString()!=='v10')return null;
  const key=crypto.pbkdf2Sync(password,'saltysalt',1003,16,'sha1');
  const d=crypto.createDecipheriv('aes-128-cbc',key,Buffer.alloc(16,' '));
  let out=Buffer.concat([d.update(buf.subarray(3)),d.final()]);
  const digest=crypto.createHash('sha256').update(host).digest();
  if(out.length>=32 && (version>=24 || out.subarray(0,32).equals(digest)))out=out.subarray(32);
  return out.toString('utf8');
}
async function desktopLogin(){
  const files=desktopCookieFiles();if(!files.length)return null;
  let password=null;
  for(const file of files){
    let rows,meta;
    try{rows=await sqliteJSON(file,"select host_key,name,value,hex(encrypted_value) as ev from cookies where host_key in ('claude.ai','.claude.ai')");
      meta=await sqliteJSON(file,"select value from meta where key='version'");}catch{continue;}
    if(!rows.some(r=>r.name==='sessionKey'))continue;
    const version=Number(meta?.[0]?.value)||0;const jar={};
    for(const r of rows){
      let v=r.value;
      if(!v && r.ev){password=password||await desktopPassword();try{v=decryptCookie(r.ev,password,r.host_key,version);}catch{v=null;}}
      if(v && /^[\x21-\x7e]+$/.test(v))jar[r.name]=v;
    }
    if(!jar.sessionKey)continue;
    return {cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),org:jar.lastActiveOrg||null};
  }
  throw new Error('找到了 Claude 桌面版，但读不到登录信息。请确认桌面版已登录，或在下方粘贴 sessionKey。');
}
async function fetchClaudeWeb(cookie,orgHint,source){
  const headers={Cookie:cookie,Accept:'application/json','User-Agent':UA,Referer:'https://claude.ai/settings/usage',
    'anthropic-client-platform':'web_claude_ai','Accept-Language':'zh-CN,zh;q=0.9,en;q=0.8'};
  const get=async url=>{let r;try{r=await request(url,{headers,timeout:18});}catch{throw new Error(`${source}：连接 claude.ai 失败，请检查网络或代理。`);}
    if(r.status===200){try{return JSON.parse(r.body);}catch{throw new Error(`${source}：claude.ai 返回了无法识别的数据。`);}}
    const e=new Error(r.status===429?`${source}：claude.ai 暂时限流。`:looksHTML(r.body)&&r.status===403?`${source}：被 claude.ai 的安全验证拦下了，稍后会自动重试。`:
      r.status===401||r.status===403?`${source}：登录已失效，请在 Claude 桌面版重新登录（或更新 sessionKey）。`:`${source}：claude.ai 接口暂不可用（HTTP ${r.status}）。`);
    e.status=r.status;if(r.status===429)e.retryAfter=900;throw e;};
  const uuid=v=>typeof v==='string' && /^[0-9a-f-]{36}$/i.test(v);
  const orgs=async()=>{const list=await get('https://claude.ai/api/organizations');
    const arr=Array.isArray(list)?list:[];const paid=arr.find(o=>(o.capabilities||[]).some(c=>/claude_(pro|max)|raven/i.test(c)));
    const org=(paid||arr.find(o=>(o.capabilities||[]).includes('chat'))||arr[0])?.uuid;
    if(!uuid(org))throw new Error(`${source}：没有找到 Claude 账户组织。`);return org;};
  let org=uuid(orgHint)?orgHint:await orgs();
  let payload;
  try{payload=await get(`https://claude.ai/api/organizations/${org}/usage`);}
  catch(e){if(org!==orgHint || ![403,404].includes(e.status))throw e;org=await orgs();payload=await get(`https://claude.ai/api/organizations/${org}/usage`);}
  return claudeResult(payload,source);
}
async function fetchClaude(dataDir) {
  const errors=[];
  const cred=await claudeCodeCredentials();
  if(cred){try{return await fetchClaudeOAuth(cred);}catch(e){errors.push(e);}}
  const manual=readSessionKey(dataDir);
  if(manual){try{return await fetchClaudeWeb(`sessionKey=${manual}`,null,'手动 sessionKey');}catch(e){errors.push(e);}}
  try{const login=await desktopLogin();if(login)return await fetchClaudeWeb(login.cookie,login.org,'Claude 桌面版');}catch(e){errors.push(e);}
  if(!errors.length)throw new Error('没有找到 Claude 登录信息。请登录 Claude 桌面版或 Claude Code，也可以在下方粘贴 sessionKey。');
  const error=new Error([...new Set(errors.map(e=>e.message))].join(' '));
  if(errors.every(e=>e.retryAfter))error.retryAfter=900;
  throw error;
}
function sessionKeyFile(dataDir){return path.join(dataDir,'claude-session-key');}
function readTheme(dataDir){try{return fs.readFileSync(path.join(dataDir,'theme.txt'),'utf8').trim()==='light'?'light':'dark';}catch{return 'dark';}}
function readSessionKey(dataDir){try{const v=fs.readFileSync(sessionKeyFile(dataDir),'utf8').trim();return /^sk-ant-[\w-]{20,}$/.test(v)?v:null;}catch{return null;}}

/* ---------- Tibo (Codex lead at OpenAI) reset announcements ---------- */
const TIBO_SOURCES=[
  {type:'rss',name:'X 镜像 · kareem',url:'https://nitter.kareem.one/thsottiaux/rss'},
  {type:'syndication',name:'X',url:'https://syndication.twitter.com/srv/timeline-profile/screen-name/thsottiaux'},
];
const RESET_RE=/\b(reset|resets|resetting|refresh(?:ed|ing)?|replenish\w*|top(?:ped|ping)? up)\b|重置|刷新/i;
const LIMIT_RE=/\b(rate[- ]?limits?|usage[- ]?limits?|limits?|usage|quota|codex|tokens?|banked)\b|额度|限额|用量|重置券/i;
const trustedTibo=p=>p.kind!=='news' && String(p.author||'').replace(/^@/,'').toLowerCase()==='thsottiaux'
  && /^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(p.url||'');
function resetPhase(p){
  if(!trustedTibo(p))return null;
  const text=p.text||'';
  if(!RESET_RE.test(text))return null;
  if(/\b(?:no|not|never|won't|will not|cannot|can't)\s+(?:\w+\s+){0,3}resets?\b|\bneeds?\s+(?:a\s+)?reset\b|\b(?:can|could|should|would)\s+(?:we|you|someone)\b.{0,30}\breset\b/i.test(text))return null;
  if(/\breset(?:ting)?\s+(?:the\s+|your\s+|a\s+)?(?:password|context|cache|conversation|branch|repository)\b/i.test(text)
    && !/\b(?:rate|usage)[- ]?limits?\b/i.test(text))return null;
  if(!LIMIT_RE.test(text) && !/\bglobal\s+reset\b|^Day\s+\d+\s*\/\s*Reset[.!]?$/i.test(text))return null;
  if(/\bbanked\b|\b(?:free|bonus|extra)\s+(?:rate limit\s+)?reset\b|\breset\s+credits?\b|重置券/i.test(text))return 'banked';
  if(/\b(?:have|has|had|already|just)\s+(?:been\s+)?reset\b|\breset\b.{0,30}\b(?:processed|complete[ds]?|done|landed)\b|已(?:经)?重置/i.test(text))return 'completed';
  if(/\b(?:will|going to|about to|resetting|tomorrow|next|upcoming)\b|\bby\s+(?:EOD|end of|tonight)\b|即将|将会/i.test(text))return 'upcoming';
  return 'announcement';
}
const isResetPost=p=>resetPhase(p)!==null;
function tiboMessage(a){
  const title={upcoming:'Tibo：额度即将重置',completed:'Tibo：额度已重置',banked:'Tibo：重置券消息',announcement:'Tibo：额度重置消息'}[a.phase]||'Tibo：额度重置消息';
  return {title,body:`${a.phase==='upcoming'?'可在重置前使用剩余额度。':''}「${a.text.slice(0,180)}」`};
}
function activeTiboAlert(tibo,n=NOW()){
  if(tibo?.pendingReset)return {...tibo.pendingReset,persistent:true};
  const a=tibo?.alert;return a && a.at<=n+600 && n-a.at<(a.window||DAY)?a:null;
}
function weeklyObservation(p,n=NOW()){
  if(!p || p.error || !Number.isFinite(p.fetchedAt) || n-p.fetchedAt>600 || p.fetchedAt>n+600)return null;
  const w=summarize('gpt',p).weekly;
  if(!w || !Number.isFinite(w.used))return null;
  return {id:w.id,used:w.used,resetsAt:w.resetsAt,fetchedAt:p.fetchedAt};
}
function weeklyWasReset(before,after){
  if(!before || !after || before.id!==after.id || after.fetchedAt<=before.fetchedAt)return false;
  // A new weekly period, zeroed usage, or a substantial weekly replenishment.
  // The five-hour window is deliberately never consulted.
  return (Number.isFinite(before.resetsAt) && Number.isFinite(after.resetsAt) && after.resetsAt>before.resetsAt+60)
    || (before.used>0 && after.used===0) || before.used-after.used>=5;
}
function observeWeeklyReset(tibo,gpt,n=NOW()){
  const pending=tibo.pendingReset,latest=weeklyObservation(gpt,n);
  if(!pending || !latest)return false;
  if(!pending.weeklyBefore || pending.weeklyBefore.id!==latest.id){pending.weeklyBefore=latest;return false;}
  if(!weeklyWasReset(pending.weeklyBefore,latest)){
    // Usage can rise while the warning is held; retain the newest pre-reset observation.
    if(latest.fetchedAt>pending.weeklyBefore.fetchedAt)pending.weeklyBefore=latest;
    return false;
  }
  tibo.resolvedThroughAt=Math.max(tibo.resolvedThroughAt||0,latest.fetchedAt);
  tibo.resolvedReset={id:pending.id,at:n,weeklyAfter:latest};
  tibo.pendingReset=null;
  if(['upcoming','announcement'].includes(tibo.alert?.phase))tibo.alert=null;
  return true;
}
function latchResetPost(tibo,hit,gpt,n=NOW()){
  if(!hit || !['upcoming','announcement'].includes(hit.phase) || hit.at<=(tibo.resolvedThroughAt||0))return;
  if(tibo.pendingReset){
    if(hit.at>tibo.pendingReset.at){const {kind,...post}=hit;tibo.pendingReset={...tibo.pendingReset,...post,text:hit.text.slice(0,400)};}
    return;
  }
  const {kind,...post}=hit;
  tibo.pendingReset={...post,text:hit.text.slice(0,400),firstDetectedAt:n,weeklyBefore:weeklyObservation(gpt,n)};
}
function selectTiboPost(posts,n=NOW()){
  return posts.map(p=>({...p,phase:resetPhase(p)})).filter(p=>p.phase && p.at && p.at<=n+600 && n-p.at<(p.window||DAY))
    .sort((a,b)=>b.at-a.at)[0]||null;
}
function decode(s){return String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ')
  .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(+d))
  .replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
  .replace(/\s+/g,' ').trim();}
function parseRss(xml,src){
  const tag=(item,t)=>{const m=item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`,'i'));return m?m[1]:'';};
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m=>{
    const item=m[1];let link=decode(tag(item,'link'));
    if(src.type!=='news')link=link.replace(/^https?:\/\/[^/]+/,'https://x.com').replace(/#m$/,'');
    const title=decode(tag(item,'title'));
    // A quoted older post must not make an unrelated new post look like a new reset.
    const desc=decode(tag(item,'description').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').split(/<hr\s*\/?\s*>|<blockquote\b/i)[0]);
    return {id:(link.match(/status\/(\d+)/)||[])[1]||crypto.createHash('sha1').update(link||title).digest('hex').slice(0,16),
      text:src.type==='news'?title:(desc||title.replace(/^R to @[^:]+:\s*/i,'')),author:decode(tag(item,'dc:creator')),
      at:epoch(decode(tag(item,'pubDate'))),url:/^https:\/\//.test(link)?link:null,
      kind:src.type,sourceName:src.name,window:src.type==='news'?12*HOUR:DAY};
  }).filter(p=>p.text && p.at);
}
function parseSyndication(html,src){
  const m=String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);if(!m)return [];
  let data;try{data=JSON.parse(m[1]);}catch{return [];}
  const out=[],queue=[data];
  for(let i=0;i<queue.length && i<20000;i++){const o=queue[i];if(!o || typeof o!=='object')continue;
    if(o.id_str && (o.full_text || o.text) && o.created_at)out.push({id:o.id_str,text:decode(o.full_text||o.text),at:epoch(o.created_at),
      author:o.user?.screen_name||null,url:`https://x.com/${o.user?.screen_name||'unknown'}/status/${o.id_str}`,kind:'tweet',sourceName:src.name,window:DAY});
    else for(const v of Object.values(o))if(v && typeof v==='object')queue.push(v);}
  return out.filter(p=>p.at);
}
async function fetchTiboPosts({requestFn=request,sources=TIBO_SOURCES}={}){
  const failures=[];
  const headers={'User-Agent':UA,Accept:'text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9'};
  for(const src of sources){
    try{const r=await requestFn(src.url,{headers,timeout:12});if(r.status!==200){failures.push(`${src.name}: HTTP ${r.status}`);continue;}
      const list=src.type==='rss'?parseRss(r.body,src):parseSyndication(r.body,src);
      const posts=list.filter(trustedTibo);
      if(posts.length)return {posts,source:src.name,latestPostAt:Math.max(...posts.map(p=>p.at))};
      failures.push(`${src.name}: 未读到有效原帖`);
    }catch{failures.push(`${src.name}: 连接失败`);}
  }
  throw new Error(failures.join('；')||'没有可用的原帖来源');
}

/* ---------- views shared by the window and the menu bar ---------- */
function summarize(id,p){
  const ws=(p?.windows||[]).filter(w=>!isReserved(w.bucket,w.group,w.label,w.id));
  let primary=ws;
  if(id==='gpt'){const main=ws.find(w=>w.main)?.bucket || (ws.some(w=>w.bucket==='codex')?'codex':ws[0]?.bucket);primary=ws.filter(w=>w.bucket===main);}
  const session=primary.find(w=>w.minutes===300 || w.id==='five_hour') || [...primary].filter(w=>w.minutes).sort((a,b)=>a.minutes-b.minutes)[0] || null;
  const rest=primary.filter(w=>w!==session);
  const weekly=rest.find(w=>w.id==='seven_day') || rest.find(w=>w.minutes===10080) || rest.find(w=>(w.minutes||0)>300) || null;
  return {session,weekly,others:ws.filter(w=>w!==session && w!==weekly)};
}
function expiringCredits(p,n=NOW()){
  return (p?.resetCredits?.credits||[]).filter(c=>usable(c) && c.expiresAt && c.expiresAt>n && c.expiresAt-n<=CREDIT_WINDOW)
    .sort((a,b)=>a.expiresAt-b.expiresAt);
}
function demoState(){const n=NOW();return {gpt:{fetchedAt:n,windows:[
  {id:'codex:secondary',bucket:'codex',main:true,group:'共享额度',label:'每周',minutes:10080,used:38,remaining:62,resetsAt:n+86400*2+3600*4+27*60},
  {id:'codex:primary',bucket:'codex',main:true,group:'共享额度',label:'5 小时',minutes:300,used:24,remaining:76,resetsAt:n+3600*2+14*60}],
  models:[{id:'gpt-6.1-sol',name:'GPT-6.1 Sol',isDefault:true},{id:'gpt-6-astra',name:'GPT-6 Astra',isDefault:false}],plan:'plus',
  resetCredits:{availableCount:2,credits:[{id:'demo1',status:'available',expiresAt:n+86400*2+3600*5},{id:'demo2',status:'available',expiresAt:n+86400*9}]}},
  claude:{fetchedAt:n,source:'Claude 桌面版',windows:[{id:'seven_day',group:'Claude',label:'每周',minutes:10080,used:67,remaining:33,resetsAt:n+86400+3600*8+42*60},
  {id:'five_hour',group:'Claude',label:'5 小时',minutes:300,used:46,remaining:54,resetsAt:n+3600+38*60},
  {id:'seven_day_opus',group:'Claude',label:'每周 · Opus',minutes:10080,used:12,remaining:88,resetsAt:n+86400+3600*8}]}};}

async function startServer(options={}) {
  const demo=options.demo || process.argv.includes('--demo');
  const dataDir=process.env.USAGE_DATA_DIR || path.join(os.homedir(),'Library/Application Support/Usage Together');
  const cacheFile=path.join(dataDir,'usage.json'),reminderFile=path.join(dataDir,'reminders.json'),tiboFile=path.join(dataDir,'tibo.json');
  let state={gpt:{windows:[]},claude:{windows:[]}};
  if(demo)state=demoState();else try{const cached=JSON.parse(fs.readFileSync(cacheFile,'utf8'));for(const p of ['gpt','claude'])if(cached[p]?.windows)state[p]=cached[p];}catch{}
  let reminders={credit:{},tiboNotified:[],tiboDismissed:[]};
  try{reminders={...reminders,...JSON.parse(fs.readFileSync(reminderFile,'utf8'))};}catch{}
  const notifications=[];
  let tibo=demo?{checkedAt:NOW(),ok:true,source:'X',alert:{id:'demo',text:'We are resetting Codex rate limits for all paid plans in the next hour. Enjoy!',at:NOW()-1800,url:'https://x.com/thsottiaux',sourceName:'X'}}
    :{checkedAt:null,lastSuccessAt:null,latestPostAt:null,ok:null,source:null,alert:null};
  if(demo)latchResetPost(tibo,{...tibo.alert,phase:'upcoming'},state.gpt);
  if(!demo)try{const cached=JSON.parse(fs.readFileSync(tiboFile,'utf8'));tibo={...tibo,...cached,ok:null};
    // Migrate the previous release's current warning, including an acknowledged one.
    if(!Object.hasOwn(cached,'pendingReset'))latchResetPost(tibo,activeTiboAlert(tibo),state.gpt);
    if(!tibo.pendingReset)tibo.alert=activeTiboAlert(tibo);
  }catch{}
  let tiboBusy=false,tiboLast=0;
  const busy=new Set(),last=new Map(),retry=new Map();let stopping=false;
  function writeJSON(file,value){if(demo)return;try{fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
    fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file);}catch{}}
  const save=()=>writeJSON(cacheFile,state),saveReminders=()=>writeJSON(reminderFile,reminders);
  function notify(n){notifications.push({...n,at:NOW()});if(notifications.length>20)notifications.shift();}
  function checkReminders(){
    const n=NOW();let changed=false;
    for(const [id,name] of [['gpt','GPT / Codex'],['claude','Claude']]){
      const list=expiringCredits(state[id],n);let fire=false;
      for(const c of list){const key=`${id}:${c.id ?? Math.round(c.expiresAt)}`;
        const slot=Math.floor((n-(c.expiresAt-CREDIT_WINDOW))/CREDIT_EVERY);
        if(reminders.credit[key]?.slot!==slot){reminders.credit[key]={slot,exp:c.expiresAt};fire=true;changed=true;}}
      if(fire)notify({title:'重置券快到期了',subtitle:name,
        body:`${name} 有 ${list.length} 张重置券将在 ${left(list[0].expiresAt-n)} 后到期（${when(list[0].expiresAt)}），记得及时用掉。`});
    }
    for(const [k,v] of Object.entries(reminders.credit))if(!v || v.exp<n-DAY){delete reminders.credit[k];changed=true;}
    const a=activeTiboAlert(tibo,n);
    if(a && !reminders.tiboNotified.includes(a.id) && (a.persistent || !reminders.tiboDismissed.includes(a.id))){
      reminders.tiboNotified=[...reminders.tiboNotified,a.id].slice(-50);changed=true;
      notify({...tiboMessage(a),subtitle:'Tibo 的 X 动态'});
    }
    if(changed)saveReminders();
  }
  async function update(provider,force=false) {
    const n=NOW();if(stopping || demo || busy.has(provider) || n<(retry.get(provider)||0) || n-(last.get(provider)||0)<(force?30:INTERVAL))return;
    busy.add(provider);last.set(provider,n);
    try{const fresh=await (provider==='gpt'?(options.fetchCodex||fetchCodex)():fetchClaude(dataDir));state[provider]={...fresh,error:null};retry.delete(provider);}
    catch(error){state[provider]={...state[provider],error:provider==='gpt'?friendlyCodexError(error):error.message,errorAt:NOW()};
      if(error.retryAfter)retry.set(provider,NOW()+error.retryAfter);}
    finally{busy.delete(provider);save();if(provider==='gpt' && tibo.pendingReset){observeWeeklyReset(tibo,state.gpt);writeJSON(tiboFile,tibo);}checkReminders();}
  }
  async function checkTibo(force=false){
    const n=NOW();if(demo || stopping || tiboBusy || n-tiboLast<(force?60:TIBO_INTERVAL))return;
    tiboBusy=true;tiboLast=n;
    try{const {posts,source,latestPostAt}=await (options.fetchTiboPosts||fetchTiboPosts)();
      const hit=selectTiboPost(posts,NOW());
      const previous=tibo.alert && activeTiboAlert({alert:tibo.alert});
      const latest=hit && (!previous || hit.at>=previous.at)?hit:previous;
      tibo={...tibo,checkedAt:NOW(),lastSuccessAt:NOW(),latestPostAt,ok:true,source,error:null,
        alert:latest?{id:latest.id,text:latest.text.slice(0,400),at:latest.at,url:latest.url,sourceName:latest.sourceName,phase:latest.phase,window:latest.window}:null};
      latchResetPost(tibo,hit,state.gpt);
      observeWeeklyReset(tibo,state.gpt);
      if(!tibo.pendingReset && ['upcoming','announcement'].includes(tibo.alert?.phase))tibo.alert=null;
    }catch(e){tibo={...tibo,checkedAt:NOW(),ok:false,error:e.message,alert:activeTiboAlert(tibo)};}
    finally{tiboBusy=false;writeJSON(tiboFile,tibo);checkReminders();}
  }
  function refresh(force=false){checkTibo(force);return Promise.allSettled(['gpt','claude'].map(p=>update(p,force)));}
  const view=id=>({...state[id],summary:summarize(id,state[id])});
  function alerts(){
    const out=[];const n=NOW();
    const a=activeTiboAlert(tibo,n);
    // kind goes last: the saved post carries its own kind ('rss'/'tweet'), which must not replace 'tibo',
    // or the window draws this warning as a reset-credit card ("Claude 有 undefined 张重置券").
    if(a && (a.persistent || !reminders.tiboDismissed.includes(a.id)))out.push({...a,kind:'tibo',warning:!!a.persistent,title:tiboMessage(a).title});
    for(const id of ['gpt','claude']){const list=expiringCredits(state[id],n);
      if(list.length)out.push({kind:'credit',provider:id,count:list.length,expiresAt:list[0].expiresAt});}
    return out;
  }
  const key=crypto.randomBytes(24).toString('hex');const prefix='/'+key+'/';
  const html=fs.readFileSync(path.join(__dirname,'index.html'));
  let requestedAction=null;const nativeStatus={visible:null,compact:null,events:[]};
  function readBody(req){return new Promise((resolve,reject)=>{let size=0,chunks=[];
    req.on('data',c=>{size+=c.length;if(size>4096){reject(new Error('too large'));req.destroy();}else chunks.push(c);});
    req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));req.on('error',reject);});}
  const server=http.createServer(async (req,res)=>{
    const origin=req.headers.origin;
    if(req.headers.host!==`127.0.0.1:${server.address().port}` || (origin && origin!==`http://127.0.0.1:${server.address().port}`)) {res.writeHead(403);res.end();return;}
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(!pathname.startsWith(prefix)){res.writeHead(404);res.end();return;}
    const route=pathname.slice(prefix.length);
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    function json(value){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}
    if(req.method==='GET' && route==='state'){json({gpt:view('gpt'),claude:view('claude'),demo,refreshing:[...busy],serverTime:NOW(),nativeStatus,
      alerts:alerts(),tibo:{checkedAt:tibo.checkedAt,lastSuccessAt:tibo.lastSuccessAt,latestPostAt:tibo.latestPostAt,
        ok:tibo.ok,source:tibo.source,error:tibo.error,checking:tiboBusy},hasSessionKey:!!readSessionKey(dataDir),theme:readTheme(dataDir),version:VERSION});return;}
    if(req.method==='POST' && /^host\/(show|hide|compact|expand)\/[01]$/.test(route)){const parts=route.split('/');nativeStatus.visible=parts[2]==='1';if(parts[1]==='compact' || parts[1]==='expand')nativeStatus.compact=parts[1]==='compact';nativeStatus.events.push({action:parts[1],visible:nativeStatus.visible,at:NOW()});nativeStatus.events=nativeStatus.events.slice(-20);json({ok:true});return;}
    if(req.method==='POST' && route==='refresh'){refresh(true);json({ok:true});return;}
    if(req.method==='POST' && /^tibo\/dismiss\/[\w:.-]{1,80}$/.test(route)){const id=route.split('/')[2];
      if(tibo.pendingReset?.id===id){json({ok:true,persistent:true});return;}
      reminders.tiboDismissed=[...reminders.tiboDismissed.filter(x=>x!==id),id].slice(-50);saveReminders();json({ok:true});return;}
    if(req.method==='POST' && /^config\/theme\/(dark|light)$/.test(route)){
      try{fs.mkdirSync(dataDir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dataDir,'theme.txt'),route.split('/')[2],{mode:0o600});}catch{}
      json({ok:true});return;}
    if(req.method==='POST' && route==='config/claude-session'){
      let value='';try{value=String(JSON.parse(await readBody(req)).sessionKey||'').trim();}catch{res.writeHead(400);res.end();return;}
      if(value && !/^sk-ant-[\w-]{20,}$/.test(value)){res.statusCode=400;json({ok:false,error:'格式不对：sessionKey 一般以 sk-ant- 开头。'});return;}
      try{fs.mkdirSync(dataDir,{recursive:true,mode:0o700});if(value)fs.writeFileSync(sessionKeyFile(dataDir),value,{mode:0o600});else fs.rmSync(sessionKeyFile(dataDir),{force:true});}catch{}
      retry.delete('claude');last.delete('claude');update('claude',true);json({ok:true});return;}
    if(req.method==='POST' && route.startsWith('action/')){
      const action=route.slice(7);if(!['hide','show','compact','expand','quit'].includes(action)){res.writeHead(400);res.end();return;}
      json({ok:true});if(action==='quit' && options.onQuit){setTimeout(options.onQuit,80);return;}requestedAction=action;return;
    }
    if(req.method==='GET' && route==='native'){const action=requestedAction;requestedAction=null;
      // Only what the menu bar needs: the native host parses this on the main thread, so keep it small.
      const brief=id=>{const p=state[id]||{},s=summarize(id,p).session;
        return {fetchedAt:p.fetchedAt??null,error:p.error??null,summary:{session:s?{remaining:s.remaining,resetsAt:s.resetsAt}:null}};};
      const marks=alerts().map(a=>({kind:a.kind,warning:a.warning,title:a.title}));
      json({action,state:{gpt:brief('gpt'),claude:brief('claude')},alerts:marks,notifications:notifications.splice(0)});return;}
    const allowed={'': ['text/html',html],'ui.js':['text/javascript',null],'style.css':['text/css',null]};
    if(req.method==='GET' && Object.hasOwn(allowed,route)) {const [mime,data]=allowed[route];res.setHeader('Content-Type',mime);res.end(data || fs.readFileSync(path.join(__dirname,route)));return;}
    res.writeHead(404);res.end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port || 0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}${prefix}`;
  const timer=setInterval(()=>{refresh();checkReminders();},30000);
  const stop=()=>{stopping=true;clearInterval(timer);stopChildren();server.close();};
  if(options.autoRefresh!==false)refresh(true);
  if(demo)checkReminders();
  return {url,state,refresh,update,checkTibo,server,stop};
}
function friendlyCodexError(error){const s=String(error.message || '');
  if(/auth|login|sign.?in|credential|unauthor|401|not logged/i.test(s))return 'Codex 尚未登录或登录已过期。请在 ChatGPT/Codex 中登录，然后刷新。';
  if(/rate.?limit|429/i.test(s))return 'Codex 接口暂时限流，稍后自动重试。';
  if(/not support|method not found|unknown method/i.test(s))return '本机 Codex 版本过旧，请更新官方应用后刷新。';
  // Avoid leaking raw server responses, paths, or credentials to the UI/cache.
  if(['未找到','无法启动','查询超时','连接已','进程已'].some(t=>s.includes(t)))return s;
  return 'Codex 用量查询失败。请检查网络和登录状态，并确认使用的是订阅账户。';
}
module.exports={percent,epoch,duration,normalizeCodex,normalizeClaude,extractToken,extractOAuth,RPC,fetchCodex,fetchClaude,startServer,demoState,
  summarize,expiringCredits,parseRss,parseSyndication,isResetPost,resetPhase,selectTiboPost,activeTiboAlert,tiboMessage,fetchTiboPosts,
  weeklyObservation,weeklyWasReset,observeWeeklyReset,latchResetPost,decryptCookie,claudeCredits};
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
  // The window host reads the address from this file with a time limit, so it can never hang waiting for it.
  const urlIndex=process.argv.indexOf('--url-file');
  const urlFile=urlIndex>=0?process.argv[urlIndex+1]:null;
  if(urlFile){try{fs.writeFileSync(urlFile+'.tmp',app.url+'\n',{mode:0o600});fs.renameSync(urlFile+'.tmp',urlFile);}catch{}
    process.on('exit',()=>{try{fs.rmSync(urlFile,{force:true});}catch{}});}
  process.stdout.write(app.url+'\n');
    // after the address is handed over, nothing more is written to the parent's pipe (a full pipe would stall the service)
    process.stdout.write=()=>true;process.stderr.write=()=>true;process.removeAllListeners('warning');process.on('warning',()=>{});
  if(process.argv.includes('--native-host')){process.stdin.resume();process.stdin.on('end',()=>{app.stop();process.exit(0);});}
  process.on('SIGTERM',()=>{app.stop();process.exit(0);});process.on('SIGINT',()=>{app.stop();process.exit(0);});
}).catch(()=>{process.stderr.write('无法启动本地用量服务。\n');process.exit(1);});

}
