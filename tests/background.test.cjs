const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8');
const cookies = [
  ['SESSDATA', 'test-session'], ['DedeUserID', '123'], ['acf_uid', '123'],
  ['udb_uid', '123'], ['sessionid', 'test-session'], ['auth-token', 'test-token'], ['unique_id', 'test-device'],
].map(([name, value]) => ({ name, value }));

function harness(fetchImpl, options = {}) {
  let listener;
  const events = {};
  const event = (name) => ({ addListener: (fn) => { events[name] = fn; } });
  const alarms = new Map();
  const notifications = [];
  const tabs = [];
  // Existing platform tests run without tracked channels unless a test supplies them.
  const stored = { trackedChannels: options.trackedChannels ?? { youtube: [], twitch: [] }, ...options.stored };
  const context = vm.createContext({
    fetch: fetchImpl, AbortController, AbortSignal, URL, setTimeout: options.setTimeout || setTimeout,
    clearTimeout, Date, console: { error() {}, warn() {} },
    importScripts: (...files) => files.forEach((file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context)),
    chrome: {
      cookies: { getAll: options.getCookies || ((_details, callback) => callback(options.cookies ?? cookies)) },
      storage: { onChanged: event('storage'), local: {
        get: async () => structuredClone(stored),
        set: async (values) => { Object.assign(stored, structuredClone(values)); },
      } },
      alarms: {
        onAlarm: event('alarm'),
        get: async (name) => alarms.get(name),
        create: async (name, info) => { alarms.set(name, { name, ...info }); },
        clear: async (name) => alarms.delete(name),
      },
      notifications: {
        onClicked: event('notificationClick'),
        getPermissionLevel: async () => options.permissionLevel ?? 'granted',
        create: async (id, info) => {
          if (options.rejectRemoteIcons && !info.iconUrl.startsWith('chrome-extension://')) throw new Error('Unable to download all specified images.');
          notifications.push({ id, ...info });
          return id;
        },
        clear: async () => true,
      },
      tabs: { create: async (info) => { tabs.push(info); } },
      runtime: {
        getURL: (file) => `chrome-extension://test-id/${file}`,
        onInstalled: event('installed'), onStartup: event('startup'),
        onMessage: { addListener: (fn) => { listener = fn; } },
      },
    },
  });
  vm.runInContext(source, context);
  return {
    stored, alarms, notifications, tabs, events,
    fetchPlatform: (key) => vm.runInContext(`fetchPlatform(${JSON.stringify(key)})`, context),
    checkFavoriteLive: () => vm.runInContext('checkFavoriteLive()', context).then(plain),
    scheduleLiveCheck: () => vm.runInContext('scheduleLiveCheck()', context),
    message: (platform, action = 'getFollowedStreamers') => new Promise((resolve) => listener({ action, platform }, {}, resolve)),
  };
}

// Values created inside the vm context have their own Array prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => body };
}

function bilibiliItem(roomid = 123) {
  return { roomid, uname: '测试主播', live_status: 1, title: '测试直播' };
}

function douyuItem(room_id) {
  return { room_id, nickname: `主播 ${room_id}`, show_status: 1, videoLoop: 0 };
}

test('known Bilibili authentication error is not a successful empty list', async () => {
  const result = await harness(async () => json({ code: -101, message: '账号未登录' })).message('bilibili');
  assert.equal(result.status, 'auth_required');
  assert.equal(result.success, false);
  assert.equal(result.isLoggedIn, false);
  assert.equal(result.fetchedAt, undefined);
});

test('HTTP 500 and 403 are service failures, not logged out or healthy empty lists', async () => {
  for (const status of [500, 403]) {
    const result = await harness(async () => json({}, status)).message('bilibili');
    assert.equal(result.status, 'error');
    assert.equal(result.success, false);
    assert.equal(result.isLoggedIn, null);
    assert.equal(result.fetchedAt, undefined);
  }
});

test('network and malformed JSON errors retain unknown authentication state', async () => {
  for (const fetchImpl of [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ...json({}), json: async () => { throw new SyntaxError('bad json'); } }),
  ]) {
    const result = await harness(fetchImpl).message('bilibili');
    assert.equal(result.status, 'error');
    assert.equal(result.isLoggedIn, null);
    assert.ok(result.error);
  }
});

test('successful empty and populated Bilibili responses remain distinct from invalid structure', async () => {
  for (const list of [[], [bilibiliItem()]]) {
    const result = await harness(async () => json({ code: 0, data: { list } })).message('bilibili');
    assert.equal(result.status, 'ok');
    assert.equal(result.success, true);
    assert.equal(result.data.length, list.length);
    assert.ok(Number.isFinite(result.fetchedAt));
  }
  const broken = await harness(async () => json({ code: 0, data: {} })).message('bilibili');
  assert.equal(broken.status, 'error');
});

test('Twitch nullable game is valid and existing authentication/query are preserved', async () => {
  let request;
  const result = await harness(async (url, options) => {
    request = { url, options };
    return json([{ data: { sideNav: { sections: { edges: [{ node: {
      id: 'side-nav-followed', content: { edges: [{ node: {
        __typename: 'Stream', broadcaster: { login: 'testchannel', displayName: '测试频道', broadcastSettings: { title: '直播' } },
        game: null,
      } }] },
    } }] } } } }]);
  }).message('twitch');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].gameName, '');
  assert.equal(request.options.headers.Authorization, 'OAuth test-token');
  assert.equal(request.options.headers['X-Device-Id'], 'test-device');
  const body = JSON.parse(request.options.body);
  assert.equal(body[0].extensions.persistedQuery.sha256Hash, 'b235e7c084bc768d827343cda0b95310535a0956d449e574885b00e176fe5f27');
});

