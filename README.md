# Usage Together · 用量伴侣

一个 macOS 菜单栏小工具，同时显示 **GPT（Codex / ChatGPT）** 和 **Claude** 的账户剩余额度、刷新时间和重置券，还会在额度要被重置时提醒你。

*A small macOS menu-bar app that shows your remaining Codex/ChatGPT and Claude usage side by side, with reset countdowns, reset-credit reminders and alerts when Codex limits are about to be reset. Read-only: it never sends chats or changes account settings.*

<p align="center">
  <img src="docs/screenshot-dark.png" alt="深色模式" width="300">
  <img src="docs/screenshot-light.png" alt="浅色模式" width="300">
</p>

<p align="center"><sub>截图使用程序自带的演示数据，不是真实账户用量。</sub></p>

## 功能

- **菜单栏**显示两边的 5 小时剩余额度，比如 `G 76%  C 54%`（G = GPT，C = Claude，`*` 表示数据已过时）。
- **悬浮小窗口**里，每一边的大数字是 5 小时剩余额度，下面是 5 小时刷新倒计时、每周剩余额度和每周刷新时间。点「更多」可以看其他额度窗口，比如按模型分的每周额度。
- Claude 的 5 小时额度从你发出第一条消息才开始计时，还没用过时会显示「还没开始计时」。GPT 的 reserved 额度不显示。
- **重置券提醒**：显示 GPT 和 Claude 的重置券数量。快到期的重置券在到期前 3 天提醒一次，之后每 12 小时提醒一次，直到用掉或到期。
- **Tibo 动态提醒**：每 10 分钟检查一次 Tibo（OpenAI Codex 负责人）在 X 上公开发的消息。他说要重置 Codex 额度时，菜单栏出现 ⚠︎，窗口顶部出现提醒，并弹出系统通知，提醒你抓紧用完额度。
- **深色 / 浅色**两种主题，点右上角 ☀ / ☾ 切换。
- 窗口会出现在所有桌面和全屏应用上，切换应用或桌面时一直跟着你。
- 每 5 分钟自动刷新，也可以点 ↻ 手动刷新。

## 运行要求

| 项目 | 要求 |
| --- | --- |
| 系统 | macOS 13 或以上 |
| GPT 数据 | 本机已安装并登录 ChatGPT / Codex 桌面版，或 Codex CLI |
| Claude 数据 | 以下任意一种：已登录的 Claude Code、已登录的 Claude 桌面版，或手动填写的 sessionKey |
| 构建和测试 | Node.js 20 或以上（Apple Silicon 电脑需要 arm64 版本） |
| 第三方依赖 | 无，只用 Node.js 自带模块和 macOS 自带工具 |

只登录了其中一边也可以用，另一边会显示「—」和提示。

## 快速开始

```sh
git clone https://github.com/PaulChen0508/usage-together.git
cd usage-together

npm test          # 运行自带测试
npm run preview   # 用演示数据启动本地服务，把输出的地址粘到浏览器里就能预览界面
npm run build     # 构建应用，输出到 dist/Usage Together.app
```

也可以不用 npm，直接运行：

```sh
sh build.sh "/绝对路径/Usage Together.app" "$(which node)"
```

`build.sh` 会把你指定的 Node.js 可执行文件一起打包进应用，所以构建出来的应用在别的 Mac 上不需要再装 Node。应用使用本地临时签名，没有经过 Apple 公证，第一次打开时可能需要在「系统设置 → 隐私与安全性」里点「仍要打开」。

## 使用

- **单击**菜单栏的用量数字弹出菜单；**双击**打开窗口，再双击收起。
- 拖动窗口最上面的细条可以移动窗口。
- 窗口右上角：☀ / ☾ 切换主题，↻ 刷新，? 查看说明，「隐藏」收到菜单栏。
- 退出请用菜单栏菜单里的「退出」，或说明里的「退出程序」。

### Claude 读不到怎么办

程序会按顺序尝试三种方式读取 Claude 用量：

1. **Claude Code 的登录**：从 macOS 钥匙串或 `~/.claude/.credentials.json` 读取。
2. **手动填写的 sessionKey**：Claude 读取失败时，窗口里会出现「Claude 读不到？手动填写 sessionKey」。在浏览器登录 claude.ai，打开开发者工具 → Application / 存储 → Cookies → claude.ai，复制 `sessionKey` 的值（以 `sk-ant-` 开头）粘贴进去即可。
3. **Claude 桌面版的登录**：读取桌面版本机保存的登录信息。第一次读取时 macOS 会弹出钥匙串授权（Claude Safe Storage），点「始终允许」。

## 数据范围和准确性

