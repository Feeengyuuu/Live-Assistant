// Optional browser regressions: set PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE,
// or install playwright-core and a compatible Chromium. No real profile is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const sourceRoot = process.env.SOURCE_ROOT || path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(sourceRoot, 'src/popup.html'), 'utf8').replace(/<script[^>]+src=["']\/src\/popup.js["'][^>]*><\/script>/, '');
const source = fs.readFileSync(path.join(sourceRoot, 'src/popup.js'), 'utf8');
const streamer = (name, platform = 'bilibili', roomId = '1') => ({
  name, platform, roomId, url: `https://${platform === 'bilibili' ? 'live.bilibili.com' : 'www.douyu.com'}/${roomId}`,
  isLive: true, title: `${name} 的直播`, viewers: 1000,
  avatar: 'https://assets.test/avatar.svg', thumbnail: `https://assets.test/cover-${roomId}.svg`,
  thumbnailFallback: `https://assets.test/cover-${roomId}.svg`, thumbnailKind: 'cover', gameName: '游戏',
});
const ok = data => ({ status: 'ok', success: true, data, isLoggedIn: true, fetchedAt: Date.now() });
const offline = (name, platform = 'bilibili', roomId = '2') => ({ ...streamer(name, platform, roomId), isLive: false, isOffline: true, thumbnail: '', thumbnailFallback: '' });
const withOffline = (data, offlineData, extras = {}) => ({ ...ok(data), offlineData, offlineSupported: true, offlineCoverage: 'complete', ...extras });
let browser;
const failures = [];
const metrics = {};

async function setup(enabled = ['bilibili'], extra = {}) {
  const page = await browser.newPage({ viewport: { width: 720, height: 600 }, colorScheme: 'dark' });
  page.setDefaultTimeout(2500);
  await page.route('**/*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#25384b"/></svg>' }));
  await page.setContent(html);
  await page.evaluate(store => {
    window.auditStore = store;
    window.auditMessages = [];
    window.auditFrames = {};
    window.auditTabs = [];
    window.auditWrites = [];
    window.chrome = {
      storage: { local: {
        get: async () => structuredClone(auditStore),
        set: async values => { const copy = structuredClone(values); auditWrites.push(copy); Object.assign(auditStore, copy); },
        remove: (keys, cb) => { keys.forEach(key => delete auditStore[key]); cb?.(); return Promise.resolve(); },
      } },
      runtime: {
        getManifest: () => ({ version: '1.3.4' }),
        sendMessage: (request, callback) => {
          const message = { request, callback, done: false };
          auditMessages.push(message);
          if (request.action === 'getLiveThumbnails') {
            message.done = true;
            queueMicrotask(() => callback({ success: true, thumbnails: auditFrames }));
          }
        },
      },
      tabs: { create: options => { auditTabs.push(options); return Promise.resolve(); } },
    };
  }, { enabledPlatforms: enabled, platformOrder: enabled, ...extra });
  await page.addScriptTag({ content: source + '\nwindow.liveAssistant = window.liveAssistant || new LiveAssistant();' });
  await page.evaluate(async () => { await window.liveAssistant.ready; });
  await page.waitForFunction(() => auditMessages.length > 0 || document.querySelector('.project-footer'));
  return page;
}

async function reply(page, platform, response, last = false) {
  await page.evaluate(({ platform, response, last }) => {
    const messages = auditMessages.filter(m => !m.done && m.request.action === 'getFollowedStreamers' && m.request.platform === platform);
    const message = last ? messages.at(-1) : messages[0];
    if (!message) throw new Error(`No pending request for ${platform}`);
    message.done = true;
    message.callback(response);
  }, { platform, response, last });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));
}

async function replyOffline(page, response, last = false) {
  await page.waitForFunction(() => auditMessages.some(m => !m.done && m.request.action === 'getOfflineFollowedStreamers' && m.request.platform === 'bilibili'));
  await page.evaluate(({response,last}) => {
    const pending = auditMessages.filter(m => !m.done && m.request.action === 'getOfflineFollowedStreamers' && m.request.platform === 'bilibili');
    const message = last ? pending.at(-1) : pending[0];
    message.done = true;
    message.callback(response);
  },{response,last});
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve,30)));
}

