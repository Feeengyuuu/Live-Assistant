// EricWang fork of Licardo's Live-Assistant. Modified 2026-10-05; see NOTICE.md and LICENSE (GPLv3).
// Popup 主逻辑：
// - 从 background 拉取 5 个平台的关注列表并渲染
// - 缓存 + 收藏 + 平台启用/排序 + 悬浮按钮等用户设置
//
// 设计要点：
// - 所有用户/远端数据通过 DOM API (textContent / setAttribute) 注入，避免 innerHTML 拼接
// - #content 容器上用事件委托处理卡片/收藏/登录按钮点击，避免每次渲染重绑
// - 收藏键为 `${platform}:${url}`（兼容旧的纯 name 键）
// - 收藏切换不重新拉取数据，稳定复用卡片并立即排序

const DEFAULT_AVATAR =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiNlMGUwZTAiLz4KPGNpcmNsZSBjeD0iMTYiIGN5PSIxMiIgcj0iNSIgZmlsbD0iIzk5OTk5OSIvPgo8cGF0aCBkPSJNNiAyNmMwLTUuNSA0LjUtMTAgMTAtMTBzMTAgNC41IDEwIDEwIiBmaWxsPSIjOTk5OTk5Ii8+Cjwvc3ZnPg==";

const ARROW_UP_SVG =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M7 14l5-5 5 5z"/></svg>';
const ARROW_DOWN_SVG =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M7 10l5 5 5-5z"/></svg>';

const CACHE_TTL_MS = 60_000;
const LIVE_HISTORY_LIMIT = 1000;
const LIVE_HISTORY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

class LiveAssistant {
  constructor() {
    this.platforms = {
      douyu: { name: "斗鱼", icon: "https://www.douyu.com/favicon.ico", loginUrl: "https://www.douyu.com" },
      huya: { name: "虎牙", icon: "https://www.huya.com/favicon.ico", loginUrl: "https://www.huya.com" },
      bilibili: { name: "B站", icon: "https://www.bilibili.com/favicon.ico", loginUrl: "https://www.bilibili.com" },
      douyin: { name: "抖音", icon: "https://www.douyin.com/favicon.ico", loginUrl: "https://www.douyin.com" },
      twitch: { name: "Twitch", icon: "https://www.twitch.tv/favicon.ico", loginUrl: "https://www.twitch.tv" },
    };
    this.platformOrder = Object.keys(this.platforms);
    this.enabledPlatforms = [...this.platformOrder];
    this.floatingButtonsVisible = true;
    this.floatingButtonsCollapsed = false;
    this.favoriteStreamers = new Set();
    this.lastLiveHistory = {};
    this.platformState = {};
    this.cards = new Map();
    this.offlineCards = new Map();
    this.offlineExpanded = false;
    this.notices = new Map();
    this.requestGeneration = 0;
    this.activeRefresh = null;
    this.settingsOpen = false;
    this.settingsDragBound = false;
    this.floatingButtonsSignature = "";
    this.pendingStorage = null;
    this.storageDrain = null;
    this.storageErrorCount = 0;
    this.renderFrame = null;
    this.renderPending = false;
    this.thumbnailRequests = new Map();
    this.offlineRequests = new Map();
    this.ready = this.init();
  }

  async init() {
    await this.loadCachedData();
    this.bindEvents();
    this.renderStreamers();
    const stale = this.getEnabledPlatformKeys().filter((key) => !this.isPlatformFresh(key));
    if (stale.length) this.refreshPlatforms(stale);
    else {
      this.refreshVisibleThumbnails();
      this.refreshVisibleOfflineFollowers();
    }
  }

