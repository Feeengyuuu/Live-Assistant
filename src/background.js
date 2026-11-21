// EricWang fork of Licardo's Live-Assistant. Modified 2026-10-05; see NOTICE.md and LICENSE (GPLv3).
// 每个平台只声明请求、列表结构和记录转换；公共层负责状态、分页、超时和去重。
importScripts("thumbnails.js", "settings.js");

const REQUEST_TIMEOUT_MS = 10000;
const MAX_PAGES = 20;
const TRACKED_CONCURRENCY = 4;
// Twitch 网页端公开 Client-Id，只用于查询公开的开播状态，不携带账号凭据。
const TWITCH_PUBLIC_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TWITCH_TRACKED_QUERY = "query TrackedChannels($logins: [String!]) { users(logins: $logins) { login displayName " +
  "profileImageURL(width: 70) stream { title viewersCount createdAt game { displayName } } } }";
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

async function readJsonResponse(response) {
  if (!response.ok) throw new PlatformError("http", `平台请求失败（HTTP ${response.status}），请稍后重试`);
  const contentType = response.headers.get("content-type") || "";
  if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
    throw new PlatformError("response_format", "平台未返回有效数据，请稍后重试");
  }
  try { return await response.json(); } catch {
    throw new PlatformError("response_format", "平台数据无法解析，请稍后重试");
  }
}

async function getTrackedChannels() {
  try {
    const saved = await chrome.storage.local.get("trackedChannels");
    return normalizeTrackedChannels(saved?.trackedChannels);
  } catch {
    return normalizeTrackedChannels();
  }
}

function youtubeChannelUrl(channel) {
  const path = channel.startsWith("@") ? `@${encodeURIComponent(channel.slice(1))}` : `channel/${channel}`;
  return `https://www.youtube.com/${path}/live`;
}

