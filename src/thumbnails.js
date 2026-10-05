// EricWang fork additions, 2026-10-05. See NOTICE.md and LICENSE (GPLv3) for origin and terms.
// Live frame enrichment runs separately from follow-list loading. Never fetch video streams.
const FRAME_TTL_MS = 60_000;
const FRAME_FAILURE_TTL_MS = 15_000;
const FRAME_TIMEOUT_MS = 10_000;
const FRAME_CACHE_LIMIT = 500;
const frameCache = new Map();
const frameRequests = new Map();
const frameQueue = [];
let activeFrameRequests = 0;

function frameImageUrl(value, platform) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    const domain = platform === "douyu" ? "douyucdn.cn" : "hdslb.com";
    if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return "";
    // These are provider-returned snapshot paths, distinct from uploaded event covers.
    const path = platform === "douyu" ? "/asrpic/" : "/bfs/live-key-frame/";
    if (!url.pathname.startsWith(path)) return "";
    url.protocol = "https:";
    return url.href;
  } catch {
    return "";
  }
}

function queueFrameRequest(work) {
  return new Promise((resolve, reject) => {
    frameQueue.push({ work, resolve, reject });
    drainFrameQueue();
  });
}

function drainFrameQueue() {
  while (activeFrameRequests < 4 && frameQueue.length) {
    const job = frameQueue.shift();
    activeFrameRequests++;
    Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
      activeFrameRequests--;
      drainFrameQueue();
    });
  }
}

function rememberFrame(key, thumbnail) {
  const now = Date.now();
  const value = thumbnail ? { thumbnail, thumbnailKind: "live", thumbnailFetchedAt: now } : null;
  frameCache.delete(key);
  frameCache.set(key, { value, expires: now + (value ? FRAME_TTL_MS : FRAME_FAILURE_TTL_MS) });
  while (frameCache.size > FRAME_CACHE_LIMIT) frameCache.delete(frameCache.keys().next().value);
  return value;
}

async function frameJson(url, options, signal) {
  signal.throwIfAborted();
  const response = await fetch(url, { ...options, credentials: "omit", signal });
  if (!response.ok) throw new Error("截图信息暂时不可用");
  return response.json();
}

function requestDouyuFrame(roomId) {
  const signal = AbortSignal.timeout(FRAME_TIMEOUT_MS);
  return queueFrameRequest(async () => {
    const data = await frameJson(`https://www.douyu.com/betard/${roomId}`, {}, signal);
    const room = data?.room;
    if (String(room?.room_id) !== roomId || Number(room.show_status) !== 1) return "";
    // room_pic is the captured frame; coverSrc/rs1 can be promotional event artwork.
    return frameImageUrl(room.room_pic, "douyu");
  });
}

function requestBilibiliFrames(roomIds) {
  const signal = AbortSignal.timeout(FRAME_TIMEOUT_MS);
  return queueFrameRequest(async () => {
    // The API's batch GET also works in an extension context; POST can return HTTP 412 there.
    const url = new URL("https://api.live.bilibili.com/room/v2/Room/get_by_ids");
    for (const id of roomIds) url.searchParams.append("ids[]", id);
    const data = await frameJson(url.href, {}, signal);
    if (Number(data?.code) !== 0 || !data.data || Array.isArray(data.data)) {
      throw new Error("截图信息暂时不可用");
    }
    const result = {};
    for (const room of Object.values(data.data)) {
      if (!room || Number(room.live_status) !== 1) continue;
      const frame = frameImageUrl(room.keyframe, "bilibili") || frameImageUrl(room.cover, "bilibili");
      for (const id of [room.roomid ?? room.room_id, room.short_id]) {
        if (frame && roomIds.includes(String(id))) result[String(id)] = frame;
      }
    }
    return result;
  });
}

async function fetchLiveThumbnails(request) {
  const { platform } = request || {};
  if (!["douyu", "bilibili"].includes(platform) || !Array.isArray(request.roomIds)) {
    return { success: false, thumbnails: {} };
  }
  const ids = [...new Set(request.roomIds.map(String).filter((id) => /^[1-9]\d{0,14}$/.test(id)))].slice(0, 50);
  const pending = new Map();
  const missing = [];
  for (const id of ids) {
    const key = `${platform}:${id}`;
    const cached = frameCache.get(key);
    if (cached && cached.expires > Date.now()) pending.set(id, Promise.resolve(cached.value));
    else if (frameRequests.has(key)) pending.set(id, frameRequests.get(key));
    else missing.push(id);
  }
  // Bilibili supports one batch request; Douyu room requests share a global concurrency bound.
  const batch = platform === "bilibili" && missing.length ? requestBilibiliFrames(missing) : null;
  for (const id of missing) {
    const key = `${platform}:${id}`;
    const source = batch ? batch.then((frames) => frames[id] || "") : requestDouyuFrame(id);
    const promise = source.catch(() => "").then((frame) => rememberFrame(key, frame)).finally(() => frameRequests.delete(key));
    frameRequests.set(key, promise);
    pending.set(id, promise);
  }
  const thumbnails = {};
  await Promise.all([...pending].map(async ([id, promise]) => {
    const value = await promise;
    if (value) thumbnails[id] = value;
  }));
  return { success: true, thumbnails };
}