test('Douyu follows all pages using page size fallback and preserves Cookie header', async () => {
  const pages = [];
  const result = await harness(async (url, options) => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    assert.match(options.headers.Cookie, /acf_uid=123/);
    return json({ error: 0, data: { list: page === 1 ? Array.from({ length: 50 }, (_, i) => douyuItem(i + 1)) : [douyuItem(51)] } });
  }).message('douyu');
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.status, 'ok');
  assert.equal(result.data.length, 51);
});

test('pagination failure retains accumulated rows and does not mark them fresh', async () => {
  const result = await harness(async (url) => {
    if (new URL(url).searchParams.get('page') === '2') return json({}, 500);
    return json({ error: 0, data: { list: [douyuItem(1)], has_more: true } });
  }).message('douyu');
  assert.equal(result.status, 'partial');
  assert.equal(result.success, false);
  assert.equal(result.data.length, 1);
  assert.equal(result.fetchedAt, undefined);
});

test('authentication expiry on a later page clears accumulated follows', async () => {
  const pages = [];
  const result = await harness(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    if (page === 2) return json({}, 401);
    return json({ error: 0, data: { list: [douyuItem(1)], has_more: true } });
  }).message('douyu');
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.status, 'auth_required');
  assert.equal(result.errorKind, 'auth_required');
  assert.equal(result.success, false);
  assert.equal(result.isLoggedIn, false);
  assert.equal(result.data.length, 0);
  assert.equal(result.fetchedAt, undefined);
});

test('one invalid record does not discard healthy records', async () => {
  const result = await harness(async () => json({ status_code: 0, data: { data: [
    { room: null },
    { web_rid: '456', room: { owner: { nickname: '正常主播' }, status: 0, title: '直播' } },
  ] } })).message('douyin');
  assert.equal(result.status, 'partial');
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].isLive, true);
  assert.ok(result.error);
});

test('concurrent requests to one platform share the same fetch', async () => {
  const pending = [];
  let requests = 0;
  const api = harness(() => { requests++; return new Promise((resolve) => { pending.push(resolve); }); });
  const first = api.fetchPlatform('bilibili');
  const second = api.fetchPlatform('bilibili');
  await new Promise((resolve) => setImmediate(resolve));
  for (const finish of pending) finish(json({ code: 0, data: { list: [bilibiliItem()] } }));
  await Promise.all([first, second]);
  assert.equal(requests, 1);
});

test('one deadline covers slow cookies, all pages, and stalled response bodies', async () => {
  const shortTimer = (callback) => setTimeout(callback, 15);
  const scenarios = [
    { fetch: async () => { throw new Error('should not fetch'); }, getCookies() {} },
    { fetch: async () => ({ ...json({}), json: () => new Promise(() => {}) }) },
    { fetch: async (url) => new URL(url).searchParams.get('page') === '1'
      ? json({ error: 0, data: { list: [douyuItem(1)], has_more: true } })
      : new Promise(() => {}), platform: 'douyu' },
  ];
  for (const scenario of scenarios) {
    const result = await harness(scenario.fetch, { setTimeout: shortTimer, getCookies: scenario.getCookies }).message(scenario.platform || 'bilibili');
    assert.equal(result.errorKind, 'timeout');
    assert.equal(result.status, scenario.platform === 'douyu' ? 'partial' : 'error');
    assert.equal(result.isLoggedIn, scenario.platform === 'douyu' ? true : null);
    assert.equal(result.fetchedAt, undefined);
  }
});

test('Huya pagination obeys explicit total pages even when the first page is short', async () => {
  const pages = [];
  const result = await harness(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    return json({ status: 1000, result: {
      totalPage: 2,
      list: [{ profileRoom: page, nick: '主播', isLive: page === 1 ? '1' : '0' }],
    } });
  }).message('huya');
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.status, 'ok');
  assert.equal(result.data.length, 2);
  assert.equal(result.data[0].isLive, true);
  assert.equal(result.data[1].isLive, false);
});

test('duplicate pages stop with partial data instead of fetching forever or duplicating cards', async () => {
  let requests = 0;
  const result = await harness(async () => {
    requests++;
    return json({ error: 0, data: { list: [douyuItem(1)], has_more: true } });
  }).message('douyu');
  assert.equal(requests, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.errorKind, 'pagination');
  assert.equal(result.data.length, 1);
});

test('pagination has a hard page cap for continually expanding data', async () => {
  let requests = 0;
  const result = await harness(async () => {
    requests++;
    return json({ error: 0, data: { list: [douyuItem(requests)], has_more: true } });
  }).message('douyu');
  assert.equal(requests, 20);
  assert.equal(result.status, 'partial');
  assert.equal(result.data.length, 20);
});

test('missing cookies and HTTP 401 give authentication state, while HTML is a format error', async () => {
  const missing = await harness(async () => { throw new Error('unexpected fetch'); }, { cookies: [] }).message('bilibili');
  const unauthorized = await harness(async () => json({}, 401)).message('bilibili');
  for (const result of [missing, unauthorized]) {
    assert.equal(result.status, 'auth_required');
    assert.equal(result.isLoggedIn, false);
    assert.equal(result.success, false);
    assert.equal(result.loginUrl, 'https://www.bilibili.com');
  }
  const html = await harness(async () => ({ ...json({}), headers: { get: () => 'text/html' } })).message('bilibili');
  assert.equal(html.status, 'error');
  assert.equal(html.errorKind, 'response_format');
  assert.equal(html.isLoggedIn, null);
});

