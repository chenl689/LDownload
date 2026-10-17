# 阶段一：旧版分析与 Electron 迁移建议

检查日期：2026-10-16。范围：静态阅读项目根目录中的 `LDownload1/`；未运行旧版程序、构建或测试。迅雷安装目录另见 [01-thunder-feasibility.md](01-thunder-feasibility.md)。

## 0. 根目录与只读边界

- 当前根目录 `D:\project\LDownload` 只有 `LDownload1/`。`docs/`、`electron/`、`src/`、`vendor/`、`tests/`、`package.json`、`README.md`、`tsconfig.json`、Vite 和 electron-builder 配置均不存在，因此没有同名文件需要覆盖。
- 根目录不是 Git 仓库；`LDownload1/.git` 是独立仓库。其工作树当前有大量未提交修改、删除和未跟踪文件，内部状态不能当作干净发布基线。旧仓库当前分支名为 `V3.0`，而 `Cargo.toml` 与 Tauri 配置版本为 `2.1.2`。
- 旧目录实际拼写是 `LDownload1`。其约 18,165 个文件中包含 `target/`、`dist/` 等大量构建产物；按旧目录约定，它仍只作为只读参考。重构工具配置必须将整个 `LDownload1/` 排除。
- 本轮没有在 `LDownload1/` 中创建、修改、移动或删除文件。新报告放在根目录 `docs/`。

## 1. 旧版技术栈、目录与运行方式

**旧版不是 Electron。** 它是 Tauri 2 桌面应用：Rust 主程序与下载逻辑运行在 Tauri 应用进程/异步运行时中，窗口通过系统 WebView 显示静态网页。Cargo 项目位于 `LDownload1/src-tauri/`，使用 Rust 2021、`tauri = 2`、Tokio、Reqwest、Serde 等；没有根级 `package.json` 或前端 npm 构建链。

UI 是**原生 HTML、CSS 和浏览器 JavaScript**，没有 React、Vue 或其他 UI 框架。主要标记和多数样式在 `ui/index.html`，交互在 `ui/app.js`，磁力任务适配在 `ui/magnet.js`，附加样式在 `ui/magnet.css`。页面通过 `window.__TAURI__` 调用 Tauri 命令和事件；`tauri.conf.json` 设置了 `withGlobalTauri: true`。现有 CSP 含 `'unsafe-inline'`，迁移到 Electron 时应收紧。

| 路径 | 当前内容与用途 | 新版处理建议 |
|---|---|---|
| `LDownload1/ui/` | HTML/CSS/JS 渲染界面；混有 Tauri API 调用 | 复制到根目录 `src/` 后保留布局和交互，逐步替换桥接调用 |
| `LDownload1/src-tauri/src/download.rs` | HTTP/HTTPS/FTP 下载与文件处理 | 仅作功能清单和行为参考，不沿用实现 |
| `LDownload1/src-tauri/src/range_scheduler.rs` | 动态 HTTP 分段调度 | 只参考对外行为和边界，不迁移实现 |
| `LDownload1/src-tauri/src/manager.rs`、`model.rs` | 普通任务、设置、队列、持久化及调度 | 从中整理数据契约；新版重写 |
| `LDownload1/src-tauri/src/magnet/` | Rust BT、磁力任务管理、迅雷适配、UPnP、协议处理 | 不移植手写 BT；按用户确认优先接迅雷引擎，具体接口路径见迅雷报告 |
| `LDownload1/src-tauri/thunder/` | 未跟踪的 C# 迅雷桥接源码和 SDK 副本 | 只读参考；不得视为可再分发许可 |
| `LDownload1/browser-extension/` | Chrome/Edge 与 Firefox 扩展 | 是否迁移需在后续范围确认；不要从旧路径引用 |
| `LDownload1/installer/`、`scripts/`、`.github/` | 旧 Tauri/Rust 构建、安装与 CI | 不作为新版构建配置复用 |
| `LDownload1/docs/` | 旧版架构、磁力差异和安全记录 | 仅作参考，已在本报告吸收的内容需与当前代码核对 |
| `LDownload1/target/`、`dist/`、`.tools/` | 构建产物、缓存及随项目保存的工具 | 不复制进新项目或安装包 |

