'use strict';
const {test,mock}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parseRss,parseSyndication,resetPhase,selectTiboPost,activeTiboAlert,fetchTiboPosts,startServer,tiboMessage,
 weeklyObservation,weeklyWasReset,observeWeeklyReset,latchResetPost,annotateThreads}=require('./backend');
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

test('a saved reset warning stays a Tibo warning, never a reset-credit card (2.3.3 fix)',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'usage-together-kind-'));
 const old=process.env.USAGE_DATA_DIR;process.env.USAGE_DATA_DIR=dir;let app;
 try{
  // Saved by 2.3.2: the pending warning still carries the post's own kind ('rss').
  fs.writeFileSync(path.join(dir,'tibo.json'),JSON.stringify({pendingReset:{...post('Resetting Codex rate limits for everyone today.'),phase:'upcoming',at:Date.now()/1000-600}}));
  app=await startServer({autoRefresh:false});
  const alerts=(await (await fetch(app.url+'state')).json()).alerts;
  assert.equal(alerts.length,1);assert.equal(alerts[0].kind,'tibo');assert.equal(alerts[0].warning,true);
  const native=(await (await fetch(app.url+'native')).json()).alerts;
  assert.deepEqual(native.map(a=>a.kind),['tibo']);
  const tibo={};latchResetPost(tibo,{...post('Resetting Codex rate limits for everyone today.'),phase:'upcoming'},null);
  assert.equal('kind' in tibo.pendingReset,false);
 }finally{app?.stop();if(old===undefined)delete process.env.USAGE_DATA_DIR;else process.env.USAGE_DATA_DIR=old;fs.rmSync(dir,{recursive:true,force:true});}
});

// 2.3.5: FxTwitter source, retries, stale sources and quick retry after a failed check.
// Public posts only, trimmed to the fields the app reads (same shape as the real API answer).
const {parseFx}=require('./backend');
const fxBody=JSON.stringify({code:200,results:[
 {type:'status',id:'2109812360596865224',url:'https://x.com/thsottiaux/status/2109812360596865224',text:'Global reset landing by EOD PST time. Enjoy',
  author:{screen_name:'thsottiaux'},created_at:'Tue Oct 13 01:03:59 +0000 2026',created_timestamp:1791853439,reposted_by:null,
  replying_to:{screen_name:'thsottiaux',status:'2109812216212099456'}},
 {type:'status',id:'2109873287853707513',url:'https://x.com/thsottiaux/status/2109873287853707513',text:"What would you like with your side of reset? It's done.",
  author:{screen_name:'thsottiaux'},created_timestamp:1791867966,reposted_by:null,quote:{text:'We will reset Codex rate limits tomorrow',author:{screen_name:'other'}}},
 {type:'status',id:'999',url:'https://x.com/other/status/999',text:'Codex limits will reset tomorrow',author:{screen_name:'other'},created_timestamp:1791867000,
  reposted_by:{screen_name:'thsottiaux'}}],cursor:{}});
const fxSrc={type:'fxtwitter',name:'FxTwitter',url:'https://fx.example/statuses',attempts:4};
const fxNow=1791860000;
test('FxTwitter posts are parsed; reposts and quoted text are ignored',()=>{
 const posts=parseFx(fxBody,fxSrc);
 assert.equal(posts.length,2);
 assert.equal(posts[0].url,'https://x.com/thsottiaux/status/2109812360596865224');
 assert.equal(posts[0].at,1791853439);
 assert.ok(!posts.some(p=>p.text.includes('tomorrow')));
 const hit=selectTiboPost(posts.filter(p=>resetPhase(p)),fxNow);
 assert.equal(hit.id,'2109812360596865224');assert.equal(hit.phase,'upcoming');
 assert.deepEqual(parseFx('{"code":404,"results":[],"cursor":{"top":null}}',fxSrc),[]);
 assert.deepEqual(parseFx('not json',fxSrc),[]);
});
test('a flaky source is retried until it answers',async()=>{
 let calls=0;
 const r=await fetchTiboPosts({sources:[fxSrc],retryDelay:0,requestFn:async()=>++calls<3?{status:404,body:'{"code":404,"results":[]}'}:{status:200,body:fxBody}});
 assert.equal(calls,3);assert.equal(r.source,'FxTwitter');assert.equal(r.attempts,3);assert.equal(r.latestPostAt,1791867966);
});
test('a source that only returns months-old posts does not count as a successful check',async()=>{
 const old={type:'syndication',name:'X',url:'https://x.example',maxAge:14*86400};
 const html=`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({tweets:[{id_str:'1',full_text:'hello',created_at:'Wed Nov 19 23:45:08 +0000 2025',user:{screen_name:'thsottiaux'}}]})}</script>`;
 await assert.rejects(fetchTiboPosts({sources:[old],retryDelay:0,now:()=>fxNow,requestFn:async()=>({status:200,body:html})}),/旧帖子/);
 // ...and the next source is still tried
 const r=await fetchTiboPosts({sources:[old,fxSrc],retryDelay:0,now:()=>fxNow,requestFn:async u=>u.startsWith('https://x.')?{status:200,body:html}:{status:200,body:fxBody}});
 assert.equal(r.source,'FxTwitter');
});
test('a failed check is retried within minutes and only repeated failures are reported',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tibo-retry-'));
 const old=process.env.USAGE_DATA_DIR;process.env.USAGE_DATA_DIR=dir;
 let time=fxNow*1000,fail=true,calls=0,app;
 mock.method(Date,'now',()=>time);
 const fetchPosts=async()=>{calls++;if(fail)throw Error('FxTwitter: HTTP 404');return {posts:parseFx(fxBody,fxSrc),source:'FxTwitter',latestPostAt:1791867966};};
 try{
  app=await startServer({autoRefresh:false,fetchTiboPosts:fetchPosts,fetchCodex:async()=>gpt(time/1000)});
  const state=async()=> (await (await fetch(app.url+'state')).json()).tibo;
  await app.checkTibo();assert.equal(calls,1);
  let t=await state();assert.equal(t.ok,false);assert.equal(t.failStreak,1);assert.ok(t.nextCheckAt-fxNow<=130);
  time+=60*1000;await app.checkTibo();assert.equal(calls,1,'not before the retry time');
  time+=70*1000;await app.checkTibo();assert.equal(calls,2,'retried after about 2 minutes');
  t=await state();assert.equal(t.failStreak,2);
  fail=false;time+=5*60*1000;await app.checkTibo();assert.equal(calls,3);
  t=await state();assert.equal(t.ok,true);assert.equal(t.failStreak,0);assert.equal(t.source,'FxTwitter');
  time+=5*60*1000;await app.checkTibo();assert.equal(calls,3,'after a success, the normal 10-minute interval applies');
 }finally{app?.stop();mock.restoreAll();if(old)process.env.USAGE_DATA_DIR=old;else delete process.env.USAGE_DATA_DIR;fs.rmSync(dir,{recursive:true,force:true});}
});