test('completed and failed requests release dedupe state for a later refresh', async () => {
  let requests = 0;
  const api = harness(async () => {
    requests++;
    return requests === 1 ? json({}, 500) : json({ code: 0, data: { list: [bilibiliItem()] } });
  });
  assert.equal((await api.message('bilibili')).status, 'error');
  assert.equal((await api.message('bilibili')).status, 'ok');
  assert.equal(requests, 2);
});

test('optional image URLs reject executable and relative URLs while keeping verified room identity', async () => {
  const result = await harness(async () => json({ code: 0, data: { list: [{
    ...bilibiliItem(), face: 'javascript:alert(1)', keyframe: '/relative/path', cover_from_user: '//i0.hdslb.com/example.jpg',
  }] } })).message('bilibili');
  assert.equal(result.status, 'ok');
  assert.equal(result.data[0].avatar, '');
  assert.equal(result.data[0].thumbnail, 'https://i0.hdslb.com/example.jpg');
  assert.equal(result.data[0].thumbnailFallback, 'https://i0.hdslb.com/example.jpg');
  assert.equal(result.data[0].thumbnailKind, 'cover');
  assert.equal(result.data[0].roomId, '123');
});

test('unknown platforms never fetch arbitrary URLs or throw from inherited object properties', async () => {
  const api = harness(async () => { throw new Error('unexpected fetch'); });
  for (const platform of ['unknown', '__proto__', 'constructor']) {
    const result = await api.message(platform);
    assert.equal(result.status, 'error');
    assert.equal(result.errorKind, 'unsupported');
  }
});

test('only explicit offline states become offline follows; replay and missing states never do', async () => {
  const result = await harness(async () => json({ error: 0, data: { list: [
    douyuItem(1), { ...douyuItem(2), show_status: '2' },
    { ...douyuItem(3), videoLoop: 1 }, { ...douyuItem(4), show_status: undefined },
  ] } })).message('douyu');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.length, 4, 'existing normalized data remains backward compatible');
  assert.equal(result.offlineSupported, true);
  assert.equal(result.offlineData.length, 1);
  assert.equal(result.offlineData[0].roomId, '2');
  assert.equal(result.offlineData[0].isLive, false);
  assert.equal(result.offlineCoverage, 'partial', 'unknown states must not look like complete offline coverage');
  assert.equal(result.offlineFetchedAt, undefined);
});

test('Huya string zero and boolean false are offline but absent or unknown flags are not', async () => {
  const result = await harness(async () => json({ status: 1000, result: { list: [
    { profileRoom: 1, isLive: '0' }, { profileRoom: 2, isLive: false },
    { profileRoom: 3 }, { profileRoom: 4, isLive: 9 }, { profileRoom: 5, isLive: '1' },
  ] } })).message('huya');
  assert.deepEqual(Array.from(result.offlineData, entry => entry.roomId), ['1', '2']);
  assert.equal(result.offlineCoverage, 'partial');
});

test('offline embedded data is complete only after all pages and clears on authentication expiry', async () => {
  for (const secondStatus of [200, 500, 401]) {
    const result = await harness(async (url) => {
      if (new URL(url).searchParams.get('page') === '1') {
        return json({ error: 0, data: { list: [{ ...douyuItem(1), show_status: 2 }], totalPage: 2 } });
      }
      return json({ error: 0, data: { list: [{ ...douyuItem(2), show_status: 2 }], totalPage: 2 } }, secondStatus);
    }).message('douyu');
    assert.equal(result.offlineCoverage, secondStatus === 200 ? 'complete' : 'partial');
    assert.equal(result.offlineData.length, secondStatus === 200 ? 2 : secondStatus === 500 ? 1 : 0);
    assert.equal(Boolean(result.offlineFetchedAt), secondStatus === 200);
  }
});

test('Bilibili offline pages use the official following endpoint separately from its live feed', async () => {
  const urls = [];
  const api = harness(async (url) => {
    urls.push(url);
    if (url.includes('GetWebList')) return json({ code: 0, data: { list: [bilibiliItem(1)] } });
    const page = Number(new URL(url).searchParams.get('page'));
    assert.equal(new URL(url).searchParams.get('page_size'), '9');
    assert.equal(new URL(url).searchParams.get('hit_ab'), 'false');
    return json({ code: 0, data: { totalPage: 2, list: page === 1
      ? [bilibiliItem(1), { ...bilibiliItem(2), live_status: 0 }]
      : [{ ...bilibiliItem(3), live_status: '0' }, { ...bilibiliItem(4), live_status: 2 }],
    } });
  });
  const live = await api.message('bilibili');
  assert.equal(urls.length, 1, 'the live request does not wait for or fetch offline pages');
  assert.equal(live.status, 'ok');
  assert.equal(live.offlineCoverage, 'pending');
  const offline = await api.message('bilibili', 'getOfflineFollowedStreamers');
  assert.equal(offline.offlineCoverage, 'complete');
  assert.equal(offline.offlineStatus, 'ok');
  assert.deepEqual(Array.from(offline.offlineData, entry => entry.roomId), ['2', '3']);
  assert.ok(Number.isFinite(offline.offlineFetchedAt));
  assert.equal(live.data[0].isLive, true, 'supplemental results never mutate the live response');
  assert.equal(urls.length, 3);
});