旧版开发说明是在 `src-tauri/` 下使用 `cargo tauri dev`，先安装 Rust、Tauri CLI 和平台依赖。Windows 发布脚本是 `scripts/build-windows.ps1`，输出 `dist/LDownload.exe` 和 NSIS/自定义安装程序；Linux/macOS 由各自平台构建脚本和 CI runner 原生构建。旧版前端开发不需要单独的 npm install。

## 2. UI 页面、组件和状态

界面是一个主窗口中的单页 DOM，不是组件框架应用。侧栏有“下载”“已完成”“链接收集”“浏览器接管”“设置”；“下载/已完成”切换主任务表筛选，“链接收集”和“浏览器接管”打开工具面板，设置使用侧栏分节的设置面板。

主要 UI 结构如下：

```text
应用窗口
├── 侧栏：导航、默认保存路径、本机工作区
├── 顶栏：搜索、主题、通知按钮、文本链接导入、新建任务菜单
├── 下载概览：下载中/已完成、汇总速度、排序、筛选、批量操作、任务表、分页
├── 新建任务面板：链接/种子、HTTP 元数据、普通文件与磁力文件选择、高级选项
├── 磁力详情面板：种子文件列表和文件勾选
├── 链接收集面板：项目、发现结果、深度/页数与链接过滤
├── 浏览器接管面板：扩展、原生消息主机和桌面链接注册
├── 设置面板：外观、下载、连接、安全、分类/队列、磁力
└── 确认与提示：删除、文件名、完成动作、剪贴板提示、Toast
```

任务表具有搜索、任务状态/类型筛选、排序、分页、手动排序、列开关、分类/队列操作、批量暂停/继续/删除、右键菜单和拖放链接。新建面板保留 HTTP/HTTPS/FTP/Magnet 批量识别、文本链接导入、`.torrent` 选择、普通 URL 元数据探测和磁力多文件选择流程。主题、语言和部分界面偏好由浏览器 `localStorage` 保存；任务与业务设置由后端保存。

**状态管理没有外部库**：`app.js` 中的普通任务列表、筛选、选择、分页、主题和面板状态由模块级变量与 DOM 更新管理；`magnet.js` 单独缓存普通/磁力任务快照，再合并用于渲染。它为磁力 UI 临时加 `magnet:` ID 前缀并据此分派命令。此处的 UI 行为可以保留，但不能保留直接访问 Tauri 的代码。

## 3. UI 与后端的现有耦合契约

### 命令与事件

普通任务 UI 使用的命令包括：

- 列表、设置、目录：`list_downloads`、`get_download_settings`、`update_download_settings`、`default_download_directory`。
- 创建和检查：`inspect_download_url`、`add_download`、`read_download_list_links`、`import_download_list`。
- 操作：`pause_download`、`resume_download`、`resume_downloads_in_order`、`remove_download`、`copy_download_link`、`open_download_file`、`show_download_folder`。
- 分类/队列：`set_download_category`、`set_download_task_queue`、`create_download_queue`、`set_download_queue_paused`、`delete_download_queue`。
- 其他 UI 流程：完成后动作、链接收集 CRUD/执行、浏览器原生消息主机安装、扩展目录打开、桌面链接注册、种子导入。

磁力 UI 使用 `list_magnet_downloads`、`inspect_magnet_files`、`update_magnet_file_selection`、`add_magnet_download`、`import_torrent_download`、暂停/恢复/删除/复制/打开目录和磁力设置命令。新 Electron API 应按业务功能命名并做参数验证，不能暴露通用 `invoke(channel, args)`。

