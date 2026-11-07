import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

let sequence = 0;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

async function setup(fetchHandler, initialSettings = {}, initialStorage = {}) {
  const storageMap = new Map(Object.entries(initialStorage));
  const settingsMap = new Map(Object.entries(initialSettings));
  const storageReads = [];
  const prompts = [];

  globalThis.host = {
    setting: (key) => settingsMap.get(key) || "",
    storage: {
      get: (k) => {
        storageReads.push(k);
        return storageMap.get(k);
      },
      set: (k, v) => storageMap.set(k, structuredClone(v)),
      remove: (k) => storageMap.delete(k),
    },
    crypto: {
      md5: (text) => createHash("md5").update(text).digest("hex"),
    },
    signInPrompt: (p) => prompts.push(p),
  };

  globalThis.fetch = fetchHandler;

  const plugin = await import(`./index.js?test=${++sequence}`);
  return { plugin, storageMap, settingsMap, storageReads, prompts };
}

// 1. Module initialization deferral test
test("module initialization defers host storage calls until action", async () => {
  const { plugin, storageReads } = await setup(async () => jsonResponse({ success: true }));
  assert.deepEqual(storageReads, []);
  assert.equal(await plugin.account(), null);
  assert.deepEqual(storageReads, ["session"]);
});

// 2. Direct server URL normalization & signIn
test("signIn with direct URL normalizes protocol and saves session", async () => {
  const settings = {
    server: "192.168.1.100:5000",
    username: "admin",
    password: "secretpassword",
  };

  const handler = async (url, init) => {
    if (url.includes("/webapi/entry.cgi")) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("api"), "SYNO.API.Auth");
      assert.equal(body.get("account"), "admin");
      assert.equal(body.get("passwd"), "secretpassword");
      return jsonResponse({
        success: true,
        data: { sid: "mock_sid_12345" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const { plugin, storageMap, prompts } = await setup(handler, settings);
  const acc = await plugin.signIn();

  assert.equal(acc.id, "admin");
  assert.equal(acc.name, "admin");
  assert.ok(prompts.some((p) => p.text?.includes("登录成功")));

  const session = storageMap.get("session");
  assert.ok(session);
  assert.equal(session.baseUrl, "http://192.168.1.100:5000");
  assert.equal(session.sid, "mock_sid_12345");
});

// 3. QuickConnect resolution and pingpong verification
test("signIn with QuickConnect ID probes candidate IPs and selects verified address", async () => {
  const qcId = "mynas";
  const expectedEzid = createHash("md5").update("MY_SERVER_ID_999").digest("hex");

  const settings = {
    server: qcId,
    username: "testuser",
    password: "testpassword",
  };

  const handler = async (url, init) => {
    // 1. QuickConnect directory query - simulate regional redirect from global to cnc
    if (url.includes("global.quickconnect.to/Serv.php")) {
      return jsonResponse([
        {
          command: "get_server_info",
          errno: 4,
          sites: ["cnc.quickconnect.cn"],
        },
      ]);
    }

    if (url.includes("cnc.quickconnect.cn/Serv.php")) {
      return jsonResponse([
        {
          command: "get_server_info",
          errno: 0,
          server: {
            serverID: "MY_SERVER_ID_999",
            interface: [{ ip: "192.168.1.200" }],
            external: { ip: "203.0.113.10" },
            ddns: "mynas.synology.me",
          },
          service: { port: 5001, ext_port: 50551 },
        },
        {
          command: "get_server_info",
          errno: 0,
          server: {
            serverID: "MY_SERVER_ID_999",
            interface: [{ ip: "192.168.1.200" }],
            external: { ip: "203.0.113.10" },
            ddns: "mynas.synology.me",
          },
          service: { port: 5000, ext_port: 50550 },
        },
      ]);
    }

    // 2. Ping-pong probe
    if (url.includes("/webman/pingpong.cgi")) {
      if (url.startsWith("https://192.168.1.200:5001")) {
        return jsonResponse({ success: true, ezid: expectedEzid });
      }
      return jsonResponse({ success: false }, 500);
    }

    // 3. Auth login
    if (url.includes("/webapi/entry.cgi")) {
      return jsonResponse({
        success: true,
        data: { sid: "qc_session_sid" },
      });
    }

    throw new Error(`Unhandled url: ${url}`);
  };

  const { plugin, storageMap } = await setup(handler, settings);
  const acc = await plugin.signIn();

  assert.equal(acc.id, "testuser");
  const session = storageMap.get("session");
  assert.equal(session.baseUrl, "https://192.168.1.200:5001");
  assert.equal(session.sid, "qc_session_sid");
});

// 4. DSM Auth Error handling
test("signIn translates DSM 2FA and password error codes", async () => {
  const settings = {
    server: "http://192.168.1.1:5000",
    username: "user",
    password: "badpassword",
  };

  const { plugin } = await setup(
    async () => jsonResponse({ success: false, error: { code: 400 } }),
    settings
  );

  await assert.rejects(
    async () => plugin.signIn(),
    (err) => err.message.includes("用户名或密码错误")
  );
});

// 5. Stream URL generation and native format mapping
test("stream generates correct stream.cgi URL and metadata", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "valid_sid_456",
    username: "user",
    account: { id: "user", name: "user" },
  };

  const handler = async (url) => {
    if (url.includes("api=SYNO.AudioStation.Song&method=getinfo")) {
      return jsonResponse({
        success: true,
        data: {
          songs: [
            {
              id: "music_1001",
              title: "Test Track",
              additional: {
                song_audio: {
                  bitrate: 320000,
                  container: "flac",
                  codec: "flac",
                  filesize: 25000000,
                  lossless: true,
                },
              },
            },
          ],
        },
      });
    }
    throw new Error(`Unhandled url: ${url}`);
  };

  const { plugin } = await setup(handler, {}, { session: initialSession });
  const result = await plugin.stream({ id: "music_1001" });

  assert.equal(result.type, "flac");
  assert.equal(result.quality, "lossless");
  assert.equal(result.bitRate, 320000);
  assert.ok(result.url.includes("/webapi/AudioStation/stream.cgi/0.flac"));
  assert.ok(result.url.includes("api=SYNO.AudioStation.Stream"));
  assert.ok(result.url.includes("id=music_1001"));
  assert.ok(result.url.includes("_sid=valid_sid_456"));
});

// 6. Search songs, albums, and artists
test("search correctly maps DSM responses to MyGo Track models", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "valid_sid_456",
    username: "user",
    account: { id: "user", name: "user" },
  };

  const handler = async (url) => {
    if (url.includes("api=SYNO.AudioStation.Search&method=list")) {
      return jsonResponse({
        success: true,
        data: {
          songTotal: 1,
          songs: [
            {
              id: "music_2001",
              title: "Haruhikage",
              artist: "MyGO!!!!!",
              album: "Haruhikage Single",
              additional: {
                song_audio: { duration: 250 },
                song_tag: { artist: "MyGO!!!!!", album: "Haruhikage Single" },
              },
            },
          ],
        },
      });
    }
    throw new Error(`Unhandled: ${url}`);
  };

  const { plugin } = await setup(handler, {}, { session: initialSession });
  const res = await plugin.search({ query: "Haruhikage", kind: "tracks" });

  assert.equal(res.tracks.length, 1);
  const track = res.tracks[0];
  assert.equal(track.id, "music_2001");
  assert.equal(track.name, "Haruhikage");
  assert.equal(track.artists[0].name, "MyGO!!!!!");
  assert.equal(track.album.name, "Haruhikage Single");
  assert.equal(track.duration, 250000);
  assert.ok(track.album.imageUrl.includes("cover.cgi"));
});

