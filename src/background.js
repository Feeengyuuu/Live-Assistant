// EricWang fork of Licardo's Live-Assistant. Modified 2026-10-05; see NOTICE.md and LICENSE (GPLv3).
// 每个平台只声明请求、列表结构和记录转换；公共层负责状态、分页、超时和去重。
importScripts("thumbnails.js");

const REQUEST_TIMEOUT_MS = 10000;
const MAX_PAGES = 20;
const platformRequests = new Map();
const offlinePlatformRequests = new Map();

class PlatformError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function getCookies(url) {
  return new Promise((resolve, reject) => chrome.cookies.getAll({ url }, (cookies) => {
    if (chrome.runtime.lastError) {
      reject(new PlatformError("cookies", "无法读取平台登录状态，请稍后重试"));
    } else {
      resolve(Array.isArray(cookies) ? cookies : []);
    }
  }));
}

function buildCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function findCookie(cookies, name) {
  return cookies.find((cookie) => cookie.name === name && cookie.value);
}

function flag(value, expected) {
  return value === expected || value === String(expected) || value === Boolean(expected);
}

function textValue(value, fallback = "") {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function roomId(value) {
  const id = textValue(value);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || id === "0") throw new Error("无效的直播间标识");
  return id;
}

function startDate(seconds) {
  const timestamp = Number(seconds) * 1000;
  return timestamp > 0 && Number.isFinite(new Date(timestamp).getTime()) ? new Date(timestamp) : null;
}

function lastLiveFields(seconds, source) {
  if (typeof seconds !== "number" && typeof seconds !== "string") return {};
  const timestamp = Number(seconds) * 1000;
  // These provider fields are Unix seconds; durations and absent/future values are not dates.
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp > Date.now()) return {};
  return { lastLiveAt: timestamp, lastLiveSource: source };
}

function requireList(value) {
  if (!Array.isArray(value)) throw new PlatformError("response_format", "平台返回的关注列表格式已变化");
  return value;
}

function checkBusinessCode(value, expected, authCodes = []) {
  if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) {
    throw new PlatformError("response_format", "平台响应缺少有效状态码");
  }
  const code = Number(value);
  if (authCodes.includes(code)) throw new PlatformError("auth_required", "登录已失效，请重新登录平台");
  if (code !== expected) throw new PlatformError("api", `平台暂时无法提供关注列表（错误码 ${code}）`);
}

function coverFields(thumbnail, fallback, kind = "cover") {
  return { thumbnail: normalizeUrl(thumbnail), thumbnailFallback: normalizeUrl(fallback), thumbnailKind: kind };
}