现有事件是完整快照而非增量：`downloads-updated`、`magnet-downloads-updated`、`site-collection-list-updated`、`site-collection-updated`，以及设置更新事件。普通任务进度会在每个任务至少间隔 450 ms 后发布一份全任务列表，即单任务最高约 2.2 Hz；每次发布还会序列化并写入普通任务 JSON。磁力任务由另一套管理器发全量快照。没有“可见且变化任务”的增量契约或虚拟列表。

### 任务、状态和设置字段

普通任务 `DownloadTask` 的 UI 字段包括：`id`、`url`、`fileName`、`directory`、`status`、`totalBytes`、`downloadedBytes`、`segments`、`speedBytesSec`、`error`、校验算法/值、分类与自动分类标记、内容类型、计划/重复计划、队列、凭据引用、`etag`、`lastModified` 和创建/更新时间。普通状态为 `queued`、`downloading`、`merging`、`scanning`、`paused`、`completed`、`failed`。进度段含索引、字节数、范围起止和 active 标记。

磁力 `MagnetTask` 字段包括 `id`、`url`、`infoHash`、文件名/目录、种子路径、勾选文件索引、实际下载引擎、迅雷路径、状态、总量/已下载/速度、错误/阶段、活跃 peer、DHT 节点、诊断信息及时间。状态为 `queued`、`downloading`、`paused`、`completed`、`failed`；文件项含 `index/path/size`。两种任务目前不是一个后端接口或一份持久化记录。

普通设置的现有默认值/限制包括：并发任务 3（1–10）、HTTP 自动分段开启、连接超时 30 秒（5–300）、失败重试 3 次（最多 10）、普通下载限速 0 表示不限、系统代理、默认下载目录、分类规则、可见列、完成动作、剪贴板监控关闭、病毒扫描器、简体中文、工具栏按钮和最小化到托盘。磁力设置包括引擎 `auto`、解析等待 10 秒（1–300）、最多 48 个 peer（1–64）、UPnP 开启、公开 Tracker 开关、保存目录和病毒扫描器。

当前实现没有全局类型化 IPC 清单，也没有统一错误码（命令错误通常是字符串）。新契约建议统一普通/BT任务快照、状态和错误码；`DownloadEngine` 作为业务层唯一下载接口；由 preload 只暴露明确的方法和事件订阅；主进程校验所有参数，渲染进程不接触 Node 或 `ipcRenderer`。

## 4. 旧版功能与已知差距

### 已实现或 UI 明确支持

- HTTP/HTTPS/FTP 普通下载：重定向、元数据探测、认证、系统/自定义代理、重试、暂停/继续、校验、计划、重复计划、队列、类别、病毒扫描和完成动作。
- HTTP 安全分段与回退：按 `Range` 和实体校验器决定是否并发；文档记录默认最多 16 条/任务、全局 24 条请求、按剩余范围动态拆分。该调度器已有独立源码和测试，但仍在 Tauri/Rust 进程里。
- BT/磁力：Rust 自写 BTv1 路径支持 Tracker、DHT、PEX、元数据、分片校验和恢复；Windows 可选迅雷 SDK 适配。旧版已有磁力文件勾选 UI，但内置 Rust 路径目前默认整包下载；完整 BTv2、uTP、NAT-PMP、持久完整 DHT 等能力有缺口。旧文档明确说这不是完整 qBittorrent Enhanced，也没有调用 qBittorrent/libtorrent 或迅雷云端加速。
- 托盘、关闭到托盘、单实例、`ldownload://` 注册与启动参数/深链转发；系统托盘由 Tauri 主进程管理。
- 默认关闭的剪贴板轮询（约 1.2 秒）和确认提示；现识别 HTTP/HTTPS/FTP/Magnet，不识别 `thunder://`。
- Chrome/Edge/Firefox 浏览器扩展与原生消息主机；文本链接导入、拖放和站点静态链接收集。
- 可选哈希校验（MD5/SHA 系列）、凭据存系统密码库、完成后打开文件/目录或询问退出/关机。