test('Bilibili supplemental failures never convert a successful live feed into offline data', async () => {
  const api = harness(async (url) => url.includes('GetWebList')
    ? json({ code: 0, data: { list: [bilibiliItem()] } }) : json({}, 403));
  const live = await api.message('bilibili');
  const offline = await api.message('bilibili', 'getOfflineFollowedStreamers');
  assert.equal(live.status, 'ok');
  assert.equal(offline.status, 'error');
  assert.equal(offline.isLoggedIn, null);
  assert.equal(offline.offlineData.length, 0);
  assert.equal(offline.offlineCoverage, 'partial');
  assert.equal(offline.offlineFetchedAt, undefined);
});

test('slow supplemental calls are deduplicated without delaying an independent live response', async () => {
  let release;
  let supplementalCalls = 0;
  const api = harness(async (url) => {
    if (url.includes('GetWebList')) return json({ code: 0, data: { list: [bilibiliItem()] } });
    supplementalCalls++;
    return new Promise(resolve => { release = resolve; });
  });
  const first = api.message('bilibili', 'getOfflineFollowedStreamers');
  const second = api.message('bilibili', 'getOfflineFollowedStreamers');
  await new Promise(resolve => setImmediate(resolve));
  const live = await api.message('bilibili');
  assert.equal(live.status, 'ok');
  assert.equal(supplementalCalls, 1);
  release(json({ code: 0, data: { totalPage: 1, list: [{ ...bilibiliItem(2), live_status: 0 }] } }));
  const responses = await Promise.all([first, second]);
  assert.ok(responses.every(result => result.offlineData.length === 1));
});

test('Bilibili offline page cap and later authentication error cannot claim complete coverage', async () => {
  let requests = 0;
  const capped = await harness(async () => {
    const firstId = requests++ * 9 + 1;
    return json({ code: 0, data: { totalPage: 21, list: Array.from({ length: 9 }, (_, i) => ({
      ...bilibiliItem(firstId + i), live_status: 0,
    })) } });
  }).message('bilibili', 'getOfflineFollowedStreamers');
  assert.equal(requests, 20);
  assert.equal(capped.offlineData.length, 180);
  assert.equal(capped.offlineCoverage, 'partial');
  assert.equal(capped.offlineFetchedAt, undefined);

  const expired = await harness(async url => new URL(url).searchParams.get('page') === '1'
    ? json({ code: 0, data: { totalPage: 2, list: [{ ...bilibiliItem(1), live_status: 0 }] } })
    : json({ code: -101, message: '账号未登录' }))
    .message('bilibili', 'getOfflineFollowedStreamers');
  assert.equal(expired.status, 'auth_required');
  assert.equal(expired.offlineStatus, 'auth_required');
  assert.equal(expired.offlineData.length, 0);
  assert.equal(expired.offlineFetchedAt, undefined);
});

test('platforms without a verified offline source explicitly report unsupported', async () => {
  const api = harness(async () => json({ status_code: 0, data: { data: [
    { web_rid: '456', room: { owner: { nickname: '正常主播' }, status: 1 } },
  ] } }));
  const result = await api.message('douyin');
  assert.equal(result.offlineSupported, false);
  assert.equal(result.offlineCoverage, 'unsupported');
  assert.equal(result.offlineData.length, 0);
  const twitch = await api.message('twitch', 'getOfflineFollowedStreamers');
  assert.equal(twitch.offlineSupported, false);
  assert.equal(twitch.offlineData.length, 0);
});

test('offline last-live dates use verified platform timestamp fields with explicit provenance', async () => {
  const douyu = await harness(async () => json({ error: 0, data: { list: [{
    ...douyuItem(1), show_status: 2, show_time: '1689674245',
  }] } })).message('douyu');
  assert.equal(douyu.offlineData[0].lastLiveAt, 1689674245000);
  assert.equal(douyu.offlineData[0].lastLiveSource, 'platform_start');

  const bilibili = await harness(async () => json({ code: 0, data: { totalPage: 1, list: [{
    ...bilibiliItem(2), live_status: 0, record_live_time: 1689674245, live_time: 7200,
  }] } })).message('bilibili', 'getOfflineFollowedStreamers');
  assert.equal(bilibili.offlineData[0].lastLiveAt, 1689674245000);
  assert.equal(bilibili.offlineData[0].lastLiveSource, 'platform_record');
});

test('duration, absent, invalid and future values never become an offline last-live date', async () => {
  const values = [undefined, null, 0, 7200, '', 'invalid', true, (Date.now() / 1000) + 86400];
  const result = await harness(async () => json({ code: 0, data: { totalPage: 1, list: values.map((value, i) => ({
    ...bilibiliItem(i + 1), live_status: 0, record_live_time: value, live_time: 7200,
  })) } })).message('bilibili', 'getOfflineFollowedStreamers');
  assert.equal(result.offlineData.length, values.length);
  assert.ok(result.offlineData.every(entry => entry.lastLiveAt === undefined && entry.lastLiveSource === undefined));
  const huya = await harness(async () => json({ status: 1000, result: { list: [{
    profileRoom: 1, isLive: 0, startTime: 1689674245,
  }] } })).message('huya');
  assert.equal(huya.offlineData[0].lastLiveAt, undefined, 'unverified offline meaning of Huya startTime is not asserted');
});

function html(body, { status = 200, url = 'https://www.youtube.com/@channel/live' } = {}) {
  return { ok: status >= 200 && status < 300, status, url, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body };
}

function youtubePage({ player, initial }) {
  // Matches the page shape: object literals inside inline scripts, with braces inside strings.
  return `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player ?? null)};var meta = {};</script>` +
    `<script>var ytInitialData = ${JSON.stringify(initial ?? {})};</script></html>`;
}