const PLATFORMS = {
  douyu: {
    host: "https://www.douyu.com",
    offlineMode: "embedded",
    pageSize: 50,
    // 保留现用登录线索；服务器错误会单独报告，不据此推断已退出登录。
    isLoggedIn: (cookies) => !!(findCookie(cookies, "acf_uid") || findCookie(cookies, "dy_did")),
    request: (cookies, page = 1) => ({
      url: `https://www.douyu.com/wgapi/livenc/liveweb/follow/list?page=${page}&limit=50`,
      options: { method: "GET", headers: { Cookie: buildCookieHeader(cookies) } },
    }),
    read: (payload) => {
      checkBusinessCode(payload?.error, 0);
      return { records: requireList(payload?.data?.list), pagination: payload.data };
    },
    parseItem: (item) => {
      const id = roomId(item.room_id);
      const thumbnail = normalizeUrl(item.room_src) || normalizeUrl(item.show_pic) || normalizeUrl(item.vertical_src);
      return {
        roomId: id,
        name: textValue(item.nickname || item.room_name, "未知主播"),
        avatar: normalizeUrl(item.avatar_small) || normalizeUrl(item.avatar) || normalizeUrl(item.owner_avatar),
        url: `https://www.douyu.com/${id}`,
        isLive: flag(item.show_status, 1) && flag(item.videoLoop, 0),
        isOffline: item.show_status === 2 || item.show_status === "2",
        hasKnownLiveState: flag(item.show_status, 1) || item.show_status === 2 || item.show_status === "2",
        title: textValue(item.room_name),
        platform: "douyu", viewers: item.online || 0, followers: 0,
        startTime: startDate(item.show_time),
        ...(item.show_status === 2 || item.show_status === "2" ? lastLiveFields(item.show_time, "platform_start") : {}),
        ...coverFields(thumbnail, thumbnail),
        gameName: textValue(item.game_name),
      };
    },
  },
  huya: {
    host: "https://www.huya.com",
    offlineMode: "embedded",
    pageSize: 22,
    isLoggedIn: (cookies) => !!findCookie(cookies, "udb_uid"),
    request: (cookies, page = 1) => ({
      url: `https://fw.huya.com/dispatch?do=subscribeList&uid=${encodeURIComponent(findCookie(cookies, "udb_uid").value)}&page=${page}&pageSize=22`,
      options: { method: "GET", headers: { Cookie: buildCookieHeader(cookies) } },
    }),
    read: (payload) => {
      checkBusinessCode(payload?.status, 1000);
      return { records: requireList(payload?.result?.list), pagination: payload.result };
    },
    parseItem: (item) => {
      const id = roomId(item.profileRoom);
      return {
        roomId: id, name: textValue(item.nick, "未知主播"), avatar: normalizeUrl(item.avatar180),
        url: `https://www.huya.com/${id}`, isLive: flag(item.isLive, 1),
        isOffline: flag(item.isLive, 0),
        hasKnownLiveState: flag(item.isLive, 0) || flag(item.isLive, 1) || item.isLive === 2 || item.isLive === "2",
        title: textValue(item.intro), platform: "huya", viewers: item.totalCount || 0,
        followers: item.activityCount || 0, startTime: startDate(item.startTime),
        ...coverFields(item.screenshot, item.screenshot), gameName: textValue(item.gameName),
      };
    },
  },
  bilibili: {
    host: "https://www.bilibili.com",
    offlineMode: "separate",
    isLoggedIn: (cookies) => !!(findCookie(cookies, "SESSDATA") && findCookie(cookies, "DedeUserID")),
    request: (cookies) => ({
      url: "https://api.live.bilibili.com/xlive/web-ucenter/v1/xfetter/GetWebList",
      options: { method: "GET", headers: { Cookie: buildCookieHeader(cookies) } },
    }),
    read: (payload) => {
      checkBusinessCode(payload?.code, 0, [-101]);
      return { records: requireList(payload?.data?.list) };
    },
    parseItem: (item) => {
      const id = roomId(item.roomid || item.room_id);
      const keyframe = normalizeUrl(item.keyframe);
      const fallback = normalizeUrl(item.cover_from_user);
      return {
        roomId: id, name: textValue(item.uname, "未知主播"), avatar: normalizeUrl(item.face),
        url: `https://live.bilibili.com/${id}`, isLive: flag(item.live_status, 1),
        isOffline: flag(item.live_status, 0),
        hasKnownLiveState: flag(item.live_status, 0) || flag(item.live_status, 1) || item.live_status === 2 || item.live_status === "2",
        title: textValue(item.title, "直播中..."), platform: "bilibili", viewers: item.online || 0,
        followers: 0, liveTime: item.live_time,
        ...coverFields(keyframe || fallback, fallback, keyframe ? "live" : "cover"),
        gameName: textValue(item.area_v2_name),
      };
    },
  },
  douyin: {
    host: "https://www.douyin.com",
    isLoggedIn: (cookies) => !!findCookie(cookies, "sessionid"),
    request: (cookies) => ({
      url: "https://www.douyin.com/webcast/web/feed/follow/?aid=6383&scene=aweme_pc_follow_top",
      options: { method: "GET", headers: { Cookie: buildCookieHeader(cookies) } },
    }),
    read: (payload) => {
      if (payload?.status_code !== undefined) checkBusinessCode(payload.status_code, 0);
      return { records: requireList(payload?.data?.data) };
    },
    parseItem: (item) => {
      const room = item.room;
      if (!room || !room.owner) throw new Error("缺少直播间信息");
      const id = roomId(item.web_rid);
      return {
        roomId: id, name: textValue(room.owner.nickname, "未知主播"),
        avatar: normalizeUrl(room.owner.avatar_thumb?.url_list?.[0]),
        url: `https://live.douyin.com/${id}`,
        // 保留现有接口的状态约定；不套用其他抖音接口的状态值。
        isLive: flag(room.status, 0), title: textValue(room.title, "直播中..."), platform: "douyin",
        viewers: room.stats?.user_count_str || "0", followers: 0,
        ...coverFields(room.cover?.url_list?.[0], room.cover?.url_list?.[0]), gameName: "",
      };
    },
  },
  twitch: {
    host: "https://www.twitch.tv",
    persistedQueryHash: "b235e7c084bc768d827343cda0b95310535a0956d449e574885b00e176fe5f27",
    isLoggedIn: (cookies) => !!(findCookie(cookies, "auth-token") && findCookie(cookies, "unique_id")),
    request: (cookies) => ({
      url: "https://gql.twitch.tv/gql",
      options: {
        method: "POST",
        headers: { Authorization: `OAuth ${findCookie(cookies, "auth-token").value}`, "X-Device-Id": findCookie(cookies, "unique_id").value },
        body: JSON.stringify([{
          variables: { input: { followSortOrder: "RECS" }, creatorAnniversariesFeature: false, withFreeformTags: false },
          extensions: { persistedQuery: { sha256Hash: PLATFORMS.twitch.persistedQueryHash } },
        }]),
      },
    }),
    read: (payload) => {
      if (!Array.isArray(payload) || !payload.length) throw new PlatformError("response_format", "Twitch 返回格式已变化");
      const result = payload[0];
      if (result?.errors?.length) {
        const auth = result.errors.some((error) => error?.extensions?.code === "UNAUTHENTICATED");
        throw new PlatformError(auth ? "auth_required" : "api", auth ? "登录已失效，请重新登录 Twitch" : "Twitch 暂时无法提供关注列表");
      }
      const sections = requireList(result?.data?.sideNav?.sections?.edges);
      const records = [];
      let invalidCount = 0;
      for (const section of sections) {
        if (typeof section?.node?.id !== "string") { invalidCount++; continue; }
        if (!section.node.id.includes("followed")) continue;
        const edges = section.node.content?.edges;
        if (!Array.isArray(edges)) { invalidCount++; continue; }
        for (const edge of edges) {
          if (!edge?.node) { invalidCount++; continue; }
          if (edge.node.__typename === "Stream") records.push(edge.node);
        }
      }
      return { records, invalidCount };
    },
    parseItem: (node) => {
      const broadcaster = node.broadcaster;
      const login = roomId(broadcaster?.login);
      return {
        roomId: login, name: textValue(broadcaster.displayName, "未知主播"),
        avatar: normalizeUrl(broadcaster.profileImageURL), url: `https://www.twitch.tv/${login}`,
        isLive: true, title: textValue(broadcaster.broadcastSettings?.title), platform: "twitch",
        viewers: node.viewersCount || 0, followers: 0,
        ...coverFields(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-320x180.jpg`, "", "live"),
        gameName: textValue(node.game?.displayName),
      };
    },
  },
};

// 官方直播个人中心使用的关注分页接口，包含明确的 live_status。
// 当前网页来源与字段证据见 docs/offline-api-evidence.md；不从直播列表缺席推断离线。
const BILIBILI_OFFLINE = {
  ...PLATFORMS.bilibili,
  offlineMode: "embedded",
  pageSize: 9,
  request: (cookies, page = 1) => ({
    url: `https://api.live.bilibili.com/xlive/web-ucenter/user/following?page=${page}&page_size=9&ignoreRecord=1&hit_ab=false`,
    options: { method: "GET", headers: { Cookie: buildCookieHeader(cookies) } },
  }),
  read: (payload) => {
    checkBusinessCode(payload?.code, 0, [-101]);
    return { records: requireList(payload?.data?.list), pagination: payload.data };
  },
  parseItem: (item) => ({
    ...PLATFORMS.bilibili.parseItem(item),
    title: textValue(item.title),
    gameName: textValue(item.area_name_v2 || item.area_v2_name),
    ...(flag(item.live_status, 0) ? lastLiveFields(item.record_live_time, "platform_record") : {}),
  }),
};

// 优先采用显式分页信息；旧接口没有元数据时，满页才继续读取。
function hasNextPage(metadata, page, pageSize, count) {
  const containers = [metadata?.pagination, metadata?.pageInfo, metadata];
  for (const data of containers) {
    if (!data || typeof data !== "object") continue;
    for (const key of ["has_more", "hasMore", "has_next", "hasNext"]) {
      if ([true, 1, "1"].includes(data[key])) return true;
      if ([false, 0, "0"].includes(data[key])) return false;
    }
    for (const key of ["total_page", "totalPage", "totalPages", "pageCount", "page_count"]) {
      if (data[key] !== undefined && data[key] !== null && data[key] !== "" && Number.isInteger(Number(data[key])) && Number(data[key]) >= 0) {
        return page < Number(data[key]);
      }
    }
    for (const key of ["total", "totalCount", "total_count"]) {
      if (data[key] !== undefined && data[key] !== null && data[key] !== "" && Number.isInteger(Number(data[key])) && Number(data[key]) >= 0) {
        return page * pageSize < Number(data[key]);
      }
    }
  }
  return count >= pageSize;
}

function platformResult(cfg, status, data, extras = {}) {
  const offlineSupported = !!cfg.offlineMode;
  const separate = cfg.offlineMode === "separate";
  const knownStates = data.every((entry) => entry.hasKnownLiveState !== false);
  const complete = status === "ok" && knownStates;
  const offlineCoverage = !offlineSupported ? "unsupported" : separate ? "pending" : complete ? "complete" : "partial";
  const offlineStatus = !offlineSupported ? "unsupported" : separate ? "pending" : status === "ok" && !knownStates ? "partial" : status;
  return {
    success: status === "ok", status, data, loginUrl: cfg.host,
    isLoggedIn: status === "auth_required" ? false : status === "ok" || status === "partial" ? true : null,
    offlineData: offlineSupported && !separate && (status === "ok" || status === "partial")
      ? data.filter((entry) => entry.isOffline === true && !entry.isLive) : [],
    offlineSupported, offlineCoverage, offlineStatus,
    ...(offlineCoverage === "complete" ? { offlineFetchedAt: extras.fetchedAt || Date.now() } : {}),
    ...extras,
  };
}

async function fetchPlatformPages(cfg, state, signal) {
  const cookies = await getCookies(cfg.host);
  if (signal.aborted) throw new PlatformError("timeout", "请求超时，请稍后刷新");
  if (!cfg.isLoggedIn(cookies)) throw new PlatformError("auth_required", "请先登录平台");
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (signal.aborted) throw new PlatformError("timeout", "请求超时，请稍后刷新");
    const { url, options } = cfg.request(cookies, page);
    const response = await fetch(url, { ...options, signal });
    if (response.status === 401) throw new PlatformError("auth_required", "登录已失效，请重新登录平台");
    if (!response.ok) throw new PlatformError("http", `平台请求失败（HTTP ${response.status}），请稍后重试`);
    const contentType = response.headers.get("content-type") || "";
    if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
      throw new PlatformError("response_format", "平台未返回有效数据，请稍后重试");
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new PlatformError("response_format", "平台数据无法解析，请稍后重试");
    }
    if (signal.aborted) throw new PlatformError("timeout", "请求超时，请稍后刷新");
    const { records, pagination, invalidCount = 0 } = cfg.read(payload);
    state.invalidCount += invalidCount;
    let added = 0;
    for (const item of records) {
      try {
        if (!item || typeof item !== "object") throw new Error("无效记录");
        const streamer = cfg.parseItem(item);
        if (seen.has(streamer.url)) continue;
        seen.add(streamer.url);
        state.data.push(streamer);
        added++;
      } catch {
        state.invalidCount++;
      }
    }
    if (page > 1 && records.length && added === 0) {
      throw new PlatformError("pagination", "平台重复返回同一页，关注列表可能不完整");
    }
    if (!cfg.pageSize || !hasNextPage(pagination, page, cfg.pageSize, records.length)) {
      if (state.invalidCount) throw new PlatformError("invalid_records", `${state.invalidCount} 条平台数据无法读取，列表可能不完整`);
      return platformResult(cfg, "ok", state.data, { fetchedAt: Date.now() });
    }
    if (!records.length) throw new PlatformError("pagination", "平台分页信息不一致，关注列表可能不完整");
  }
  throw new PlatformError("pagination", "关注列表较长，本次未能完整读取，请稍后刷新");
}

