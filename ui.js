'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=v=>v===null || v===undefined?'—':Number(v).toLocaleString('zh-CN',{maximumFractionDigits:1})+'%';
const date=v=>v?new Date(v*1000).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未知';
function countdown(t){if(!t)return '时间未知';const s=Math.ceil(t-Date.now()/1000);if(s<=0)return '已到重置时间 · 待刷新确认';
 const days=Math.floor(s/86400),hours=Math.floor(s%86400/3600),mins=Math.floor(s%3600/60);
 if(days)return `${days} 天 ${hours} 小时`;
 if(hours)return `${hours} 小时 ${mins} 分`;
 return mins>0?`${mins} 分 ${s%60} 秒`:`${s} 秒`;
}
let state=null,signature='',compact=false;
function isOld(p){return !!p.error || !p.fetchedAt || Date.now()/1000-p.fetchedAt>600 || (p.windows||[]).some(w=>w.resetsAt && w.resetsAt<Date.now()/1000);}
function card(id,p){const isGPT=id==='gpt',windows=p.windows||[],available=windows.filter(w=>typeof w.remaining==='number');
 const limiting=available.reduce((a,w)=>!a || w.remaining<a.remaining?w:a,null);
 const remaining=limiting?.remaining??null;
 const resets=windows.filter(w=>w.resetsAt).sort((a,b)=>a.resetsAt-b.resetsAt);
 const next=resets[0];const old=isOld(p),busy=state.refreshing.includes(id);
 const accent=remaining!==null && remaining<=5?'#cb6559':remaining!==null && remaining<=20?'#c79947':null;
 const defaultModel=(p.models||[]).find(m=>m.isDefault);
 const plan=p.plan?.toUpperCase();
 const main = `<div class="hero"><div class="ring" style="--amount:${remaining??0};${accent?'--ringcolor:'+accent:''}"><div class="ring-inner"><strong>${remaining===null?'—':esc(Number(remaining).toLocaleString('zh-CN',{maximumFractionDigits:1}))}${remaining===null?'':'<em>%</em>'}</strong><span>${old && p.fetchedAt?'上次剩余':'剩余额度'}</span></div></div><div class="hero-copy"><p class="eyebrow">${next?'最近一次额度重置':'等待账户数据'}</p><h3 class="countdown" data-reset="${next?.resetsAt||''}">${next?esc(countdown(next.resetsAt)):'—'}</h3><p class="sub">${next?esc(date(next.resetsAt))+' 重置 · '+esc(next.label):'登录后即可查看用量和重置时间'}</p><div class="bucket">${limiting?esc(limiting.label+' · '+limiting.group)+' 剩余最少':isGPT?'Codex / ChatGPT Work':'Claude Code'}</div></div></div>`;
 const rows=windows.map(w=>`<div class="window"><div class="window-top"><span class="window-title">${esc(w.label)}${isGPT && windows.some(x=>x.bucket!==w.bucket)?' · '+esc(w.group):''}</span><span class="values">已用 <b>${pct(w.used)}</b> <span> / 剩余 ${pct(w.remaining)}</span></span></div><div class="bar" role="progressbar" aria-label="${esc(w.label)}已用额度" ${w.used!==null?'aria-valuenow="'+w.used+'"':''} aria-valuemin="0" aria-valuemax="100"><span style="width:${w.used??0}%;${w.used>=95?'background:#cb6559':w.used>=80?'background:#c79947':''}"></span></div><div class="window-date"><span>${w.resetsAt?esc(date(w.resetsAt))+' 重置':'重置时间未提供'}</span><span class="countdown" data-reset="${w.resetsAt||''}">${w.resetsAt?esc(countdown(w.resetsAt)):'—'}</span></div></div>`).join('');
 const models=isGPT?`<details><summary>可用模型 ${(p.models||[]).length?'· '+p.models.length+' 个':''}</summary><div class="models">${(p.models||[]).map(m=>`<span class="${m.id==='gpt-6.1-sol'?'latest':''}">${esc(m.name)}${m.isDefault?' · 默认':''}</span>`).join('')||'本机尚未提供模型列表'}</div><p class="models-note">模型自动从账户读取；以上额度为服务提供的分组，多个模型可能共享额度。</p>${p.note?'<p class="models-note">'+esc(p.note)+'</p>':''}</details>`:'';
 const credits=isGPT && p.resetCredits && typeof p.resetCredits.availableCount==='number'?`<div class="credits">Full reset 重置券 <b>${p.resetCredits.availableCount}</b> 张${(()=>{const expiry=(p.resetCredits.credits||[]).filter(c=>c.status==='available' && c.expiresAt).sort((a,b)=>a.expiresAt-b.expiresAt)[0];return expiry?' · 最早 '+esc(date(expiry.expiresAt))+' 到期':'';})()}</div>`:'';
 return `<section class="provider ${id}"><div class="provider-head"><span class="provider-icon" aria-hidden="true">${isGPT?'G':'✳'}</span><h2>${isGPT?'GPT':'Claude'}<small>${isGPT?'Codex / Work':'Code'}</small></h2><span class="badge" title="${esc(defaultModel?.name||'')}">${isGPT?esc(plan || '账户额度'):'账户额度'}</span></div>${isGPT && defaultModel?'<p class="model-caption">可用模型 · <b>'+esc(defaultModel.name)+'</b></p>':''}${main}${p.error?'<p class="error">'+esc(p.error)+'</p>':''}<div class="window-list">${rows || '<p class="unknown">'+(busy?'正在读取用量…':p.fetchedAt?'账户未提供固定额度窗口':'账户暂未返回额度窗口')+'</p>'}</div>${credits}${models}<div class="data-foot"><span class="health ${old && p.fetchedAt?'old':''}"><i></i>${busy?'更新中…':p.error?'读取失败'+(p.fetchedAt?' · 保留旧数据':''):old && p.fetchedAt?'数据待更新':p.fetchedAt?'已同步':'尚未连接'}</span><span>${p.fetchedAt?'更新于 '+esc(date(p.fetchedAt)):'未取得数据'}</span></div></section>`;
}
function clocks(){document.querySelectorAll('[data-reset]').forEach(el=>{const t=Number(el.dataset.reset);if(t)el.textContent=countdown(t);});}
async function load(){try{const r=await fetch('state');if(!r.ok)throw Error();const s=await r.json();
 state={...s,refreshing:s.refreshing||[]};if(typeof s.nativeStatus?.compact==='boolean')setCompact(s.nativeStatus.compact);const key=JSON.stringify([s.gpt,s.claude,s.refreshing,isOld(s.gpt),isOld(s.claude)]);
 if(key!==signature){const opened=[...document.querySelectorAll('.provider details[open]')].map(d=>d.closest('.provider').classList.contains('gpt')?'gpt':'claude');
  signature=key;$('providers').innerHTML=card('gpt',s.gpt)+card('claude',s.claude);
  opened.forEach(id=>{const d=document.querySelector('.'+id+' details');if(d)d.open=true;});}
 document.body.classList.toggle('demo',!!s.demo);$('mode').textContent=s.demo?'演示数据 · 非真实账户用量':'账户额度，一目了然';
 $('refresh').disabled=state.refreshing.length>0;
 $('status').textContent=state.refreshing.length?'正在同步账户数据…':'每 5 分钟自动更新';clocks();
 }catch{$('status').textContent='本地连接中断，请重新打开应用';}}
async function action(name){
 if(window.webkit?.messageHandlers?.usageTogether){window.webkit.messageHandlers.usageTogether.postMessage(name);return;}
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
function setCompact(value){compact=value;document.body.classList.toggle('compact',compact);$('compact').title=compact?'展开完整视图':'切换紧凑视图';$('compact').setAttribute('aria-label',$('compact').title);$('compact').textContent=compact?'展开视图':'紧凑视图';$('compact').setAttribute('aria-pressed',String(compact));}
window.setCompact=setCompact;
$('compact').onclick=()=>{setCompact(!compact);action(compact?'compact':'expand');};
$('hide').onclick=()=>action('hide');
$('refresh').onclick=async()=>{$('refresh').disabled=true;try{await fetch('refresh',{method:'POST'});await load();}catch{$('status').textContent='刷新失败，请重新打开应用';$('refresh').disabled=false;}};
$('help').onclick=()=>{$('helpDialog').showModal();};
$('closeHelp').onclick=$('doneHelp').onclick=()=>{$('helpDialog').close();};
load();setInterval(load,2000);setInterval(clocks,1000);

$('quitApp').onclick=()=>action('quit');