### 明确未实现或值得重写的部分

- 旧版主任务、分段写盘、哈希和队列均在 Tauri Rust 运行时所在应用进程；没有独立可崩溃重启的 engine process 和已定义的恢复心跳协议。
- 普通和磁力使用两套 manager、任务存储和命令/事件；`magnet.js` 用 ID 前缀在 UI 合并，不是统一 `DownloadEngine`。持久化为 JSON（普通任务/设置和磁力任务/设置分开），没有 SQLite；普通任务有段信息、ETag/Last-Modified，但没有独立 `.ldl` 元数据文件。
- 进度事件是每任务全量列表而不是变化增量，当前最多约 2.2 Hz；主线程以完整快照写 JSON。对任务多或进度频繁时会增加磁盘写放大。没有虚拟列表。
- 当前页面事件直接依赖 `window.__TAURI__`，应用全局暴露 Tauri API；HTML/CSS 有内联样式，CSP 放宽 `'unsafe-inline'`。这些与 Electron 的隔离 preload/API allowlist 不兼容，需迁移桥接并收紧 CSP。
- 工具栏通知按钮当前只显示“没有新通知”，完成提示是 UI toast；没有看到系统通知实现。未发现开机自启实现/依赖。旧版注册的是 `ldownload`，不是 `magnet:`。
- 普通下载 UI 不提供自定义请求头、完整 Cookie、SOCKS5 等本任务要求项；应在新任务/设置模型中明确补齐，而不是假定旧 UI 已有。
- BT 引擎功能与调度有清晰缺口；旧版成功日志证明本机 Thunder SDK 2.86.202.143 的窄范围 BT 路径曾跑通，但旧桥接直接绑定 DLL 导出并处理原始任务信息缓冲区。迅雷开放平台现有公开 Electron/Node 下载 SDK 明确暂不支持 BT/磁力；另有支持 BT 的公开微应用任务 API，但只能在迅雷客户端微应用运行时调用。用户已明确不采用自写 BT 或 libtorrent；独立 Electron 调用旧 SDK 是否继续采用，仍需在“公开接口/不逆向”约束下定路径，见迅雷报告。

这些条目区分了代码/文件直接可见的事实与迁移风险；本阶段没有对网络、公网速度或功能完整性做运行验收。

## 5. UI 迁移方案

1. 将 `ui/index.html`、`app.js`、`magnet.js`、`magnet.css` 和应用图标复制到根目录 `src/`。不链接、不引用、不格式化旧目录。
2. 原样保留 vanilla HTML/CSS/JS 的组件结构与交互。先抽离 `app.js`/`magnet.js` 中的 Tauri API 调用到一个渲染器 adapter；后续可渐进改为 TypeScript，不引入 React/Vue。
3. 建立共享 TypeScript 契约和 `window.ldownload` 类型声明；preload 使用 `contextBridge` 暴露窄接口，如 `downloads.add/pause/resume/remove/list`、`settings.get/update`、`downloads.onSnapshot(callback)`。事件回调只传类型化数据，不把 `ipcRenderer`、事件对象或通用通道映射暴露给渲染器。
4. 旧 HTML 里的内联样式迁移为 CSS 类；脚本、图片、字体只从本地包加载。Electron 窗口使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，拒绝未授权导航和新窗口，CSP 限制本地资源。
5. UI 第一阶段接 mock engine，让旧任务表、新建磁力/种子流程、设置、托盘状态提示等可运行；引擎进程、持久化和平台集成分别接入后再验收。

Electron 官方安全文档建议开启 context isolation、sandbox、限制导航/新窗口并定义 CSP；官方 `utilityProcess` 提供 Node 子进程和 MessagePort 通信，可用于把下载热路径隔离出主进程。[安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)

## 6. 阶段二前的技术选型建议（本阶段未安装依赖）

### 构建与打包