async function fetchPlatformWithDeadline(cfg) {
  const state = { data: [], invalidCount: 0 };
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PlatformError("timeout", "请求超时，请稍后刷新"));
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    // Deadline 同时覆盖 Cookie 回调、分页及响应体读取，不会每页重置。
    return await Promise.race([fetchPlatformPages(cfg, state, controller.signal), timeout]);
  } catch (error) {
    const kind = error.kind || (controller.signal.aborted ? "timeout" : "network");
    const status = kind === "auth_required" ? "auth_required" : state.data.length || state.invalidCount ? "partial" : "error";
    return platformResult(cfg, status, status === "auth_required" ? [] : state.data, {
      errorKind: kind,
      error: error instanceof PlatformError ? error.message : "网络连接失败，请稍后重试",
    });
  } finally {
    clearTimeout(timer);
  }
}

function fetchPlatform(platformKey) {
  if (!Object.prototype.hasOwnProperty.call(PLATFORMS, platformKey)) {
    return Promise.resolve(platformResult({ host: "" }, "error", [], { errorKind: "unsupported", error: "不支持的平台" }));
  }
  if (platformRequests.has(platformKey)) return platformRequests.get(platformKey);
  const request = fetchPlatformWithDeadline(PLATFORMS[platformKey]).finally(() => platformRequests.delete(platformKey));
  platformRequests.set(platformKey, request);
  return request;
}