async function setupOffline(enabled = ['bilibili'], extra = {}) {
  const page = await setup(enabled, extra);
  await page.locator('.offline-toggle').click();
  return page;
}

async function run(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}

async function regressions() {
  await run('fast platforms render without waiting for slow platforms', async () => {
    const page = await setup(['bilibili', 'douyu']);
    try {
      await reply(page, 'bilibili', ok([streamer('fast')]));
      await page.waitForFunction(() => document.querySelector('.streamer-name')?.textContent === 'fast');
      assert.equal(await page.evaluate(() => auditMessages.filter(m => m.request.platform === 'douyu' && !m.done).length), 1);
    } finally { await page.close(); }
  });
  await run('same-scope refresh is coalesced and cannot regress to older responses', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => { window.liveAssistant.refreshInBackground(); });
      assert.equal(await page.evaluate(() => auditMessages.filter(m => m.request.action === 'getFollowedStreamers').length), 1);
      await reply(page, 'bilibili', ok([streamer('latest')]));
      await page.waitForFunction(() => document.querySelector('.streamer-name')?.textContent === 'latest');
    } finally { await page.close(); }
  });
  await run('transient failure preserves cards and successful freshness timestamp', async () => {
    const page = await setup();
    try {
      await reply(page, 'bilibili', ok([streamer('retained')]));
      const before = await page.evaluate(() => liveAssistant.platformState.bilibili.fetchedAt);
      await page.locator('#refreshBtn').click();
      await reply(page, 'bilibili', { status: 'error', success: false, data: [], isLoggedIn: null, error: '请求超时', errorKind: 'timeout' });
      assert.equal(await page.locator('.streamer-name').textContent(), 'retained');
      assert.equal(await page.locator('.login-prompt').count(), 0);
      const state = await page.evaluate(async () => { await liveAssistant.flushStorage(); return { state: liveAssistant.platformState.bilibili, cache: auditStore.platformCache.bilibili }; });
      assert.equal(state.state.fetchedAt, before);
      assert.equal(state.cache.fetchedAt, before);
      assert.equal(state.state.status, 'error');
      assert.match(await page.locator('#content').innerText(), /超时|失败|上次|缓存/);
    } finally { await page.close(); }
  });
  await run('confirmed logout clears old private cards instead of retaining them', async () => {
    const page = await setup();
    try {
      await reply(page, 'bilibili', ok([streamer('private')]));
      await page.locator('#refreshBtn').click();
      await reply(page, 'bilibili', { status: 'auth_required', success: false, data: [], isLoggedIn: false, loginUrl: 'https://www.bilibili.com' });
      await page.waitForFunction(() => !document.querySelector('.streamer-item'));
      assert.equal(await page.locator('.login-btn').count(), 1);
      await page.evaluate(() => liveAssistant.flushStorage());
      assert.equal(await page.evaluate(() => auditStore.platformCache.bilibili.data.length), 0);
    } finally { await page.close(); }
  });
  await run('unchanged cards and image nodes survive refresh and keep scroll position', async () => {
    const page = await setup();
    try {
      const data = Array.from({ length: 60 }, (_,i) => streamer(`主播 ${i}`, 'bilibili', String(i+1)));
      await reply(page, 'bilibili', ok(data));
      await page.evaluate(() => {
        window.auditNodes = [...document.querySelectorAll('.streamer-item')];
        window.auditImages = [...document.querySelectorAll('.streamer-thumbnail')];
        document.querySelector('#content').scrollTop = 450;
      });
      data[0].viewers = 2000;
      await page.locator('#refreshBtn').click();
      await reply(page, 'bilibili', ok(data));
      const result = await page.evaluate(() => ({
        cards: auditNodes.filter((node,i) => node === document.querySelectorAll('.streamer-item')[i]).length,
        images: auditImages.filter((node,i) => node === document.querySelectorAll('.streamer-thumbnail')[i]).length,
        scrollTop: document.querySelector('#content').scrollTop,
      }));
      metrics.retainedCards = result.cards; metrics.retainedImages = result.images;
      assert.equal(result.cards, 60); assert.equal(result.images, 60); assert.ok(Math.abs(result.scrollTop - 450) < 5);
    } finally { await page.close(); }
  });
  await run('favorites reorder immediately without requests and preserve keyboard focus', async () => {
    const page = await setup();
    try {
      await reply(page, 'bilibili', ok([streamer('alpha', 'bilibili', '1'),streamer('beta', 'bilibili', '2')]));
      const messages = await page.evaluate(() => auditMessages.length);
      await page.locator('.favorite-button').nth(1).focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.locator('.streamer-name').allTextContents(), ['beta','alpha']);
      assert.equal(await page.evaluate(() => document.activeElement.closest('.streamer-item')?.dataset.streamerId), 'bilibili:https://live.bilibili.com/2');
      assert.equal(await page.evaluate(() => auditMessages.length), messages);
    } finally { await page.close(); }
  });
  await run('initial completion does not reveal floating navigation over settings', async () => {
    const page = await setup();
    try {
      await page.locator('#settingsBtn').click();
      await reply(page, 'bilibili', ok([streamer('alpha')]));
      assert.equal(await page.locator('#settingsPanel').isVisible(), true);
      assert.equal(await page.locator('.floating-buttons-container').isVisible(), false);
    } finally { await page.close(); }
  });
  await run('live frame enrichment updates the existing image and preserves its cover fallback', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => { auditFrames = { '1': { thumbnail: 'https://i0.hdslb.com/bfs/live-key-frame/actual.jpg', thumbnailKind: 'live', thumbnailFetchedAt: Date.now() } }; });
      await reply(page, 'bilibili', ok([streamer('frame')]));
      await page.waitForFunction(() => document.querySelector('.streamer-thumbnail')?.src.includes('/live-key-frame/'));
      assert.match(await page.locator('.streamer-thumbnail').getAttribute('src'), /actual\.jpg/);
      await page.evaluate(() => document.querySelector('.streamer-thumbnail').dispatchEvent(new Event('error')));
      await page.waitForFunction(() => document.querySelector('.streamer-thumbnail')?.src.includes('assets.test/cover'));
      assert.equal(await page.locator('.streamer-item').count(), 1);
    } finally { await page.close(); }
  });
  await run('keyboard can open a stream without activating its favorite', async () => {
    const page = await setup();
    try {
      await reply(page, 'bilibili', ok([streamer('keyboard')]));
      const link = page.locator('.streamer-item a[href],.streamer-item[tabindex]').first();
      await link.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => auditTabs.length === 1);
      assert.equal(await page.evaluate(() => auditTabs[0].url), 'https://live.bilibili.com/1');
      assert.equal(await page.locator('.favorite-button.favorited').count(), 0);
    } finally { await page.close(); }
  });
  await run('legacy settings and favorites migrate without loss', async () => {
    const page = await setup(['bilibili'], { favoriteStreamers: ['legacy'], floatingButtonsCollapsed: true,
      cachedTimestamp: Date.now() - 120000, cachedStreamers: { bilibili: { isLoggedIn: true, data: [streamer('legacy')] } } });
    try {
      assert.equal(await page.locator('.favorite-button.favorited').count(), 1);
      await reply(page, 'bilibili', ok([streamer('legacy')]));
      await page.evaluate(() => liveAssistant.flushStorage());
      assert.deepEqual(await page.evaluate(() => auditStore.favoriteStreamers), ['legacy']);
      assert.equal(await page.evaluate(() => auditStore.platformCacheVersion), 2);
      assert.equal(await page.locator('.floating-buttons.collapsed').count(), 1);
    } finally { await page.close(); }
  });
  await run('obsolete platform scope cannot overwrite new settings or persisted cards', async () => {
    const page = await setup();
    try {
      await page.evaluate(() => { liveAssistant.enabledPlatforms=['bilibili','douyu']; liveAssistant.refreshPlatforms(); });
      await reply(page,'bilibili',ok([streamer('new-scope','bilibili','2')]),true);
      await reply(page,'douyu',ok([streamer('new-platform','douyu','3')]));
      await reply(page,'bilibili',ok([streamer('obsolete','bilibili','1')]));
      await page.evaluate(() => liveAssistant.flushStorage());
      assert.deepEqual(await page.locator('.streamer-name').allTextContents(),['new-scope','new-platform']);
      assert.equal(await page.evaluate(() => auditStore.platformCache.bilibili.data[0].name),'new-scope');
    } finally { await page.close(); }
  });
  await run('restoring settings preserves favorites and rejects obsolete request results after Save', async () => {
    const page = await setup(['bilibili'], {favoriteStreamers:['keep-this-favorite']});
    try {
      page.on('dialog',dialog=>dialog.accept());
      await page.locator('#settingsBtn').click();
      await page.locator('#resetSettingsBtn').click();
      assert.equal(await page.evaluate(()=>auditMessages.filter(m=>m.request.action==='getFollowedStreamers').length),1,'restore only edits the draft');
      assert.equal(await page.locator('.floating-buttons-container').isVisible(),false);
      await page.locator('#applySettingsBtn').click();
      await page.waitForFunction(()=>auditMessages.filter(m=>m.request.action==='getFollowedStreamers').length===6);
      await reply(page,'bilibili',ok([streamer('after-reset','bilibili','2')]),true);
      for(const platform of ['douyu','huya','douyin','twitch']) await reply(page,platform,{status:'auth_required',success:false,data:[],isLoggedIn:false});
      await reply(page,'bilibili',ok([streamer('before-reset','bilibili','1')]));
      await page.evaluate(()=>liveAssistant.flushStorage());
      assert.equal(await page.evaluate(()=>auditStore.platformCache.bilibili.data[0].name),'after-reset');
      assert.deepEqual(await page.evaluate(()=>auditStore.favoriteStreamers),['keep-this-favorite']);
      assert.equal(await page.locator('#settingsPanel').isVisible(),false);
    } finally { await page.close(); }
  });
  await run('metadata refresh does not flash an already acquired live frame back to its poster', async () => {
    const page = await setup(['douyu']);
    try {
      await page.evaluate(()=>{auditFrames={'1':{thumbnail:'https://rpic.douyucdn.cn/asrpic/frame.jpg',thumbnailKind:'live',thumbnailFetchedAt:Date.now()}};});
      await reply(page,'douyu',ok([streamer('room','douyu','1')]));
      await page.waitForFunction(()=>document.querySelector('.streamer-thumbnail')?.src.includes('/asrpic/'));
      await page.evaluate(()=>{window.auditFrameImage=document.querySelector('.streamer-thumbnail');auditFrames={};});
      await page.locator('#refreshBtn').click();
      await reply(page,'douyu',ok([streamer('room','douyu','1')]));
      assert.match(await page.locator('.streamer-thumbnail').getAttribute('src'),/\/asrpic\//);
      assert.equal(await page.evaluate(()=>auditFrameImage===document.querySelector('.streamer-thumbnail')),true);
    } finally {await page.close();}
  });
  await run('settings draft can be canceled; fixed actions remain visible and Save applies changes', async () => {
    const page=await setup();
    try {
      await reply(page,'bilibili',ok([streamer('settings')]));
      await page.locator('#settingsBtn').click();
      const toggle=page.locator('.platform-item[data-platform="douyu"] input');
      await toggle.check();
      assert.match(await page.locator('#settingsSaveState').innerText(),/未保存/);
      for(const id of ['applySettingsBtn','cancelSettingsBtn']) {
        const rect=await page.locator('#'+id).boundingBox();assert.ok(rect.y>=0 && rect.y+rect.height<=600);
      }
      await page.locator('#cancelSettingsBtn').click();
      assert.deepEqual(await page.evaluate(()=>liveAssistant.enabledPlatforms),['bilibili']);
      await page.locator('#settingsBtn').click();
      assert.equal(await toggle.isChecked(),false);
      await toggle.check();
      await page.locator('#applySettingsBtn').click();
      await reply(page,'douyu',ok([streamer('enabled','douyu','3')]));
      assert.deepEqual(await page.evaluate(()=>auditStore.enabledPlatforms),['bilibili','douyu']);
    } finally {await page.close();}
  });
  await run('settings storage failure keeps the draft available without applying unsaved changes', async () => {
    const page = await setup();
    try {
      await reply(page,'bilibili',withOffline([streamer('已保存')],[]));
      await page.evaluate(async () => {
        await liveAssistant.flushStorage();
        window.auditOriginalSet = chrome.storage.local.set;
        chrome.storage.local.set = async values => {
          if (values.enabledPlatforms) throw new Error('simulated storage failure');
          return auditOriginalSet(values);
        };
      });
      await page.locator('#settingsBtn').click();
      await page.locator('.platform-item[data-platform="douyu"] input').check();
      await page.locator('#applySettingsBtn').click();
      assert.equal(await page.locator('#settingsPanel').isVisible(),true);
      assert.match(await page.locator('#settingsSaveState').innerText(),/失败/);
      assert.equal(await page.locator('.platform-item[data-platform="douyu"] input').isChecked(),true);
      assert.deepEqual(await page.evaluate(() => liveAssistant.enabledPlatforms),['bilibili']);
      await page.evaluate(() => {chrome.storage.local.set = auditOriginalSet;});
      await page.locator('#applySettingsBtn').click();
      await reply(page,'douyu',withOffline([],[]));
      assert.equal(await page.locator('#settingsPanel').isVisible(),false);
      assert.deepEqual(await page.evaluate(() => auditStore.enabledPlatforms),['bilibili','douyu']);
    } finally {await page.close();}
  });
}