// ytInitial* 是页面脚本里的对象字面量；按括号配对截取，字符串中的括号与转义不计入。
function extractPageJson(html, name) {
  const match = new RegExp(`${name}["']?\\]?\\s*=\\s*\\{`).exec(html);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let inString = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function findFirstKey(value, key, depth = 0) {
  if (!value || typeof value !== "object" || depth > 40) return undefined;
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findFirstKey(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function youtubeAvatar(thumbnails) {
  const url = normalizeUrl(Array.isArray(thumbnails) ? thumbnails.at(-1)?.url : "");
  return url.replace(/=s\d+-/, "=s88-");
}

// 频道的 /live 地址：开播时是直播观看页，预告时是预告观看页，未开播时是频道主页。
function parseYouTubePage({ channel, html }) {
  const player = extractPageJson(html, "ytInitialPlayerResponse");
  const initial = extractPageJson(html, "ytInitialData");
  const details = player?.videoDetails;
  const broadcast = player?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  const metadata = initial?.metadata?.channelMetadataRenderer;
  const watch = initial?.contents?.twoColumnWatchNextResults?.results;
  const channelId = textValue(details?.channelId || metadata?.externalId);
  const name = textValue(details?.author || metadata?.title);
  if (!channelId || !name) throw new Error("无法识别 YouTube 频道页面");
  const owner = watch && findFirstKey(watch, "videoOwnerRenderer");
  const base = {
    roomId: roomId(channelId), name, url: youtubeChannelUrl(channel), platform: "youtube", followers: 0, gameName: "",
    avatar: youtubeAvatar(owner?.thumbnail?.thumbnails || metadata?.avatar?.thumbnails), hasKnownLiveState: true,
  };
  if (details?.isLive !== true || details.isUpcoming === true || broadcast?.isLiveNow === false) {
    return { ...base, isLive: false, isOffline: true, title: "", viewers: 0, ...coverFields("", "") };
  }
  const videoId = roomId(details.videoId);
  const started = Date.parse(broadcast?.startTimestamp);
  return {
    ...base, isLive: true, isOffline: false, title: textValue(details.title, "直播中..."),
    // videoDetails.viewCount 是累计播放量；同时在线人数在观看页的 originalViewCount。
    viewers: Number(findFirstKey(watch, "videoViewCountRenderer")?.originalViewCount) || 0,
    ...(started > 0 ? { startTime: new Date(started).toISOString() } : {}),
    ...coverFields(`https://i.ytimg.com/vi/${videoId}/mqdefault_live.jpg`, `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, "live"),
  };
}

// 追踪频道没有账号关注列表，逐个频道查询并限制并发。
// 查询失败的频道计入无法读取的数量，不能当作未开播。
async function collectTrackedChannels(platformKey, signal, load) {
  const channels = (await getTrackedChannels())[platformKey];
  const records = new Array(channels.length);
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < channels.length) {
      const index = next++;
      try {
        records[index] = await load(channels[index]);
      } catch {
        if (signal.aborted) throw new PlatformError("timeout", "请求超时，请稍后刷新");
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRACKED_CONCURRENCY, channels.length) }, worker));
  return { records: records.filter(Boolean), invalidCount: failed };
}

function collectYouTubePages(signal) {
  return collectTrackedChannels("youtube", signal, async (channel) => {
    const response = await fetch(youtubeChannelUrl(channel), { credentials: "omit", signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // 地区同意页等跳转不是频道页面，不能当作未开播。
    if (response.url && new URL(response.url).hostname !== "www.youtube.com") throw new Error("unexpected redirect");
    return { channel, html: await response.text() };
  });
}

// Kick 网页端公开的频道接口，无需登录；不存在的频道返回 404，被拦截时返回非 JSON 页面。
function collectKickChannels(signal) {
  return collectTrackedChannels("kick", signal, async (channel) => {
    const response = await fetch(`https://kick.com/api/v1/channels/${channel}`, { credentials: "omit", signal });
    return readJsonResponse(response);
  });
}

// Kick 的时间是不带时区的 UTC，例如 “2026-11-21 13:23:54”。
function kickTime(value) {
  const time = Date.parse(`${textValue(value).replace(" ", "T")}Z`);
  return time > 0 ? time : 0;
}

// 直播截图有多档宽度；卡片用 640w 一档，没有时用接口给出的默认地址。
function kickThumbnail(thumbnail) {
  const sized = textValue(thumbnail?.responsive).split(",").map((entry) => entry.trim().split(/\s+/));
  return sized.find((entry) => entry[1] === "640w")?.[0] || textValue(thumbnail?.url);
}

function parseKickChannel(channel) {
  const slug = roomId(textValue(channel.slug).toLowerCase());
  const stream = channel.livestream;
  const base = {
    roomId: slug, name: textValue(channel.user?.username, slug), avatar: normalizeUrl(channel.user?.profile_pic),
    url: `https://kick.com/${slug}`, platform: "kick", followers: 0, hasKnownLiveState: true,
  };
  if (stream?.is_live !== true || channel.is_banned === true) {
    // previous_livestreams 按时间倒序，第一条是最近一次直播。
    const previous = Array.isArray(channel.previous_livestreams) ? channel.previous_livestreams[0] : null;
    return {
      ...base, isLive: false, isOffline: true, title: "", viewers: 0, gameName: "",
      ...lastLiveFields(kickTime(previous?.start_time) / 1000, "platform_start"), ...coverFields("", ""),
    };
  }
  const started = kickTime(stream.start_time);
  return {
    ...base, isLive: true, isOffline: false, title: textValue(stream.session_title, "直播中..."),
    viewers: Number(stream.viewer_count) || 0, gameName: textValue(stream.categories?.[0]?.name),
    ...(started ? { startTime: new Date(started).toISOString() } : {}),
    ...coverFields(kickThumbnail(stream.thumbnail), "", "live"),
  };
}

const PLATFORMS = {
  douyu: {
    name: "斗鱼",
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
    name: "虎牙",
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
    name: "B站",
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
    name: "抖音",
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
    name: "Twitch",
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
    // 追踪频道走公开查询，无需关注；已在关注列表里的频道不重复请求。
    supplement: async (state, signal) => {
      const listed = new Set(state.data.map((entry) => entry.roomId));
      const logins = (await getTrackedChannels()).twitch.filter((login) => !listed.has(login));
      if (!logins.length) return { records: [] };
      const response = await fetch("https://gql.twitch.tv/gql", {
        method: "POST", signal,
        headers: { "Client-Id": TWITCH_PUBLIC_CLIENT_ID, "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ query: TWITCH_TRACKED_QUERY, variables: { logins } }),
      });
      const payload = await readJsonResponse(response);
      if (payload?.errors?.length) throw new PlatformError("api", "Twitch 追踪频道暂时无法查询");
      // 不存在的登录名返回 null；未开播的频道没有 stream，Twitch 不提供未开播名单。
      return { records: requireList(payload?.data?.users).filter((user) => user?.stream) };
    },
    parseSupplement: (user) => {
      const login = roomId(user.login);
      return {
        roomId: login, name: textValue(user.displayName, login), avatar: normalizeUrl(user.profileImageURL),
        url: `https://www.twitch.tv/${login}`, isLive: true, title: textValue(user.stream.title), platform: "twitch",
        viewers: user.stream.viewersCount || 0, followers: 0, startTime: textValue(user.stream.createdAt) || null,
        ...coverFields(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-320x180.jpg`, "", "live"),
        gameName: textValue(user.stream.game?.displayName),
      };
    },
  },
  youtube: {
    name: "YouTube",
    host: "https://www.youtube.com",
    offlineMode: "embedded",
    collect: collectYouTubePages,
    parseItem: parseYouTubePage,
  },
  kick: {
    name: "Kick",
    host: "https://kick.com",
    offlineMode: "embedded",
    collect: collectKickChannels,
    parseItem: parseKickChannel,
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

function addRecords(parse, state, { records, invalidCount = 0 }) {
  state.invalidCount += invalidCount;
  let added = 0;
  for (const item of records) {
    try {
      if (!item || typeof item !== "object") throw new Error("无效记录");
      const streamer = parse(item);
      if (state.seen.has(streamer.url)) continue;
      state.seen.add(streamer.url);
      state.data.push(streamer);
      added++;
    } catch {
      state.invalidCount++;
    }
  }
  return added;
}

async function fetchFollowPages(cfg, state, signal) {
  const cookies = await getCookies(cfg.host);
  if (signal.aborted) throw new PlatformError("timeout", "请求超时，请稍后刷新");
  if (!cfg.isLoggedIn(cookies)) throw new PlatformError("auth_required", "请先登录平台");
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (signal.aborted) throw new PlatformError("timeout", "请求超时，请稍后刷新");
    const { url, options } = cfg.request(cookies, page);
    const response = await fetch(url, { ...options, signal });
    if (response.status === 401) throw new PlatformError("auth_required", "登录已失效，请重新登录平台");
    const payload = await readJsonResponse(response);
    if (signal.aborted) throw new PlatformError("timeout", "请求超时，请稍后刷新");
    const { records, pagination, invalidCount = 0 } = cfg.read(payload);
    const added = addRecords(cfg.parseItem, state, { records, invalidCount });
    if (page > 1 && records.length && added === 0) {
      throw new PlatformError("pagination", "平台重复返回同一页，关注列表可能不完整");
    }
    if (!cfg.pageSize || !hasNextPage(pagination, page, cfg.pageSize, records.length)) return;
    if (!records.length) throw new PlatformError("pagination", "平台分页信息不一致，关注列表可能不完整");
  }
  throw new PlatformError("pagination", "关注列表较长，本次未能完整读取，请稍后刷新");
}

async function fetchPlatformPages(cfg, state, signal) {
  // 追踪频道类平台（YouTube、Kick）没有账号关注列表，直接按频道收集。
  if (cfg.collect) addRecords(cfg.parseItem, state, await cfg.collect(signal));
  else await fetchFollowPages(cfg, state, signal);
  if (cfg.supplement) {
    if (signal.aborted) throw new PlatformError("timeout", "请求超时，请稍后刷新");
    addRecords(cfg.parseSupplement, state, await cfg.supplement(state, signal));
  }
  if (state.invalidCount) throw new PlatformError("invalid_records", `${state.invalidCount} 条平台数据无法读取，列表可能不完整`);
  return platformResult(cfg, "ok", state.data, { fetchedAt: Date.now() });
}

async function fetchPlatformWithDeadline(cfg) {
  const state = { data: [], seen: new Set(), invalidCount: 0 };
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

// ========== 开播通知 ==========
// 收藏主播从“确认未开播”变为开播时提醒。没有记录的主播只记下当前状态、不提醒，
// 避免刚开启通知或刚收藏时，把已经在播的主播当成新开播。
const LIVE_CHECK_ALARM = "favorite-live-check";
const LIVE_NOTIFICATION_PREFIX = "live:";
let liveCheck = null;

async function scheduleLiveCheck() {
  const { liveNotifications } = await chrome.storage.local.get("liveNotifications");
  const settings = normalizeLiveNotifications(liveNotifications);
  if (!settings.enabled) {
    await chrome.alarms.clear(LIVE_CHECK_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(LIVE_CHECK_ALARM);
  if (existing?.periodInMinutes === settings.intervalMinutes) return;
  await chrome.alarms.create(LIVE_CHECK_ALARM, { delayInMinutes: 1, periodInMinutes: settings.intervalMinutes });
}

async function checkFavoriteLive() {
  const saved = await chrome.storage.local.get(["liveNotifications", "favoriteStreamers", "enabledPlatforms", "platformOrder", "liveNotifyState"]);
  const settings = normalizeLiveNotifications(saved.liveNotifications);
  if (!settings.enabled) return [];
  const favorites = new Set(Array.isArray(saved.favoriteStreamers) ? saved.favoriteStreamers.filter((key) => typeof key === "string") : []);
  const keys = Object.keys(PLATFORMS);
  // 旧版收藏只存主播名，看不出平台，只能检查全部已启用平台。
  const legacy = [...favorites].some((favorite) => !keys.some((key) => favorite.startsWith(`${key}:`)));
  const platforms = resolveEnabledPlatforms(saved, keys)
    .filter((key) => legacy || [...favorites].some((favorite) => favorite.startsWith(`${key}:`)));
  const previous = saved.liveNotifyState?.records && typeof saved.liveNotifyState.records === "object" ? saved.liveNotifyState.records : {};
  // 短暂断流后恢复不算新开播：至少错过两次检查才再次提醒。
  const restartGap = Math.max(20, settings.intervalMinutes * 2 + 1) * 60_000;
  const now = Date.now();
  const records = {};
  const started = [];
  const results = await Promise.all(platforms.map(async (key) => [key, await fetchPlatform(key)]));
  for (const [key, result] of results) {
    const seen = new Set();
    for (const entry of result.status === "ok" || result.status === "partial" ? result.data : []) {
      const id = `${key}:${normalizeUrl(entry.url)}`;
      if (!favorites.has(id) && !favorites.has(entry.name)) continue;
      seen.add(id);
      const old = previous[id];
      if (entry.isLive && old?.live === false && now - (old.lastLiveAt || 0) >= restartGap) started.push({ ...entry, id });
      records[id] = { live: entry.isLive === true, lastLiveAt: entry.isLive ? now : old?.lastLiveAt || 0, name: entry.name };
    }
    const known = new Set([...favorites].filter((id) => id.startsWith(`${key}:`)));
    for (const [id, record] of Object.entries(previous)) {
      if (id.startsWith(`${key}:`) && favorites.has(record?.name)) known.add(id);
    }
    for (const id of known) {
      if (seen.has(id)) continue;
      // 完整的列表里没有它即为未开播；请求失败或列表不完整时状态未知，沿用上次记录。
      if (result.status === "ok") records[id] = { live: false, lastLiveAt: previous[id]?.lastLiveAt || 0, name: previous[id]?.name || "" };
      else if (previous[id]) records[id] = previous[id];
    }
  }
  await chrome.storage.local.set({ liveNotifyState: { checkedAt: now, records } });
  await Promise.all(started.map(showLiveNotification));
  return started.map((entry) => entry.id);
}

async function showLiveNotification(entry) {
  const id = `${LIVE_NOTIFICATION_PREFIX}${entry.id}`;
  const fallbackIcon = chrome.runtime.getURL("icon.png");
  const options = {
    type: "basic", priority: 1, iconUrl: normalizeUrl(entry.avatar) || fallbackIcon,
    title: `${entry.name} 开播了`, message: entry.title || "正在直播",
    contextMessage: [PLATFORMS[entry.platform]?.name, entry.gameName].filter(Boolean).join(" · "),
  };
  try {
    await chrome.notifications.create(id, options);
  } catch {
    // 头像下载失败时改用扩展图标，不能因此漏掉提醒。
    await chrome.notifications.create(id, { ...options, iconUrl: fallbackIcon }).catch(() => {});
  }
}

async function showTestNotification() {
  try {
    if (await chrome.notifications.getPermissionLevel() !== "granted") {
      return { success: false, error: "Chrome 已关闭本扩展的通知" };
    }
    await chrome.notifications.create("live-test", {
      type: "basic", priority: 1, iconUrl: chrome.runtime.getURL("icon.png"),
      title: "开播通知已开启", message: "收藏的主播开播时，会像这样提醒你。",
    });
    return { success: true };
  } catch {
    return { success: false, error: "通知发送失败" };
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LIVE_CHECK_ALARM || liveCheck) return;
  liveCheck = checkFavoriteLive().catch(() => []).finally(() => { liveCheck = null; });
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith(LIVE_NOTIFICATION_PREFIX)) {
    const id = notificationId.slice(LIVE_NOTIFICATION_PREFIX.length);
    const url = normalizeUrl(id.slice(id.indexOf(":") + 1));
    if (url) chrome.tabs.create({ url });
  }
  chrome.notifications.clear(notificationId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.liveNotifications) scheduleLiveCheck().catch(() => {});
});
// 闹钟可能在浏览器重启后被清除，安装、更新和启动时都重新确认。
chrome.runtime.onInstalled.addListener(() => { scheduleLiveCheck().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { scheduleLiveCheck().catch(() => {}); });

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === "testLiveNotification") {
    showTestNotification().then(sendResponse);
    return true;
  }
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
