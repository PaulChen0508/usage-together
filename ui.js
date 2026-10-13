'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=v=>v===null || v===undefined?'—':Math.round(v)+'%';
const short=v=>v?new Date(v*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未知';
function countdown(t){if(!t)return '时间未知';const s=Math.ceil(t-Date.now()/1000);if(s<=0)return '已到时间 · 待刷新确认';
 const days=Math.floor(s/86400),hours=Math.floor(s%86400/3600),mins=Math.floor(s%3600/60);
 if(days)return `${days} 天 ${hours} 小时`;
 if(hours)return `${hours} 小时 ${mins} 分`;
 return mins>0?`${mins} 分 ${s%60} 秒`:`${s} 秒`;
}
const host=()=>window.webkit?.messageHandlers?.usageTogether;
let theme='',state=null,signature='',alertSig='',lastFit=0;
function isOld(p){return !!p.error || !p.fetchedAt || Date.now()/1000-p.fetchedAt>600 || (p.windows||[]).some(w=>w.resetsAt && w.resetsAt<Date.now()/1000);}
const tone=r=>r===null || r===undefined?'':r<=5?'bad':r<=20?'warn':'';
const usable=c=>!c.status || /avail|active|unused|valid/i.test(String(c.status));

// One small card per provider: big 5-hour number, then 5-hour reset, weekly, reset credits.
function when5(w){
 if(w?.resetsAt)return `<span class="countdown" data-reset="${w.resetsAt}">${esc(countdown(w.resetsAt))}</span><span class="at">${esc(short(w.resetsAt))} 刷新</span>`;
 if(w && (w.used===0 || w.remaining===100))return `<span class="countdown idle">还没开始计时</span><span class="at">发第一条消息后开始</span>`;
 return '<span class="at">刷新时间未提供</span>';}
function weekly(w){
 if(!w)return '<div class="week"><div class="week-top"><span>每周</span><span class="at">未返回</span></div></div>';
 const r=w.remaining;
 const t=w.resetsAt?`<span class="countdown" data-reset="${w.resetsAt}">${esc(countdown(w.resetsAt))}</span><span class="at">${esc(short(w.resetsAt))} 刷新</span>`:(w.used===0?'<span class="at">还没用过</span>':'<span class="at">时间未知</span>');
 return `<div class="week"><div class="week-top"><span>每周剩余</span><b class="${tone(r)}">${pct(r)}</b></div><div class="bar ${tone(r)}" role="progressbar" aria-label="每周剩余额度" aria-valuenow="${r??0}" aria-valuemin="0" aria-valuemax="100"><span style="width:${r??0}%"></span></div><div class="week-when">${t}</div></div>`;}
function credits(p){const rc=p.resetCredits;if(!rc || typeof rc.availableCount!=='number')return '';
 const first=(rc.credits||[]).filter(c=>usable(c) && c.expiresAt && c.expiresAt>Date.now()/1000).sort((a,b)=>a.expiresAt-b.expiresAt)[0];
 const soon=first && first.expiresAt-Date.now()/1000<=3*86400;
 return `<div class="credits ${soon?'soon':''}" title="${first?'最早 '+esc(short(first.expiresAt))+' 到期':''}">重置券 <b>${rc.availableCount}</b>${first?` · ${soon?'<span class="countdown" data-reset="'+first.expiresAt+'">'+esc(countdown(first.expiresAt))+'</span>后到期':esc(short(first.expiresAt).slice(0,5))+' 到期'}`:''}</div>`;}
function more(id,p,list){
 const isGPT=id==='gpt',models=isGPT?(p.models||[]):[];
 if(!list.length && !models.length)return '';
 return `<details class="more"><summary>更多</summary>${list.map(w=>`<div class="other"><span>${esc(w.label)}</span><span>${pct(w.remaining)}${w.resetsAt?' · '+esc(short(w.resetsAt)):''}</span></div>`).join('')}${models.length?`<div class="models">${models.map(m=>`<span>${esc(m.name)}${m.isDefault?' · 默认':''}</span>`).join('')}</div>`:''}</details>`;}
function card(id,p){const isGPT=id==='gpt',s=p.summary||{},old=isOld(p),busy=state.refreshing.includes(id),session=s.session;
 const r=session?.remaining??null;
 const plan=isGPT && p.plan?String(p.plan).toUpperCase():'';
 const status=busy?'更新中…':p.error?'读取失败':old && p.fetchedAt?'数据待更新':p.fetchedAt?'':'尚未连接';
 return `<section class="provider ${id}">
  <div class="provider-head"><span class="provider-icon" aria-hidden="true">${isGPT?'G':'✳'}</span><h2>${isGPT?'GPT':'Claude'}</h2>${plan?`<span class="badge">${esc(plan)}</span>`:''}</div>
  <div class="big ${tone(r)}"><strong>${r===null?'—':Math.round(r)}</strong>${r===null?'':'<em>%</em>'}<span class="cap">${old && p.fetchedAt?'上次 5 小时剩余':'5 小时剩余'}</span></div>
  <div class="reset">${session?when5(session):`<span class="at">${busy?'正在读取…':'登录后可查看'}</span>`}</div>
  ${weekly(s.weekly)}${credits(p)}
  ${p.error?`<p class="error" title="${esc(p.error)}">${esc(p.error)}</p>`:''}
  ${status?`<p class="health ${p.error?'bad':''}">${esc(status)}${p.fetchedAt&&status?' · '+esc(short(p.fetchedAt)):''}</p>`:''}
  ${more(id,p,s.others||[])}
 </section>`;}
// Only real Tibo warnings and real reset-credit reminders are drawn; anything else is skipped instead of being shown as a credit card.
function alertsHTML(list){return list.filter(a=>a.kind==='tibo' || (a.kind==='credit' && typeof a.count==='number' && a.count>0 && a.expiresAt)).map(a=>a.kind==='tibo'
 ?`<div class="alert tibo" role="alert" title="${esc(a.text)}"><span class="alert-icon" aria-hidden="true">${a.warning===false?'ℹ':'⚠︎'}</span><div class="alert-body"><b>${esc(a.title||'Tibo：额度重置消息')}</b><p class="alert-text">${esc(a.text)}</p>${a.persistent?'<p class="alert-text">警告保留至 GPT 每周额度实际重置。</p>':a.phase==='upcoming'?'<p class="alert-text">可在重置前使用剩余额度。</p>':''}<div class="alert-actions"><span>${esc(short(a.at))}</span>${a.url?`<button data-open="${esc(a.url)}">原帖</button>`:''}${a.persistent?'<span>持续提醒</span>':`<button data-dismiss="${esc(a.id)}">知道了</button>`}</div></div></div>`
 :`<div class="alert credit" role="alert"><span class="alert-icon" aria-hidden="true">⏰</span><div class="alert-body"><b>${a.provider==='gpt'?'GPT':'Claude'} 有 ${a.count} 张重置券快到期</b><div class="alert-actions"><span>还剩 <span class="countdown" data-reset="${a.expiresAt}">${esc(countdown(a.expiresAt))}</span>（${esc(short(a.expiresAt))}）</span></div></div></div>`).join('');}
function clocks(){document.querySelectorAll('[data-reset]').forEach(el=>{const t=Number(el.dataset.reset);if(t)el.textContent=countdown(t);});}
function fit(){const h=host();if(!h)return;let height=Math.ceil(document.body.getBoundingClientRect().height);
 if($('helpDialog').open)height=Math.max(height,520);
 if(Math.abs(height-lastFit)>2){lastFit=height;h.postMessage('fit:'+height);}}
// Every request has a time limit, and only one state request runs at a time, so stuck requests never pile up.
function timed(url,opts={},ms=5000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);
 return fetch(url,{...opts,signal:c.signal}).finally(()=>clearTimeout(t));}