async function offlineRegressions() {
  await run('collapsed offline list adds no requests or row work until explicitly opened', async () => {
    const page = await setup(['bilibili','douyu']);
    try {
      await reply(page,'bilibili',withOffline([streamer('直播')],[],{offlineCoverage:'pending'}));
      await reply(page,'douyu',withOffline([], [offline('已有数据','douyu','8')]));
      assert.equal(await page.locator('.offline-toggle').getAttribute('aria-expanded'),'false');
      assert.equal(await page.locator('.offline-item').count(),0);
      assert.equal(await page.evaluate(() => auditMessages.filter(m=>m.request.action==='getOfflineFollowedStreamers').length),0);
      await page.locator('#refreshBtn').click();
      await reply(page,'bilibili',withOffline([streamer('直播刷新')],[],{offlineCoverage:'pending'}));
      await reply(page,'douyu',withOffline([], [offline('已有数据','douyu','8')]));
      assert.equal(await page.evaluate(() => auditMessages.filter(m=>m.request.action==='getOfflineFollowedStreamers').length),0);
      assert.equal(await page.locator('.offline-item').count(),0);
      await page.locator('.offline-toggle').click();
      assert.deepEqual(await page.locator('.offline-name').allTextContents(),['已有数据']);
      await page.waitForFunction(() => auditMessages.some(m=>m.request.action==='getOfflineFollowedStreamers'));
      await page.locator('.offline-toggle').click();
      const before = await page.locator('.offline-item').count();
      await replyOffline(page,withOffline([], [offline('辅助迟到')]));
      assert.equal(await page.locator('.offline-toggle').getAttribute('aria-expanded'),'false');
      assert.equal(await page.locator('.offline-item').count(),before,'hidden completion must not build new rows');
      await page.locator('.offline-toggle').click();
      assert.deepEqual(await page.locator('.offline-name').allTextContents(),['辅助迟到','已有数据']);
      const requests = await page.evaluate(() => auditMessages.filter(m=>m.request.action==='getOfflineFollowedStreamers').length);
      assert.equal(requests,1,'reopening fresh data must reuse its cache');
    } finally {await page.close();}
  });
  await run('offline time labels distinguish a known start, a provider record, and no evidence', async () => {
    const page = await setupOffline();
    try {
      const timestamp = Date.now()-86_400_000;
      await reply(page,'bilibili',withOffline([], [
        {...offline('开播时间','bilibili','2'),lastLiveAt:timestamp,lastLiveSource:'platform_start'},
        {...offline('平台记录','bilibili','3'),lastLiveAt:timestamp,lastLiveSource:'platform_record'},
        offline('无时间','bilibili','4'),
      ]));
      const rows = await page.locator('.offline-item').allTextContents();
      assert.match(rows[0],/上次开播/);
      assert.match(rows[1],/上次直播/);
      assert.doesNotMatch(rows[1],/上次开播/);
      assert.match(rows[2],/暂无记录/);
      assert.doesNotMatch(rows[2],/1970|NaN|Invalid Date/);
    } finally {await page.close();}
  });
  await run('local last-live observation survives offline transitions and reopen without being refreshed by cache or errors', async () => {
    let page = await setupOffline();
    try {
      await reply(page,'bilibili',withOffline([streamer('观察主播','bilibili','2')],[]));
      await page.evaluate(() => liveAssistant.flushStorage());
      const key = 'bilibili:https://live.bilibili.com/2';
      const observed = await page.evaluate(key => auditStore.lastLiveHistory?.[key]?.observedLiveAt,key);
      assert.ok(Number.isFinite(observed) && observed>0);
      await page.locator('#refreshBtn').click();
      await reply(page,'bilibili',withOffline([], [offline('观察主播')]));
      assert.match(await page.locator('.offline-item').innerText(),/最近看到直播/);
      await page.evaluate(() => liveAssistant.flushStorage());
      const saved = await page.evaluate(() => structuredClone(auditStore));
      saved.platformCache.bilibili.fetchedAt=Date.now()-120000;
      await page.close();
      page = await setupOffline(['bilibili'],saved);
      assert.match(await page.locator('.offline-item').innerText(),/最近看到直播/);
      await reply(page,'bilibili',{status:'error',success:false,data:[],error:'模拟网络错误'});
      await page.evaluate(() => liveAssistant.flushStorage());
      assert.equal(await page.evaluate(key => auditStore.lastLiveHistory[key].observedLiveAt,key),observed);
      await page.locator('#refreshBtn').click();
      await reply(page,'bilibili',{status:'auth_required',success:false,data:[],isLoggedIn:false});
      await page.evaluate(() => liveAssistant.flushStorage());
      assert.equal(await page.evaluate(key => !!auditStore.lastLiveHistory[key],key),false);
    } finally {await page.close();}
  });
  await run('a newer live observation without a start time cannot inherit an older session start', async () => {
    const page = await setupOffline();
    try {
      await reply(page,'bilibili',withOffline([{...streamer('新一场','bilibili','2'),lastLiveAt:Date.now()-3*86_400_000,lastLiveSource:'platform_start'}],[]));
      await page.locator('#refreshBtn').click();
      await reply(page,'bilibili',withOffline([], [offline('新一场')]));
      assert.match(await page.locator('.offline-item').innerText(),/上次开播/);
      await page.locator('#refreshBtn').click();
      await reply(page,'bilibili',withOffline([streamer('新一场','bilibili','2')],[]));
      await page.locator('#refreshBtn').click();
      await reply(page,'bilibili',withOffline([], [offline('新一场')]));
      assert.match(await page.locator('.offline-item').innerText(),/最近看到直播/);
      assert.doesNotMatch(await page.locator('.offline-item').innerText(),/上次开播/);
    } finally {await page.close();}
  });
  await run('Bilibili offline supplement is progressive and has independent success and failure freshness', async () => {
    const page = await setupOffline();
    try {
      await reply(page,'bilibili',withOffline([streamer('直播先到')],[],{offlineCoverage:'pending'}));
      assert.equal(await page.locator('.streamer-name').innerText(),'直播先到');
      const liveTime = await page.evaluate(() => liveAssistant.platformState.bilibili.fetchedAt);
      const offlineTime = Date.now()-1000;
      await replyOffline(page,withOffline([], [offline('补充名单')], {fetchedAt:offlineTime}));
      assert.equal(await page.locator('.offline-name').innerText(),'补充名单');
      assert.equal(await page.evaluate(() => liveAssistant.platformState.bilibili.fetchedAt),liveTime);
      assert.equal(await page.evaluate(() => liveAssistant.platformState.bilibili.offlineFetchedAt),offlineTime);
      await page.locator('#refreshBtn').click();
      await reply(page,'bilibili',withOffline([streamer('直播仍更新')],[],{offlineCoverage:'pending'}));
      await replyOffline(page,{status:'error',success:false,data:[],offlineData:[],offlineSupported:true,offlineCoverage:'partial',error:'名单请求超时'});
      assert.equal(await page.locator('.streamer-name').innerText(),'直播仍更新');
      assert.equal(await page.locator('.offline-name').innerText(),'补充名单');
      assert.equal(await page.evaluate(() => liveAssistant.platformState.bilibili.status),'ok');
      assert.equal(await page.evaluate(() => liveAssistant.platformState.bilibili.offlineFetchedAt),offlineTime);
      assert.match(await page.locator('.offline-section').innerText(),/未更新|未完整|失败|尚未|上次/);
    } finally {await page.close();}
  });
  await run('an obsolete Bilibili offline response cannot overwrite the current scope', async () => {
    const page = await setupOffline();
    try {
      await reply(page,'bilibili',withOffline([streamer('直播')],[],{offlineCoverage:'pending'}));
      await page.waitForFunction(() => auditMessages.some(m => !m.done && m.request.action === 'getOfflineFollowedStreamers'));
      await page.evaluate(() => {liveAssistant.enabledPlatforms=['bilibili','douyu'];liveAssistant.refreshPlatforms();});
      await reply(page,'bilibili',withOffline([streamer('新直播')],[],{offlineCoverage:'pending'}));
      await reply(page,'douyu',withOffline([],[]));
      await replyOffline(page,withOffline([], [offline('新名单')]),true);
      await replyOffline(page,withOffline([], [offline('旧名单')]),false);
      assert.deepEqual(await page.locator('.offline-name').allTextContents(),['新名单']);
      await page.evaluate(() => liveAssistant.flushStorage());
      assert.equal(await page.evaluate(() => auditStore.platformCache.bilibili.offlineData[0].name),'新名单');
    } finally {await page.close();}
  });
  await run('offline follows appear below live cards, deduplicate and never request live frames', async () => {
    const page = await setupOffline();
    try {
      const live = streamer('正在直播', 'bilibili', '1');
      const resting = offline('已休息', 'bilibili', '2');
      await reply(page, 'bilibili', withOffline([live], [resting, resting, offline('重复的直播间', 'bilibili', '1')]));
      assert.deepEqual(await page.locator('.streamer-name').allTextContents(), ['正在直播']);
      assert.deepEqual(await page.locator('.offline-name').allTextContents(), ['已休息']);
      assert.equal(await page.locator('.offline-item img.streamer-thumbnail').count(), 0);
      assert.equal(await page.evaluate(() => {
        const liveCard = document.querySelector('.streamer-item');
        const offlineSection = document.querySelector('.offline-section');
        return !!(liveCard.compareDocumentPosition(offlineSection) & Node.DOCUMENT_POSITION_FOLLOWING);
      }), true);
      const ids = await page.evaluate(() => auditMessages.filter(m => m.request.action === 'getLiveThumbnails').flatMap(m => m.request.roomIds));
      assert.ok(!ids.includes('2'), 'offline rows must not trigger live screenshot requests');
    } finally { await page.close(); }
  });
  await run('offline favorites use the same identity when a streamer comes online', async () => {
    const page = await setupOffline();
    try {
      await reply(page, 'bilibili', withOffline([], [offline('回归主播')]));
      await page.locator('.offline-item .favorite-button').click();
      await page.evaluate(() => liveAssistant.flushStorage());
      assert.ok((await page.evaluate(() => auditStore.favoriteStreamers)).includes('bilibili:https://live.bilibili.com/2'));
      await page.locator('#refreshBtn').click();
      await reply(page, 'bilibili', withOffline([streamer('回归主播', 'bilibili', '2')], []));
      assert.equal(await page.locator('.offline-item').count(), 0);
      assert.equal(await page.locator('.streamer-item .favorite-button.favorited').count(), 1);
      await page.locator('#refreshBtn').click();
      await reply(page, 'bilibili', withOffline([], [offline('回归主播')]));
      assert.equal(await page.locator('.streamer-item').count(), 0);
      assert.equal(await page.locator('.offline-item .favorite-button.favorited').count(), 1);
    } finally { await page.close(); }
  });
  await run('offline cache survives reopen and transient failure; logout clears it', async () => {
    let page = await setupOffline();
    try {
      await reply(page, 'bilibili', withOffline([], [offline('缓存主播')], {fetchedAt:1234567890000}));
      await page.evaluate(() => liveAssistant.flushStorage());
      const stored = await page.evaluate(() => structuredClone(auditStore));
      await page.close();
      page = await setupOffline(['bilibili'], stored);
      assert.equal(await page.locator('.offline-name').innerText(), '缓存主播');
      await reply(page, 'bilibili', {status:'error',success:false,data:[],offlineData:[],isLoggedIn:null,error:'网络超时'});
      assert.equal(await page.locator('.offline-name').innerText(), '缓存主播');
      assert.equal(await page.evaluate(() => liveAssistant.platformState.bilibili.fetchedAt),1234567890000);
      await page.locator('#refreshBtn').click();
      await reply(page, 'bilibili', {status:'auth_required',success:false,data:[],offlineData:[],isLoggedIn:false});
      assert.equal(await page.locator('.offline-item').count(),0);
      await page.evaluate(() => liveAssistant.flushStorage());
      assert.equal(await page.evaluate(() => auditStore.platformCache.bilibili.offlineData.length),0);
    } finally { await page.close(); }
  });
  await run('offline section supports collapse and keyboard navigation without extra network', async () => {
    const page = await setupOffline();
    try {
      await reply(page,'bilibili',withOffline([], [offline('键盘主播')]));
      const requestCount = await page.evaluate(() => auditMessages.length);
      await page.locator('.offline-toggle').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.offline-toggle').getAttribute('aria-expanded'),'false');
      assert.equal(await page.locator('.offline-list').isVisible(),false);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.offline-list').isVisible(),true);
      await page.locator('.offline-item a[href]').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => auditTabs.at(-1)?.url),'https://live.bilibili.com/2');
      assert.equal(await page.locator('.offline-item .favorite-button.favorited').count(),0);
      assert.equal(await page.evaluate(() => auditMessages.length),requestCount);
    } finally {await page.close();}
  });
  await run('a platform without offline support does not infer offline from its missing live rows', async () => {
    const page = await setupOffline(['twitch']);
    try {
      await reply(page,'twitch',withOffline([streamer('直播结束前','twitch','1')],[],{offlineSupported:false,offlineCoverage:'unsupported'}));
      await page.locator('#refreshBtn').click();
      await reply(page,'twitch',withOffline([],[],{offlineSupported:false,offlineCoverage:'unsupported'}));
      assert.equal(await page.locator('.streamer-item').count(),0);
      assert.equal(await page.locator('.offline-item').count(),0);
      assert.match(await page.locator('.offline-section').innerText(),/未提供|暂不|暂无|不支持/);
    } finally {await page.close();}
  });
}