const ytLive = youtubePage({
  player: {
    videoDetails: { videoId: 'live_video1', channelId: 'UCWsDFcIhY2DBi3GB5uykGXA', author: 'IShowSpeed', title: 'IRL {stream} "quoted"', isLive: true, viewCount: '9999999' },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true, startTimestamp: '2026-10-30T18:00:00+00:00' } } },
  },
  initial: { contents: { twoColumnWatchNextResults: { results: { results: { contents: [
    { videoPrimaryInfoRenderer: { viewCount: { videoViewCountRenderer: { originalViewCount: '123456', isLive: true } } } },
    { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { thumbnail: { thumbnails: [{ url: 'https://yt3.ggpht.com/speed=s48-c-k' }] } } } } },
  ] } } } } },
});
const ytUpcoming = youtubePage({
  player: {
    videoDetails: { videoId: 'upcoming_v1', channelId: 'UCWsDFcIhY2DBi3GB5uykGXA', author: 'IShowSpeed', title: '预告', isLiveContent: true, isUpcoming: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, startTimestamp: '2026-10-31T21:30:00+00:00' } } },
  },
});
const ytChannel = youtubePage({ initial: { metadata: { channelMetadataRenderer: {
  title: 'Kai Cenat', externalId: 'UCoEmptob-eEGKk18c2VplJg', avatar: { thumbnails: [{ url: 'https://yt3.googleusercontent.com/kai=s900-c-k' }] },
} } } });

test('YouTube tracked channels report live viewers, start time and live frame without login', async () => {
  const requests = [];
  const result = await harness(async (url, options) => {
    requests.push({ url, options });
    return html(ytLive);
  }, { cookies: [], trackedChannels: { youtube: ['@IShowSpeed'], twitch: [] } }).message('youtube');
  assert.equal(result.status, 'ok');
  assert.equal(requests[0].url, 'https://www.youtube.com/@IShowSpeed/live');
  assert.equal(requests[0].options.credentials, 'omit');
  const [live] = result.data;
  assert.equal(live.isLive, true);
  assert.equal(live.name, 'IShowSpeed');
  assert.equal(live.title, 'IRL {stream} "quoted"');
  assert.equal(live.viewers, 123456, 'concurrent viewers, not the cumulative viewCount');
  assert.equal(live.startTime, '2026-10-30T18:00:00.000Z');
  assert.equal(live.roomId, 'UCWsDFcIhY2DBi3GB5uykGXA');
  assert.equal(live.url, 'https://www.youtube.com/@IShowSpeed/live');
  assert.equal(live.thumbnail, 'https://i.ytimg.com/vi/live_video1/mqdefault_live.jpg');
  assert.equal(live.thumbnailKind, 'live');
  assert.equal(live.avatar, 'https://yt3.ggpht.com/speed=s88-c-k');
  assert.equal(result.offlineData.length, 0);
});

test('YouTube upcoming streams and plain channel pages are known offline entries', async () => {
  const result = await harness(async (url) => html(url.includes('IShowSpeed') ? ytUpcoming : ytChannel), {
    trackedChannels: { youtube: ['@IShowSpeed', 'UCoEmptob-eEGKk18c2VplJg'], twitch: [] },
  }).message('youtube');
  assert.equal(result.status, 'ok');
  assert.equal(result.offlineCoverage, 'complete');
  assert.deepEqual(plain(result.data).map((entry) => [entry.name, entry.isLive]), [['IShowSpeed', false], ['Kai Cenat', false]]);
  assert.deepEqual(plain(result.offlineData.map((entry) => entry.name)), ['IShowSpeed', 'Kai Cenat']);
  assert.equal(result.data[1].url, 'https://www.youtube.com/channel/UCoEmptob-eEGKk18c2VplJg/live');
  assert.equal(result.data[1].avatar, 'https://yt3.googleusercontent.com/kai=s88-c-k');
});

test('YouTube missing channels, consent redirects and unreadable pages are partial, never offline', async () => {
  const result = await harness(async (url) => {
    if (url.includes('missing')) return html('', { status: 404 });
    if (url.includes('consent')) return html(ytChannel, { url: 'https://consent.youtube.com/m?continue=x' });
    if (url.includes('garbage')) return html('<html>no data</html>');
    return html(ytLive);
  }, { trackedChannels: { youtube: ['@IShowSpeed', '@missing', '@consent', '@garbage'], twitch: [] } }).message('youtube');
  assert.equal(result.status, 'partial');
  assert.match(result.error, /3 条/);
  assert.deepEqual(plain(result.data).map((entry) => entry.name), ['IShowSpeed']);
  assert.equal(result.offlineCoverage, 'partial');
  assert.equal(result.fetchedAt, undefined);
});

test('YouTube with no tracked channels is a successful empty list without requests', async () => {
  let requests = 0;
  const result = await harness(async () => { requests++; return html(ytLive); }).message('youtube');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.length, 0);
  assert.equal(requests, 0);
});

// Shape of kick.com/api/v1/channels/<slug>: times are UTC without a zone, thumbnails come in several widths.
function kickChannel(slug, { username = slug, livestream = null, previous = [], banned = false } = {}) {
  return {
    slug, is_banned: banned, followersCount: 11798, livestream, previous_livestreams: previous,
    user: { username, profile_pic: `https://files.kick.com/images/user/${slug}/avatar.webp` },
  };
}

