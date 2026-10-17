# LDownload

LDownload 是一个本地运行的桌面下载管理器。当前版本使用 Electron、React 和 TypeScript 构建，主界面支持中文与英文；下载任务由独立的 Electron utility process 执行。

- 当前应用版本：3.4.1（见 package.json）
- 应用标识：LDownload
- 安装包目标：Windows x64 / NSIS
- 迁移分析与迅雷 SDK 调研见 docs/

## 项目背景

LDownload 起源于一个很实际的愿望：让下载工具回归下载本身。我们希望降低对 IDM 等收费下载工具的依赖，减少迅雷客户端广告带来的干扰，同时获得稳定、顺手的磁力与种子下载体验。

项目早期曾计划集成增强版 qBittorrent 作为磁力下载后台引擎，但实际效果未达到预期，难以满足项目对稳定性和下载体验的要求。经过评估，项目最终选择迅雷引擎处理磁力与种子任务，并通过随应用集成的 SDK 接入，让用户无需打开迅雷客户端，就能在 LDownload 中统一管理下载任务，减少客户端广告对使用流程的干扰。

围绕这一目标，LDownload 将 HTTP/HTTPS、FTP/FTPS 与磁力任务整合进同一款本地桌面应用，提供清晰的任务管理、下载控制与进度追踪。

## 功能概览

| 功能 | 当前实现 |
| --- | --- |
| HTTP / HTTPS | 元数据探测、Range 并发分段、动态调度、断点恢复、重试、速度限制、自定义请求头与认证、代理、可选哈希校验和病毒扫描 |
| FTP / FTPS | 单连接下载、重试、速度限制、可选校验和病毒扫描；服务器提供 SIZE 与 MDTM 时可校验并恢复断点 |
| 磁力链 / .torrent | Windows 上通过随应用分发的固定版本迅雷 SDK 适配器处理；支持读取文件列表、选择文件、暂停/继续与任务诊断 |
| 任务管理 | 搜索、排序、分页、手动排序、分类、命名队列、批量暂停/继续/删除、计划和重复计划 |
| 链接导入 | 批量粘贴链接、文本链接列表导入、.torrent 文件导入 |
| 站点链接收集 | 从起始网页递归收集同源页面中的文件链接；遵循 robots.txt，不执行页面脚本 |
| 浏览器接管 | Chrome、Edge、Firefox 扩展；可从上下文菜单或扩展弹窗发送链接，自动拦截下载链接为可选功能 |
| 桌面集成 | 托盘、关闭到托盘、完成通知、剪贴板链接确认、magnet: 与 ldownload: 协议、.torrent 文件关联 |
| 本地日志 | 应用日志与任务日志，支持在任务菜单中查看最近记录 |

## 下载引擎与支持范围

### HTTP / HTTPS

普通链接任务由 utility process 中的 HTTP 引擎执行。程序先探测文件名、大小和 Range 支持情况，再按服务器能力选择并发分段或单连接传输。

- 可选择每个任务使用 1、2、4、8、16 或 32 个逻辑分段；默认 8。服务器不支持 Range 时使用单连接。
- 分段任务支持动态重新分配网络区间、重试、暂停后恢复与断点校验。下载过程中会生成 .part、.ldl 等临时文件。
- 支持全局和单任务速度上限、请求超时、最大重试次数、自定义请求头、Cookie、Referer、User-Agent 与 HTTP Basic 认证。
- 代理模式包括系统代理、自定义代理和禁用代理。HTTP/HTTPS 自定义代理支持 HTTP(S) 与 SOCKS5；系统代理交由 Electron 网络层处理系统设置与 PAC。
- 对不安全的明文 HTTP Basic 认证或经未加密 HTTP 代理发送凭据，必须在设置中明确允许。
- 用户可设置预期校验值和算法；可选配置外部病毒扫描器，在文件下载完成后扫描再完成任务。
- 计划任务支持指定开始时间，以及按日或按周重复。

自定义代理连接失败时任务会报错，不会静默改为直连。HTTP/HTTPS 的系统代理设置和 PAC 由 Electron 网络栈处理。

### FTP / FTPS