- GPT 额度是 **Codex / ChatGPT 的账户额度**，不包括 OpenAI API 的账单用量。多个模型可能共用一份额度，程序不会给每个模型编一个独立额度。
- 剩余比例 = 100% − 已用比例，不能换算成固定的聊天次数。
- 账户没有返回的数据显示「—」，不会当成 0% 或 100%。
- 读取失败时保留上一次成功的数据，并标明是旧数据。
- 接口返回 HTTP 429（限流）时，程序会暂停查询 15 分钟。
- Tibo 提醒依赖 X 的公开页面和几个镜像站，它们打不开时，窗口底部的「Tibo 动态」会显示检查失败，不影响用量显示。

## 工作原理

- **GPT**：在本机启动 `codex app-server`，只调用 `account/rateLimits/read` 和 `model/list` 两个只读接口。
- **Claude**：用 Claude Code 的登录请求 `api.anthropic.com/api/oauth/usage`；用 sessionKey 或桌面版登录时，请求 `claude.ai` 上的用量接口。
- **Tibo 动态**：读取 X 的公开时间线（失败时换用 Nitter 镜像），再加上 Google News 的 RSS。
- **网络**：优先使用 macOS 自带的网络功能发请求，所以会自动跟随系统代理。
- **界面**：由一个只监听 `127.0.0.1` 的本地服务提供，地址里带有每次启动随机生成的访问码，并检查 Host 和 Origin，其他网页无法访问。
- **原生窗口**：`native.js` 用 macOS 自带的 JavaScript for Automation (JXA) 创建悬浮窗口、菜单栏图标和系统通知。

## 隐私和安全

- 只读取用量，不发送聊天，不消耗重置券，不修改任何账户设置。
- 登录信息只在内存中使用，只发给对应的官方接口（Anthropic / claude.ai），不会发到任何其他地方，也不会写进日志或界面。
- 程序在本机 `~/Library/Application Support/Usage Together/` 里保存这些文件，权限都只有你自己可读写：
  - `usage.json`：最近一次的用量（不含登录信息）
  - `reminders.json`：哪些提醒已经发过
  - `theme.txt`：深色还是浅色
  - `claude-session-key`：只有你手动填写了 sessionKey 才会有，可以在窗口里点「清除」删掉
- 不会把任何数据上传到第三方服务器。

## 项目结构

| 文件 | 作用 |
| --- | --- |
| `backend.js` | 本地服务：读取 GPT 和 Claude 用量、Tibo 动态、提醒、缓存、提供界面 |
| `native.js` | macOS 原生悬浮窗口、菜单栏和系统通知 |
| `index.html` / `ui.js` / `style.css` | 窗口里显示的界面 |
| `test.js` | 自动测试（数据解析、模拟 Codex、本地服务的访问限制、退出流程等） |
| `build.sh` | 构建 `.app` 应用包 |
| `AppIcon.icns` | 应用图标 |
| `package.json` | 项目信息和 `npm` 命令 |
| `Node-LICENSE.txt` | 打包进应用的 Node.js 的许可证 |

## 常见问题

**Claude 显示「登录已过期」**：打开一次 Claude Code 或 Claude 桌面版，登录会自动续期，然后点刷新。也可以改用手动填写 sessionKey。

**GPT 显示「未找到 Codex」**：安装 ChatGPT / Codex 官方桌面版或 Codex CLI。如果装在不常见的位置，可以用环境变量 `USAGE_CODEX_PATH` 指定路径。

**数字后面有 `*`**：表示数据超过 10 分钟没更新，或者已经过了刷新时间还没读到新数据。

## 版本记录

- **2.3.0**（当前版本）：菜单栏和窗口改为突出 5 小时剩余额度；新增深色 / 浅色主题、重置券到期提醒、Tibo 重置动态提醒和系统通知；Claude 支持 Claude 桌面版登录和手动 sessionKey；窗口改为小巧的悬浮样式，出现在所有桌面和全屏应用上；单击菜单栏弹出菜单，双击开关窗口。
- **2.0.2**：修复切换紧凑视图时闪退的问题。
- **2.0.1**：修复隐藏和退出按钮；退出时会同时结束本地服务。
- **2.0.0**：重写数据层，支持全部 GPT 额度分组、自动读取模型列表、Claude 两种返回格式。

## 注意

- 这是个人项目，**不是 OpenAI 或 Anthropic 的官方产品**，与它们没有任何关联。
- Claude 的用量接口没有公开文档，服务端以后的变动可能导致读取失败。

## 许可

代码使用 [MIT License](LICENSE)。`Node-LICENSE.txt` 是打包进应用的 Node.js 运行时的许可证。