// 7. Lyrics query
test("lyrics returns LRC text from Audio Station Lyrics API", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "sid_test",
    username: "user",
    account: { id: "user", name: "user" },
  };

  const lrcContent = "[00:01.00]春日影\n[00:05.00]MyGO!!!!!";

  const handler = async (url) => {
    if (url.includes("api=SYNO.AudioStation.Lyrics")) {
      return jsonResponse({
        success: true,
        data: { lyrics: lrcContent },
      });
    }
    throw new Error(`Unhandled: ${url}`);
  };

  const { plugin } = await setup(handler, {}, { session: initialSession });
  const res = await plugin.lyrics({ id: "music_2001" });

  assert.deepEqual(res, { lrc: lrcContent });
});

// 8. Like / Rating toggle
test("like sets 5-star rating on Synology Audio Station", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "sid_test",
    username: "user",
    account: { id: "user", name: "user" },
  };

  let ratedId = null;
  let ratedValue = null;

  const handler = async (url) => {
    if (url.includes("api=SYNO.AudioStation.Song&method=setrating")) {
      const u = new URL(url);
      ratedId = u.searchParams.get("id");
      ratedValue = u.searchParams.get("rating");
      return jsonResponse({ success: true, data: {} });
    }
    throw new Error(`Unhandled: ${url}`);
  };

  const { plugin } = await setup(handler, {}, { session: initialSession });
  await plugin.like({ id: "music_2001", on: true });

  assert.equal(ratedId, "music_2001");
  assert.equal(ratedValue, "5");

  const likedStatus = await plugin.isLiked({ ids: ["music_2001", "music_9999"] });
  assert.equal(likedStatus["music_2001"], true);
  assert.equal(likedStatus["music_9999"], false);
});

// 9. Home page browsing
test("home aggregates recent, random, albums, and playlists", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "sid_test",
    username: "user",
    serverName: "My-Home-NAS",
    account: { id: "user", name: "user" },
  };

  const handler = async (url) => {
    if (url.includes("api=SYNO.AudioStation.Song")) {
      return jsonResponse({
        success: true,
        data: { songs: [{ id: "song_1", title: "Song 1" }] },
      });
    }
    if (url.includes("api=SYNO.AudioStation.Album")) {
      return jsonResponse({
        success: true,
        data: { albums: [{ name: "Album 1", display_artist: "Artist 1" }] },
      });
    }
    if (url.includes("api=SYNO.AudioStation.Playlist")) {
      return jsonResponse({
        success: true,
        data: { playlists: [{ id: "pl_1", name: "Playlist 1" }] },
      });
    }
    throw new Error(`Unhandled: ${url}`);
  };

  const { plugin } = await setup(handler, {}, { session: initialSession });
  const homeData = await plugin.home();

  assert.equal(homeData.title, "群晖音乐库");
  assert.equal(homeData.subtitle, "My-Home-NAS");
  assert.ok(homeData.sections.length >= 2);
});