  bindEvents() {
    document.getElementById("refreshBtn").addEventListener("click", () => this.refreshInBackground());
    document.getElementById("settingsBtn").addEventListener("click", () => this.toggleSettings());
    document.getElementById("applySettingsBtn").addEventListener("click", () => this.applySettings());
    document.getElementById("resetSettingsBtn").addEventListener("click", () => this.resetSettings());
    document.getElementById("cancelSettingsBtn").addEventListener("click", () => this.toggleSettings());
    document.getElementById("settingsPanel").addEventListener("change", () => this.updateSettingsDraft());
    document.getElementById("content").addEventListener("click", (event) => this.handleContentClick(event));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
        this.renderFrame = null;
        clearTimeout(this.messageTimer);
        document.getElementById("messageContainer").style.display = "none";
      } else {
        // No background polling or hidden-page animation work.
        this.scheduleRender();
      }
    });
  }

  handleContentClick(event) {
    const favorite = event.target.closest(".favorite-button");
    if (favorite) {
      event.preventDefault();
      this.handleFavoriteClick(favorite);
      return;
    }
    const login = event.target.closest(".login-btn");
    if (login) {
      this.openUrl(login.dataset.url);
      return;
    }
    const link = event.target.closest(".streamer-link, .offline-link");
    if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault();
      this.openUrl(link.href);
    }
  }

  safeUrl(url) {
    if (typeof url !== "string") return "";
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
    } catch {
      return "";
    }
  }

  openUrl(url) {
    const safe = this.safeUrl(url);
    if (safe) chrome.tabs.create({ url: safe });
  }

  emptyPlatformState(key) {
    return { status: "idle", data: [], hasSnapshot: false, fetchedAt: 0, lastAttemptAt: 0,
      offlineData: [], offlineSupported: false, offlineCoverage: "unknown", offlineStatus: "idle", offlineError: "",
      offlineHasSnapshot: false, offlineFetchedAt: 0,
      loginUrl: this.platforms[key].loginUrl, error: "" };
  }

  normalizePlatformOrder(order) {
    const valid = Array.isArray(order) ? [...new Set(order.filter((key) => this.platforms[key]))] : [];
    return [...valid, ...Object.keys(this.platforms).filter((key) => !valid.includes(key))];
  }

  getEnabledPlatformKeys() {
    return this.platformOrder.filter((key) => this.enabledPlatforms.includes(key));
  }

  isPlatformFresh(key) {
    const state = this.platformState[key];
    const age = Date.now() - (state?.fetchedAt || 0);
    return state?.status === "ok" && state.hasSnapshot && age >= 0 && age < CACHE_TTL_MS;
  }

  hasFreshCache() {
    return this.getEnabledPlatformKeys().every((key) => this.isPlatformFresh(key));
  }

  async loadCachedData() {
    let saved = {};
    try {
      saved = await chrome.storage.local.get([
        "platformCacheVersion", "platformCache", "cachedStreamers", "cachedTimestamp", "favoriteStreamers", "lastLiveHistory",
        "platformOrder", "enabledPlatforms", "floatingButtonsVisible", "floatingButtonsCollapsed",
      ]);
    } catch (error) {
      console.warn("读取本地设置失败", error);
    }
    this.lastLiveHistory = this.normalizeLiveHistory(saved.lastLiveHistory);
    this.platformOrder = this.normalizePlatformOrder(saved.platformOrder);
    if (Array.isArray(saved.enabledPlatforms)) {
      this.enabledPlatforms = [...new Set(saved.enabledPlatforms.filter((key) => this.platforms[key]))];
    }
    if (Array.isArray(saved.favoriteStreamers)) {
      this.favoriteStreamers = new Set(saved.favoriteStreamers.filter((key) => typeof key === "string"));
    }
    if (typeof saved.floatingButtonsVisible === "boolean") this.floatingButtonsVisible = saved.floatingButtonsVisible;
    if (typeof saved.floatingButtonsCollapsed === "boolean") this.floatingButtonsCollapsed = saved.floatingButtonsCollapsed;
    for (const key of Object.keys(this.platforms)) {
      const state = this.emptyPlatformState(key);
      const cached = saved.platformCacheVersion === 2 ? saved.platformCache?.[key] : null;
      if (cached?.status === "auth_required") {
        state.status = "auth_required";
        this.clearPlatformLiveHistory(key);
      } else if (cached && Array.isArray(cached.data)) {
        state.data = this.normalizeStreamers(key, cached.data);
        state.hasSnapshot = cached.hasSnapshot !== false;
        state.fetchedAt = this.validTimestamp(cached.fetchedAt);
        state.status = ["ok", "error", "partial"].includes(cached.lastAttemptStatus) ? cached.lastAttemptStatus : "idle";
        state.error = typeof cached.error === "string" ? cached.error : "";
        state.lastAttemptAt = this.validTimestamp(cached.lastAttemptAt);
        state.offlineSupported = cached.offlineSupported === true;
        state.offlineCoverage = ["complete", "partial", "pending", "unsupported"].includes(cached.offlineCoverage) ? cached.offlineCoverage : "unknown";
        state.offlineData = this.normalizeOfflineStreamers(key, cached.offlineData, state.data);
        state.offlineHasSnapshot = cached.offlineHasSnapshot === true;
        state.offlineFetchedAt = this.validTimestamp(cached.offlineFetchedAt);
        state.offlineStatus = ["ok", "partial", "error", "auth_required"].includes(cached.offlineStatus) ? cached.offlineStatus : "idle";
        state.offlineError = typeof cached.offlineError === "string" ? cached.offlineError : "";
        // Old snapshots know nothing about offline coverage; keep their cards and upgrade immediately.
        if (state.offlineCoverage === "unknown" && state.status === "ok") state.status = "idle";
      } else {
        // Previous versions cached failures as successes. Keep their cards, but revalidate immediately.
        const legacy = saved.cachedStreamers?.[key];
        if (legacy?.isLoggedIn !== false && Array.isArray(legacy?.data)) {
          state.data = this.normalizeStreamers(key, legacy.data);
          state.hasSnapshot = true;
        }
      }
      this.platformState[key] = state;
    }
  }

  validTimestamp(value) {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 && time <= Date.now() + 1000 ? time : 0;
  }

  normalizeStreamers(key, data) {
    const seen = new Set();
    return data.filter((entry) => entry && typeof entry === "object").map((entry) => ({
      ...entry, platform: key, platformKey: key, platformInfo: this.platforms[key],
      name: String(entry.name || "未命名主播"), url: this.safeUrl(entry.url),
      thumbnailFallback: entry.thumbnailFallback || (entry.thumbnailKind === "live" ? "" : entry.thumbnail),
      thumbnailFetchedAt: this.validTimestamp(entry.thumbnailFetchedAt),
    })).filter((entry) => {
      const id = this.getStreamerId(entry);
      if (!entry.url || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  getRoomIdentity(streamer) {
    // Room identity is shared across live and offline lists, even if a provider varies its URL.
    return `${streamer.platform}:${streamer.roomId || streamer.url}`;
  }

  normalizeOfflineStreamers(platform, data, liveData = []) {
    if (!Array.isArray(data)) return [];
    const liveIds = new Set(liveData.filter((entry) => entry.isLive).map((entry) => this.getRoomIdentity(entry)));
    const seen = new Set();
    return this.normalizeStreamers(platform, data).filter((entry) => {
      if (entry.isLive !== false) return false;
      const identity = this.getRoomIdentity(entry);
      if (seen.has(identity) || liveIds.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }

  applyOfflineResult(platform, next, previous, result) {
    if (next.status === "auth_required") {
      next.offlineData = [];
      next.offlineHasSnapshot = false;
      next.offlineFetchedAt = 0;
      next.offlineCoverage = "unknown";
      next.offlineSupported = false;
      next.offlineStatus = "auth_required";
      next.offlineError = "";
      return;
    }
    if (next.status === "error" || (next.status === "partial" && previous.hasSnapshot)) return;
    const coverage = ["complete", "partial", "pending", "unsupported"].includes(result?.offlineCoverage) ? result.offlineCoverage : "unknown";
    next.offlineSupported = result?.offlineSupported === true;
    next.offlineCoverage = coverage;
    next.offlineError = typeof result?.offlineError === "string" ? result.offlineError : "";
    if (coverage === "pending") {
      // Bilibili's independent follow-list lookup must not delay or clear its live results.
      next.offlineData = this.normalizeOfflineStreamers(platform, previous.offlineData, next.data);
      next.offlineCoverage = previous.offlineHasSnapshot ? previous.offlineCoverage : "pending";
      next.offlineStatus = previous.offlineStatus === "auth_required" ? "idle" : previous.offlineStatus;
    } else if (next.status === "ok" && coverage === "complete" && Array.isArray(result.offlineData)) {
      next.offlineData = this.normalizeOfflineStreamers(platform, result.offlineData, next.data);
      next.offlineHasSnapshot = true;
      next.offlineFetchedAt = this.validTimestamp(result.offlineFetchedAt) || next.fetchedAt;
      next.offlineStatus = "ok";
    } else if (coverage === "partial" || coverage === "complete" || coverage === "unknown") {
      const available = previous.offlineHasSnapshot ? previous.offlineData : result.offlineData;
      next.offlineData = this.normalizeOfflineStreamers(platform, available, next.data);
      next.offlineHasSnapshot = previous.offlineHasSnapshot;
      next.offlineFetchedAt = previous.offlineFetchedAt;
      next.offlineStatus = coverage === "partial" ? "partial" : coverage === "complete" ? "error" : "idle";
      if (coverage === "complete") next.offlineCoverage = "partial";
    } else {
      // Lack of a supported list is not evidence that everybody else is offline.
      next.offlineData = [];
      next.offlineHasSnapshot = false;
      next.offlineFetchedAt = 0;
      next.offlineStatus = "idle";
      if (coverage === "complete") next.offlineCoverage = "partial";
    }
  }

  refreshVisibleOfflineFollowers() {
    if (!this.offlineExpanded) return;
    for (const platform of this.getEnabledPlatformKeys()) this.refreshOfflineFollowers(platform);
  }

  refreshOfflineFollowers(platform, generation = this.requestGeneration, { force = false } = {}) {
    if (!this.offlineExpanded) return;
    const state = this.platformState[platform];
    if (platform !== "bilibili" || !state?.hasSnapshot || state.status === "auth_required" || !state.offlineSupported) return;
    const age = Date.now() - state.offlineFetchedAt;
    if (!force && state.offlineStatus === "ok" && state.offlineCoverage === "complete" && age >= 0 && age < CACHE_TTL_MS) return;
    const requestKey = `${generation}:${platform}`;
    if (this.offlineRequests.has(requestKey)) return;
    this.offlineRequests.set(requestKey, true);
    state.offlineBeforeLoading = state.offlineStatus;
    state.offlineStatus = "loading";
    state.offlineError = "";
    this.scheduleRender();
    let completed = false;
    const complete = (response) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      this.offlineRequests.delete(requestKey);
      if (generation !== this.requestGeneration || !this.enabledPlatforms.includes(platform)) return;
      const current = this.platformState[platform];
      if (!current?.hasSnapshot || current.status === "auth_required") return;
      const next = { ...current, offlineError: typeof response?.error === "string" ? response.error : "" };
      const status = response?.offlineStatus || response?.status || "error";
      if (status === "ok" && response?.offlineCoverage === "complete" && Array.isArray(response.offlineData)) {
        next.offlineData = this.normalizeOfflineStreamers(platform, response.offlineData, current.data);
        next.offlineHasSnapshot = true;
        next.offlineCoverage = "complete";
        next.offlineStatus = "ok";
        next.offlineFetchedAt = this.validTimestamp(response.offlineFetchedAt || response.fetchedAt) || Date.now();
      } else if (status === "auth_required") {
        // This endpoint may need authentication independently of the working live endpoint.
        next.offlineData = [];
        next.offlineHasSnapshot = false;
        next.offlineFetchedAt = 0;
        next.offlineCoverage = "partial";
        next.offlineStatus = "auth_required";
      } else {
        next.offlineStatus = status === "partial" ? "partial" : "error";
        next.offlineCoverage = "partial";
        if (!current.offlineHasSnapshot) {
          next.offlineData = status === "partial" ? this.normalizeOfflineStreamers(platform, response?.offlineData, current.data) : [];
        }
      }
      delete next.offlineBeforeLoading;
      this.platformState[platform] = next;
      this.persistCache();
      this.scheduleRender();
    };
    const timeout = setTimeout(() => complete({ status: "error", error: "未开播名单暂时无法更新" }), 20_000);
    try {
      chrome.runtime.sendMessage({ action: "getOfflineFollowedStreamers", platform }, (response) => {
        const error = chrome.runtime.lastError;
        complete(error ? null : response);
      });
    } catch { complete(null); }
  }

  getPlatformData(platform) {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (response) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(response);
      };
      // Bound a disconnected extension message channel as well as network requests in the worker.
      const timeout = setTimeout(() => finish({ status: "error", error: "请求超时，请稍后重试" }), 45_000);
      try {
        chrome.runtime.sendMessage({ action: "getFollowedStreamers", platform }, (response) => {
          const error = chrome.runtime.lastError;
          if (error || !response) {
            finish({ status: "error", error: "连接暂时中断，请重新刷新" });
            return;
          }
          finish(response);
        });
      } catch {
        finish({ status: "error", error: "连接暂时中断，请重新刷新" });
      }
    });
  }

  invalidateRefresh() {
    this.requestGeneration += 1;
    this.activeRefresh = null;
    for (const state of Object.values(this.platformState)) {
      if (state.status === "loading") state.status = state.beforeLoading || "idle";
      if (state.offlineStatus === "loading") state.offlineStatus = state.offlineBeforeLoading || "idle";
    }
    this.resetRefreshButton();
  }

  refreshPlatforms(platforms = this.getEnabledPlatformKeys(), options = {}) {
    const keys = [...new Set(platforms)].filter((key) => this.platforms[key] && this.enabledPlatforms.includes(key));
    const scope = [...keys].sort().join(",");
    if (this.activeRefresh?.scope === scope) {
      this.activeRefresh.forceOffline ||= options.forceOffline === true;
      return this.activeRefresh.promise;
    }
    this.invalidateRefresh();
    if (!keys.length) {
      this.scheduleRender();
      return Promise.resolve();
    }
    const generation = this.requestGeneration;
    for (const key of keys) {
      const state = this.platformState[key] || (this.platformState[key] = this.emptyPlatformState(key));
      state.beforeLoading = state.status;
      state.status = "loading";
    }
    this.showRefreshLoading();
    this.scheduleRender();
    this.refreshVisibleThumbnails();
    for (const key of this.getEnabledPlatformKeys()) {
      if (!keys.includes(key)) this.refreshOfflineFollowers(key, generation, { force: options.forceOffline === true });
    }
    const promise = Promise.all(keys.map(async (key) => {
      const result = await this.getPlatformData(key);
      if (generation !== this.requestGeneration || !this.enabledPlatforms.includes(key)) return;
      this.applyPlatformResult(key, result);
      this.persistCache();
      this.scheduleRender();
      if (this.platformState[key].status === "ok") {
        this.refreshLiveThumbnails(key, generation);
        this.refreshOfflineFollowers(key, generation, { force: options.forceOffline === true || this.activeRefresh?.forceOffline === true });
      }
    })).finally(() => {
      if (generation !== this.requestGeneration) return;
      this.activeRefresh = null;
      this.resetRefreshButton();
      this.scheduleRender();
    });
    this.activeRefresh = { scope, generation, promise, forceOffline: options.forceOffline === true };
    return promise;
  }

  refreshVisibleThumbnails() {
    for (const key of this.getEnabledPlatformKeys()) this.refreshLiveThumbnails(key, this.requestGeneration);
  }

  refreshLiveThumbnails(platform, generation = this.requestGeneration) {
    if (platform !== "douyu" && platform !== "bilibili") return;
    const state = this.platformState[platform];
    if (!state?.hasSnapshot || state.status === "auth_required") return;
    const now = Date.now();
    const ids = [...new Set(state.data.filter((entry) => entry.isLive && /^\d+$/.test(String(entry.roomId)) &&
      (!entry.thumbnailFetchedAt || now - entry.thumbnailFetchedAt >= CACHE_TTL_MS))
      .map((entry) => String(entry.roomId)))];
    for (let start = 0; start < ids.length; start += 50) {
      const roomIds = ids.slice(start, start + 50);
      const requestKey = `${generation}:${platform}:${roomIds.join(",")}`;
      if (this.thumbnailRequests.has(requestKey)) continue;
      this.thumbnailRequests.set(requestKey, true);
      let completed = false;
      const complete = (response) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        this.thumbnailRequests.delete(requestKey);
        if (generation !== this.requestGeneration || !this.enabledPlatforms.includes(platform)) return;
        const current = this.platformState[platform];
        if (!response?.success || !current?.hasSnapshot || current.status === "auth_required") return;
        let changed = false;
        for (const entry of current.data) {
          const roomId = String(entry.roomId);
          if (!entry.isLive || !roomIds.includes(roomId)) continue;
          const preview = response.thumbnails?.[roomId];
          const source = this.safeUrl(preview?.thumbnail);
          if (!source || preview.thumbnailKind !== "live") continue;
          const fetchedAt = this.validTimestamp(preview.thumbnailFetchedAt);
          if (!fetchedAt || fetchedAt < (entry.thumbnailFetchedAt || 0)) continue;
          entry.thumbnailFallback ||= entry.thumbnailKind === "live" ? "" : entry.thumbnail;
          entry.thumbnail = source;
          entry.thumbnailKind = "live";
          entry.thumbnailFetchedAt = fetchedAt;
          changed = true;
        }
        if (changed) {
          this.persistCache();
          this.scheduleRender();
        }
      };
      const timeout = setTimeout(() => complete(null), 35_000);
      try {
        chrome.runtime.sendMessage({ action: "getLiveThumbnails", platform, roomIds }, (response) => {
          const error = chrome.runtime.lastError;
          complete(error ? null : response);
        });
      } catch { complete(null); }
    }
  }

  applyPlatformResult(key, result) {
    const previous = this.platformState[key] || this.emptyPlatformState(key);
    let status = result?.status;
    // Be conservative if an older worker answers while the extension is being reloaded.
    if (!["ok", "auth_required", "error", "partial"].includes(status)) {
      status = result?.isLoggedIn === false ? "auth_required" : result?.success === true ? "ok" : "error";
    }
    if ((status === "ok" || status === "partial") && !Array.isArray(result.data)) status = "error";
    const next = { ...previous, status, lastAttemptAt: Date.now(), error: "",
      loginUrl: this.safeUrl(result?.loginUrl) || this.platforms[key].loginUrl };
    if (status === "ok") {
      next.fetchedAt = this.validTimestamp(result.fetchedAt) || Date.now();
      const previousById = new Map(previous.data.map((entry) => [this.getStreamerId(entry), entry]));
      next.data = this.normalizeStreamers(key, result.data).map((entry) => {
        if (entry.thumbnailKind === "live" && this.safeUrl(entry.thumbnail)) {
          // The follow API may already contain a genuine keyframe; avoid a duplicate room lookup.
          entry.thumbnailFetchedAt ||= next.fetchedAt;
        } else {
          const old = previousById.get(this.getStreamerId(entry));
          if (entry.isLive && old?.thumbnailKind === "live" && this.safeUrl(old.thumbnail)) {
            // Keep the last live frame while renewing it instead of flashing back to a promo cover.
            entry.thumbnailFallback ||= entry.thumbnail;
            entry.thumbnail = old.thumbnail;
            entry.thumbnailKind = "live";
            entry.thumbnailFetchedAt = old.thumbnailFetchedAt || 0;
          }
        }
        return entry;
      });
      next.hasSnapshot = true;
      this.recordLiveHistory(next.data, next.fetchedAt);
    } else if (status === "auth_required") {
      // Revoked authentication must not leave old private follow-list data on screen or disk.
      next.data = [];
      next.hasSnapshot = false;
      next.fetchedAt = 0;
      this.clearPlatformLiveHistory(key);
    } else {
      next.error = typeof result?.error === "string" ? result.error : "暂时无法获取，请稍后重试";
      if (!previous.hasSnapshot) next.data = status === "partial" ? this.normalizeStreamers(key, result.data) : [];
    }
    this.applyOfflineResult(key, next, previous, result);
    delete next.beforeLoading;
    this.platformState[key] = next;
  }

  persistCache() {
    const platformCache = {};
    for (const [key, state] of Object.entries(this.platformState)) {
      const lastAttemptStatus = state.status === "loading" ? state.beforeLoading : state.status;
      platformCache[key] = {
        status: lastAttemptStatus === "auth_required" ? "auth_required" : "ok",
        data: state.hasSnapshot ? state.data.map(({ platformInfo, ...entry }) => entry) : [],
        offlineData: state.offlineHasSnapshot ? state.offlineData.map(({ platformInfo, ...entry }) => entry) : [],
        offlineSupported: state.offlineSupported, offlineCoverage: state.offlineCoverage,
        offlineStatus: state.offlineStatus === "loading" ? state.offlineBeforeLoading : state.offlineStatus,
        offlineError: state.offlineError,
        offlineHasSnapshot: state.offlineHasSnapshot, offlineFetchedAt: state.offlineFetchedAt,
        hasSnapshot: state.hasSnapshot, fetchedAt: state.fetchedAt,
        lastAttemptStatus, lastAttemptAt: state.lastAttemptAt, error: state.error,
      };
    }
    // Clear legacy lists in the same serialized write, including data revoked by logout.
    return this.queueStorage({ platformCacheVersion: 2, platformCache, lastLiveHistory: { ...this.lastLiveHistory }, cachedStreamers: null, cachedTimestamp: 0 });
  }

  queueStorage(patch) {
    this.pendingStorage = { ...this.pendingStorage, ...patch };
    if (!this.storageDrain) {
      // Coalesce same-turn changes, then serialize writes so an old snapshot cannot win.
      this.storageDrain = Promise.resolve().then(async () => {
        while (this.pendingStorage) {
          const next = this.pendingStorage;
          this.pendingStorage = null;
          try {
            await chrome.storage.local.set(next);
          } catch (error) {
            this.storageErrorCount += 1;
            console.warn("保存本地数据失败", error);
            this.showMessage("保存失败，请重试");
          }
        }
      }).finally(() => {
        this.storageDrain = null;
        if (this.pendingStorage) this.queueStorage({});
      });
    }
    return this.storageDrain;
  }

  async flushStorage() {
    while (this.storageDrain) await this.storageDrain;
  }

  loadFollowedStreamers() { return this.refreshPlatforms(); }
  refreshInBackground() { return this.refreshPlatforms(undefined, { forceOffline: true }); }

  // Keep stable shell and keyed cards. Unchanged URLs never restart image requests.
  ensureRenderShell() {
    if (this.streamerList) return;
    const content = document.getElementById("content");
    this.noticeContainer = this.el("div", { class: "platform-notices", "aria-live": "polite" });
    this.streamerContainer = this.el("div", { class: "all-streamers-container" });
    const title = this.el("div", { class: "section-title" });
    title.appendChild(this.el("span", {}, "正在直播"));
    this.liveCount = this.el("span", { class: "live-count" });
    title.appendChild(this.liveCount);
    this.streamerList = this.el("ul", { class: "streamer-list", "aria-label": "正在直播的关注主播" });
    this.streamerContainer.append(title, this.streamerList);
    this.emptyNotice = this.el("div", { class: "no-live", role: "status" });
    this.offlineSection = this.el("section", { class: "offline-section", "aria-labelledby": "offlineSectionTitle" });
    const offlineHeading = this.el("h2", { class: "offline-section-heading" });
    this.offlineToggle = this.el("button", { type: "button", class: "offline-toggle", "aria-expanded": "false", "aria-controls": "offlineBody" });
    this.offlineToggle.appendChild(this.el("span", { id: "offlineSectionTitle" }, "未开播"));
    const headingEnd = this.el("span", { class: "offline-heading-end" });
    this.offlineCount = this.el("span", { class: "offline-count" });
    headingEnd.append(this.offlineCount, this.el("span", { class: "offline-chevron", "aria-hidden": "true" }, "›"));
    this.offlineToggle.appendChild(headingEnd);
    this.offlineToggle.addEventListener("click", () => this.setOfflineExpanded(this.offlineToggle.getAttribute("aria-expanded") !== "true"));
    offlineHeading.appendChild(this.offlineToggle);
    this.offlineBody = this.el("div", { id: "offlineBody", hidden: "" });
    this.offlineCoverageNotice = this.el("p", { class: "offline-coverage" });
    this.offlineList = this.el("ul", { class: "offline-list", "aria-label": "未开播的关注主播" });
    this.offlineEmpty = this.el("div", { class: "offline-empty", role: "status" });
    this.offlineBody.append(this.offlineCoverageNotice, this.offlineList, this.offlineEmpty);
    this.offlineSection.append(offlineHeading, this.offlineBody);
    content.replaceChildren(this.noticeContainer, this.streamerContainer, this.emptyNotice, this.offlineSection, this.buildFooter());
    this.displayVersion();
  }

  scheduleRender() {
    this.renderPending = true;
    if (document.hidden || this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.renderStreamers();
    });
  }

  renderStreamers() {
    this.renderPending = false;
    this.renderDateKey = new Date().toDateString();
    this.ensureRenderShell();
    const content = document.getElementById("content");
    const scrollTop = content.scrollTop;
    const focused = content.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.closest("[data-streamer-id]")?.dataset.streamerId;
    const focusedFavorite = focused?.classList.contains("favorite-button");
    const live = [];
    const offline = [];
    const enabled = this.getEnabledPlatformKeys();
    const noticeOrder = [];
    let loading = false;
    let incomplete = false;
    for (const key of enabled) {
      const state = this.platformState[key] || this.emptyPlatformState(key);
      loading ||= state.status === "loading";
      incomplete ||= state.status !== "ok";
      if (state.status !== "auth_required") {
        live.push(...state.data.filter((entry) => entry.isLive));
        if (this.offlineExpanded) offline.push(...(state.offlineData || []));
      }
      const notice = this.updatePlatformNotice(key, state);
      if (notice) noticeOrder.push(notice);
    }
    this.reconcileChildren(this.noticeContainer, noticeOrder);
    const sorted = this.sortFavoritesFirst(live);
    const wanted = new Set();
    const order = [];
    for (const streamer of sorted) {
      const id = this.getStreamerId(streamer);
      wanted.add(id);
      let card = this.cards.get(id);
      if (!card) {
        card = this.buildStreamerCard(streamer);
        this.cards.set(id, card);
      }
      this.patchStreamerCard(card, streamer);
      order.push(card);
    }
    this.reconcileChildren(this.streamerList, order);
    for (const id of this.cards.keys()) if (!wanted.has(id)) this.cards.delete(id);
    this.setText(this.liveCount, `${sorted.length} 位主播`);
    this.setHidden(this.streamerContainer, !sorted.length);
    this.setHidden(this.emptyNotice, sorted.length > 0);
    this.setText(this.emptyNotice, !enabled.length ? "请在设置中启用要查看的平台" : loading ? "正在加载关注列表…" : incomplete ? "暂时没有可显示的直播，请查看上方平台状态" : "暂无正在直播的主播");
    this.setAttribute(this.streamerList, "aria-busy", String(loading));
    this.renderOfflineStreamers(offline, live, enabled, loading);
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    else if (focusedId && !focused?.isConnected) {
      const replacement = this.cards.get(focusedId) || this.offlineCards.get(focusedId);
      const target = replacement?.querySelector(focusedFavorite ? ".favorite-button" : ".streamer-link, .offline-link");
      if (target && !this.offlineBody.hidden) target.focus({ preventScroll: true });
      else if (target && replacement.classList.contains("streamer-item")) target.focus({ preventScroll: true });
    }
    content.scrollTop = scrollTop;
    this.updateFloatingButtons();
  }

  parseLiveTimestamp(value) {
    if ((typeof value !== "number" && typeof value !== "string") || value === "") return 0;
    const numeric = Number(value);
    const time = Number.isFinite(numeric) ? (numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : Date.parse(value);
    return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1) && time <= Date.now() ? time : 0;
  }

  platformLastLive(streamer) {
    if (["platform_start", "platform_record"].includes(streamer.lastLiveSource)) {
      const time = this.parseLiveTimestamp(streamer.lastLiveAt);
      if (time) return { time, source: streamer.lastLiveSource };
    }
    return null;
  }

  normalizeLiveHistory(history) {
    const cutoff = Date.now() - LIVE_HISTORY_RETENTION_MS;
    const entries = Object.entries(history && typeof history === "object" && !Array.isArray(history) ? history : {})
      .filter(([id, record]) => record && this.platforms[record.platform] && id.startsWith(`${record.platform}:`) &&
        this.validTimestamp(record.observedLiveAt) >= cutoff)
      .sort((a, b) => b[1].observedLiveAt - a[1].observedLiveAt)
      .slice(0, LIVE_HISTORY_LIMIT)
      .map(([id, record]) => {
        const value = { platform: record.platform, observedLiveAt: this.validTimestamp(record.observedLiveAt) };
        const explicit = this.platformLastLive(record);
        if (explicit) { value.lastLiveAt = explicit.time; value.lastLiveSource = explicit.source; }
        return [id, value];
      });
    return Object.fromEntries(entries);
  }

  recordLiveHistory(streamers, fetchedAt) {
    for (const streamer of streamers) {
      if (!streamer.isLive) continue;
      const id = this.getStreamerId(streamer);
      const previous = this.lastLiveHistory[id];
      const record = { platform: streamer.platform, observedLiveAt: Math.max(previous?.observedLiveAt || 0, fetchedAt) };
      let explicit = this.platformLastLive(streamer);
      // Twitch's documented stream.createdAt is a start timestamp; other adapters need explicit provenance.
      if (!explicit && streamer.platform === "twitch" && streamer.startTime) {
        const time = this.parseLiveTimestamp(streamer.startTime);
        if (time) explicit = { time, source: "platform_start" };
      }
      if (explicit) {
        record.lastLiveAt = explicit.time;
        record.lastLiveSource = explicit.source;
      }
      this.lastLiveHistory[id] = record;
    }
    this.lastLiveHistory = this.normalizeLiveHistory(this.lastLiveHistory);
  }

  clearPlatformLiveHistory(platform) {
    this.lastLiveHistory = Object.fromEntries(Object.entries(this.lastLiveHistory).filter(([id]) => !id.startsWith(`${platform}:`)));
  }

  describeLastLive(streamer) {
    let explicit = this.platformLastLive(streamer);
    const history = this.lastLiveHistory[this.getStreamerId(streamer)];
    if (!explicit && history) explicit = this.platformLastLive(history);
    const time = explicit?.time || history?.observedLiveAt;
    if (!time) return { text: "上次直播：暂无记录", title: "平台未提供记录，插件也尚未观察到这位主播开播" };
    const label = explicit ? explicit.source === "platform_start" ? "上次开播" : "上次直播" : "最近看到直播";
    const date = new Date(time);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    const day = time >= today.getTime() ? "今天" : time >= yesterday.getTime() ? "昨天" :
      date.toLocaleDateString("zh-CN", { ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}), month: "numeric", day: "numeric" });
    const fullTime = date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    return {
      text: `${label}：${day} ${clock}`,
      title: `${label}：${fullTime}（当地时间）${explicit ? "" : "；仅表示插件成功看到其直播的时间"}`,
    };
  }

  setOfflineExpanded(expanded) {
    this.offlineExpanded = Boolean(expanded);
    this.setAttribute(this.offlineToggle, "aria-expanded", String(this.offlineExpanded));
    this.setHidden(this.offlineBody, !this.offlineExpanded);
    // Render already-known rows first; supplementary requests are only made on explicit expansion.
    this.renderStreamers();
    if (this.offlineExpanded) this.refreshVisibleOfflineFollowers();
  }

  renderOfflineStreamers(streamers, live, enabled, loading) {
    this.setHidden(this.offlineSection, enabled.length === 0);
    if (!this.offlineExpanded) {
      this.setText(this.offlineCount, "展开查看未开播主播");
      // Hidden rows can be reused on expansion, but revoked or disabled platform data must leave the DOM.
      for (const [id, row] of this.offlineCards) {
        const platform = row.dataset.platform;
        const state = this.platformState[platform];
        if (!enabled.includes(platform) || state?.status === "auth_required" || state?.offlineStatus === "auth_required") {
          row.remove();
          this.offlineCards.delete(id);
        }
      }
      return;
    }
    const liveIds = new Set(live.map((entry) => this.getRoomIdentity(entry)));
    const seen = new Set();
    const sorted = this.sortFavoritesFirst(streamers.filter((entry) => {
      const identity = this.getRoomIdentity(entry);
      if (entry.isLive !== false || seen.has(identity) || liveIds.has(identity)) return false;
      seen.add(identity);
      return true;
    }));
    const wanted = new Set();
    const rows = sorted.map((streamer) => {
      const id = this.getStreamerId(streamer);
      wanted.add(id);
      let row = this.offlineCards.get(id);
      if (!row) {
        row = this.buildOfflineCard(streamer);
        this.offlineCards.set(id, row);
      }
      this.patchOfflineCard(row, streamer);
      return row;
    });
    this.reconcileChildren(this.offlineList, rows);
    for (const id of this.offlineCards.keys()) if (!wanted.has(id)) this.offlineCards.delete(id);
    const pendingCoverage = enabled.some((key) => {
      const state = this.platformState[key];
      return state?.offlineSupported && (!state.offlineHasSnapshot || ["pending", "partial"].includes(state.offlineCoverage));
    });
    this.setText(this.offlineCount, pendingCoverage ? `${sorted.length} 位已获取` : `${sorted.length} 位主播`);
    this.setHidden(this.offlineEmpty, sorted.length > 0);
    const offlineLoading = loading || enabled.some((key) => this.platformState[key]?.offlineStatus === "loading");
    this.setAttribute(this.offlineList, "aria-busy", String(offlineLoading));
    const missing = enabled.filter((key) => ["unknown", "unsupported"].includes(this.platformState[key]?.offlineCoverage || "unknown"));
    const outdated = enabled.filter((key) => {
      const state = this.platformState[key];
      return state?.offlineCoverage === "partial" || (state?.offlineData?.length > 0 && (state.status !== "ok" || state.offlineStatus === "loading"));
    });
    const hints = [];
    if (missing.length) hints.push(missing.length === enabled.length ? "当前平台暂未提供未开播名单" : "部分平台暂未提供未开播名单");
    if (outdated.length) hints.push("部分名单尚未更新完整");
    const offlineAuth = enabled.filter((key) => this.platformState[key]?.offlineStatus === "auth_required");
    if (offlineAuth.length) hints.push("请登录相应平台以更新未开播名单");
    this.setText(this.offlineCoverageNotice, hints.join("；"));
    this.setAttribute(this.offlineCoverageNotice, "title", [
      missing.length ? `暂无名单：${missing.map((key) => this.platforms[key].name).join("、")}` : "",
      outdated.length ? `等待完整更新：${outdated.map((key) => this.platforms[key].name).join("、")}` : "",
    ].filter(Boolean).join("；"));
    this.setHidden(this.offlineCoverageNotice, hints.length === 0);
    const complete = enabled.length > 0 && enabled.every((key) => {
      const state = this.platformState[key];
      return state?.status === "ok" && state.offlineStatus === "ok" && state.offlineCoverage === "complete";
    });
    this.setText(this.offlineEmpty, offlineLoading ? "正在获取未开播名单…" : complete ? "暂无未开播的关注主播" : "暂无可显示的未开播主播");
  }

  buildOfflineCard(streamer) {
    const row = this.el("li", { class: "offline-item" });
    const link = this.el("a", { class: "offline-link", target: "_blank", rel: "noopener noreferrer" });
    const avatar = this.el("img", { class: "offline-avatar", alt: "", loading: "lazy", decoding: "async" });
    avatar.addEventListener("error", () => { if (avatar.src !== DEFAULT_AVATAR) avatar.src = DEFAULT_AVATAR; });
    const identity = this.el("span", { class: "offline-identity" });
    const name = this.el("span", { class: "offline-name" });
    const platform = this.el("span", { class: "offline-platform" });
    const icon = this.el("img", { class: "offline-platform-icon", alt: "" });
    const platformName = this.el("span");
    platform.append(icon, platformName);
    const lastLive = this.el("span", { class: "offline-last-live" });
    identity.append(name, platform, lastLive);
    link.append(avatar, identity);
    const favorite = this.el("button", { class: "favorite-button offline-favorite", type: "button" });
    row.append(link, favorite);
    row.parts = { link, avatar, name, icon, platformName, lastLive, favorite };
    return row;
  }

  patchOfflineCard(row, streamer) {
    const part = row.parts;
    this.setAttribute(row, "data-streamer-id", this.getStreamerId(streamer));
    this.setAttribute(row, "data-streamer-name", streamer.name);
    this.setAttribute(row, "data-platform", streamer.platform);
    this.setAttribute(row, "data-url", streamer.url);
    this.setAttribute(part.link, "href", streamer.url);
    this.setAttribute(part.link, "aria-label", `查看 ${streamer.platformInfo.name} ${streamer.name} 的主页，当前未开播`);
    this.patchImage(part.avatar, this.safeUrl(streamer.avatar) || DEFAULT_AVATAR);
    this.patchImage(part.icon, streamer.platformInfo.icon);
    this.setText(part.name, streamer.name);
    this.setAttribute(part.name, "title", streamer.name);
    this.setText(part.platformName, streamer.platformInfo.name);
    const history = this.lastLiveHistory[this.getStreamerId(streamer)];
    const timeSignature = `${streamer.lastLiveAt}:${streamer.lastLiveSource}:${history?.observedLiveAt}:${history?.lastLiveAt}:${history?.lastLiveSource}:${this.renderDateKey}`;
    if (part.lastLiveSignature !== timeSignature) {
      part.lastLiveSignature = timeSignature;
      const lastLive = this.describeLastLive(streamer);
      this.setText(part.lastLive, lastLive.text);
      this.setAttribute(part.lastLive, "title", lastLive.title);
    }
    const favorite = this.isFavorite(streamer);
    part.favorite.classList.toggle("favorited", favorite);
    this.setText(part.favorite, favorite ? "★" : "☆");
    this.setAttribute(part.favorite, "aria-pressed", String(favorite));
    this.setAttribute(part.favorite, "aria-label", `${favorite ? "取消收藏" : "收藏"} ${streamer.name}`);
  }

  reconcileChildren(parent, wanted) {
    const keep = new Set(wanted);
    for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
    let cursor = parent.firstElementChild;
    for (const node of wanted) {
      if (node === cursor) cursor = cursor.nextElementSibling;
      else parent.insertBefore(node, cursor);
    }
  }

  updatePlatformNotice(key, state) {
    const info = this.platforms[key];
    const oldSnapshot = state.hasSnapshot && !this.isPlatformFresh(key);
    let message = "";
    let kind = state.status;
    const savedTime = state.fetchedAt ? `，上次成功更新 ${new Date(state.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    if (state.status === "auth_required") message = `请先登录 ${info.name} 来获取关注列表`;
    else if (state.status === "loading") message = `${info.name}：更新中${state.hasSnapshot ? "，暂显示上次结果" : ""}…`;
    else if (state.status === "error") message = `${info.name}：刷新失败${state.hasSnapshot ? `，保留上次结果${savedTime}` : "，请稍后重试"}`;
    else if (state.status === "partial") message = `${info.name}：列表尚未完整获取${state.hasSnapshot ? `，保留上次完整结果${savedTime}` : "，当前仅显示已获取的部分"}`;
    else if (oldSnapshot || state.status === "idle") { kind = "stale"; message = `${info.name}：${state.hasSnapshot ? "显示上次结果，等待更新" : "等待加载"}`; }
    if (!message) return null;
    let notice = this.notices.get(key);
    if (!notice) {
      notice = this.el("div", { class: "platform-notice", "data-platform": key });
      notice.appendChild(this.el("span", { class: "platform-notice-text" }));
      const login = this.el("button", { class: "login-btn", type: "button" }, "前往登录");
      notice.appendChild(login);
      this.notices.set(key, notice);
    }
    this.setAttribute(notice, "data-status", kind);
    this.setAttribute(notice, "title", state.error || "");
    this.setText(notice.firstElementChild, message);
    const button = notice.querySelector("button");
    this.setHidden(button, state.status !== "auth_required");
    this.setAttribute(button, "data-url", state.loginUrl);
    this.setAttribute(button, "aria-label", `登录 ${info.name}`);
    return notice;
  }

  buildStreamerCard(streamer) {
    const card = this.el("li", { class: "streamer-item" });
    const link = this.el("a", { class: "streamer-link", target: "_blank", rel: "noopener noreferrer" });
    const thumbnail = this.el("img", { class: "streamer-thumbnail", alt: "", loading: "lazy", decoding: "async" });
    thumbnail.addEventListener("error", () => {
      const fallback = thumbnail.dataset.fallback;
      if (fallback && thumbnail.getAttribute("src") !== fallback) thumbnail.src = fallback;
      else thumbnail.style.visibility = "hidden";
    });
    link.appendChild(thumbnail);
    const badge = this.el("div", { class: "platform-badge" });
    badge.append(this.el("img", { class: "platform-badge-icon", alt: "" }), this.el("span", { class: "platform-badge-name" }));
    link.appendChild(badge);
    const content = this.el("div", { class: "streamer-content" });
    const avatar = this.el("img", { class: "streamer-avatar", alt: "", loading: "lazy", decoding: "async" });
    avatar.addEventListener("error", () => { if (avatar.src !== DEFAULT_AVATAR) avatar.src = DEFAULT_AVATAR; });
    const info = this.el("div", { class: "streamer-info" });
    const nameRow = this.el("div", { class: "streamer-name-row" });
    nameRow.append(this.el("div", { class: "streamer-name" }), this.el("div", { class: "live-duration" }));
    const stats = this.el("div", { class: "streamer-stats" });
    stats.append(this.el("span", { class: "stat-item viewer-stat" }), this.el("span", { class: "stat-item game-stat" }));
    info.append(nameRow, this.el("div", { class: "streamer-title" }), stats);
    content.append(avatar, info);
    link.appendChild(content);
    card.append(link, this.el("button", { class: "favorite-button", type: "button" }));
    card.parts = {
      link, thumbnail, avatar, badgeIcon: badge.firstElementChild, badgeName: badge.lastElementChild,
      name: nameRow.firstElementChild, duration: nameRow.lastElementChild,
      title: info.querySelector(".streamer-title"), viewers: stats.firstElementChild,
      game: stats.lastElementChild, favorite: card.lastElementChild,
    };
    return card;
  }

  patchStreamerCard(card, streamer) {
    const part = card.parts;
    this.setAttribute(card, "data-streamer-id", this.getStreamerId(streamer));
    this.setAttribute(card, "data-streamer-name", streamer.name);
    this.setAttribute(card, "data-platform", streamer.platform);
    this.setAttribute(card, "data-url", streamer.url);
    this.setAttribute(part.link, "href", streamer.url);
    this.setAttribute(part.link, "aria-label", `打开 ${streamer.platformInfo.name} ${streamer.name} 的直播间：${streamer.title || "直播中"}`);
    this.setAttribute(part.thumbnail, "data-fallback", this.safeUrl(streamer.thumbnailFallback));
    const thumbnailSource = this.safeUrl(streamer.thumbnail);
    const previewTime = String(streamer.thumbnailFetchedAt || 0);
    if (part.thumbnail.dataset.previewTime !== previewTime) {
      // A newly fetched preview may retry a previously failed image, while healthy images stay untouched.
      if (part.thumbnail.dataset.source === thumbnailSource &&
          (part.thumbnail.getAttribute("src") !== thumbnailSource || part.thumbnail.style.visibility === "hidden")) {
        delete part.thumbnail.dataset.source;
      }
      this.setAttribute(part.thumbnail, "data-preview-time", previewTime);
    }
    this.patchImage(part.thumbnail, thumbnailSource);
    this.patchImage(part.avatar, this.safeUrl(streamer.avatar) || DEFAULT_AVATAR);
    this.patchImage(part.badgeIcon, streamer.platformInfo.icon);
    this.setText(part.badgeName, streamer.platformInfo.name);
    this.setText(part.name, streamer.name);
    this.setAttribute(part.name, "title", streamer.name);
    const duration = this.calculateLiveDuration(streamer);
    this.setText(part.duration, duration);
    this.setHidden(part.duration, !duration);
    this.setText(part.title, streamer.title || "直播中...");
    this.setAttribute(part.title, "title", streamer.title || "直播中...");
    const heat = streamer.platform === "douyu" || streamer.platform === "huya";
    const viewers = streamer.platform === "douyin" ? String(streamer.viewers ?? "0") : this.formatNumber(streamer.viewers);
    this.setText(part.viewers, `${heat ? "🔥" : "👥"} ${viewers}`);
    this.setText(part.game, streamer.gameName || "");
    this.setHidden(part.game, !streamer.gameName);
    const favorite = this.isFavorite(streamer);
    part.favorite.classList.toggle("favorited", favorite);
    this.setText(part.favorite, favorite ? "★" : "☆");
    this.setAttribute(part.favorite, "aria-pressed", String(favorite));
    this.setAttribute(part.favorite, "aria-label", `${favorite ? "取消收藏" : "收藏"} ${streamer.name}`);
  }

  patchImage(image, source) {
    if (image.dataset.source === source) return;
    image.dataset.source = source;
    image.style.visibility = source ? "" : "hidden";
    if (source) image.src = source;
    else image.removeAttribute("src");
  }

  setHidden(node, value) {
    if (node.hidden !== value) node.hidden = value;
  }

  setText(node, value) {
    const text = String(value ?? "");
    if (node.textContent !== text) node.textContent = text;
  }

  setAttribute(node, key, value) {
    const text = String(value ?? "");
    if (node.getAttribute(key) !== text) node.setAttribute(key, text);
  }

  calculateLiveDuration(streamer) {
    const duration = Number(streamer.liveTime);
    if (Number.isFinite(duration) && duration > 0 && duration < 1_000_000_000) return this.formatDuration(duration);
    const rawStart = streamer.startTime || (duration >= 1_000_000_000 ? duration : null);
    if (!rawStart) return "";
    const numeric = Number(rawStart);
    const time = Number.isFinite(numeric) ? (numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : Date.parse(rawStart);
    const now = Date.now();
    if (!Number.isFinite(time) || time < Date.UTC(2000, 0, 1) || time > now) return "";
    return this.formatDuration((now - time) / 1000);
  }

  buildFooter() {
    const footer = this.el("footer", { class: "project-footer" });
    const credits = this.el("small");
    credits.appendChild(document.createTextNode("开发维护：EricWang · 原作："));
    credits.appendChild(this.el("a", {
      href: "https://github.com/L1cardo/Live-Assistant", target: "_blank", rel: "noopener noreferrer",
    }, "Licardo"));
    footer.appendChild(credits);

    const versionInfo = this.el("div", { class: "version-info" });
    versionInfo.appendChild(this.el("span", { id: "version", class: "version-number" }));

    const link = this.el("a", {
      href: "https://github.com/Feeengyuuu/Live-Assistant",
      target: "_blank",
      rel: "noopener noreferrer",
      class: "project-link",
    });
    link.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="project-icon">' +
      '<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.6.113.82-.268.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.807 1.305 3.492.998.107-.775.418-1.305.762-1.605-2.665-.305-5.466-1.335-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.123-.303-.535-1.523.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.241 2.873.118 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.805 5.625-5.475 5.92.42.362.81 1.098.81 2.222 0 1.605-.015 2.895-.015 3.285 0 .315.21.69.825.577C20.565 21.795 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>' +
      "</svg>" +
      "项目主页";
    versionInfo.appendChild(link);
    footer.appendChild(versionInfo);

    return footer;
  }

  displayVersion() {
    try {
      const manifest = chrome.runtime.getManifest();
      const el = document.getElementById("version");
      if (el) el.textContent = `版本: v${manifest.version}`;
    } catch (error) {
      console.error("获取版本号失败:", error);
    }
  }

  // Favorites are ordered immediately without network traffic.
  getStreamerId(streamer) { return `${streamer.platform}:${streamer.url}`; }
  isFavorite(streamer) { return this.favoriteStreamers.has(this.getStreamerId(streamer)) || this.favoriteStreamers.has(streamer.name); }

  handleFavoriteClick(button) {
    const card = button.closest("[data-streamer-id]");
    if (!card) return;
    const id = card.dataset.streamerId;
    const legacyName = card.dataset.streamerName;
    if (this.favoriteStreamers.has(id) || this.favoriteStreamers.has(legacyName)) {
      this.favoriteStreamers.delete(id);
      this.favoriteStreamers.delete(legacyName);
    } else this.favoriteStreamers.add(id);
    this.queueStorage({ favoriteStreamers: [...this.favoriteStreamers] });
    this.renderStreamers();
  }

  sortFavoritesFirst(streamers) {
    return streamers.slice().sort((a, b) => Number(this.isFavorite(b)) - Number(this.isFavorite(a)));
  }

  // ========== 悬浮按钮 ==========

  getFloatingButtonsSignature() {
    return JSON.stringify({
      order: this.platformOrder,
      enabled: this.enabledPlatforms,
      visible: this.floatingButtonsVisible,
      collapsed: this.floatingButtonsCollapsed,
    });
  }

  updateFloatingButtons(force = false) {
    const signature = this.getFloatingButtonsSignature();
    const hasContainer = !!document.querySelector(".floating-buttons-container");
    if (!force && hasContainer && signature === this.floatingButtonsSignature) {
      this.syncFloatingVisibility();
      return;
    }

    this.floatingButtonsSignature = signature;
    this.createFloatingButtons();
  }

  createFloatingButtons() {
    const existing = document.querySelector(".floating-buttons-container");
    if (existing) existing.remove();

    const container = this.el("div", { class: "floating-buttons-container" });
    const buttons = this.el("div", { class: "floating-buttons" });

    for (const platformKey of this.platformOrder) {
      if (!this.enabledPlatforms.includes(platformKey)) continue;
      const info = this.platforms[platformKey];
      if (!info || !info.icon) continue;

      const btn = this.el("button", { class: "floating-button", title: info.name });
      btn.dataset.platform = platformKey;

      const icon = this.el("img", {
        class: "floating-button-icon" + (platformKey === "bilibili" ? " bilibili-icon" : ""),
        src: info.icon,
        alt: info.name,
      });
      btn.appendChild(icon);
      btn.appendChild(this.el("span", { class: "floating-button-label" }, info.name));

      btn.addEventListener("click", () => this.scrollToPlatform(platformKey));
      buttons.appendChild(btn);
    }

    // 返回顶部
    const topBtn = this.el("button", { class: "top-button", title: "返回顶部" });
    topBtn.appendChild(this.el("img", { class: "top-button-icon", src: ARROW_UP_SVG, alt: "返回顶部" }));
    topBtn.addEventListener("click", () => {
      document.getElementById("content").scrollTo({ top: 0, behavior: this.scrollBehavior() });
    });
    buttons.appendChild(topBtn);

    // 折叠按钮
    const collapseBtn = this.el("button", {
      class: "collapse-button",
      title: this.floatingButtonsCollapsed ? "展开悬浮按钮" : "折叠悬浮按钮",
      "aria-expanded": String(!this.floatingButtonsCollapsed),
    });
    const collapseIcon = this.el("img", {
      class: "collapse-button-icon",
      src: this.floatingButtonsCollapsed ? ARROW_UP_SVG : ARROW_DOWN_SVG,
      alt: "折叠按钮",
    });
    collapseBtn.appendChild(collapseIcon);
    collapseBtn.addEventListener("click", () => this.toggleFloatingButtons());
    buttons.appendChild(collapseBtn);

    container.appendChild(buttons);
    document.body.appendChild(container);

    this.syncFloatingVisibility();

    if (this.floatingButtonsCollapsed) {
      buttons.classList.add("collapsed");
      // CSS 中 .floating-buttons.collapsed 已经处理显示/隐藏
    }
  }

  scrollToPlatform(platformKey) {
    // 找到第一条该平台的直播卡片并滚动过去；找不到则回到顶部
    const content = document.getElementById("content");
    const first = content.querySelector(`.streamer-item[data-platform="${platformKey}"]`) ||
      (this.offlineExpanded ? content.querySelector(`.offline-item[data-platform="${platformKey}"]`) : null);
    if (first) {
      first.scrollIntoView({ behavior: this.scrollBehavior(), block: "start" });
    } else {
      content.scrollTo({ top: 0, behavior: this.scrollBehavior() });
    }
  }

  toggleFloatingButtons() {
    const buttons = document.querySelector(".floating-buttons");
    const collapseBtn = document.querySelector(".collapse-button");
    if (!buttons || !collapseBtn) return;

    const willCollapse = !buttons.classList.contains("collapsed");
    buttons.classList.toggle("collapsed", willCollapse);
    collapseBtn.title = willCollapse ? "展开悬浮按钮" : "折叠悬浮按钮";

    const icon = collapseBtn.querySelector(".collapse-button-icon");
    if (icon) icon.src = willCollapse ? ARROW_UP_SVG : ARROW_DOWN_SVG;

    this.floatingButtonsCollapsed = willCollapse;
    this.floatingButtonsSignature = this.getFloatingButtonsSignature();
    this.queueStorage({ floatingButtonsCollapsed: willCollapse });
    collapseBtn.setAttribute("aria-expanded", String(!willCollapse));
  }

  // ========== Settings ==========
  toggleSettings() {
    if (this.settingsSaving) return;
    this.settingsOpen = !this.settingsOpen;
    document.getElementById("settingsPanel").style.display = this.settingsOpen ? "flex" : "none";
    document.getElementById("content").style.display = this.settingsOpen ? "none" : "block";
    const settingsButton = document.getElementById("settingsBtn");
    settingsButton.textContent = this.settingsOpen ? "返回直播" : "设置";
    settingsButton.setAttribute("aria-expanded", String(this.settingsOpen));
    document.body.classList.toggle("settings-open", this.settingsOpen);
    document.getElementById("refreshBtn").style.display = this.settingsOpen ? "none" : "inline-block";
    this.syncFloatingVisibility();
    if (this.settingsOpen) {
      this.settingsBaseline = JSON.stringify(this.getSettingsSnapshot());
      this.renderSettings();
      document.getElementById("settingsTitle").focus({ preventScroll: true });
    } else {
      // Draft controls are rebuilt from saved preferences next time; leaving never saves implicitly.
      settingsButton.focus({ preventScroll: true });
    }
  }

  syncFloatingVisibility() {
    const container = document.querySelector(".floating-buttons-container");
    if (container) container.style.display = this.floatingButtonsVisible && !this.settingsOpen ? "block" : "none";
  }

  scrollBehavior() {
    return matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  getSettingsSnapshot() {
    return {
      platformOrder: [...this.platformOrder], enabledPlatforms: this.getEnabledPlatformKeys(),
      floatingButtonsVisible: this.floatingButtonsVisible,
      floatingButtonsCollapsed: this.floatingButtonsCollapsed,
    };
  }

  readSettingsDraft() {
    const items = [...document.querySelectorAll("#platformSortable .platform-item")];
    return {
      platformOrder: this.normalizePlatformOrder(items.map((item) => item.dataset.platform)),
      enabledPlatforms: items.filter((item) => item.querySelector("input").checked).map((item) => item.dataset.platform),
      floatingButtonsVisible: document.getElementById("floatingButtonToggle").checked,
      floatingButtonsCollapsed: this.settingsDraftCollapsed,
    };
  }

  updateSettingsDraft() {
    if (!this.settingsOpen) return;
    const draft = this.readSettingsDraft();
    const dirty = JSON.stringify(draft) !== this.settingsBaseline;
    const status = document.getElementById("settingsSaveState");
    status.dataset.dirty = String(dirty);
    this.setText(status, dirty ? "有未保存的更改" : "已保存");
    this.setText(document.getElementById("enabledPlatformCount"), `${draft.enabledPlatforms.length} / ${this.platformOrder.length} 已启用`);
    const items = [...document.querySelectorAll("#platformSortable .platform-item")];
    items.forEach((item, index) => {
      this.setText(item.querySelector(".platform-position"), String(index + 1));
      item.classList.toggle("platform-disabled", !item.querySelector("input").checked);
      item.querySelector('[data-direction="-1"]').disabled = index === 0;
      item.querySelector('[data-direction="1"]').disabled = index === items.length - 1;
    });
  }

  renderSettings(snapshot = this.getSettingsSnapshot()) {
    const sortable = document.getElementById("platformSortable");
    sortable.replaceChildren();
    this.settingsDraftCollapsed = snapshot.floatingButtonsCollapsed;
    for (const key of snapshot.platformOrder) {
      const platform = this.platforms[key];
      const item = this.el("li", { class: "platform-item", "data-platform": key });
      item.draggable = true;
      item.append(this.el("span", { class: "drag-handle", "aria-hidden": "true" }, "⠿"),
        this.el("span", { class: "platform-position", "aria-hidden": "true" }),
        this.el("img", { class: "platform-icon", src: platform.icon, alt: "" }),
        this.el("span", { class: "platform-name" }, platform.name));
      const orderButtons = this.el("div", { class: "platform-order-buttons" });
      for (const [direction, symbol] of [[-1, "↑"], [1, "↓"]]) {
        const button = this.el("button", { type: "button", class: "platform-order-button", "data-direction": direction,
          "aria-label": `${platform.name}${direction < 0 ? "上移" : "下移"}`, title: direction < 0 ? "上移" : "下移" }, symbol);
        button.addEventListener("click", () => {
          const sibling = direction < 0 ? item.previousElementSibling : item.nextElementSibling;
          if (!sibling) return;
          if (direction < 0) sortable.insertBefore(item, sibling);
          else sortable.insertBefore(sibling, item);
          this.updateSettingsDraft();
          const focusTarget = button.disabled ? item.querySelector(`[data-direction="${-direction}"]`) : button;
          focusTarget.focus({ preventScroll: true });
        });
        orderButtons.appendChild(button);
      }
      item.appendChild(orderButtons);
      const label = this.el("label", { class: "platform-switch" });
      const input = this.el("input", { type: "checkbox", role: "switch", "aria-label": `显示 ${platform.name}` });
      input.checked = snapshot.enabledPlatforms.includes(key);
      label.append(input, this.el("span", { class: "switch-slider" }));
      item.appendChild(label);
      sortable.appendChild(item);
    }
    this.setupDragAndDrop();
    document.getElementById("floatingButtonToggle").checked = snapshot.floatingButtonsVisible;
    this.updateSettingsDraft();
  }

  setupDragAndDrop() {
    if (this.settingsDragBound) return;

    const sortable = document.getElementById("platformSortable");
    if (!sortable) return;
    this.settingsDragBound = true;

    sortable.addEventListener("dragstart", (e) => {
      if (e.target.classList.contains("platform-item")) {
        e.target.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      }
    });

    sortable.addEventListener("dragend", (e) => {
      if (e.target.classList.contains("platform-item")) {
        e.target.classList.remove("dragging");
        this.updateSettingsDraft();
      }
    });

    sortable.addEventListener("dragover", (e) => {
      e.preventDefault();
      const afterElement = this.getDragAfterElement(sortable, e.clientY);
      const dragging = document.querySelector(".dragging");
      if (!dragging) return;
      if (afterElement == null) sortable.appendChild(dragging);
      else sortable.insertBefore(dragging, afterElement);
    });

    sortable.addEventListener("drop", (e) => {
      e.preventDefault();
      this.updateSettingsDraft();
    });
  }

  getDragAfterElement(container, y) {
    const items = [...container.querySelectorAll(".platform-item:not(.dragging)")];
    return items.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY }
    ).element;
  }

  async applySettings() {
    if (this.settingsSaving || !this.settingsOpen) return;
    const draft = this.readSettingsDraft();
    if (JSON.stringify(draft) === this.settingsBaseline) {
      this.toggleSettings();
      return;
    }
    // Invalidate before waiting for storage; a late response must not restore disabled platforms.
    this.invalidateRefresh();
    this.settingsSaving = true;
    this.setSettingsSaving(true);
    const errorCount = this.storageErrorCount;
    await this.queueStorage(draft);
    this.settingsSaving = false;
    this.setSettingsSaving(false);
    if (this.storageErrorCount !== errorCount) {
      this.setText(document.getElementById("settingsSaveState"), "保存失败，请重试");
      const stale = this.getEnabledPlatformKeys().filter((key) => !this.isPlatformFresh(key));
      if (stale.length) this.refreshPlatforms(stale);
      else this.refreshVisibleOfflineFollowers();
      return;
    }
    this.platformOrder = draft.platformOrder;
    this.enabledPlatforms = draft.enabledPlatforms;
    this.floatingButtonsVisible = draft.floatingButtonsVisible;
    this.floatingButtonsCollapsed = draft.floatingButtonsCollapsed;
    this.toggleSettings();
    this.renderStreamers();
    const stale = this.getEnabledPlatformKeys().filter((key) => !this.isPlatformFresh(key));
    if (stale.length) this.refreshPlatforms(stale);
    else this.refreshVisibleOfflineFollowers();
    this.showMessage("设置已保存");
  }

  setSettingsSaving(saving) {
    document.querySelector(".settings-scroll").inert = saving;
    for (const id of ["settingsBtn", "applySettingsBtn", "cancelSettingsBtn"]) {
      document.getElementById(id).disabled = saving;
    }
    this.setText(document.getElementById("applySettingsBtn"), saving ? "正在保存…" : "保存并返回");
    if (saving) this.setText(document.getElementById("settingsSaveState"), "正在保存设置…");
  }

  resetSettings() {
    if (!this.settingsOpen || this.settingsSaving) return;
    // This only changes the editable draft. Favorites, cached lists and saved preferences stay intact until Save.
    const all = Object.keys(this.platforms);
    this.renderSettings({ platformOrder: all, enabledPlatforms: all,
      floatingButtonsVisible: true, floatingButtonsCollapsed: false });
    const status = document.getElementById("settingsSaveState");
    if (status.dataset.dirty === "true") this.setText(status, "已恢复默认选项，保存后生效");
  }

  showRefreshLoading() {
    const button = document.getElementById("refreshBtn");
    if (button.disabled) return;
    button.replaceChildren(this.el("span", { class: "refresh-spinner", "aria-hidden": "true" }), document.createTextNode("刷新中"));
    button.disabled = true;
    button.setAttribute("aria-label", "正在刷新关注列表");
  }

  resetRefreshButton() {
    const button = document.getElementById("refreshBtn");
    if (!button) return;
    this.setText(button, "刷新");
    button.disabled = false;
    button.setAttribute("aria-label", "刷新关注列表");
  }

  showMessage(message) {
    const element = document.getElementById("messageContainer");
    if (!element || document.hidden) return;
    clearTimeout(this.messageTimer);
    element.textContent = message;
    element.style.display = "block";
    this.messageTimer = setTimeout(() => { element.style.display = "none"; }, 1800);
  }

  formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return "0";
    if (number >= 10000) return (number / 10000).toFixed(1) + "万";
    if (number >= 1000) return (number / 1000).toFixed(1) + "k";
    return Math.floor(number).toString();
  }

  formatDuration(seconds) {
    const value = Number(seconds);
    // Permit long-running streams, but never render Infinity, NaN or epoch values as durations.
    if (!Number.isFinite(value) || value <= 0 || value > 10 * 366 * 86400) return "";
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m` : "< 1m";
  }

  el(tag, attrs = {}, text) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (value != null) element.setAttribute(key, value);
    if (text != null) element.textContent = text;
    return element;
  }
}

document.addEventListener("DOMContentLoaded", () => { window.liveAssistant = new LiveAssistant(); });
