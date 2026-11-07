// SPDX-License-Identifier: MIT
// Synology Audio Station (DS Audio) Plugin for MyGo Music
// Implements MyGo Music Source interface for streaming and managing Synology NAS music.

const QUICKCONNECT_SERV_URL = "http://global.quickconnect.to/Serv.php";
const PING_TIMEOUT_MS = 2500;

const DSM_AUTH_ERRORS = {
  400: "用户名或密码错误，请检查设置中的 DSM 账号与密码",
  401: "该 DSM 账号已被停用",
  402: "该账号无权访问 Audio Station，请在 DSM 控制台中授予该用户 Audio Station 访问权限",
  403: "该账号启用了两步验证 (2FA)，请在设置中填写 6 位动态验证码",
  404: "两步验证 (2FA) 验证码错误或已过期，请重新填写",
  406: "DSM 强制要求两步验证，请先在网页端完成安全配置",
  407: "IP 已被 DSM 自动封锁（多次尝试登录失败）",
};

// Cached session state in memory (lazy-loaded from host.storage)
let session = null;
let likedCache = null;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function currentSession() {
  if (!session) {
    session = host.storage.get("session") || null;
  }
  return session;
}

function persistSession(sess) {
  session = sess;
  if (sess) {
    host.storage.set("session", sess);
  } else {
    host.storage.remove("session");
  }
}

async function requireSession() {
  const sess = currentSession();
  if (!sess || !sess.sid || !sess.baseUrl) {
    throw fail("signIn", "请先登录群晖 Audio Station");
  }
  return sess;
}

function computeMd5(text) {
  if (typeof globalThis.host?.crypto?.md5 === "function") {
    return globalThis.host.crypto.md5(text);
  }
  return "";
}

/**
 * Determine whether the given string is a QuickConnect ID or direct server URL/IP.
 */
function isQuickConnectId(server) {
  const trimmed = server.trim();
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (trimmed.includes(":") || trimmed.includes("/") || trimmed.includes(".")) return false;
  // QuickConnect IDs are typically alphanumeric and dashes
  return /^[a-zA-Z0-9_\-]+$/.test(trimmed);
}

/**
 * Normalize direct URL or IP.
 */
function normalizeServerUrl(server) {
  let url = server.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  return url;
}

/**
 * Probe a candidate server address using DSM pingpong endpoint.
 */
async function probeCandidate(baseUrl, expectedEzid) {
  const pingUrl = `${baseUrl}/webman/pingpong.cgi?action=cors&quickconnect=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(pingUrl, {
      method: "GET",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && json.success) {
      if (expectedEzid && json.ezid && json.ezid.toLowerCase() !== expectedEzid.toLowerCase()) {
        return null;
      }
      return baseUrl;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  return null;
}

/**
 * Query QuickConnect directory server with regional site redirect support.
 */
async function fetchQuickConnectServerInfo(host, qcid) {
  const payload = [
    {
      version: 1,
      command: "get_server_info",
      stop_when_error: false,
      stop_when_success: false,
      id: "dsm_portal_https",
      serverID: qcid,
      is_gofile: false,
    },
    {
      version: 1,
      command: "get_server_info",
      stop_when_error: false,
      stop_when_success: false,
      id: "dsm_portal",
      serverID: qcid,
      is_gofile: false,
    },
  ];

  let res;
  try {
    res = await fetch(`http://${host}/Serv.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`连接 QuickConnect 服务器 (${host}) 失败: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`QuickConnect 请求失败 (${host}): HTTP ${res.status}`);
  }

  const list = await res.json();
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`未找到 QuickConnect ID "${qcid}" 对应的群晖设备`);
  }

  return list;
}

/**
 * Resolve a QuickConnect ID to a reachable DSM base URL.
 */