const kickStream = {
  is_live: true, session_title: 'Kick 测试直播', start_time: '2026-11-21 13:23:54', viewer_count: 5374,
  thumbnail: {
    url: 'https://images.kick.com/video_thumbnails/ch/run/720.webp?versionId=a',
    responsive: 'https://images.kick.com/video_thumbnails/ch/run/1080.webp?versionId=b 1920w, ' +
      'https://images.kick.com/video_thumbnails/ch/run/720.webp?versionId=a 1280w, ' +
      'https://images.kick.com/video_thumbnails/ch/run/480.webp?versionId=c 640w',
  },
  categories: [{ name: 'Grand Theft Auto VI (GTA)' }],
};

test('Kick tracked channels report live viewers, UTC start time and a card-sized live frame without login', async () => {
  const requests = [];
  const result = await harness(async (url, options) => {
    requests.push({ url, options });
    return json(kickChannel('xqc', { username: 'xQc', livestream: kickStream }));
  }, { cookies: [], trackedChannels: { kick: ['xqc'] } }).message('kick');
  assert.equal(result.status, 'ok');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://kick.com/api/v1/channels/xqc');
  assert.equal(requests[0].options.credentials, 'omit');
  const [live] = result.data;
  assert.equal(live.isLive, true);
  assert.equal(live.name, 'xQc');
  assert.equal(live.roomId, 'xqc');
  assert.equal(live.url, 'https://kick.com/xqc');
  assert.equal(live.title, 'Kick 测试直播');
  assert.equal(live.viewers, 5374);
  assert.equal(live.startTime, '2026-11-21T13:23:54.000Z', 'Kick times are UTC, not local time');
  assert.equal(live.gameName, 'Grand Theft Auto VI (GTA)');
  assert.equal(live.avatar, 'https://files.kick.com/images/user/xqc/avatar.webp');
  assert.equal(live.thumbnail, 'https://images.kick.com/video_thumbnails/ch/run/480.webp?versionId=c');
  assert.equal(live.thumbnailKind, 'live');
  assert.equal(result.offlineData.length, 0);
});

test('Kick offline and banned channels are known offline entries with their last stream start', async () => {
  const channels = {
    adinross: kickChannel('adinross'),
    xqc: kickChannel('xqc', { username: 'xQc', previous: [{ start_time: '2026-11-20 13:00:15' }, { start_time: '2026-11-19 13:57:32' }] }),
    banned: kickChannel('banned', { livestream: kickStream, banned: true }),
  };
  const result = await harness(async (url) => json(channels[url.split('/').pop()]), {
    trackedChannels: { kick: Object.keys(channels) },
  }).message('kick');
  assert.equal(result.status, 'ok');
  assert.equal(result.offlineCoverage, 'complete');
  assert.deepEqual(plain(result.data).map((entry) => [entry.name, entry.isLive]), [['adinross', false], ['xQc', false], ['banned', false]]);
  assert.deepEqual(plain(result.offlineData.map((entry) => entry.roomId)), ['adinross', 'xqc', 'banned']);
  assert.equal(result.data[0].lastLiveAt, undefined, 'a channel that never streamed has no last-live time');
  assert.equal(result.data[1].lastLiveAt, Date.UTC(2026, 10, 20, 13, 0, 15));
  assert.equal(result.data[1].lastLiveSource, 'platform_start');
});

test('Kick missing channels and blocked responses are partial, never offline', async () => {
  const result = await harness(async (url) => {
    if (url.endsWith('/missing')) return json({ error: 'Not Found', message: 'Channel not found.', status: 404 }, 404);
    if (url.endsWith('/blocked')) return html('<html>Just a moment...</html>', { status: 403 });
    if (url.endsWith('/garbage')) return json({ unexpected: true });
    return json(kickChannel('xqc', { livestream: kickStream }));
  }, { trackedChannels: { kick: ['xqc', 'missing', 'blocked', 'garbage'] } }).message('kick');
  assert.equal(result.status, 'partial');
  assert.match(result.error, /3 条/);
  assert.deepEqual(plain(result.data).map((entry) => entry.roomId), ['xqc']);
  assert.equal(result.offlineCoverage, 'partial');
  assert.equal(result.fetchedAt, undefined);
});

test('Kick with no tracked channels is a successful empty list without requests', async () => {
  let requests = 0;
  const result = await harness(async () => { requests++; return json(kickChannel('xqc')); }).message('kick');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.length, 0);
  assert.equal(requests, 0);
});

test('a favorite Kick channel is announced when it goes live and the notification opens its page', async () => {
  const favorite = 'kick:https://kick.com/xqc';
  const requests = [];
  let livestream = null;
  const api = harness(async (url) => {
    requests.push(url);
    return json(kickChannel('xqc', { username: 'xQc', livestream }));
  }, { trackedChannels: { kick: ['xqc'] }, stored: { favoriteStreamers: [favorite] } });
  assert.deepEqual(await api.checkFavoriteLive(), []);
  livestream = kickStream;
  assert.deepEqual(await api.checkFavoriteLive(), [favorite]);
  assert.ok(requests.every((url) => url === 'https://kick.com/api/v1/channels/xqc'), 'only the platform with a favorite is requested');
  const [notice] = api.notifications;
  assert.equal(notice.title, 'xQc 开播了');
  assert.equal(notice.contextMessage, 'Kick · Grand Theft Auto VI (GTA)');
  api.events.notificationClick(notice.id);
  assert.deepEqual(plain(api.tabs), [{ url: 'https://kick.com/xqc' }]);
});

