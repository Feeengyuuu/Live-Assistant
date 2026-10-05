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
  const context = vm.createContext({
    fetch: fetchImpl, AbortController, AbortSignal, URL, setTimeout: options.setTimeout || setTimeout,
    clearTimeout, Date, importScripts() {}, console: { error() {}, warn() {} },
    chrome: {
      cookies: { getAll: options.getCookies || ((_details, callback) => callback(options.cookies ?? cookies)) },
      runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    },
  });
  vm.runInContext(source, context);
  return {
    fetchPlatform: (key) => vm.runInContext(`fetchPlatform(${JSON.stringify(key)})`, context),
    message: (platform, action = 'getFollowedStreamers') => new Promise((resolve) => listener({ action, platform }, {}, resolve)),
  };
}

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