async function resolveQuickConnect(qcId) {
  const id = qcId.trim();
  let currentHost = "global.quickconnect.to";
  let list = null;

  // Follow regional site redirects (e.g. global -> cnc.quickconnect.cn / dec.quickconnect.to)
  for (let redirect = 0; redirect < 3; redirect++) {
    list = await fetchQuickConnectServerInfo(currentHost, id);
    const first = list[0];
    if (first && first.errno === 4 && Array.isArray(first.sites) && first.sites.length > 0) {
      currentHost = first.sites[0];
      continue;
    }
    break;
  }

  const httpsInfo = list[0]?.errno === 0 ? list[0] : null;
  const httpInfo = list[1]?.errno === 0 ? list[1] : null;
  const primary = httpsInfo || httpInfo;

  if (!primary || !primary.server) {
    const errCode = list[0]?.errno;
    throw new Error(`QuickConnect 解析错误 (errno: ${errCode || "未知"}): 请检查 QuickConnect ID 是否正确或 NAS 是否联网在线`);
  }

  const serverID = primary.server.serverID || id;
  const expectedEzid = computeMd5(serverID);

  // Group candidate endpoints with priority levels
  // 1: LAN HTTPS / SmartDNS LAN HTTPS
  // 2: LAN HTTP / SmartDNS LAN HTTP
  // 3: WAN / DDNS / SmartDNS Host HTTPS
  // 4: WAN / DDNS / SmartDNS Host HTTP
  // 5: Relay Tunnel HTTP / HTTPS
  const candidates = [];

  const addCandidate = (proto, host, port, priority) => {
    if (!host || host === "NULL") return;
    const p = port ? `:${port}` : "";
    candidates.push({ url: `${proto}://${host}${p}`, priority });
  };

  const parseServer = (info, proto) => {
    if (!info?.server || !info?.service) return;
    const srv = info.server;
    const svc = info.service;
    const smart = info.smartdns;
    const port = svc.port;
    const extPort = svc.ext_port && svc.ext_port !== "0" && svc.ext_port !== port ? svc.ext_port : null;

    // Local interfaces (LAN IP)
    if (Array.isArray(srv.interface)) {
      for (const iface of srv.interface) {
        if (iface.ip) {
          addCandidate(proto, iface.ip, port, proto === "https" ? 1 : 2);
        }
      }
    }

    // SmartDNS LAN (e.g. 192-168-1-100.xxx.direct.quickconnect.cn)
    if (smart && Array.isArray(smart.lan)) {
      for (const lanHost of smart.lan) {
        addCandidate(proto, lanHost, port, proto === "https" ? 1 : 2);
      }
    }

    // SmartDNS Host
    if (smart?.host && smart.host !== "NULL") {
      addCandidate(proto, smart.host, extPort || port, proto === "https" ? 3 : 4);
      if (extPort) addCandidate(proto, smart.host, port, proto === "https" ? 3 : 4);
    }

    // DDNS / FQDN (WAN)
    if (srv.ddns && srv.ddns !== "NULL") {
      addCandidate(proto, srv.ddns, extPort || port, proto === "https" ? 3 : 4);
      if (extPort) addCandidate(proto, srv.ddns, port, proto === "https" ? 3 : 4);
    }
    if (srv.fqdn && srv.fqdn !== "NULL") {
      addCandidate(proto, srv.fqdn, extPort || port, proto === "https" ? 3 : 4);
    }

    // External WAN IP
    if (srv.external?.ip && srv.external.ip !== "NULL") {
      addCandidate(proto, srv.external.ip, extPort || port, proto === "https" ? 3 : 4);
    }

    // Relay Tunnel (relay_dn / relay_ip)
    if (svc.relay_dn && svc.relay_port) {
      addCandidate("http", svc.relay_dn, svc.relay_port, 5);
      if (svc.https_port) addCandidate("https", svc.relay_dn, svc.https_port, 5);
    }
    if (svc.relay_ip && svc.relay_port) {
      addCandidate("http", svc.relay_ip, svc.relay_port, 5);
      if (svc.https_port) addCandidate("https", svc.relay_ip, svc.https_port, 5);
    }
  };

  if (httpsInfo) parseServer(httpsInfo, "https");
  if (httpInfo) parseServer(httpInfo, "http");

  // De-duplicate candidates preserving lowest priority number
  const candidateMap = new Map();
  for (const c of candidates) {
    if (!candidateMap.has(c.url) || candidateMap.get(c.url) > c.priority) {
      candidateMap.set(c.url, c.priority);
    }
  }

  // Probe candidates concurrently
  const probeTasks = Array.from(candidateMap.entries()).map(([url, priority]) =>
    probeCandidate(url, expectedEzid).then((verified) => (verified ? { url: verified, priority } : null))
  );

  const results = await Promise.all(probeTasks);
  const successful = results.filter(Boolean).sort((a, b) => a.priority - b.priority);

  if (successful.length > 0) {
    return successful[0].url;
  }

  // Fallback to relay address if available
  const relayFallback =
    primary.service?.relay_dn && primary.service?.relay_port
      ? `http://${primary.service.relay_dn}:${primary.service.relay_port}`
      : primary.service?.relay_ip && primary.service?.relay_port
      ? `http://${primary.service.relay_ip}:${primary.service.relay_port}`
      : `https://${id}.quickconnect.to`;

  return relayFallback;
}