建议 **electron-vite + electron-builder**：前者集中处理 main/preload/renderer 三种构建目标并提供渲染器 HMR，适合当前无框架网页 UI；后者符合指定的 Windows NSIS 安装包要求，并提供 `extraResources`/asar 配置和原生依赖重编译流程。`electron-builder` 文档说明 NSIS 是 Windows 默认安装格式；Electron 文档说明 native Node 模块必须针对 Electron ABI 重编译，builder 有原生依赖重建流程。[electron-vite 指南](https://electron-vite.org/guide/)、[electron-builder 配置](https://www.electron.build/configuration/)、[Electron 原生模块](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

此为推荐，不是在未确认前引入依赖。配置需显式只包含根目录的 `electron/`、`src/`、`vendor/` 和构建产物，并对 `LDownload1/` 做排除；`vendor/` 原生二进制放 `extraResources` 或 asar 外路径。

### 持久化

建议任务、段状态和设置采用单一 SQLite 数据库，文件内容仍放在用户下载目录；生产持久化推荐评估 `better-sqlite3`。事务适合原子保存任务/段状态，索引查询比频繁重写完整任务 JSON 更直接。它是原生模块，需要按 Electron ABI 和目标架构重建，并在打包时正确解包；CI/本机脚本都要锁定 Electron 版本、架构及工具链。

替代方案是带原子替换/备份的 JSON：无本机编译、依赖少，可用于 mock 阶段和小型设置文件；但任务/段状态持续重写、迁移、并发与恢复规则需自行实现。建议第二阶段 mock 先不绑定数据库，确认后在接普通下载前完成选型和存储设计。

### BT 引擎

用户后续明确选择将校验通过的 Thunder SDK 复制进新应用，并要求打包版只使用包内副本、不检测目标电脑是否安装迅雷；同时明确不自写 BT 引擎、不用 libtorrent。SDK 的公开 ABI 与再分发许可仍未得到迅雷官方确认，详见 [01-thunder-feasibility.md](01-thunder-feasibility.md)。

## 7. 后续决策与当前实现状态

本报告前文记录的是阶段一对旧版源码的只读分析。后续用户确认了以下实施边界：

- `LDownload1/` 只读，并从新项目 Git、构建和测试中排除。
- UI 经用户后续明确选择迁移到 React + TypeScript，视觉布局和 CSS 保留；旧 DOM renderer 脚本已移除。
- 磁力/种子只调用应用包内随附的 Thunder SDK，不回退到目标电脑上的安装副本；不自写 BT 引擎，也不使用 libtorrent。

新项目已实现 Electron 主进程、隔离 preload API、utility process、HTTP/HTTPS 与 FTP/FTPS 下载、任务/设置持久化、日志、代理、站点链接收集、浏览器原生消息主机、托盘与协议处理、Windows x64 NSIS 打包及随包 SDK 路径校验。应用品牌图标统一使用 icon/app-icon.svg：侧边栏、favicon、窗口、托盘、安装包和 Chromium/Firefox 扩展均使用同一设计；构建脚本从该 SVG 生成 Windows ICO、macOS ICNS、Electron/Linux PNG 与扩展尺寸 PNG。普通下载在元数据探测前按来源链接查重，并在并发提交后复核；目标文件本身的占用单独提示。HTTP/HTTPS 支持系统代理/PAC 与自定义 HTTP/HTTPS/SOCKS5 代理；FTP/FTPS 当前要求直连。进度快照已限制为最多 8 Hz，任务状态结构变化立即保存，下载进度约每秒保存一次。用户提供的 magnet 已由随包 Thunder SDK 解析并真实传输 17,461,900 字节后按测试上限停止（目标文件约 6.48 GB，未完整下载）。当前安装脚本拦截策略按用户选择保持不变；可用现有依赖树通过直接调用 electron-vite/electron-builder 完成打包。SDK ABI 稳定性与再分发授权仍未获迅雷官方确认，详见 [01-thunder-feasibility.md](01-thunder-feasibility.md)。