function twitchFollowed(logins) {
  return json([{ data: { sideNav: { sections: { edges: [{ node: { id: 'side-nav-followed', content: { edges: logins.map((login) => ({ node: {
    __typename: 'Stream', viewersCount: 10, broadcaster: { login, displayName: login, broadcastSettings: { title: '关注直播' } }, game: null,
  } })) } } }] } } } }]);
}

test('Twitch tracked channels are added from the public query without duplicating followed channels', async () => {
  const requests = [];
  const result = await harness(async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ headers: options.headers, body });
    if (Array.isArray(body)) return twitchFollowed(['xqc']);
    return json({ data: { users: [
      { login: 'kaicenat', displayName: 'KaiCenat', profileImageURL: 'https://static-cdn.jtvnw.net/kai.png', stream: {
        title: 'Mafiathon', viewersCount: 50000, createdAt: '2026-10-30T20:00:00Z', game: { displayName: 'Just Chatting' },
      } },
      { login: 'sleepy', displayName: 'sleepy', stream: null },
      null,
    ] } });
  }, { trackedChannels: { youtube: [], twitch: ['xqc', 'kaicenat', 'sleepy', 'nobody'] } }).message('twitch');
  assert.equal(result.status, 'ok');
  assert.deepEqual(plain(result.data).map((entry) => entry.roomId), ['xqc', 'kaicenat']);
  assert.deepEqual(plain(requests[1].body.variables.logins), ['kaicenat', 'sleepy', 'nobody'], 'already followed channels are not queried');
  assert.equal(requests[1].headers.Authorization, undefined, 'public lookup never sends the account token');
  assert.equal(requests[1].headers['Client-Id'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
  const kai = result.data[1];
  assert.equal(kai.isLive, true);
  assert.equal(kai.viewers, 50000);
  assert.equal(kai.startTime, '2026-10-30T20:00:00Z');
  assert.equal(kai.gameName, 'Just Chatting');
  assert.equal(kai.url, 'https://www.twitch.tv/kaicenat');
});

test('Twitch tracked lookup failure keeps followed rows but is not a complete snapshot', async () => {
  const result = await harness(async (_url, options) => Array.isArray(JSON.parse(options.body))
    ? twitchFollowed(['xqc'])
    : json({ errors: [{ message: 'service timeout' }] }), { trackedChannels: { youtube: [], twitch: ['kaicenat'] } }).message('twitch');
  assert.equal(result.status, 'partial');
  assert.deepEqual(plain(result.data).map((entry) => entry.roomId), ['xqc']);
  assert.equal(result.fetchedAt, undefined);
});

test('tracked channel input accepts handles, IDs and links and rejects other sites', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/settings.js'), 'utf8'), context);
  const call = (expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
  const yt = (value) => call(`normalizeYouTubeChannel(${JSON.stringify(value)})`);
  const tw = (value) => call(`normalizeTwitchChannel(${JSON.stringify(value)})`);
  assert.equal(yt('@IShowSpeed'), '@IShowSpeed');
  assert.equal(yt('IShowSpeed'), '@IShowSpeed');
  assert.equal(yt('https://www.youtube.com/@IShowSpeed/live'), '@IShowSpeed');
  assert.equal(yt('youtube.com/channel/UCWsDFcIhY2DBi3GB5uykGXA'), 'UCWsDFcIhY2DBi3GB5uykGXA');
  assert.equal(yt('m.youtube.com/@KaiCenat'), '@KaiCenat');
  for (const bad of ['https://www.twitch.tv/kaicenat', 'youtube.com/user/legacy', 'a', '@has space', '<script>', 'https://evil.test/@x']) {
    assert.equal(yt(bad), '', bad);
  }
  assert.equal(tw('KaiCenat'), 'kaicenat');
  assert.equal(tw('https://www.twitch.tv/kaicenat'), 'kaicenat');
  assert.equal(tw('youtube.com/@KaiCenat'), '');
  assert.equal(tw('bad-name'), '');
  const kick = (value) => call(`normalizeKickChannel(${JSON.stringify(value)})`);
  assert.equal(kick('xQc'), 'xqc');
  assert.equal(kick('https://kick.com/xQc'), 'xqc');
  assert.equal(kick('kick.com/adinross?ref=sidebar'), 'adinross');
  assert.equal(kick('some_name-1'), 'some_name-1');
  for (const bad of ['https://www.twitch.tv/xqc', 'kick.com/', 'ab', 'has space', '<script>', '主播']) {
    assert.equal(kick(bad), '', bad);
  }
  const text = JSON.stringify('@IShowSpeed\n@ishowspeed, @KaiCenat，bad name!');
  assert.deepEqual(call(`parseTrackedChannelText(${text}, normalizeYouTubeChannel)`), { channels: ['@IShowSpeed', '@KaiCenat', '@bad'], invalid: ['name!'] });
  assert.deepEqual(call('[normalizeTrackedChannels(), normalizeTrackedChannels({ youtube: [] })]'),
    [{ youtube: ['@IShowSpeed', '@KaiCenat'], twitch: ['kaicenat'], kick: [] }, { youtube: [], twitch: [], kick: [] }]);
  assert.deepEqual(call('normalizeTrackedChannels({ youtube: ["@a_b_c"], kick: ["xQc", "xqc", "kick.com/adinross"] })'),
    { youtube: ['@a_b_c'], twitch: [], kick: ['xqc', 'adinross'] }, 'settings saved before Kick existed keep working');
});

const room = (id) => `bilibili:https://live.bilibili.com/${id}`;