FTP 与 FTPS 使用 basic-ftp，运行在同一个隔离引擎进程中。传输为单连接；支持重试、任务限速、校验和、病毒扫描及受条件限制的断点恢复。

- 断点续传只有在服务器同时提供可用于核对的文件大小（SIZE）和修改时间（MDTM）时才会启用。
- 当前 FTP/FTPS 要求直接连接，不使用 HTTP 引擎的代理设置。
- 普通 FTPS 使用显式 TLS；端口 990 使用隐式 TLS。

### 磁力链与种子文件

BT 任务通过独立的 ThunderBridge.exe sidecar 调用 vendor/thunder/sdk 中固定版本的迅雷 SDK。下载引擎不搜索目标电脑的迅雷安装目录，也不会回退到另一个 SDK。

- 支持从磁力链接解析种子元数据、读取 .torrent、预览文件列表、选择要下载的文件，以及暂停、继续、移除任务。
- 默认引擎固定为 Thunder；项目没有自写 BT 协议引擎。
- SDK DLL 会进行 SHA-256 校验。校验不匹配或 SDK 初始化失败时，引擎会报告不可用。
- 任务状态和速度由适配器映射到统一任务快照；任务文件、元数据与运行状态留在本机。

这套随包 DLL 的调用方式来自项目已有的本地 SDK 集成。仓库材料没有确认它属于迅雷公开支持的稳定 ABI，也没有确认厂商的再分发授权；不要把它描述为官方公开 SDK 或兼容性承诺。相关调研见 [docs/01-thunder-feasibility.md](docs/01-thunder-feasibility.md)。

## 界面使用

### 创建下载任务

1. 在“下载”页选择“新建链接任务”，粘贴一个或多个 HTTP、HTTPS、FTP、FTPS 或 Magnet 链接。
2. 普通链接可先探测元数据，检查文件名和大小；需要时修改保存目录、文件名、分类、队列、计划时间、速度上限、校验值或认证参数。
3. 磁力任务会读取种子元数据，显示文件清单供选择；也可以通过“导入”选择 .torrent 文件。
4. 创建后在任务列表查看状态、进度、大小、速度和错误信息。任务行菜单提供暂停、继续、移除、打开文件/目录和查看任务日志等操作。

重复的普通下载链接会在元数据探测前按标准化来源地址检查；URL 片段不参与比较。磁力任务按 BTIH 去重。程序也会检查正在添加的任务和目标文件，避免同一目标发生并发写入。

### 导入链接列表或种子

“导入”可读取 .txt、.lst、.urls 链接列表或 .torrent。链接列表按行读取；空行会被忽略，符合支持协议的链接会进入常规任务创建流程。

### 队列与调度

- 下载队列可在设置中创建、暂停或删除，也可对任务指定队列。
- 全局并发下载数与每任务 HTTP 分段数可分别配置。
- 可对单个任务设置速度上限、类别、开始时间和重复间隔。
- 关闭应用后，正在运行的任务会在下次启动时恢复为暂停状态；打开应用后可按需继续。

### 剪贴板、完成操作与托盘

剪贴板监控默认关闭。启用后，应用运行期间发现可识别链接会先提示，用户确认后才加入任务。下载完成动作可配置为无操作、打开文件、打开目录、退出应用或关机；可选择最小化到托盘、登录时启动，并通过系统通知获知任务完成情况。

## 站点链接收集

“链接收集”可保存多个采集项目，并设置起始 URL、最大深度、最多访问页数、文件扩展名、包含模式和排除模式。采集结果可勾选后加入下载队列。

实现边界和保护：

- 只访问起始地址的同源 HTTP/HTTPS 页面；不执行 JavaScript。
- 请求前读取并遵循站点的 robots.txt。遇到拒绝访问、服务端错误或访问限制时可能停止采集。
- 页面响应体限制为 2 MiB，重定向最多 5 次，请求间隔至少 500 ms。
- 界面允许深度 0–4、页数 1–200；单个项目最多保留 1,000 个发现链接。
- 采集器只解析静态 HTML 中的常见链接和资源属性，不等同于浏览器渲染或动态网页爬虫。

## 浏览器扩展