let loading=false,misses=0;
async function load(){if(loading)return;loading=true;try{await loadOnce();}finally{loading=false;}}
async function loadOnce(){try{const r=await timed('state');if(!r.ok)throw Error();const s=await r.json();
 misses=0;if(host())host().postMessage('alive');
 state={...s,refreshing:s.refreshing||[]};
 const key=JSON.stringify([s.gpt,s.claude,s.refreshing,isOld(s.gpt),isOld(s.claude)]);
 if(key!==signature){const opened=[...document.querySelectorAll('.provider details[open]')].map(d=>d.closest('.provider').classList[1]+'|'+d.className);
  signature=key;$('providers').innerHTML=card('gpt',s.gpt)+card('claude',s.claude);
  opened.forEach(k=>{const [id,cls]=k.split('|');const d=document.querySelector(`.provider.${id} details.${cls}`);if(d)d.open=true;});}
 const ak=JSON.stringify(s.alerts||[]);if(ak!==alertSig){alertSig=ak;$('alerts').innerHTML=alertsHTML(s.alerts||[]);}
 $('claudeKey').hidden=!(s.claude.error || s.hasSessionKey);
 document.body.classList.toggle('demo',!!s.demo);$('mode').textContent=s.demo?'演示数据 · ':'';
 if(s.version)$('ver').textContent=s.version;
 applyTheme(s.theme||'dark');
 $('refresh').disabled=state.refreshing.length>0;
 $('status').textContent=state.refreshing.length?'同步中…':'每 5 分钟更新';document.querySelector('header .mark').title=$('status').textContent;
 const t=s.tibo||{},el=$('tibo');
 // One failed check is common (the public sources are flaky) and is retried within minutes, so it is only
 // reported as unreadable after repeated failures or when the last good read is more than 30 minutes old.
 const recent=t.lastSuccessAt && Date.now()/1000-t.lastSuccessAt<1800, down=t.ok===false && ((t.failStreak||0)>=2 || !recent);
 const hhmm=v=>short(v).slice(6);
 el.textContent=t.checking?'Tibo 原帖检查中…':down?'Tibo 原帖暂时读不到 · 自动重试':t.ok===false?`Tibo 原帖 ${hhmm(t.lastSuccessAt)} 已查 · 重试中`:
  t.ok===true?`Tibo 原帖 ${hhmm(t.lastSuccessAt||t.checkedAt)} 已查`:'Tibo 原帖待检查';
 el.classList.toggle('bad',!!down);
 el.title=t.ok===false?`这次没读到 Tibo 原帖，${t.nextCheckAt?hhmm(t.nextCheckAt)+' 左右':'稍后'}自动重试。${t.lastSuccessAt?'上次成功：'+short(t.lastSuccessAt)+'。':''}${t.error||''}`:
  `${t.source?'来源：'+t.source+'。':''}${t.latestPostAt?'最新原帖：'+short(t.latestPostAt)+'。':''}每 10 分钟检查，失败后几分钟内自动重试；来源可能有缓存延迟。`;
 clocks();fit();
 }catch{$('status').textContent='本地连接中断，正在自动恢复…';
  // Tell the app after a few misses in a row; it restarts the local service or reloads this page.
  if(++misses%3===0 && host())host().postMessage('stale');}}