// Bilibili's live list only contains rooms that are live; `state.live` decides which rooms it returns.
function liveHarness(stored, options = {}) {
  const state = { live: [], requests: [], fail: false };
  const api = harness(async (url) => {
    state.requests.push(url);
    if (state.fail) return json({}, 500);
    return json({ code: 0, data: { list: state.live.map((id) => ({
      ...bilibiliItem(id), uname: `主播 ${id}`, title: `直播 ${id}`, area_v2_name: '英雄联盟', face: `https://i0.hdslb.com/face-${id}.jpg`,
    })) } });
  }, { stored: { enabledPlatforms: ['bilibili', 'douyu'], ...stored }, ...options });
  return { api, state };
}

test('go-live notification fires only on an observed offline-to-live change and opens the room on click', async () => {
  const { api, state } = liveHarness({ favoriteStreamers: [room(1), room(2)] });
  state.live = [1];
  assert.deepEqual(await api.checkFavoriteLive(), [], 'a favorite already live on the first check is only recorded');
  assert.ok(state.requests.every((url) => url.includes('bilibili.com')), 'platforms without favorites are not requested');
  assert.equal(api.stored.liveNotifyState.records[room(2)].live, false, 'absence from a complete live list is offline');

  state.live = [1, 2];
  assert.deepEqual(await api.checkFavoriteLive(), [room(2)]);
  const [notice] = api.notifications;
  assert.equal(notice.id, `live:${room(2)}`);
  assert.equal(notice.title, '主播 2 开播了');
  assert.equal(notice.message, '直播 2');
  assert.equal(notice.contextMessage, 'B站 · 英雄联盟');
  assert.equal(notice.iconUrl, 'https://i0.hdslb.com/face-2.jpg');

  assert.deepEqual(await api.checkFavoriteLive(), [], 'a stream that stays live is announced once');
  api.events.notificationClick(notice.id);
  assert.deepEqual(plain(api.tabs), [{ url: 'https://live.bilibili.com/2' }]);
});

test('failed checks and short drops never re-announce a stream; a real restart does', async () => {
  const { api, state } = liveHarness({ favoriteStreamers: [room(1)] });
  state.live = [];
  await api.checkFavoriteLive();
  state.live = [1];
  assert.deepEqual(await api.checkFavoriteLive(), [room(1)]);

  state.fail = true;
  assert.deepEqual(await api.checkFavoriteLive(), []);
  assert.equal(api.stored.liveNotifyState.records[room(1)].live, true, 'an unknown state keeps the last record');
  state.fail = false;
  assert.deepEqual(await api.checkFavoriteLive(), [], 'recovery from a failed request is not a new stream');

  state.live = [];
  await api.checkFavoriteLive();
  state.live = [1];
  assert.deepEqual(await api.checkFavoriteLive(), [], 'a drop shorter than the restart gap is not announced');

  state.live = [];
  await api.checkFavoriteLive();
  api.stored.liveNotifyState.records[room(1)].lastLiveAt -= 30 * 60_000;
  state.live = [1];
  assert.deepEqual(await api.checkFavoriteLive(), [room(1)], 'a stream after a real break is announced');
  assert.equal(api.notifications.length, 2);
});

test('unfavorited streamers are forgotten and legacy name favorites still match', async () => {
  const { api, state } = liveHarness({ favoriteStreamers: ['主播 7'], enabledPlatforms: ['bilibili'] });
  state.live = [];
  await api.checkFavoriteLive();
  state.live = [7];
  await api.checkFavoriteLive();
  state.live = [];
  await api.checkFavoriteLive();
  assert.equal(api.stored.liveNotifyState.records[room(7)].live, false, 'a name-only favorite is tracked by its room');
  state.live = [7];
  api.stored.liveNotifyState.records[room(7)].lastLiveAt = 0;
  assert.deepEqual(await api.checkFavoriteLive(), [room(7)]);
  api.stored.favoriteStreamers = [];
  await api.checkFavoriteLive();
  assert.deepEqual(plain(api.stored.liveNotifyState.records), {});
});

test('notification settings control the alarm, and disabled checks make no requests', async () => {
  const { api, state } = liveHarness({ favoriteStreamers: [room(1)] });
  await api.scheduleLiveCheck();
  assert.equal(api.alarms.get('favorite-live-check').periodInMinutes, 5, 'enabled every 5 minutes by default');

  api.stored.liveNotifications = { enabled: true, intervalMinutes: 2 };
  api.events.storage({ liveNotifications: { newValue: api.stored.liveNotifications } }, 'local');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.alarms.get('favorite-live-check').periodInMinutes, 2);

  api.stored.liveNotifications = { enabled: false, intervalMinutes: 2 };
  await api.scheduleLiveCheck();
  assert.equal(api.alarms.size, 0);
  assert.deepEqual(await api.checkFavoriteLive(), []);
  assert.equal(state.requests.length, 0);
});

test('a failed avatar download still notifies with the extension icon; test notification reports permission', async () => {
  const { api, state } = liveHarness({ favoriteStreamers: [room(3)] }, { rejectRemoteIcons: true });
  await api.checkFavoriteLive();
  state.live = [3];
  await api.checkFavoriteLive();
  assert.equal(api.notifications[0].iconUrl, 'chrome-extension://test-id/icon.png');

  const sent = await api.message(undefined, 'testLiveNotification');
  assert.equal(sent.success, true);
  assert.equal(api.notifications.at(-1).id, 'live-test');
  const denied = await liveHarness({}, { permissionLevel: 'denied' }).api.message(undefined, 'testLiveNotification');
  assert.equal(denied.success, false);
  assert.match(denied.error, /关闭/);
});
