'use strict';
const {test,mock}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parseRss,parseSyndication,resetPhase,selectTiboPost,activeTiboAlert,fetchTiboPosts,startServer,tiboMessage,
 weeklyObservation,weeklyWasReset,observeWeeklyReset,latchResetPost}=require('./backend');
// Public announcement fixture only; never read a real account or local login cache.
const xml=`<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<item><title>Global reset by EOD. May the tokens do good things for you.</title><dc:creator>@thsottiaux</dc:creator><description><![CDATA[<p>Global reset by EOD. May the tokens do good things for you.</p>]]></description><pubDate>Sat, 10 Oct 2026 22:16:20 GMT</pubDate><link>https://nitter.kareem.one/thsottiaux/status/2109045392684032299#m</link></item>
<item><title>Day 6/ Reset</title><dc:creator>@thsottiaux</dc:creator><description><![CDATA[<p>Day 6/ Reset</p>]]></description><pubDate>Sat, 10 Oct 2026 22:15:39 GMT</pubDate><link>https://nitter.kareem.one/thsottiaux/status/2109045220411351517#m</link></item>
</channel></rss>`;
const src={type:'rss',name:'X 镜像 · kareem',url:'https://nitter.kareem.one/thsottiaux/rss'};
const realPosts=parseRss(xml,src);
const n=1791672200;
const post=text=>({id:'123',author:'thsottiaux',text,at:n-100,url:'https://x.com/thsottiaux/status/123',kind:'rss',window:86400});

test('the real October 10 announcement is parsed and selected, including short followup wording',()=>{
 const hit=selectTiboPost(realPosts,n);
 assert.equal(hit.id,'2109045392684032299');
 assert.equal(hit.text,'Global reset by EOD. May the tokens do good things for you.');
 assert.equal(hit.phase,'upcoming');
 assert.equal(resetPhase(realPosts.find(p=>p.id==='2109045220411351517')),'announcement');
 assert.equal(hit.url,'https://x.com/thsottiaux/status/2109045392684032299');
});
test('completed resets and banked credits do not tell users to burn tokens before a future reset',()=>{
 for(const text of ['We have reset Codex usage limits across all plans.','The Codex reset has been processed. Enjoy!']){
  const p={...post(text),phase:resetPhase(post(text))};assert.equal(p.phase,'completed');
  assert.ok(!tiboMessage(p).body.includes('重置前'));
 }
 const p={...post('Loading a banked reset in everyone’s paid Codex accounts.'),phase:'banked'};
 assert.equal(resetPhase(p),'banked');assert.ok(!tiboMessage(p).body.includes('重置前'));
});
test('only Tibo originals can trigger a Tibo notification',()=>{
 const p=post('Global reset by EOD.');
 assert.equal(resetPhase({...p,author:'other'}),null);
 assert.equal(resetPhase({...p,kind:'news'}),null);
 assert.equal(resetPhase({...p,url:'https://x.com/other/status/123'}),null);
 assert.equal(resetPhase({...p,author:null}),null);
});
test('questions, polls, negation and unrelated resets are excluded',()=>{
 for(const text of ['No Codex reset today.','We will not reset Codex usage limits.','Can we reset Codex limits?','80% needs a reset, Codex poll','Reset your password to use Codex.','Reset the context to save Codex tokens.'])
  assert.equal(resetPhase(post(text)),null,text);
});
test('quoted older reset text cannot turn an unrelated new post into a new announcement',()=>{
 const input=`<rss><channel><item><title>Dots got an upgrade</title><dc:creator>@thsottiaux</dc:creator><description><![CDATA[<p>Dots got an upgrade</p><hr/><blockquote><p>We have reset Codex limits.</p></blockquote>]]></description><pubDate>Sat, 10 Oct 2026 22:00:00 GMT</pubDate><link>https://nitter.kareem.one/thsottiaux/status/123</link></item></channel></rss>`;
 const p=parseRss(input,src)[0];assert.equal(p.text,'Dots got an upgrade');assert.equal(resetPhase(p),null);
});
test('expired and future-dated posts do not alert; expiry also applies between network polls',()=>{
 assert.equal(selectTiboPost([post('Codex limits will reset')],n+86400),null);
 assert.equal(selectTiboPost([{...post('Codex limits will reset'),at:n+601}],n),null);
 assert.equal(activeTiboAlert({alert:post('Global reset by EOD')},n+86400),null);
});
const gpt=(at,used=33,sessionUsed=20,resetsAt=n+10*86400)=>({fetchedAt:at,windows:[
 {id:'codex:primary',bucket:'codex',minutes:300,used:sessionUsed,remaining:100-sessionUsed,resetsAt:at+18000},
 {id:'codex:secondary',bucket:'codex',minutes:10080,used,remaining:100-used,resetsAt}]});