const API_PATHS = {
  "SYNO.API.Auth": "entry.cgi",
  "SYNO.AudioStation.Song": "AudioStation/song.cgi",
  "SYNO.AudioStation.Album": "AudioStation/album.cgi",
  "SYNO.AudioStation.Artist": "AudioStation/artist.cgi",
  "SYNO.AudioStation.Playlist": "AudioStation/playlist.cgi",
  "SYNO.AudioStation.Folder": "AudioStation/folder.cgi",
  "SYNO.AudioStation.Search": "AudioStation/search.cgi",
  "SYNO.AudioStation.Lyrics": "AudioStation/lyrics.cgi",
  "SYNO.AudioStation.Cover": "AudioStation/cover.cgi",
  "SYNO.AudioStation.Stream": "AudioStation/stream.cgi",
  "SYNO.AudioStation.Info": "AudioStation/info.cgi",
  "SYNO.AudioStation.Pin": "entry.cgi",
};

let apiInfoCache = null;

/**
 * Standard RFC 3986 percent-encoded query string builder.
 * Unlike URLSearchParams which converts spaces to '+', Synology DSM CGI
 * backend specifically requires '%20' for spaces in album/artist/song names.
 */
function buildQueryString(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join("&");
}

async function resolveApiPath(api, sess) {
  if (apiInfoCache && apiInfoCache[api]?.path) {
    return apiInfoCache[api].path;
  }
  if (!apiInfoCache && sess?.baseUrl) {
    try {
      const res = await fetch(`${sess.baseUrl}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=ALL`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          apiInfoCache = json.data;
          if (apiInfoCache[api]?.path) return apiInfoCache[api].path;
        }
      }
    } catch {
      // ignore
    }
  }
  return API_PATHS[api] || "entry.cgi";
}

/**
 * Universal Synology DSM Web API call.
 */
async function synoRequest(api, method, version, params = {}, sessionOverride = null) {
  const sess = sessionOverride || (await requireSession());
  const queryParams = {
    api,
    method,
    version: String(version),
    ...params,
  };

  if (sess.sid) {
    queryParams._sid = sess.sid;
  }

  const apiPath = await resolveApiPath(api, sess);
  const endpoint = `${sess.baseUrl}/webapi/${apiPath}`;
  const qs = buildQueryString(queryParams);

  let res;
  try {
    res = await fetch(`${endpoint}?${qs}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    throw new Error(`连接群晖失败 (${sess.baseUrl}): ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`群晖 API 响应状态异常: HTTP ${res.status}`);
  }

  const json = await res.json();
  if (!json.success) {
    const errCode = json.error?.code;
    if (errCode === 106 || errCode === 107) {
      persistSession(null);
      throw fail("signIn", "群晖登录会话已过期，请重新登录");
    }
    if (errCode === 105) {
      throw fail("unavailable", "当前账号无权执行该操作");
    }
    throw new Error(`群晖 API 请求失败 [${api}.${method}]: code ${errCode || "未知"}`);
  }

  return json.data;
}

/**
 * Convert Synology song item to MyGo Music Track model.
 */
function toTrack(item, sess) {
  const id = String(item.id);
  const title = item.title || item.path?.split("/").pop() || "未知曲目";
  const artistName = item.additional?.song_tag?.artist || item.artist || "未知歌手";
  const albumName = item.additional?.song_tag?.album || item.album || "未知专辑";
  const durationSec = item.additional?.song_audio?.duration || 0;

  const coverUrl = sess?.baseUrl
    ? `${sess.baseUrl}/webapi/AudioStation/cover.cgi?api=SYNO.AudioStation.Cover&version=3&method=getsongcover&id=${encodeURIComponent(id)}&_sid=${sess.sid}`
    : "";

  return {
    id,
    name: title,
    artists: [{ id: artistName, name: artistName }],
    album: {
      id: albumName,
      name: albumName,
      imageUrl: coverUrl,
      artists: [{ id: artistName, name: artistName }],
    },
    duration: Math.round(durationSec * 1000),
  };
}