// 10. SignOut clears stored session
test("signOut removes session from storage", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "sid_test",
    username: "user",
    account: { id: "user", name: "user" },
  };

  const { plugin, storageMap } = await setup(async () => jsonResponse({}), {}, { session: initialSession });
  assert.ok(await plugin.account());

  plugin.signOut();
  assert.equal(await plugin.account(), null);
  assert.equal(storageMap.has("session"), false);
});

// 11. Folder browsing for root and child directories
test("browse folder:root lists top-level directories as navigation links", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "sid_test",
    username: "user",
    account: { id: "user", name: "user" },
  };

  const handler = async (url) => {
    if (url.includes("api=SYNO.AudioStation.Folder&method=list")) {
      const u = new URL(url);
      const folderId = u.searchParams.get("id");
      if (!folderId) {
        return jsonResponse({
          success: true,
          data: {
            total: 2,
            items: [
              { id: "dir_1", title: "内地歌手", path: "/Music/内地歌手", type: "folder" },
              { id: "dir_2", title: "港台歌手", path: "/Music/港台歌手", type: "folder" },
            ],
          },
        });
      }
      if (folderId === "dir_1") {
        return jsonResponse({
          success: true,
          data: {
            total: 2,
            items: [
              { id: "dir_10", title: "超级市场", path: "/Music/内地歌手/超级市场", type: "folder" },
              {
                id: "music_301",
                title: "测试曲目",
                path: "/Music/内地歌手/测试曲目.flac",
                type: "file",
                additional: {
                  song_audio: { duration: 180 },
                  song_tag: { artist: "内地歌手", album: "合辑" },
                },
              },
            ],
          },
        });
      }
    }
    throw new Error(`Unhandled: ${url}`);
  };

  const { plugin } = await setup(handler, {}, { session: initialSession });

  // Root folders
  const root = await plugin.browse({ page: "folder:root" });
  assert.equal(root.title, "文件夹");
  assert.equal(root.sections.length, 1);
  assert.equal(root.sections[0].links.length, 2);
  assert.equal(root.sections[0].links[0].text, "内地歌手");
  assert.equal(root.sections[0].links[0].page, "folder:dir_1");

  // Child directory with both subfolders and files
  const child = await plugin.browse({ page: "folder:dir_1" });
  assert.equal(child.title, "内地歌手");
  assert.equal(child.sections.length, 2);
  assert.equal(child.sections[0].links[0].text, "超级市场");
  assert.equal(child.sections[1].tracks[0].name, "测试曲目");
});

// 12. Album tracks query with spaces in title
test("album query retrieves songs using album parameter with percent-encoded spaces", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "sid_test",
    username: "user",
    account: { id: "user", name: "user" },
  };

  const handler = async (url) => {
    if (url.includes("api=SYNO.AudioStation.Song&method=list")) {
      assert.ok(url.includes("album=10%20DAY'S"));
      assert.ok(!url.includes("10+DAY"));
      return jsonResponse({
        success: true,
        data: {
          total: 1,
          songs: [
            {
              id: "music_36460",
              title: "此时此刻",
              additional: {
                song_audio: { duration: 240 },
                song_tag: { album: "10 DAY'S", artist: "旅行团乐队" },
              },
            },
          ],
        },
      });
    }
    throw new Error(`Unhandled: ${url}`);
  };

  const { plugin } = await setup(handler, {}, { session: initialSession });
  const result = await plugin.album({ id: "10 DAY'S" });

  assert.equal(result.album.name, "10 DAY'S");
  assert.ok(result.album.imageUrl.includes("method=getcover"));
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].name, "此时此刻");
});

// 13. MP4 / M4A direct streaming without transcoding
test("stream handles mp4 audio container as native m4a stream", async () => {
  const initialSession = {
    baseUrl: "http://192.168.1.50:5000",
    sid: "sid_test",
    username: "user",
    account: { id: "user", name: "user" },
  };

  const handler = async (url) => {
    if (url.includes("api=SYNO.AudioStation.Song&method=getinfo")) {
      return jsonResponse({
        success: true,
        data: {
          songs: [
            {
              id: "music_33915",
              title: "A Murder Of Crows",
              additional: {
                song_audio: {
                  container: "mp4",
                  codec: "aac",
                  filesize: 21524595,
                  bitrate: 256000,
                },
              },
            },
          ],
        },
      });
    }
    throw new Error(`Unhandled: ${url}`);
  };

  const { plugin } = await setup(handler, {}, { session: initialSession });
  const res = await plugin.stream({ id: "music_33915" });

  assert.equal(res.type, "m4a");
  assert.ok(res.url.includes("stream.cgi/0.m4a"));
  assert.ok(res.url.includes("method=stream"));
  assert.ok(!res.url.includes("transcode"));
});
