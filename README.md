<p align="center">
  <img src="icon.png" width="96" height="96" alt="Synology Audio Station Icon" />
</p>

# MyGo Music - 群晖 Synology Audio Station 插件

[MyGo Music](https://music.egoist.dev/) 播放器的第三方插件，用于在原生桌面客户端中直接接入群晖 NAS 的 **Audio Station (DS Audio)** 媒体库，享受丝滑的原生本地级播放体验。

<p align="center">
  <a href="mygo-music://install-plugin?repo=liuxiaofengone/synology-DSAudio-mygo-music-plugin">
    <img src="https://img.shields.io/badge/Install%20in-MyGo%20Music-E53935?style=for-the-badge&logo=apple-music&logoColor=white" alt="Install in MyGo Music" />
  </a>
</p>

---

## ✨ 核心特性

- **QuickConnect 智能寻址**：直接输入群晖 QuickConnect ID，插件自动查询群晖中央服务器，并探测局域网内网 IP、公网 WAN/DDNS 端口，优先建立最低延迟的高速直连。
- **直连与内网穿透兼容**：除 QuickConnect ID 外，也支持直接填写内网 IP（如 `192.168.1.50:5000`）、域名或 Tailscale / WireGuard / 穿透节点地址。
- **无缝音频流播放**：支持 FLAC、APE、WAV、MP3、AAC、OGG 等多种主流格式，原生支持无损音质（Lossless）与 HTTP Range 拖拽定位。原生支持 MP4/M4A 容器直接串流，对于播放器不支持的非常规格式自动走群晖硬件实时转码。
- **媒体库全能浏览**：
  - 最近添加、随心漫游、热门专辑与个人歌单主页汇聚
  - 全部歌曲、专辑列表、歌手列表分类浏览
  - **文件夹层级目录导航**：支持 NAS 原始音乐文件树浏览，保留目录真实层级，可在文件夹中直接播放
  - 关键词全局检索歌曲、专辑、歌手与播放列表
- **多级智能封面补全引擎**：
  - **第 1 级**：音频文件内嵌 ID3 艺术封面提取
  - **第 2 级**：群晖文件夹封面（`cover.jpg` / `folder.jpg`）自动关联提取
  - **第 3 级（云端高画质补全）**：针对本地缺失封面的专辑，自动联动 QQ 音乐（500x500 超清）、网易云音乐与 Apple iTunes，支持智能过滤版本修饰词，毫秒级无感补全并自动持久化缓存
- **同名合辑精准防碰撞**：采用复合专辑唯一标识，彻底解决多艺术家同名合辑（如《50 Classical Masterworks》系列）在客户端内的路由与曲目筛选冲突。
- **歌词与标签清洗**：支持群晖内嵌及外挂 LRC 歌词同步滚动；严格优先解析 ID3 元数据，自动剥离多余的文件名扩展后缀。
- **喜欢与星级同步**：在播放器中点击“喜欢”，自动同步群晖 Audio Station 的 5 星歌曲评级。
- **安全与 2FA 支持**：支持群晖 DSM 6 / DSM 7 两步验证（OTP 动态口令），登录凭据本地加密持久化，避免频繁登录。

---

## 🚀 安装方法

### 方式一：一键快速安装（推荐）

直接点击顶部的 **[Install in MyGo Music](mygo-music://install-plugin?repo=liuxiaofengone/synology-DSAudio-mygo-music-plugin)** 徽章，或在系统浏览器中访问以下协议链接，MyGo Music 客户端将自动唤醒并提示一键下载安装：

```text
mygo-music://install-plugin?repo=liuxiaofengone/synology-DSAudio-mygo-music-plugin
```

### 方式二：在客户端内搜索或通过 GitHub 安装

1. 打开 **MyGo Music** 客户端，进入 **设置 (Settings)** -> **插件 (Plugins)** -> 点击右上角 **`+`**。
2. 可直接搜索插件名称，或选择 **从 GitHub 安装** 并输入：`liuxiaofengone/synology-DSAudio-mygo-music-plugin`。
3. 安装完成后，客户端会自动检测并支持在线静默更新。

### 方式三：从本地 ZIP 压缩包导入

1. 在本项目中执行打包命令（或从 GitHub Releases 下载构建好的 ZIP）：
   ```bash
   npm run pack
   ```
   打包产物位于 `dist/synology-audio-0.1.0.zip`。
2. 打开 **MyGo Music** 客户端。
3. 进入 **设置** -> **插件** -> 点击右上角 **`+`** 号。
4. 选择 **从本机 ZIP 安装**，选取 `dist/synology-audio-0.1.0.zip` 即可完成安装。

### 方式三：手动放置到插件目录

1. 在 MyGo Music 设置的插件页面中点击 **打开插件目录**。
2. 将本仓库根目录作为一个文件夹复制到该目录下。
3. 重启 MyGo Music 客户端。

---

## ⚙️ 配置说明

安装完成后，在 MyGo Music 设置页面的“插件”列表中找到 **群晖 Audio Station**，填写以下配置：

| 参数项 | 说明 | 示例 |
| :--- | :--- | :--- |
| **QuickConnect ID 或 服务器地址** | 群晖 QuickConnect ID 或完整的直连地址（含端口） | `mynas` 或 `192.168.1.100:5000` 或 `https://nas.domain.com:5001` |
| **用户名** | DSM 登录用户名 | `admin` |
| **密码** | DSM 登录密码 | `******` |
| **2FA 动态验证码 (可选)** | 若群晖账号开启了双重验证，首次登录时填写当前 6 位动态验证码 | `123456` |

配置完成后：
1. 在主界面左上角或侧边栏将音频源切换至 **群晖 Audio Station**。
2. 点击右上角账号进行登录（如已保存配置将自动验证并登录成功）。
3. 登录成功后即可在侧边栏浏览主页推荐、全部曲目、专辑、歌手以及自己的播放列表。

---

## 🛠️ 本地开发与测试

本插件遵循 MyGo Music 官方原生插件规范，无外部 Node 运行时依赖，纯标准 ES Module 实现。

```bash
# 语法合规性检查
npm run check

# 运行自动化单元测试
npm test

# 打包插件 ZIP
npm run pack
```

---

## 📄 开源许可

本项目基于 [MIT 许可证](LICENSE) 开源。