function applyTheme(t){if(t===theme)return;theme=t;document.body.classList.toggle('light',t==='light');
 $('theme').textContent=t==='light'?'☾':'☀';$('theme').title=t==='light'?'切换到深色':'切换到浅色';
 if(host())host().postMessage('theme:'+t);}
async function action(name){
 if(host()){host().postMessage(name);return;}
 try {const r=await fetch('action/'+name,{method:'POST'});if(!r.ok)throw Error();
  if(name==='hide' || name==='quit'){
   $('helpDialog').close();document.body.classList.add('closed');$('closedView').hidden=false;
   $('closedTitle').textContent=name==='quit'?'用量伴侣已退出':'窗口已隐藏';
   $('closedText').textContent=name==='quit'?'重新打开桌面应用即可继续查看额度。':'后台仍会更新账户额度。';
   $('restore').hidden=name==='quit';
  }
  if(name==='show'){document.body.classList.remove('closed');$('closedView').hidden=true;}
 }catch{$('status').textContent='操作未完成，请重新打开应用';}
}
$('restore').onclick=()=>action('show');
$('hide').onclick=()=>action('hide');
$('refresh').onclick=async()=>{$('refresh').disabled=true;$('refresh').classList.add('spin');setTimeout(()=>$('refresh').classList.remove('spin'),900);try{await timed('refresh',{method:'POST'});await load();}catch{$('status').textContent='刷新失败，请重新打开应用';$('refresh').disabled=false;}};
$('theme').onclick=async()=>{const t=theme==='light'?'dark':'light';applyTheme(t);try{await fetch('config/theme/'+t,{method:'POST'});}catch{}};
$('help').onclick=()=>{$('helpDialog').showModal();fit();};
$('closeHelp').onclick=$('doneHelp').onclick=()=>{$('helpDialog').close();fit();};
$('alerts').addEventListener('click',async e=>{
 const open=e.target.closest('[data-open]'),dismiss=e.target.closest('[data-dismiss]');
 if(open){const url=open.dataset.open;if(!/^https:\/\//.test(url))return;if(host())host().postMessage('open:'+url);else window.open(url,'_blank','noopener');}
 if(dismiss){try{await fetch('tibo/dismiss/'+encodeURIComponent(dismiss.dataset.dismiss),{method:'POST'});}catch{}alertSig='';load();}
});
async function saveKey(value){$('keyMsg').textContent='保存中…';
 try{const r=await fetch('config/claude-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionKey:value})});
  const j=await r.json().catch(()=>({}));$('keyMsg').textContent=r.ok?(value?'已保存，正在重新读取 Claude 用量…':'已清除。'):(j.error||'保存失败');
  if(r.ok)$('keyInput').value='';load();}catch{$('keyMsg').textContent='保存失败';}}
$('keyForm').onsubmit=e=>{e.preventDefault();saveKey($('keyInput').value.trim());};
$('keyClear').onclick=()=>saveKey('');
document.addEventListener('toggle',fit,true);
if(window.ResizeObserver)new ResizeObserver(fit).observe(document.body);
if(!host())document.body.classList.add('browser');
load();setInterval(load,2000);setInterval(clocks,1000);
$('quitApp').onclick=()=>action('quit');