async function benchmark() {
  const page = await setup();
  try {
    const data = Array.from({ length: 100 }, (_,i) => streamer(`主播 ${i}`, 'bilibili', String(i+1)));
    await reply(page, 'bilibili', ok(data));
    const result = await page.evaluate(data => {
      const app = liveAssistant;
      const times = [];
      const first = [...document.querySelectorAll('.streamer-item')];
      let created = 0;
      const create = document.createElement.bind(document);
      document.createElement = (...args) => { created++; return create(...args); };
      for (let i=0; i<20; i++) {
        const start = performance.now();
        app.renderStreamers({ bilibili: { isLoggedIn: true, data } });
        times.push(performance.now()-start);
      }
      document.createElement = create;
      times.sort((a,b)=>a-b);
      return { medianRenderMs:times[10], createdElements:created, retainedCards:first.filter((el,i)=>el===document.querySelectorAll('.streamer-item')[i]).length };
    }, data);
    console.log(JSON.stringify({ sourceRoot, benchmark:result }));
  } finally { await page.close(); }
}

(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath:process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    if (process.argv.includes('--benchmark')) await benchmark(); else { await regressions(); await offlineRegressions(); }
    console.log(JSON.stringify({ browser:browser.version(), failures, metrics }));
    if (failures.length) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