仓库中包含 Chromium 与 Firefox 扩展，位于 vendor/browser-extension/chromium 和 vendor/browser-extension/firefox。扩展可以在浏览器扩展管理页以“加载已解压的扩展”方式加载。

在 LDownload 的“浏览器接管”页可按以下步骤配置：

1. 选择 Chrome、Edge 或 Firefox，并打开对应的扩展目录。
2. 在浏览器中加载该目录；Chrome/Edge 使用 Chromium 目录，Firefox 使用 Firefox 目录。
3. 将浏览器扩展 ID 填入应用并安装原生消息主机。Firefox 使用固定 ID ldownload@open-source.local；Chrome/Edge 使用扩展管理页显示的 32 位 ID。
4. 可选注册桌面 ldownload:// 链接处理程序。

扩展通过浏览器 Native Messaging 的标准输入/输出与桌面程序通信，不开启本地网络端口。右键菜单和扩展弹窗可手动发送链接；自动接管默认关闭，需要用户在扩展中启用并授予站点权限。Chrome/Edge 与 Firefox 的权限模型由浏览器管理。

.torrent 文件也注册为 Windows 安装包的文件关联，双击打开时应用会接收文件并提示导入。

## 设置参考

初始设置值定义在 electron/process/engine-worker.ts 和 src/shared/contracts.ts 中。首次启动时主要默认值如下：

| 项目 | 默认值 |
| --- | --- |
| 最大并发下载任务数 | 3 |
| HTTP 每任务逻辑分段数 | 8 |
| 连接超时 | 30 秒 |
| 最大重试次数 | 3 |
| 全局速度上限 | 不限速 |
| 普通下载代理 | 禁用 |
| 默认下载目录 | 操作系统下载目录 |
| 界面语言 | 简体中文 |
| 完成操作 | 无 |
| 剪贴板监控 | 关闭 |
| 磁力元数据重试等待 | 10 秒 |
| 磁力 UPnP / 公共 Tracker | 关闭 |

设置面板可调整外观与工具栏、下载目录、并发和分段、网络超时与重试、代理、列显示、安全提示、病毒扫描器、命名队列、磁力与种子选项。界面支持 zh-CN 和 en-US。

## 开发环境

### 前置条件

- Node.js 22.12 或更新版本。
- pnpm 11；package.json 当前声明包管理器版本为 pnpm 11.25.0。
- Windows x64 用于完整验证迅雷 sidecar、浏览器原生消息主机和 NSIS 安装包。
- Windows 原生辅助程序由系统 .NET Framework 4.x 编译器 csc.exe 构建。非 Windows 平台的辅助程序构建脚本会跳过 Windows 专用目标。
- Windows 安装包要求 vendor/thunder/sdk 中存在项目指定的 SDK 副本，且关键 DLL 哈希与构建脚本中的固定值一致。

### 安装和启动

在项目根目录运行：

~~~powershell
pnpm install
pnpm dev
~~~

开发模式会先构建迅雷桥接辅助程序和浏览器 Native Messaging Host，再启动 electron-vite。两类辅助程序在非 Windows 平台会跳过。

常用命令：

| 命令 | 作用 |
| --- | --- |
| pnpm dev | 构建本机辅助程序并启动 Electron 开发模式 |
| pnpm typecheck | 使用 TypeScript 检查项目源码 |
| pnpm test | 运行 Node.js 内置测试运行器中的单元和集成测试 |
| pnpm build | 构建辅助程序、图标资源和 Electron 主进程、preload、renderer |
| pnpm preview | 预览 electron-vite 构建结果 |
| pnpm package:win | 更新补丁版本、构建 Windows 资源并制作 x64 NSIS 安装包 |
| pnpm smoke:thunder | 检查解包目录中的 SDK 装载、导出绑定、初始化和清理；不创建下载任务 |
| pnpm assets:icons | 从统一图标源生成应用图标资源 |
| pnpm benchmark:http | 对 HTTP 分段调度进行本地基准测试 |

HTTP 基准测试可传入 --size-mib=N 调整数据规模，例如：

~~~powershell
node --experimental-strip-types scripts/benchmark-http-scheduler.mjs --size-mib=64
~~~

