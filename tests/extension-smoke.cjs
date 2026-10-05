// Opt-in public-network smoke: isolated MV3 profile, public rooms, no account cookies.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'live-assistant-smoke-'));
const output = path.join(root, 'output', 'verification');
fs.mkdirSync(output, { recursive:true });

(async () => {
  const [dy,bl] = await Promise.all([
    fetch('https://www.douyu.com/betard/288016', { signal:AbortSignal.timeout(15000) }).then(r=>r.json()),
    fetch('https://api.live.bilibili.com/room/v1/Room/get_info?id=7734200', { signal:AbortSignal.timeout(15000) }).then(r=>r.json()),
  ]);
  assert.equal(Number(dy.room.show_status), 1, 'public Douyu room needs to be live for this opt-in check');
  assert.equal(Number(bl.data.live_status), 1, 'public Bilibili room needs to be live for this opt-in check');
  const context = await chromium.launchPersistentContext(profile, {
    headless:true, viewport:{width:720,height:600}, colorScheme:'dark',
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}),
    args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.version,'1.3.4');
    const now=Date.now();
    const entries={
      douyu:{name:dy.room.nickname,roomId:'288016',platform:'douyu',url:'https://www.douyu.com/288016',isLive:true,
        title:dy.room.room_name,thumbnail:dy.room.coverSrc,thumbnailFallback:dy.room.coverSrc,thumbnailKind:'cover',startTime:new Date(Number(dy.room.show_time)*1000).toISOString(),viewers:dy.room.online||0},
      bilibili:{name:'哔哩哔哩英雄联盟赛事',roomId:'7734200',platform:'bilibili',url:'https://live.bilibili.com/7734200',isLive:true,
        title:bl.data.title,thumbnail:bl.data.user_cover,thumbnailFallback:bl.data.user_cover,thumbnailKind:'cover',viewers:bl.data.online||0},
    };
    // This public-network check exercises image enrichment, not private followed lists.
    // Explicit coverage prevents the old-cache migration from triggering an anonymous follow refresh.
    const platformCache=Object.fromEntries(Object.entries(entries).map(([key,entry])=>[key,{status:'ok',lastAttemptStatus:'ok',data:[entry],hasSnapshot:true,fetchedAt:now,
      offlineData:[],offlineSupported:false,offlineCoverage:'unsupported',offlineStatus:'idle',offlineHasSnapshot:false,offlineFetchedAt:0}]));
    await worker.evaluate(data=>chrome.storage.local.set(data),{platformCacheVersion:2,platformCache,enabledPlatforms:['douyu','bilibili'],platformOrder:['douyu','bilibili'],favoriteStreamers:[]});
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('requestfailed',request=>console.log('IMAGE_REQUEST_FAILED',request.url().split('?')[0],request.failure()?.errorText));
    await page.goto(`chrome-extension://${id}/src/popup.html`);
    try { await page.waitForFunction(()=>{
      const dy=document.querySelector('.streamer-item[data-platform="douyu"] .streamer-thumbnail');
      const bl=document.querySelector('.streamer-item[data-platform="bilibili"] .streamer-thumbnail');
      return dy?.src.includes('/asrpic/') && bl?.src.includes('/live-key-frame/') && dy.naturalWidth>0 && bl.naturalWidth>0;
    },null,{timeout:18000}); } catch (error) {
      console.log('FRAME_DIAGNOSTIC',JSON.stringify(await page.evaluate(()=>({
        content:document.querySelector('#content')?.innerText,
        images:[...document.querySelectorAll('.streamer-thumbnail')].map(img=>({src:img.src,loaded:img.naturalWidth>0})),
        states:Object.fromEntries(Object.entries(liveAssistant.platformState).filter(([k])=>['douyu','bilibili'].includes(k)).map(([k,v])=>[k,{status:v.status,images:v.data.map(x=>({roomId:x.roomId,thumbnail:x.thumbnail,kind:x.thumbnailKind}))}])),
      }))));
      console.log('DIRECT_FRAME_DIAGNOSTIC',JSON.stringify(await worker.evaluate(()=>fetchLiveThumbnails({platform:'douyu',roomIds:['288016']}))));
      await page.screenshot({path:path.join(output,'smoke-failure.png')});
      throw error;
    }
    const results=await page.evaluate(async()=>{
      await liveAssistant.flushStorage();
      return {version:chrome.runtime.getManifest().version,rooms:[...document.querySelectorAll('.streamer-item')].map(card=>({
        platform:card.dataset.platform,room:card.dataset.streamerId,image:card.querySelector('.streamer-thumbnail').src,
        imageLoaded:card.querySelector('.streamer-thumbnail').naturalWidth>0,
      })),states:Object.fromEntries(Object.entries(liveAssistant.platformState).filter(([k])=>['douyu','bilibili'].includes(k)).map(([k,v])=>[k,{status:v.status,fetchedAt:v.fetchedAt}]))};
    });
    assert.deepEqual(errors,[]);
    assert.equal(results.states.douyu.fetchedAt,now,'frame completion must not change follow freshness');
    assert.equal(results.states.bilibili.fetchedAt,now);
    await page.screenshot({path:path.join(output,'live-frames-dark.png')});
    await page.emulateMedia({colorScheme:'light'});
    await page.waitForFunction(()=>getComputedStyle(document.body).backgroundColor==='rgb(255, 255, 255)');
    await page.screenshot({path:path.join(output,'live-frames-light.png')});
    await page.locator('#settingsBtn').click();
    await page.screenshot({path:path.join(output,'settings-light.png')});
    await page.emulateMedia({colorScheme:'dark'});
    await page.waitForFunction(()=>getComputedStyle(document.body).backgroundColor==='rgb(15, 15, 15)');
    await page.screenshot({path:path.join(output,'settings-dark.png')});
    fs.writeFileSync(path.join(output,'extension-smoke.json'),JSON.stringify({browser:context.browser()?.version(),...results,errors},null,2));
    console.log(JSON.stringify(results,null,2));
  } finally {await context.close();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  const safeRoot=path.resolve(os.tmpdir())+path.sep;
  if(path.resolve(profile).startsWith(safeRoot) && path.basename(profile).startsWith('live-assistant-smoke-')) fs.rmSync(profile,{recursive:true,force:true});
});