test('a detected warning remains latched beyond 24 hours and source failure, with no wall-clock deadline',()=>{
 const t={};latchResetPost(t,selectTiboPost(realPosts,n),gpt(n),n);
 assert.equal(activeTiboAlert(t,n+7*86400).persistent,true);
 assert.equal(activeTiboAlert({...t,ok:false},n+7*86400).id,'2109045392684032299');
});
test('five-hour reset, stale observations and failed reads never resolve a weekly warning',()=>{
 const t={};latchResetPost(t,selectTiboPost(realPosts,n),gpt(n),n);
 assert.equal(observeWeeklyReset(t,gpt(n+60,33,0),n+60),false);assert.ok(t.pendingReset);
 assert.equal(observeWeeklyReset(t,{...gpt(n+120,0),error:'unreachable'},n+120),false);
 assert.equal(observeWeeklyReset(t,gpt(n+120,0),n+1000),false);
 assert.equal(observeWeeklyReset(t,gpt(n+60,0),n+120),false);assert.ok(t.pendingReset);
});
test('weekly zeroing, new period and substantial replenishment resolve warnings; minor corrections do not',()=>{
 const before=weeklyObservation(gpt(n),n);
 assert.equal(weeklyWasReset(before,weeklyObservation(gpt(n+60,0),n+60)),true);
 assert.equal(weeklyWasReset(before,weeklyObservation(gpt(n+60,5,20,n+11*86400),n+60)),true);
 assert.equal(weeklyWasReset(before,weeklyObservation(gpt(n+60,10),n+60)),true);
 assert.equal(weeklyWasReset(before,weeklyObservation(gpt(n+60,32),n+60)),false);
 assert.equal(weeklyWasReset(before,{...before,id:'another:secondary',fetchedAt:n+60,used:0}),false);
});
test('resolved events stay resolved even when the same old announcement is read again',()=>{
 const t={},hit=selectTiboPost(realPosts,n);latchResetPost(t,hit,gpt(n),n);
 assert.equal(observeWeeklyReset(t,gpt(n+60,0),n+60),true);assert.equal(activeTiboAlert(t,n+60),null);
 latchResetPost(t,hit,gpt(n+60,0),n+60);assert.equal(t.pendingReset,null);
 latchResetPost(t,{...hit,id:'new',at:n+120},gpt(n+120,5),n+120);assert.equal(t.pendingReset.id,'new');
});
test('a completion announcement alone cannot clear the warning before the account weekly quota resets',()=>{
 const t={};latchResetPost(t,selectTiboPost(realPosts,n),gpt(n),n);
 t.alert={...post('We have reset Codex usage limits.'),phase:'completed',at:n+60};
 assert.equal(activeTiboAlert(t,n+60).phase,'upcoming');
 assert.equal(observeWeeklyReset(t,gpt(n+60,33,0),n+60),false);
 assert.equal(activeTiboAlert(t,n+60).persistent,true);
});
test('200 challenge pages and news-only fallbacks never count as checking Tibo successfully',async()=>{
 const fake=async()=>({status:200,body:'<html>Making sure you are not a bot</html>'});
 await assert.rejects(fetchTiboPosts({sources:[src],requestFn:fake}),/未读到有效原帖/);
 await assert.rejects(fetchTiboPosts({sources:[{...src,type:'news'}],requestFn:async()=>({status:200,body:xml})}));
});
test('source failure falls back to a feed containing actual Tibo originals',async()=>{
 let calls=0;
 const r=await fetchTiboPosts({sources:[{...src,url:'https://first.example/feed'},src],requestFn:async()=>++calls===1?{status:429,body:''}:{status:200,body:xml}});
 assert.equal(calls,2);assert.equal(r.source,src.name);assert.equal(r.latestPostAt,1791670580);
});
test('syndication rejects nested posts from another author',()=>{
 const data={tweets:[{id_str:'123',full_text:'Global reset by EOD',created_at:'Sat Oct 10 22:16:20 +0000 2026',user:{screen_name:'thsottiaux'}},
 {id_str:'456',full_text:'Reset Codex limits',created_at:'Sat Oct 10 22:16:20 +0000 2026',user:{screen_name:'other'}}]};
 const posts=parseSyndication(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`,{name:'X'});
 assert.equal(resetPhase(posts[0]),'upcoming');assert.equal(resetPhase(posts[1]),null);
});
test('persistent notification survives acknowledgement, source failure and restarts, then ends only on weekly reset',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tibo-regression-'));
 const old=process.env.USAGE_DATA_DIR;process.env.USAGE_DATA_DIR=dir;
 let time=n*1000,fail=false,weeklyUsed=33,sessionUsed=20,app;
 mock.method(Date,'now',()=>time);
 const fetchPosts=async()=>{if(fail)throw Error('source unavailable');return {posts:realPosts,source:src.name,latestPostAt:1791670580};};
 const settings={autoRefresh:false,fetchTiboPosts:fetchPosts,fetchCodex:async()=>gpt(time/1000,weeklyUsed,sessionUsed)};
 const state=async()=> (await fetch(app.url+'state')).json();
 const notifications=async()=> (await (await fetch(app.url+'native')).json()).notifications;
 try{
  app=await startServer(settings);await app.update('gpt',true);await app.checkTibo(true);
  let s=await state();assert.equal(s.tibo.ok,true);assert.equal(s.alerts[0].phase,'upcoming');assert.match(s.alerts[0].title,/即将重置/);
  assert.equal((await notifications()).length,1);
  time+=61000;await app.checkTibo(true);assert.equal((await notifications()).length,0);
  app.stop();app=await startServer(settings);
  assert.equal((await state()).alerts.length,1);await app.checkTibo(true);assert.equal((await notifications()).length,0);
  fail=true;time+=61000;await app.checkTibo(true);s=await state();assert.equal(s.tibo.ok,false);assert.ok(s.tibo.lastSuccessAt);assert.equal(s.alerts.length,1);
  await fetch(app.url+'tibo/dismiss/'+s.alerts[0].id,{method:'POST'});assert.equal((await state()).alerts.length,1);
  sessionUsed=0;time+=61000;await app.update('gpt',true);assert.equal((await state()).alerts.length,1);
  app.stop();app=await startServer(settings);assert.equal((await state()).alerts.length,1);
  time+=86400000;assert.equal((await state()).alerts.length,1);assert.equal((await notifications()).length,0);
  weeklyUsed=0;await app.update('gpt',true);assert.equal((await state()).alerts.length,0);
  app.stop();app=await startServer(settings);assert.equal((await state()).alerts.length,0);
  fail=false;await app.checkTibo(true);assert.equal((await state()).alerts.length,0);assert.equal((await notifications()).length,0);
 }finally{app?.stop();mock.restoreAll();if(old===undefined)delete process.env.USAGE_DATA_DIR;else process.env.USAGE_DATA_DIR=old;fs.rmSync(dir,{recursive:true,force:true});}
});