Thunder 自检默认检查 release/win-unpacked/resources/thunder，也可传入解包后资源目录：

~~~powershell
node --experimental-strip-types scripts/smoke-thunder-sdk.mjs release/win-unpacked/resources/thunder
~~~

### 当前工作区的依赖脚本限制

当前工作区将传递依赖 electron-winstaller@5.4.0 的安装脚本保持拦截；pnpm 11 遇到待处理的依赖构建脚本时可能阻止运行项目脚本。不要为了绕过此限制把该依赖加入许可列表。

如果本机已有依赖目录，可直接运行已安装的工具完成类型检查、测试和构建，例如：

~~~powershell
node_modules/.bin/tsc.cmd --noEmit
node --experimental-strip-types --test tests/*.test.mjs
node scripts/build-thunder-helper.mjs
node scripts/build-browser-native-host.mjs
node_modules/.bin/electron.cmd scripts/icon-renderer
node_modules/.bin/electron-vite.cmd build
~~~

如果依赖尚未安装且 pnpm 因该脚本策略拒绝安装，请先按项目的依赖策略处理，不要更改 pnpm-workspace.yaml 中的脚本许可设置来静默放行。

## Windows 打包

在 Windows x64 环境中运行：

~~~powershell
pnpm package:win
~~~

打包流程依次执行：补丁版本号递增、编译迅雷 sidecar、编译浏览器 Native Messaging Host、生成派生图标、构建 Electron 文件、校验 vendor/thunder/sdk 的固定副本，并将编译后的 ThunderBridge.exe 暂存到 vendor/thunder/ThunderBridge.exe、调用 electron-builder 生成 NSIS 安装程序。

产物位于 release/：

- NSIS 安装包名称格式为 LDownload-<版本>-x64.exe。
- 解包目录通常为 release/win-unpacked/。
- 随包迅雷 SDK 位于安装资源目录 resources/thunder/sdk。
- 浏览器扩展位于安装资源目录 resources/browser-extension。
- 原生消息主机位于 resources/browser-native-host/LDownloadNativeHost.exe。

package:win 会在构建开始时修改 package.json 的版本号，即使后续打包步骤失败，版本号变更也会保留。打包脚本只使用仓库的 vendor/thunder/sdk，校验关键 DLL 的 SHA-256；不从构建机的迅雷安装目录复制或探测 SDK。目标电脑无需另行安装迅雷。

当前正式交付目标是 Windows x64 NSIS。配置文件中保留了 macOS 和 Linux 的 electron-builder 目标描述，但项目脚本、Thunder 集成与当前打包流程尚未将它们作为已交付安装包。

## 架构

~~~mermaid
flowchart LR
  UI[React Renderer] -->|受限 preload API| Main[Electron 主进程]
  Main -->|MessagePort 请求 / 快照| Worker[下载 utility process]
  Worker --> HTTP[HTTP / HTTPS 引擎]
  Worker --> FTP[FTP / FTPS 引擎]
  Worker -->|标准输入 / 输出 JSON| Bridge[ThunderBridge.exe]
  Bridge --> SDK[随包 Thunder SDK]
  Main -->|校验来源、弹窗、系统集成| OS[操作系统]
~~~

- src/renderer/ 是 React + TypeScript 界面，不直接访问 Node.js 或 Electron 主进程对象。
- electron/preload/index.ts 仅暴露按业务划分的 API；没有通用 IPC 通道调用入口。
- electron/main/ 管理窗口、IPC、托盘、系统对话框、剪贴板、深层链接、通知和浏览器注册。
- electron/process/engine-supervisor.ts 在 Electron utility process 中启动并监控引擎进程；异常退出时按退避策略重启。
- electron/process/engine-worker.ts 负责任务状态、队列、调度、持久化以及引擎分发。
- electron/core/ 放置下载抽象、输入校验、调度、状态、解析、链接收集和限频发布等共享逻辑。
- HTTP Range 调度和连接并发控制位于 electron/engines/http/；FTP 实现在 electron/engines/ftp-engine.ts。
- electron/engines/thunder/ 负责固定 SDK 校验、种子元数据解析、状态映射与 sidecar 会话。
- 主进程与引擎通过 typed request/response 和任务快照通信。进度快照最多每 125 ms 发布一次（最高约 8 Hz），避免每个数据块都触发完整界面更新。

## 数据保存与安全

应用数据保存在 Electron 的 userData 目录中，具体路径随操作系统和安装环境而定。代码中使用的主要文件包括：

| 数据 | 路径（相对于 userData） | 内容 |
| --- | --- | --- |
| 任务、队列和下载设置 | engine/mock-state.json | 普通下载、磁力任务快照、队列顺序和设置 |
| 认证与代理凭据 | download-secrets.bin | 使用 Electron safeStorage 加密的下载认证信息及代理凭据 |
| 站点收集项目 | site-collections.json | 项目设置、采集队列、已访问页面与链接 |
| 应用和任务日志 | logs/ | JSON Lines 格式的应用日志与任务日志 |
| 浏览器 Native Messaging 注册 | browser-native-host/ | 原生消息主机清单 |
| 关闭提示状态 | close-choice.json | 关闭窗口提示是否已展示 |

下载文件保存在任务指定目录中；默认目录是系统下载目录。HTTP 下载中断后可能保留 .part、.ldl 或分段临时数据，恢复时会根据服务器元数据校验。删除任务时可选择是否同时删除下载文件。

安全与隐私边界：

- Renderer 通过 context-isolated preload API 与主进程通信；主进程只接受来自主窗口主 frame 的 IPC，并验证用户输入和允许的文件/目录。
- 凭据与 Cookie、认证参数、自定义请求头等不会与普通任务设置一起明文写入任务状态 JSON；它们通过 Electron safeStorage 单独加密保存。
- 应用日志按级别记录错误码。单个日志文件达到 2 MiB 后轮转，并保留一个备份；任务面板最多读取最近 500 条记录。
- 应用不会开启用于浏览器集成的本地网络服务器；扩展通过 Native Messaging 与应用通信。
- 站点收集器只请求同源页面，并遵循 robots.txt。

## 目录结构

~~~text
.
├── electron/
│   ├── core/                 # 引擎接口、调度、状态、解析、站点采集
│   ├── engines/
│   │   ├── http/             # HTTP Range、并发控制、限速和传输
│   │   ├── thunder/          # 迅雷 SDK 适配器与 C# sidecar 源码
│   │   └── ftp-engine.ts     # FTP / FTPS 传输
│   ├── main/                 # Electron 主进程、IPC、日志、密钥存储
│   ├── preload/              # Renderer 可用的受限 API
│   └── process/              # Utility process 与监督器
├── src/
│   ├── renderer/             # React 页面、组件、样式
│   └── shared/               # 共享类型、任务合同和 IPC 映射
├── vendor/
│   ├── browser-extension/    # Chromium 与 Firefox 扩展
│   └── thunder/sdk/          # 固定版本的随包 SDK 副本
├── scripts/                  # 构建、图标、打包辅助和基准脚本
├── tests/                    # Node.js 测试与本地 mock server
├── docs/                     # 迁移分析与 Thunder SDK 可行性记录
├── icon/                     # SVG 主图标及平台派生图标
├── package.json
├── electron.vite.config.ts
└── tsconfig.json
~~~

## 测试与诊断

运行所有项目测试：

~~~powershell
pnpm test
~~~

测试使用 Node.js 内置 node:test，覆盖 HTTP Range 调度与下载、FTP、任务调度、输入验证、链接解析、磁力元数据、进度估算、完成状态、任务快照限频、站点采集和应用图标等逻辑。测试通过本地模拟服务器验证网络行为，不要求连接真实下载站点或创建迅雷下载任务。

HTTP 调度基准：

~~~powershell
pnpm benchmark:http --size-mib=64
~~~

Thunder 安装资源自检只验证包内 SDK DLL 的装载、导出绑定、初始化和清理，不创建下载任务；它不能替代真实网络中的种子下载验证。

## 文档索引

- [旧版工程分析与迁移记录](docs/00-analysis.md)
- [Thunder SDK 可行性与集成记录](docs/01-thunder-feasibility.md)