/**
 * Convert Synology album item to MyGo Music Album model.
 */
function toAlbum(item, sess) {
  const name = item.name || item.title || "未知专辑";
  const artist = item.display_artist || item.album_artist || item.artist || "";
  const coverUrl = sess?.baseUrl
    ? `${sess.baseUrl}/webapi/AudioStation/cover.cgi?api=SYNO.AudioStation.Cover&version=3&method=getcover&album_name=${encodeURIComponent(name)}&album_artist_name=${encodeURIComponent(artist)}&_sid=${sess.sid}`
    : "";

  return {
    id: name,
    name,
    imageUrl: coverUrl,
    artists: artist ? [{ id: artist, name: artist }] : [],
    released: item.year ? String(item.year) : undefined,
  };
}

/**
 * Convert Synology artist item to MyGo Music Artist model.
 */
function toArtist(item, sess) {
  const name = item.name || "未知歌手";
  const coverUrl = sess?.baseUrl
    ? `${sess.baseUrl}/webapi/AudioStation/cover.cgi?api=SYNO.AudioStation.Cover&version=1&method=getcover&artist_name=${encodeURIComponent(name)}&_sid=${sess.sid}`
    : "";

  return {
    id: name,
    name,
    imageUrl: coverUrl,
  };
}

/**
 * Convert Synology playlist item to MyGo Music Playlist model.
 */
function toPlaylist(item) {
  return {
    id: String(item.id),
    name: item.name || "未命名歌单",
    trackCount: item.additional?.songs_count || 0,
    mine: true,
  };
}

// -------------------------------------------------------------------------
// Exported Plugin Methods (MyGo Music Source Interface)
// -------------------------------------------------------------------------

export async function account() {
  const sess = currentSession();
  if (!sess || !sess.sid || !sess.account) {
    return null;
  }
  return sess.account;
}

export async function signIn() {
  const serverInput = host.setting("server");
  const username = host.setting("username");
  const password = host.setting("password");
  const otp = host.setting("otp");

  if (!serverInput || !username || !password) {
    throw fail("setup", "请先在插件设置中填写群晖服务器地址 (或 QuickConnect ID)、用户名及密码");
  }

  host.signInPrompt({ text: "正在解析群晖 NAS 连接地址…" });

  let baseUrl = "";
  if (isQuickConnectId(serverInput)) {
    host.signInPrompt({ text: `正在连接 QuickConnect: ${serverInput.trim()}…` });
    baseUrl = await resolveQuickConnect(serverInput);
  } else {
    baseUrl = normalizeServerUrl(serverInput);
  }

  host.signInPrompt({ text: `已定位群晖地址 (${baseUrl})，正在登录认证…` });

  // Authenticate against DSM Auth API
  const authParams = new URLSearchParams({
    api: "SYNO.API.Auth",
    version: "6",
    method: "login",
    account: username.trim(),
    passwd: password,
    session: "AudioStation",
    format: "sid",
  });

  if (otp && otp.trim()) {
    authParams.set("otp_code", otp.trim());
  }

  let authRes;
  try {
    authRes = await fetch(`${baseUrl}/webapi/entry.cgi`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: authParams.toString(),
    });
  } catch (err) {
    throw new Error(`连接群晖登录服务失败 (${baseUrl}): ${err.message}`);
  }

  if (!authRes.ok) {
    throw new Error(`群晖登录服务返回 HTTP ${authRes.status}`);
  }

  const authJson = await authRes.json();
  if (!authJson.success) {
    const code = authJson.error?.code;
    const msg = DSM_AUTH_ERRORS[code] || `群晖认证失败 (错误代码: ${code || "未知"})`;
    throw new Error(msg);
  }

  const sid = authJson.data?.sid;
  if (!sid) {
    throw new Error("群晖未返回有效的会话 ID (sid)，登录失败");
  }

  const acc = {
    id: username.trim(),
    name: username.trim(),
    imageUrl: `${baseUrl}/webapi/entry.cgi?api=SYNO.Core.User&version=1&method=get&_sid=${sid}`,
  };

  const newSession = {
    baseUrl,
    sid,
    username: username.trim(),
    serverName: serverInput.trim(),
    account: acc,
  };

  persistSession(newSession);
  likedCache = null;
  host.signInPrompt({ text: "群晖 Audio Station 登录成功！" });
  return acc;
}

