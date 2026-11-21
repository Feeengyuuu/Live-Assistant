// EricWang fork additions, 2026-10-30. See NOTICE.md and LICENSE (GPLv3) for origin and terms.
// popup 与 background 共用的设置规则：启用平台、追踪频道和开播通知。
// 1.3.x 保存的平台顺序包含当时全部平台；之后新增的平台（YouTube、Kick）对这些用户默认启用一次。
const LEGACY_PLATFORMS = Object.freeze(["douyu", "huya", "bilibili", "douyin", "twitch"]);
const LIVE_CHECK_INTERVALS = Object.freeze([2, 5, 10, 15]);
const DEFAULT_LIVE_NOTIFICATIONS = Object.freeze({ enabled: true, intervalMinutes: 5 });
const TRACKED_CHANNEL_LIMIT = 30;

// 从未保存过设置时启用全部平台；用户关闭过的平台保持关闭。
function resolveEnabledPlatforms(saved, platformKeys) {
  if (!Array.isArray(saved?.enabledPlatforms)) return [...platformKeys];
  const order = saved.platformOrder;
  const legacy = Array.isArray(order) && LEGACY_PLATFORMS.every((key) => order.includes(key));
  const added = legacy ? platformKeys.filter((key) => !order.includes(key)) : [];
  return [...new Set([...saved.enabledPlatforms, ...added].filter((key) => platformKeys.includes(key)))];
}

function normalizeLiveNotifications(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const interval = Number(source.intervalMinutes);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_LIVE_NOTIFICATIONS.enabled,
    intervalMinutes: LIVE_CHECK_INTERVALS.includes(interval) ? interval : DEFAULT_LIVE_NOTIFICATIONS.intervalMinutes,
  };
}
const DEFAULT_TRACKED_CHANNELS = Object.freeze({
  youtube: Object.freeze(["@IShowSpeed", "@KaiCenat"]),
  twitch: Object.freeze(["kaicenat"]),
  kick: Object.freeze([]),
});

function channelPath(value, hostPattern) {
  if (!/^(?:https?:\/\/)?(?:[\w-]+\.)*[\w-]+\.[a-z]{2,}\//i.test(value)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return hostPattern.test(url.hostname) ? url.pathname.split("/").filter(Boolean).map(decodeURIComponent) : [];
  } catch {
    return [];
  }
}

// 接受 @handle、handle、UC 开头的频道 ID，以及 youtube.com/@handle、/channel/UC... 链接。
function normalizeYouTubeChannel(value) {
  let text = typeof value === "string" ? value.trim() : "";
  const path = channelPath(text, /(^|\.)youtube\.com$/i);
  if (path) text = path[0] === "channel" ? path[1] || "" : path[0]?.startsWith("@") ? path[0] : "";
  if (/^UC[\w-]{22}$/.test(text)) return text;
  const handle = text.startsWith("@") ? text.slice(1) : text;
  return /^[\p{L}\p{N}._-]{3,30}$/u.test(handle) ? `@${handle}` : "";
}

// Twitch 登录名不区分大小写，统一为小写，与关注列表的 login 对齐。
function normalizeTwitchChannel(value) {
  let text = typeof value === "string" ? value.trim() : "";
  const path = channelPath(text, /(^|\.)twitch\.tv$/i);
  if (path) text = path[0] || "";
  return /^\w{3,25}$/.test(text) ? text.toLowerCase() : "";
}

// Kick 频道名不区分大小写，统一为小写；接受频道名或 kick.com/频道名 链接。
function normalizeKickChannel(value) {
  let text = typeof value === "string" ? value.trim() : "";
  const path = channelPath(text, /(^|\.)kick\.com$/i);
  if (path) text = path[0] || "";
  return /^[\w-]{3,40}$/.test(text) ? text.toLowerCase() : "";
}

function uniqueChannels(list, normalize) {
  const seen = new Set();
  const channels = [];
  for (const item of Array.isArray(list) ? list : []) {
    const channel = normalize(item);
    const key = channel.toLowerCase();
    if (!channel || seen.has(key) || channels.length >= TRACKED_CHANNEL_LIMIT) continue;
    seen.add(key);
    channels.push(channel);
  }
  return channels;
}

// 尚未保存过追踪频道时使用默认频道；保存过的空列表保持为空，旧版本没保存过的平台也为空。
function normalizeTrackedChannels(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : DEFAULT_TRACKED_CHANNELS;
  return {
    youtube: uniqueChannels(source.youtube, normalizeYouTubeChannel),
    twitch: uniqueChannels(source.twitch, normalizeTwitchChannel),
    kick: uniqueChannels(source.kick, normalizeKickChannel),
  };
}

// 设置页文本框：每行或逗号分隔一个频道，返回可识别的频道与无法识别的原文。
function parseTrackedChannelText(text, normalize) {
  const entries = String(text ?? "").split(/[\s,，、]+/).filter(Boolean);
  return {
    channels: uniqueChannels(entries, normalize),
    invalid: entries.filter((entry) => !normalize(entry)),
  };
}
