const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(fetch) {
  const context = vm.createContext({ URL, AbortSignal, fetch });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/thumbnails.js'), 'utf8'), context);
  const request = vm.runInContext('fetchLiveThumbnails', context);
  return (platform, roomIds) => request({ platform, roomIds });
}
const json = data => ({ ok: true, json: async () => data });

test('Douyu event cover cannot replace its official captured frame', async () => {
  let calls = 0;
  const request = harness(async url => {
    calls++;
    assert.equal(url, 'https://www.douyu.com/betard/288016');
    return json({ room: { room_id: 288016, show_status: 1,
      room_pic: 'https://rpic.douyucdn.cn/asrpic/261006/288016_src_0617.avif/dy4',
      coverSrc: 'https://rpic.douyucdn.cn/live-cover/event.png/dy4' } });
  });
  const result = await request('douyu', ['288016']);
  assert.match(result.thumbnails['288016'].thumbnail, /\/asrpic\//);
  assert.equal(result.thumbnails['288016'].thumbnailKind, 'live');
  await request('douyu', ['288016']);
  assert.equal(calls, 1, 'reopening within TTL reuses screenshot metadata');
});

test('Bilibili uses one batch and maps real and short room IDs to keyframes', async () => {
  let calls = 0;
  const request = harness(async (url, options) => {
    calls++;
    assert.deepEqual(new URL(url).searchParams.getAll('ids[]'), ['7734200', '6']);
    assert.equal(options.method, undefined, 'extension-compatible batch uses GET');
    assert.equal(options.credentials, 'omit');
    return json({ code: 0, data: { '7734200': { roomid: 7734200, short_id: 6, live_status: 1,
      cover: 'https://i0.hdslb.com/bfs/live-key-frame/frame.jpg',
      user_cover: 'https://i0.hdslb.com/bfs/live/new_room_cover/promo.jpg' } } });
  });
  const result = await request('bilibili', ['7734200', '6']);
  assert.equal(Object.keys(result.thumbnails).length, 2);
  assert.match(result.thumbnails['6'].thumbnail, /live-key-frame/);
  assert.equal(calls, 1);
});

test('unavailable, offline or wrong-room screenshots never overwrite an existing cover', async () => {
  for (const room of [null, { room_id: 1, show_status: 0 }, { room_id: 2, show_status: 1 },
    { room_id: 1, show_status: 1, room_pic: 'https://rpic.douyucdn.cn/live-cover/event.png' }]) {
    const request = harness(async () => json({ room }));
    assert.equal(Object.keys((await request('douyu', ['1'])).thumbnails).length, 0);
  }
  const failed = harness(async () => { throw new Error('offline'); });
  assert.equal(Object.keys((await failed('douyu', ['1'])).thumbnails).length, 0);
});

test('duplicate callers share requests, concurrency is bounded, and IDs cannot inject URLs', async () => {
  let active = 0, peak = 0, calls = 0;
  const releases = [];
  const request = harness(async url => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve));
    active--;
    const id = Number(url.split('/').pop());
    return json({ room: { room_id: id, show_status: 1, room_pic: `https://rpic.douyucdn.cn/asrpic/${id}.jpg` } });
  });
  const first = request('douyu', ['1', '2', '3', '4', '5', '6', '../evil', 'https://evil.test']);
  const second = request('douyu', ['1']);
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setImmediate(resolve));
    releases.shift()?.();
  }
  const [a,b] = await Promise.all([first,second]);
  assert.equal(calls, 6);
  assert.ok(peak <= 4);
  assert.equal(Object.keys(a.thumbnails).length, 6);
  assert.equal(a.thumbnails['1'].thumbnail, b.thumbnails['1'].thumbnail);
});

test('external or uploaded image URLs cannot masquerade as live frames', async () => {
  for (const url of ['https://evil.test/asrpic/1.jpg', 'javascript:alert(1)', 'https://douyucdn.cn.evil.test/asrpic/1.jpg']) {
    const request = harness(async () => json({ room: { room_id: 1, show_status: 1, room_pic: url } }));
    assert.equal(Object.keys((await request('douyu', ['1'])).thumbnails).length, 0);
  }
});