export function signOut() {
  persistSession(null);
  likedCache = null;
}

export function setSetting() {
  // If user changed credentials or server, clear current session to trigger re-auth
  persistSession(null);
  likedCache = null;
}

export async function home() {
  const sess = await requireSession();

  // Query recently added songs, random songs, and albums concurrently
  const [recentData, randomData, albumData, playlistData] = await Promise.allSettled([
    synoRequest("SYNO.AudioStation.Song", "list", 3, {
      additional: "song_audio,song_tag",
      sort_by: "added",
      sort_direction: "DESC",
      limit: "15",
      library: "all",
    }),
    synoRequest("SYNO.AudioStation.Song", "list", 3, {
      additional: "song_audio,song_tag",
      sort_by: "random",
      limit: "15",
      library: "all",
    }),
    synoRequest("SYNO.AudioStation.Album", "list", 3, {
      additional: "avg_rating",
      limit: "10",
      library: "all",
    }),
    synoRequest("SYNO.AudioStation.Playlist", "list", 3, {
      limit: "10",
      library: "all",
    }),
  ]);

  const recentSongs = recentData.status === "fulfilled" ? recentData.value.songs || [] : [];
  const randomSongs = randomData.status === "fulfilled" ? randomData.value.songs || [] : [];
  const albums = albumData.status === "fulfilled" ? albumData.value.albums || [] : [];
  const playlists = playlistData.status === "fulfilled" ? playlistData.value.playlists || [] : [];

  const sections = [];
  if (recentSongs.length > 0) {
    sections.push({ title: "最近添加", tracks: recentSongs.map((s) => toTrack(s, sess)) });
  }
  if (randomSongs.length > 0) {
    sections.push({ title: "随心漫游", tracks: randomSongs.map((s) => toTrack(s, sess)) });
  }
  if (albums.length > 0) {
    sections.push({ title: "热门专辑", albums: albums.map((a) => toAlbum(a, sess)) });
  }
  if (playlists.length > 0) {
    sections.push({ title: "我的歌单", playlists: playlists.map(toPlaylist) });
  }

  return {
    title: "群晖音乐库",
    subtitle: sess.serverName || sess.baseUrl,
    sections,
  };
}

export async function browse({ page }) {
  const sess = await requireSession();

  if (page === "all_songs") {
    const data = await synoRequest("SYNO.AudioStation.Song", "list", 3, {
      additional: "song_audio,song_tag",
      sort_by: "title",
      sort_direction: "ASC",
      limit: "10000",
    });
    const songs = data.songs || [];
    return {
      title: "全部歌曲",
      subtitle: `共 ${data.total || songs.length} 首曲目`,
      sections: [{ tracks: songs.map((s) => toTrack(s, sess)) }],
    };
  }

  if (page === "all_albums") {
    const data = await synoRequest("SYNO.AudioStation.Album", "list", 3, {
      additional: "avg_rating",
      sort_by: "name",
      sort_direction: "ASC",
      limit: "2000",
    });
    const albums = data.albums || [];
    return {
      title: "专辑列表",
      subtitle: `共 ${data.total || albums.length} 张专辑`,
      sections: [{ albums: albums.map((a) => toAlbum(a, sess)) }],
    };
  }

  if (page === "all_artists") {
    const data = await synoRequest("SYNO.AudioStation.Artist", "list", 3, {
      additional: "avg_rating",
      sort_by: "name",
      sort_direction: "ASC",
      limit: "2000",
    });
    const artists = data.artists || [];
    return {
      title: "歌手列表",
      subtitle: `共 ${data.total || artists.length} 位歌手`,
      sections: [{ artists: artists.map((a) => toArtist(a, sess)) }],
    };
  }

  if (page === "folders" || page.startsWith("folder:")) {
    const isRoot = page === "folders" || page === "folder:root" || page === "folder:";
    const folderId = isRoot ? "" : page.replace(/^folder:/, "");

    const params = {
      limit: "2000",
      additional: "song_audio,song_tag",
    };
    if (folderId) {
      params.id = folderId;
    }

    const data = await synoRequest("SYNO.AudioStation.Folder", "list", 2, params);
    const items = data.items || [];
    const subfolders = items.filter((it) => it.type === "folder");
    const files = items.filter((it) => it.type === "file");

    const sections = [];
    if (subfolders.length > 0) {
      sections.push({
        title: subfolders.length > 0 && files.length > 0 ? "子文件夹" : undefined,
        links: subfolders.map((f) => ({
          text: f.title || f.path?.split("/").pop() || "未命名文件夹",
          page: `folder:${f.id}`,
          type: "folder",
        })),
      });
    }
    if (files.length > 0) {
      sections.push({
        title: subfolders.length > 0 ? "曲目" : undefined,
        tracks: files.map((s) => toTrack(s, sess)),
      });
    }

    // Determine current folder name & path for header
    let title = "文件夹";
    let subtitle = "群晖 NAS 音乐目录";
    if (!isRoot) {
      const sampleItem = items[0];
      if (sampleItem?.path) {
        const parts = sampleItem.path.split("/").filter(Boolean);
        const dirParts = parts.slice(0, -1);
        title = dirParts[dirParts.length - 1] || "文件夹";
        subtitle = "/" + dirParts.join("/");
      } else {
        title = `文件夹 (${folderId})`;
      }
    }

    return {
      title,
      subtitle: `${subtitle} · 共 ${subfolders.length} 个文件夹, ${files.length} 首曲目`,
      sections,
    };
  }

  if (page === "playlists") {
    const list = await playlists();
    return {
      title: "我的歌单",
      sections: [{ playlists: list }],
    };
  }

  throw fail("unsupported", `不支持的页面: ${page}`);
}