function fetchOfflinePlatform(platformKey) {
  // 斗鱼和虎牙复用已经取得的关注列表；只有 B 站需要独立的全部直播关注接口。
  if (platformKey !== "bilibili") {
    return Promise.resolve(platformResult({ host: "" }, "ok", []));
  }
  if (offlinePlatformRequests.has(platformKey)) return offlinePlatformRequests.get(platformKey);
  const request = fetchPlatformWithDeadline(BILIBILI_OFFLINE).finally(() => offlinePlatformRequests.delete(platformKey));
  offlinePlatformRequests.set(platformKey, request);
  return request;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === "getOfflineFollowedStreamers") {
    fetchOfflinePlatform(request.platform).then(sendResponse).catch(() => sendResponse({
      success: false, status: "error", offlineStatus: "error", offlineCoverage: "partial",
      offlineSupported: request.platform === "bilibili", offlineData: [], error: "暂时无法加载未开播列表，请稍后刷新",
    }));
    return true;
  }
  if (request?.action === "getLiveThumbnails") {
    Promise.resolve().then(() => fetchLiveThumbnails(request)).then(sendResponse).catch(() => sendResponse({ success: false, thumbnails: {} }));
    return true;
  }
  if (request?.action !== "getFollowedStreamers") return;
  fetchPlatform(request.platform).then(sendResponse).catch(() => {
    sendResponse(platformResult({ host: "" }, "error", [], { errorKind: "unexpected", error: "暂时无法加载，请稍后刷新" }));
  });
  return true;
});