// 2.3.6: the October 15 reset thread. The announcement says "Day 10/ Reset" after another sentence, and the two
// followups ("Landing within the next 2 hours", "Done and dusted") have no reset word of their own.
const oct15=JSON.stringify({code:200,results:[
 {type:'status',id:'2110750421367287996',text:'Day 11/\n\nWe\'ve landed a series of changes and more compute to very significantly decrease the occurrence of the disruptive "Selected model is at capacity. Please try a different model".',
  author:{screen_name:'thsottiaux'},created_timestamp:1792077090,reposted_by:null,replying_to:null},
 {type:'status',id:'2110618732666257557',text:'Done and dusted',author:{screen_name:'thsottiaux'},created_timestamp:1792045693,reposted_by:null,replying_to:null,
  quote:{id:'2110595554036400151',text:'Landing within the next 2 hours',author:{screen_name:'thsottiaux'},created_timestamp:1792040167}},
 {type:'status',id:'2110595554036400151',text:'Landing within the next 2 hours',author:{screen_name:'thsottiaux'},created_timestamp:1792040167,reposted_by:null,
  replying_to:{screen_name:'thsottiaux',status:'2110595484180214059'}},
 {type:'status',id:'2110595484180214059',text:'The reports of my reset button being lost are greatly exaggerated\n\nDay 10/ Reset',
  author:{screen_name:'thsottiaux'},created_timestamp:1792040151,reposted_by:null,replying_to:null},
 {type:'status',id:'2109873307722121591',text:'Mashed @poteto on the house.',author:{screen_name:'thsottiaux'},created_timestamp:1791867970,reposted_by:null,
  replying_to:{screen_name:'thsottiaux',status:'2109873287853707513'}},
 {type:'status',id:'2109873287853707513',text:"What would you like with your side of reset? It's done.",author:{screen_name:'thsottiaux'},created_timestamp:1791867966,reposted_by:null,
  quote:{id:'2109812360596865224',text:'Global reset landing by EOD PST time. Enjoy',author:{screen_name:'thsottiaux'},created_timestamp:1791853439}}],cursor:{}});
test('October 15 reset thread is caught at every step',async()=>{
 const r=await fetchTiboPosts({sources:[fxSrc],retryDelay:0,requestFn:async()=>({status:200,body:oct15})});
 const by=id=>r.posts.find(p=>p.id===id);
 assert.equal(resetPhase(by('2110595484180214059')),'announcement');
 assert.equal(resetPhase(by('2110595554036400151')),'upcoming');
 assert.equal(resetPhase(by('2110618732666257557')),'completed');
 assert.equal(resetPhase(by('2109873287853707513')),'completed');
 // ordinary replies and unrelated posts in or near the thread stay quiet
 assert.equal(resetPhase(by('2109873307722121591')),null);
 assert.equal(resetPhase(by('2110750421367287996')),null);
 // right after the announcement, the app warns that a reset is coming
 const early=annotateThreads(parseFx(oct15,fxSrc).filter(p=>p.at<=1792040167));
 assert.equal(selectTiboPost(early,1792040300).phase,'upcoming');
 // after "Done and dusted", the newest hit says the reset is done
 const hit=selectTiboPost(r.posts,1792046000);
 assert.equal(hit.id,'2110618732666257557');assert.equal(hit.phase,'completed');
});
test('a followup only counts inside a recent Tibo reset thread',()=>{
 const base={author:{screen_name:'thsottiaux'},reposted_by:null};
 const body=JSON.stringify({code:200,results:[
  {...base,id:'1',text:'Day 10/ Reset',created_timestamp:1000000},
  {...base,id:'2',text:'Done and dusted',created_timestamp:1000000+13*3600,quote:{id:'1',text:'Day 10/ Reset',author:{screen_name:'thsottiaux'},created_timestamp:1000000}},
  {...base,id:'3',text:'Done and dusted',created_timestamp:1000100,quote:{id:'9',text:'We will reset Codex limits tomorrow',author:{screen_name:'other'},created_timestamp:1000000}},
  {...base,id:'4',text:'Landing within the next 2 hours',created_timestamp:1000100,replying_to:{screen_name:'thsottiaux',status:'8'}}]});
 const posts=annotateThreads(parseFx(body,fxSrc));
 assert.equal(resetPhase(posts.find(p=>p.id==='2')),null);
 assert.equal(resetPhase(posts.find(p=>p.id==='3')),null);
 assert.equal(resetPhase(posts.find(p=>p.id==='4')),null);
});