export async function search({ query, kind = "tracks", offset = 0 }) {
  const sess = await requireSession();
  const limit = 30;

  if (kind === "tracks" || kind === "albums" || kind === "artists") {
    const data = await synoRequest("SYNO.AudioStation.Search", "list", 1, {
      keyword: query,
      additional: "song_audio,song_tag,song_rating",
      limit: String(limit),
      offset: String(offset),
    });

    if (kind === "tracks") {
      const songs = data.songs || [];
      return {
        tracks: songs.map((s) => toTrack(s, sess)),
        more: offset + songs.length < (data.songTotal || 0),
      };
    }
    if (kind === "albums") {
      const albums = data.albums || [];
      return {
        albums: albums.map((a) => toAlbum(a, sess)),
        more: offset + albums.length < (data.albumTotal || 0),
      };
    }
    if (kind === "artists") {
      const artists = data.artists || [];
      return {
        artists: artists.map((a) => toArtist(a, sess)),
        more: offset + artists.length < (data.artistTotal || 0),
      };
    }
  }

  if (kind === "playlists") {
    const data = await synoRequest("SYNO.AudioStation.Playlist", "list", 3, {
      limit: "100",
      offset: "0",
    });
    const all = (data.playlists || []).map(toPlaylist);
    const qLower = query.toLowerCase();
    const filtered = all.filter((p) => p.name.toLowerCase().includes(qLower));
    return {
      playlists: filtered.slice(offset, offset + limit),
      more: offset + limit < filtered.length,
    };
  }

  return { tracks: [], more: false };
}

export async function playlists() {
  const sess = await requireSession();
  const data = await synoRequest("SYNO.AudioStation.Playlist", "list", 3, {
    limit: "100",
    offset: "0",
    library: "all",
  });
  return (data.playlists || []).map(toPlaylist);
}

export async function playlist({ id }) {
  const sess = await requireSession();
  const data = await synoRequest("SYNO.AudioStation.Playlist", "getinfo", 3, {
    id,
    additional: "songs,songs_song_tag,songs_song_audio",
    limit: "1000",
    library: "all",
  });
  const pl = data.playlists?.[0];
  if (!pl) throw fail("unavailable", "歌单不存在或已被删除");

  const songs = pl.additional?.songs || [];
  return {
    id: String(pl.id),
    name: pl.name || "未命名歌单",
    trackCount: songs.length,
    mine: true,
    tracks: songs.map((s) => toTrack(s, sess)),
  };
}

export async function album({ id }) {
  const sess = await requireSession();
  const data = await synoRequest("SYNO.AudioStation.Song", "list", 3, {
    album: id,
    additional: "song_audio,song_tag",
    limit: "1000",
  });
  const songs = data.songs || [];
  const firstSong = songs[0];
  const artistName =
    firstSong?.additional?.song_tag?.album_artist ||
    firstSong?.additional?.song_tag?.artist ||
    firstSong?.artist ||
    "";

  return {
    album: toAlbum({ name: id, display_artist: artistName }, sess),
    tracks: songs.map((s) => toTrack(s, sess)),
  };
}

export async function artist({ id }) {
  const sess = await requireSession();
  const [songRes, albumRes] = await Promise.allSettled([
    synoRequest("SYNO.AudioStation.Song", "list", 3, {
      artist: id,
      additional: "song_audio,song_tag",
      limit: "500",
    }),
    synoRequest("SYNO.AudioStation.Album", "list", 3, {
      artist: id,
      additional: "avg_rating",
      limit: "500",
    }),
  ]);

  const songs = songRes.status === "fulfilled" ? songRes.value.songs || [] : [];
  const albums = albumRes.status === "fulfilled" ? albumRes.value.albums || [] : [];

  return {
    artist: toArtist({ name: id }, sess),
    tracks: songs.map((s) => toTrack(s, sess)),
    albums: albums.map((a) => toAlbum(a, sess)),
  };
}

export async function liked({ offset = 0 }) {
  const sess = await requireSession();
  // Fetch songs with 4+ stars rating
  const data = await synoRequest("SYNO.AudioStation.Song", "list", 3, {
    additional: "song_audio,song_tag,song_rating",
    sort_by: "rating",
    sort_direction: "DESC",
    limit: "50",
    offset: String(offset),
    library: "all",
  });

  const allSongs = data.songs || [];
  const likedSongs = allSongs.filter((s) => (s.additional?.song_rating?.rating || 0) >= 4);

  if (!likedCache) likedCache = new Set();
  for (const s of likedSongs) {
    likedCache.add(String(s.id));
  }

  return {
    tracks: likedSongs.map((s) => toTrack(s, sess)),
    more: likedSongs.length === allSongs.length && offset + allSongs.length < (data.total || 0),
  };
}

export async function isLiked({ ids }) {
  const result = {};
  for (const id of ids) {
    result[id] = likedCache ? likedCache.has(String(id)) : false;
  }
  return result;
}

export async function like({ id, on }) {
  await requireSession();
  await synoRequest("SYNO.AudioStation.Song", "setrating", 3, {
    id: String(id),
    rating: on ? "5" : "0",
  });

  if (!likedCache) {
    likedCache = new Set();
  }
  if (on) {
    likedCache.add(String(id));
  } else {
    likedCache.delete(String(id));
  }
}

export async function lyrics({ id }) {
  await requireSession();
  try {
    const data = await synoRequest("SYNO.AudioStation.Lyrics", "getlyrics", 2, { id: String(id) });
    if (data && data.lyrics) {
      return { lrc: data.lyrics };
    }
  } catch {
    // Retry with API version 1
    try {
      const data = await synoRequest("SYNO.AudioStation.Lyrics", "getlyrics", 1, { id: String(id) });
      if (data && data.lyrics) {
        return { lrc: data.lyrics };
      }
    } catch {
      // No lyrics available
    }
  }
  return null;
}

export async function stream({ id }) {
  const sess = await requireSession();

  let songInfo = null;
  try {
    const data = await synoRequest("SYNO.AudioStation.Song", "getinfo", 3, {
      id: String(id),
      additional: "song_audio,song_tag",
    });
    songInfo = data?.songs?.[0];
  } catch {
    // Fallback if getinfo fails
  }

  const audio = songInfo?.additional?.song_audio || {};
  let ext = (audio.container || audio.codec || "mp3").toLowerCase();

  // Container mp4 maps directly to m4a stream without forced transcoding
  if (ext === "mp4") {
    ext = "m4a";
  }

  const supportedFormats = ["mp3", "flac", "ogg", "wav", "m4a", "aac"];
  let method = "stream";
  let streamFile = `0.${ext}`;
  let formatParam = "";

  if (!supportedFormats.includes(ext)) {
    method = "transcode";
    ext = "mp3";
    streamFile = "0.mp3";
    formatParam = "&format=mp3";
  }

  const streamUrl = `${sess.baseUrl}/webapi/AudioStation/stream.cgi/${streamFile}?api=SYNO.AudioStation.Stream&version=2&method=${method}&id=${encodeURIComponent(id)}&_sid=${sess.sid}${formatParam}`;

  return {
    url: streamUrl,
    type: ext,
    size: audio.filesize || 0,
    bitRate: audio.bitrate || 0,
    quality: audio.lossless ? "lossless" : (audio.bitrate >= 256000 ? "high" : "standard"),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MyGo-Music/1.0",
    },
  };
}
