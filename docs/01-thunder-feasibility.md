# 阶段一：迅雷 SDK 可行性侦察

检查日期：2026-10-16。目标：`C:\Program Files\Thunder Network\Thunder`。只读检查目录、文件元数据、PE 头/导出表、签名、服务/注册表和本机 HTTP 根响应；未启动迅雷 UI、SDK server 或下载任务，未向服务发送 POST，也未读取账户数据库内容。

## 1. 安装目录与版本

Thunder Network 根目录只有一个 `Thunder/` 安装目录。该目录含 384 个文件、合计 1,406,756,600 bytes（约 1.31 GiB）。顶层分布：

| 目录 | 文件数 | 字节数 | 内容概览 |
|---|---:|---:|---|
| `BHO/` | 40 | 10,989,340 | 浏览器/外壳扩展、ThunderAgent、COM/安装辅助程序 |
| `contextMenu/` | 6 | 1,024,614 | 右键集成与资源 |
| `Profiles/` | 36 | 3,671,656 | 配置、任务/文件数据库、账号相关数据、缓存 |
| `program/` | 294 | 825,755,132 | 主程序、SDK、Chromium/Electron 运行资源、服务/播放器/插件 |
| `Thunder BHO Platform/` | 6 | 4,222,112 | 浏览器平台组件 |
| `upnity/` | 2 | 561,093,746 | `bases/` 下 25.1.13.1637.7z 更新包及 `builtin/` 版本目录 |

关键目录层级（省略普通语言资源、图片和缓存细节）：

```text
Thunder/
├── BHO/                       浏览器扩展 DLL/EXE、xluser/
├── contextMenu/               Shell 集成
├── Profiles/                  配置、TaskDb.dat、缓存和多种数据库
├── program/
│   ├── addins/gdt/            第三方/广告相关 add-in 文件
│   ├── player/                播放器及图形/解码 DLL
│   ├── resources/app/         package.json、out.asar、插件 ASAR
│   ├── SDK/                   DownloadSDK、DownloadSDKServer、P2P/TCP 依赖
│   ├── service/               XLServicePlatform 程序文件和依赖
│   └── upload/                上传相关 DLL
├── Thunder BHO Platform/
└── upnity/bases/<opaque-id>/  25.1.13.1637.7z
```

文件版本信息显示：`program/thunder.exe` 是 x64、1,300,128 bytes、版本 `25.1.13.1637`、描述“迅雷”，数字签名有效，签名者为 Shenzhen Xunlei Network Technology Co., Ltd.；`program/resources/app/package.json` 同样记录版本 `25.1.13.1637`，入口 `./out/main/index.js`。SDK 中 `DownloadSDKProxy.dll`、`DownloadSDK.dll`、`DownloadSDKServer.exe` 均为 x64、版本 `2.86.202.143`、描述“迅雷下载引擎”、签名有效。`xl_thunder_sdk.dll` 是 x64、版本 `12.0728.960.264`、描述 `Downloadlib SDK(64 bit)`。

没有发现 Thunder 主程序的多个平行安装版本目录。能看到的版本子目录/归档包括 `resources/app/plugins/XLLite/3.23.11.asar.unpacked/`、`VipPayCenter2025/2.0.9.asar`、`program/SDK/xar/` 和上面的 `upnity` 更新包。`xllite.exe` 在 `program/` 与插件目录各有一份，均为 x86、52,473,856 bytes、未签名；它不是 `program/thunder.exe` 的版本信息。

### UI 与下载内核的证据边界

主程序目录实际包含 `resources/app/out.asar`、应用 `package.json`、`node` 原生模块（如 `node_sqlite3.node`）、V8 snapshot/Chromium `.pak` 与图形运行库。结合 `package.json` 的 Node 入口，这些文件强烈表明主 UI 是 **Electron/Chromium + Node 应用壳**；本次没有解包应用脚本，因而无法从可见文件判断其内部 UI 是否使用 React/Vue，也没有确认 Electron 精确版本。

安装包内的 `program/SDK/` 有 `DownloadSDK.dll`、`DownloadSDKProxy.dll`、`DownloadSDKServer.exe`、`Http.dll`、`Ftp.dll`、多个 `P2P*.dll`、`TcpImpl.dll`、`xl_thunder_sdk.dll` 和依赖库。文件版本/描述把 DownloadSDK 文件明确标为“迅雷下载引擎”，可将它们归为 SDK/传输相关组件。其他大 DLL（例如 `XDASKernel.dll`，约 158 MB）仅凭名称/签名不能确定具体职责；报告不根据名称猜测离线加速、账号校验或云端缓存内部机制。

## 2. 配置、数据库、签名和位数

主要配置/清单文件及其文件大小：

| 相对路径 | 字节 | 备注 |
|---|---:|---|
| `BHO/BHOConfig.ini` | 30 | BHO 配置 |
| `program/manifest.json` | 12,584 | 程序文件清单 |
| `program/resources/app/package.json` | 145 | `name=thunder`、版本 `25.1.13.1637`、Node 入口 |
| `program/resources/app/plugins/config.json` | 167 | 插件配置 |
| `program/resources/app/plugins/VipPayCenter2025/config.json` | 305 | 插件配置 |
| `program/resources/app/plugins/XLGame/config.json` | 191 | 插件配置 |
| `program/resources/app/plugins/XLLite/config.json` | 196 | 插件配置 |
| `Profiles/BindingConfig.ini` | 156 | Profile 配置 |
| `Profiles/config.json` | 2,794 | Profile 配置 |
| `Profiles/global_remote_config.json` | 37,759 | Profile 配置数据；未读取其语义内容 |
| `Profiles/BrowserHistorySites.json` | 178 | Profile 数据 |
| `program/SDK/` 下的 `statstorage_v5.xml`、`statXml.xml` | 2,365 / 1,495 | SDK 统计配置 |
| `program/service/XLServicePlatform.xml` | 2,429 | 服务组件配置 |

数据库文件头只读检查显示，以下 `.dat`/`.db` 以 `SQLite format 3` 开头：`Profiles/TaskDb.dat` (4,096 B)、`FileRecord.dat` (16,384 B)、`MediaDb.dat` (20,480 B)、`PlayRecord.dat` (12,288 B)、`ThunderPan.dat` (12,288 B)、`xlaccount/account/<opaque-id>/Credentials.db` (28,672 B)、`xlaccount/common/<opaque-id>/analytics.db` (20,480 B)、`ab_test/config.db` (12,288 B)、`xl_analysis/data.db` (69,632 B)。`Profiles/XLLite/.drive/user.core.db` 为 65,536 B，但开头不是 SQLite 标识。账号数据库路径中的目录 ID 已脱敏；没有读取数据库行或凭据。

对目录中 144 个 PE/native 模块（113 DLL、25 EXE、6 NODE）读取 PE 机器类型并查询 Authenticode 状态：107 个 x64、37 个 x86，无 ARM64 文件；129 个签名状态为 `Valid`，15 个 `NotSigned`。有效签名者汇总为：107 Shenzhen Xunlei Network Technology Co., Ltd.、10 Microsoft Corporation、6 Tencent Technology (Shenzhen) Company Limited、3 Microsoft Windows Software Compatibility Publisher、2 SHENZHEN THUNDER NETWORKING TECHNOLOGIES LTD.、1 LunarG, Inc.。这仅描述检查当时的 Windows 签名状态，不表示迅雷授权可再分发。完整逐文件 PE 清单在本报告附录。

## 3. 本机 IPC / HTTP / WebSocket 侦察

本机有 Windows 服务：

- 名称 `XLServicePlatform`，显示名为“迅雷下载基础服务（用于快速申请磁盘空间及接管浏览器下载请求）”；状态 Running，Automatic，LocalSystem。
- 服务登记在 `svchost.exe -k netsvcs -p -s XLServicePlatform` 下；实际服务 DLL 在安装目录外：`C:\Program Files (x86)\Common Files\Thunder Network\ServicePlatform\XLSP.dll`，159,784 bytes、x86、版本 `3.0.0.10`、Xunlei 有效签名。
- 本次系统 TCP 快照中服务 PID `26108` 监听 `127.0.0.1:28317`。只对根路径发出一次只读 GET，收到 `HTTP 200`、`Server: MySocket Server`、`Access-Control-Allow-Methods: POST, GET, OPTIONS`、`Access-Control-Allow-Origin: *` 和正文 `{"ret":1,"version":"3"}`。
- 该结果证明本机有 HTTP 响应服务，但没有证明其是公开/受支持的下载任务 API。安装目录未见服务 API 文档；本次没有枚举 URL、调用 POST、尝试 WebSocket 或提交下载任务。也没有从文件证据确认该端口可创建、暂停、查询、删除任务。
- 当时没有运行 `thunder.exe`、`xllite.exe` 或 `DownloadSDKServer.exe`。服务由 `svchost` 承载。不能据此推断 `DownloadSDKServer.exe` 启动后的所有接口。

注册表快照：HKLM 的 `magnet` URL class 有 `URL Protocol` 标记，但没有 `shell\open\command`；当前用户没有 `magnet\UserChoice`。HKCR 存在 `qBittorrent.Url.Magnet` ProgID，指向 `C:\Program Files\qBittorrent\qbittorrent.exe "%1"`，但它不是 Thunder 入口，且本次未发现当前用户默认选择。未发现 `thunder` 或 `xunlei` URL scheme 的命令注册。`ThunderAgent`/`Thunder.MyComputerIcon` 等 shell/COM 类存在，不代表可公开调用的下载任务 API。

## 4. DLL 导出表与命令行/协议入口

`program/SDK/DownloadSDKProxy.dll` 的只读 PE 导出表包含 101 个导出，`DownloadSDK.dll` 有 107 个；二者均为 x64。可见的任务相关导出包括 `XL_Init`、`XL_UnInit`、`XL_CreateMagnetTask`、`XL_CreateBTTask`、`XL_CreateBTTask_V2`、`XL_StartTask`、`XL_StopTask`、`XL_DeleteTask`、`XL_QueryTaskInfo` 和 `XL_AddHttpHeaderField`。`xl_thunder_sdk.dll` 是 x64，导出 192 项。

旧版未跟踪的 `ThunderBridge.cs` 用 `LoadLibraryW`/`GetProcAddress` 加载 `DownloadSDKProxy.dll`，按 `StdCall` 声明委托，依赖配套 `DownloadSDKServer.exe` 初始化；支持磁力元数据解析、BT 任务创建、开始/停止/删除/查询。它将 `XL_QueryTaskInfo` 结果当成固定 924 字节缓冲区处理，并自己定义结构/偏移。该源码是旧版当前绑定方式的证据，不是厂商公开 API 文档或 ABI 兼容承诺。虽可从 x64 sidecar 技术上按导出名绑定，调用约定、参数布局、版本兼容和再分发授权仍未由可见 SDK 文档确认。

安装目录有 `ThunderCmd.exe`（x86，100,904 B，版本 `1.0.0.1`）、`ThunderStart.exe`（x64，2,995,872 B，版本 `25.0.0.1`）、`ThunderEv.exe`、`Thunder.exe` 等，未发现说明这些可执行文件参数的随附文档。不能把存在文件名为 `Cmd`/`Start` 的程序当成稳定 CLI。

## 5. 账号、登录、版本与授权边界

- 安装目录包含 `Profiles/xlaccount/.../Credentials.db` 等账号数据库；本轮没有读取其内容。Thunder 正在自动运行的 LocalSystem 服务不等于已证明下载 SDK 需要或不需要用户登录。
- `LDownload1/target/thunder-probe/` 里**已有的历史日志**记录过本地 fixture 任务完成并通过内容校验，也记录过一个实际 Magnet 元数据结果完成 info-hash 校验；`LDownload1/docs/V2_MAGNET_ENGINE.md` 记录旧适配器会按 DLL SHA-256 固定到单一 SDK 版本、自动模式在不匹配时回退 Rust。它说明现有机器/版本曾有窄范围验证，不是本轮测试，也不能证明所有远端任务不需登录、设备注册、云端授权或版本校验，更不证明公网速度。
- 在 SDK 目录没发现公开 SDK 使用手册、C/C++ 头文件、导入库或授权/再分发许可。导出表可见不等于它是公开支持接口；旧源码使用的原始任务信息缓冲区尤其不能作为稳定 ABI。
- 补充检索了迅雷开放平台官方文档，发现当前有一套**正式公开的 Electron/Node.js 下载 SDK**（`@xunlei-open/dlsdk` 及平台 native 包）。它要求先在开放平台注册、完成实名认证、创建应用并获取 API Key，再以 API Key 换取登录 token 并登录 SDK；这属于独立桌面 SDK，与本机安装包里版本为 2.86.202.143 的 `DownloadSDKProxy.dll` 不是同一套接口。[迅雷 Node.js SDK 指南](https://open.xunlei.com/doc/download/sdk/nodejs)、[接入流程](https://open.xunlei.com/doc/download/guide/access-flow)
- 官方快速接入页明确写明：当前公开下载 SDK 仅开放 HTTP(S)，BT、磁力链、ed2k 暂不支持。因此虽然这是 Electron 的受支持接口，**它不能完成用户要求的 Magnet/BT 引擎**。[迅雷 SDK 快速接入](https://open.xunlei.com/doc/download/guide/quick-start)
- 另有迅雷官方微应用 `xunlei.tasks` API，文档明确支持创建 Magnet / BT 任务、读取任务详情和状态；但 `xunlei` 是由迅雷客户端微应用运行时注入的对象，官方微应用运行在迅雷客户端 WebView 中，外部浏览器没有该对象。故它是可支持 BT 的迅雷托管应用接口，**不是独立 Electron 进程可直接调用的 Node API**。[微应用任务 API](https://open.xunlei.com/doc/miniapp/task-api)、[微应用运行时架构](https://open.xunlei.com/doc/miniapp/runtime)、[本地调试/加载方式](https://open.xunlei.com/doc/miniapp/debugging)
- 当前 SDK 文件集为 32 个文件、33,196,640 bytes（约 31.6 MiB）。旧仓库已有未跟踪的 SDK 副本和 `dist/resources/thunder-sdk/SDK-MANIFEST.json`，但没有因这份副本而产生再分发授权。依赖还包括旧版 OpenSSL/CRT、XAR 资源、下载服务程序等；版本升级可能改变哈希、ABI 或依赖。文件清单中有未签名模块，打包会扩大供应链审查范围。
- 另有 `XLServicePlatform` 注册为 LocalSystem 服务，实际 DLL 位于 Thunder 安装路径之外。如果依赖该服务，复制 SDK 到新应用不等于完整可搬运；如果不依赖，也需厂商文档/许可或独立兼容验证后才能得出结论。

## 6. 方案比较与推荐

| 路径 | Magnet/BT | 能否支撑独立 Electron UI | 目前证据与限制 |
|---|---|---|---|
| **官方 Open Platform Node SDK** | 不支持；官方当前只开放 HTTP(S)。 | 可以，文档明确面向 Electron/Node 桌面应用。 | 受支持、可跨平台；需要实名开发者账号、创建应用、API Key 与 SDK 登录。只能用于普通 HTTP(S)，不满足本项目的磁力需求。[快速接入](https://open.xunlei.com/doc/download/guide/quick-start) |
| **官方迅雷微应用 `xunlei.tasks`** | 支持 Magnet / BT 和本地种子文件路径；支持查询任务状态。 | **不可以直接被独立 Electron 调用**；官方接口注入到迅雷客户端管理的微应用 WebView。 | 接口公开且有权限模型，可用自定义 UI，但应用运行/宿主仍是迅雷客户端。是否能接受把现有界面改成迅雷微应用形态，与当前 Electron 架构要求冲突。[任务 API](https://open.xunlei.com/doc/miniapp/task-api)、[运行时架构](https://open.xunlei.com/doc/miniapp/runtime) |
| **旧版本机 `DownloadSDKProxy.dll` + `DownloadSDKServer.exe`** | 有：旧项目历史日志记录了单文件 fixture 完成和一个真实 Magnet 元数据解析；不是公网大文件性能证明。 | 可以通过独立 sidecar 调用；这是旧版采用的路径。 | 安装内 SDK 没有随附 API/ABI 文档。旧桥接按导出名绑定、手写委托和任务结构；`XL_QueryTaskInfo` 使用固定 924-byte 布局。仅有本机一个版本指纹验证，当前公开资料没有确认该 ABI 是受支持的公开接口，也未找到许可/再分发条款。若继续，只能限用户自有安装、版本锁定、隔离 sidecar、运行时校验，并且不能把它描述为官方受支持 API。 |
| **本机 HTTP 服务 / 协议入口** | 尚未证明可建 Magnet 任务。 | 理论上适合，但目前没有可用证据。 | 仅观察到 `127.0.0.1:28317/` 根健康响应，没有公开 API 文档；注册表没有 Thunder 的 URL handler。未探测未知路径/POST。 |

**结论按用户的新要求调整：** 不采用自写 BT、libtorrent 或 WebTorrent。迅雷目前提供公开的 BT API，但它必须运行在迅雷微应用宿主内；迅雷官方 Electron SDK 目前不支持 BT。旧版证明了用户本机旧 SDK 可行，但没有证明该接口属于公开受支持 API。因此“独立 Electron + 保留磁力能力 + 不显示/依赖迅雷原版 + 只用公开接口”目前没有从可见材料证实的方案。若用户选择继续使用旧版本机 SDK，需明确把原始的“只用公开受支持接口；如需逆向则放弃”约束改为允许调用这个已验证但文档未公开的本地 ABI；否则可选改做迅雷微应用，或等待厂商提供可在 Electron 中调用的官方 Magnet/BT SDK。不会探测服务未知路由、绕过账号/授权、反调试、补丁二进制或自行实现 BT 协议。
**用户后续决定（2026-10-16）：** 用户明确要求继续调用其已验证过的迅雷 SDK，不接受自写 BT 引擎，并要求 SDK 随 Windows 安装包分发，使目标电脑无需另装迅雷。最初从 Windows 迅雷目录复制 SDK 到新项目 vendor/thunder/sdk；后续开发和打包只使用这份副本。Windows 打包脚本只校验这个目录并复制自行构建的 sidecar，安装包把 SDK 放在 resources/thunder/sdk。开发版只用 vendor 副本，打包版只用 resources 副本，不扫描系统迅雷目录。该选择是用户明确提出的自用集成决定；本机材料仍不能证明未公开 ABI 是厂商稳定支持的接口，也没有找到再分发许可文本，因此不能把它描述为厂商公开 SDK 或兼容性承诺。

## 附录 A：Thunder 目录中 144 个 PE/native 文件

签名缩写：`Xunlei` = Shenzhen Xunlei Network Technology Co., Ltd.；`ThunderNet` = SHENZHEN THUNDER NETWORKING TECHNOLOGIES LTD.；`Microsoft` = Microsoft Corporation；`MS Compatibility` = Microsoft Windows Software Compatibility Publisher；`Tencent` = Tencent Technology (Shenzhen) Company Limited；`LunarG` = LunarG, Inc. `Valid` 是 Windows Authenticode 查询状态，`NotSigned` 表示没有嵌入/可验证签名。`.node` 也列出，因为它们是本机模块。

| 相对路径 | 字节 | PE | 签名状态 / 签名者 |
|---|---:|---|---|
| `BHO\atl90.dll` | 163,880 | x86 | Valid / Xunlei |
| `BHO\BHOInstall.exe` | 801,832 | x86 | Valid / Xunlei |
| `BHO\libexpat.dll` | 154,152 | x86 | Valid / Xunlei |
| `BHO\msvcp90.dll` | 570,408 | x86 | Valid / Xunlei |
| `BHO\msvcr90.dll` | 657,448 | x86 | Valid / Xunlei |
| `BHO\npxunlei.dll` | 99,368 | x86 | Valid / Xunlei |
| `BHO\ThunderAgent.dll` | 132,648 | x86 | Valid / Xunlei |
| `BHO\ThunderAgent10.1.27.622.dll` | 132,648 | x86 | Valid / Xunlei |
| `BHO\ThunderAgent64.dll` | 201,768 | x64 | Valid / Xunlei |
| `BHO\ThunderAgent649.5.62.2075.dll` | 201,768 | x64 | Valid / Xunlei |
| `BHO\ThunderBHOPlatform.exe` | 945,192 | x86 | Valid / Xunlei |
| `BHO\ThunderMyComputerIcon.dll` | 488,488 | x86 | Valid / Xunlei |
| `BHO\ThunderMyComputerIcon64.dll` | 561,192 | x64 | Valid / Xunlei |
| `BHO\ThunderMyComputerIcon641.0.0.6.dll` | 561,192 | x64 | Valid / Xunlei |
| `BHO\UserAgent.dll` | 183,848 | x86 | Valid / Xunlei |
| `BHO\xl_ext_chrome_setup.exe` | 1,957,056 | x86 | Valid / Xunlei |
| `BHO\XLNonIESvr.exe` | 801,832 | x86 | Valid / Xunlei |
| `BHO\xluser\npxluser.dll` | 42,024 | x86 | Valid / Xunlei |
| `BHO\XunleiBHO.dll` | 470,056 | x86 | Valid / Xunlei |
| `BHO\XunLeiBHO64.dll` | 705,576 | x64 | Valid / Xunlei |
| `BHO\XunleiBHO649.5.62.2075.dll` | 705,576 | x64 | Valid / Xunlei |
| `contextMenu\ThunderShell.dll` | 287,128 | x86 | Valid / ThunderNet |
| `program\addins\gdt\env_detect.exe` | 611,888 | x64 | Valid / Tencent |
| `program\addins\gdt\libamssdk.dll` | 1,439,512 | x64 | Valid / Tencent |
| `program\addins\gdt\pcyyb_sdk_dll.dll` | 6,211,624 | x64 | Valid / Tencent |
| `program\addins\gdt\qone.dll` | 1,061,424 | x64 | Valid / Tencent |
| `program\addins\gdt\WebView2Loader.dll` | 165,968 | x64 | Valid / Microsoft |
| `program\addins\gdt\xladsdk64.dll` | 580,608 | x64 | NotSigned |
| `program\addins\gdt\ylh_sdk.dll` | 1,043,040 | x64 | Valid / Tencent |
| `program\cpr.dll` | 1,775,144 | x64 | Valid / Xunlei |
| `program\crashpad_handler.dll` | 1,837,608 | x64 | Valid / Xunlei |
| `program\D3DCompiler_43.dll` | 2,526,056 | x64 | Valid / Microsoft |
| `program\d3dcompiler_47.dll` | 4,916,712 | x64 | Valid / Microsoft |
| `program\dk_addon.node` | 3,263,136 | x64 | Valid / Xunlei |
| `program\ffmpeg.dll` | 2,778,664 | x64 | Valid / Xunlei |
| `program\libcrypto-3-x64.dll` | 6,418,472 | x64 | Valid / Xunlei |
| `program\libcurl.dll` | 664,616 | x64 | Valid / Xunlei |
| `program\libeay32.dll` | 2,298,920 | x64 | Valid / Xunlei |
| `program\libEGL.dll` | 495,144 | x64 | Valid / Xunlei |
| `program\libexpat.dll` | 289,832 | x64 | Valid / Xunlei |
| `program\libGLESv2.dll` | 7,546,408 | x64 | Valid / Xunlei |
| `program\libssl-3-x64.dll` | 1,268,776 | x64 | Valid / Xunlei |
| `program\lkhb.node` | 2,423,968 | x64 | Valid / Xunlei |
| `program\minizip.dll` | 180,776 | x64 | Valid / Xunlei |
| `program\pc_addon.node` | 4,190,368 | x64 | Valid / Xunlei |
| `program\player_helper.node` | 390,304 | x64 | Valid / Xunlei |
| `program\player\APlayer.dll` | 32,222,368 | x64 | Valid / Xunlei |
| `program\player\containor.dll` | 357,376 | x64 | NotSigned |
| `program\player\D3DCompiler_43.dll` | 2,526,056 | x64 | Valid / Microsoft |
| `program\player\D3DX9_43.dll` | 2,401,112 | x64 | Valid / Microsoft |
| `program\player\libgcc_s_seh-1.dll` | 107,187 | x64 | NotSigned |
| `program\player\libglslang-default-resource-limits.dll` | 63,065 | x64 | NotSigned |
| `program\player\libplacebo-274.dll` | 6,697,220 | x64 | NotSigned |
| `program\player\libstdc++-6.dll` | 2,025,890 | x64 | NotSigned |
| `program\player\libwinpthread-1.dll` | 60,356 | x64 | NotSigned |
| `program\player\SPIRV.dll` | 3,144,086 | x64 | NotSigned |
| `program\player\vcruntime140.dll` | 119,376 | x64 | Valid / Microsoft |
| `program\player\vulkan-1.dll` | 1,102,304 | x64 | Valid / LunarG |
| `program\player\xl_video_control.dll` | 919,712 | x64 | Valid / Xunlei |
| `program\resources\app\plugins\XLLite\3.23.11.asar.unpacked\xllite.exe` | 52,473,856 | x86 | NotSigned |
| `program\resources\app\Release\node_sqlite3.node` | 1,743,984 | x64 | Valid / Xunlei |
| `program\SDK\AssistantTools.dll` | 442,528 | x64 | Valid / Xunlei |
| `program\SDK\DownloadSDK.dll` | 5,010,592 | x64 | Valid / Xunlei |
| `program\SDK\DownloadSDKProxy.dll` | 313,504 | x64 | Valid / Xunlei |
| `program\SDK\DownloadSDKServer.exe` | 429,216 | x64 | Valid / Xunlei |
| `program\SDK\Ftp.dll` | 343,200 | x64 | Valid / Xunlei |
| `program\SDK\Http.dll` | 432,800 | x64 | Valid / Xunlei |
| `program\SDK\libcurl.dll` | 884,896 | x64 | Valid / Xunlei |
| `program\SDK\libeay32.dll` | 2,288,128 | x64 | NotSigned |
| `program\SDK\minizip.dll` | 163,488 | x64 | Valid / Xunlei |
| `program\SDK\msvcp90.dll` | 853,312 | x64 | Valid / Microsoft |
| `program\SDK\msvcr90.dll` | 624,448 | x64 | Valid / Microsoft |
| `program\SDK\P2PBase.dll` | 1,798,304 | x64 | Valid / Xunlei |
| `program\SDK\P2PCommonObjects.dll` | 333,472 | x64 | Valid / Xunlei |
| `program\SDK\P2PFramework.dll` | 668,320 | x64 | Valid / Xunlei |
| `program\SDK\P2PIO.dll` | 319,648 | x64 | Valid / Xunlei |
| `program\SDK\P2PStat.dll` | 443,040 | x64 | Valid / Xunlei |
| `program\SDK\P2PTarget.dll` | 303,776 | x64 | Valid / Xunlei |
| `program\SDK\ProxyVerifier.dll` | 177,824 | x64 | Valid / Xunlei |
| `program\SDK\ssleay32.dll` | 461,312 | x64 | NotSigned |
| `program\SDK\TcpImpl.dll` | 4,619,936 | x64 | Valid / Xunlei |
| `program\SDK\upnp.exe` | 172,704 | x64 | Valid / Xunlei |
| `program\SDK\xl_thunder_sdk.dll` | 6,209,184 | x64 | Valid / Xunlei |
| `program\SDK\XLBugHandler.dll` | 718,496 | x64 | Valid / Xunlei |
| `program\SDK\XLBugReport.exe` | 1,233,056 | x64 | Valid / Xunlei |
| `program\SDK\XLFileAssistant.exe` | 289,440 | x64 | Valid / Xunlei |
| `program\SDK\XLLiveUDownload.dll` | 167,072 | x64 | Valid / Xunlei |
| `program\SDK\XLReImport.dll` | 511,136 | x64 | Valid / Xunlei |
| `program\SDK\XLTaskUpgrade.dll` | 492,192 | x64 | Valid / Xunlei |
| `program\SDK\XUdt.dll` | 898,208 | x64 | Valid / Xunlei |
| `program\SDK\zlib1.dll` | 509,600 | x64 | Valid / Xunlei |
| `program\service\atl90.dll` | 159,032 | x86 | Valid / Microsoft |
| `program\service\libcurl.dll` | 719,400 | x86 | Valid / Xunlei |
| `program\service\libeay32.dll` | 1,426,472 | x86 | Valid / Xunlei |
| `program\service\libexpat.dll` | 484,904 | x86 | Valid / Xunlei |
| `program\service\minizip.dll` | 142,888 | x86 | Valid / Xunlei |
| `program\service\msvcp90.dll` | 568,832 | x86 | Valid / Microsoft |
| `program\service\msvcr90.dll` | 655,872 | x86 | Valid / Microsoft |
| `program\service\ssleay32.dll` | 376,872 | x86 | Valid / Xunlei |
| `program\service\ThunderUnion.dll` | 189,480 | x86 | Valid / ThunderNet |
| `program\service\XLBugHandler.dll` | 612,904 | x86 | Valid / Xunlei |
| `program\service\XLBugReport.exe` | 902,696 | x86 | Valid / Xunlei |
| `program\service\XLServicePlatform.dll` | 159,784 | x86 | Valid / Xunlei |
| `program\service\XLServicePlatform.exe` | 94,248 | x86 | Valid / Xunlei |
| `program\service\zlib1.dll` | 436,776 | x86 | Valid / Xunlei |
| `program\shiply.dll` | 7,130,672 | x64 | Valid / Tencent |
| `program\ssleay32.dll` | 472,104 | x64 | Valid / Xunlei |
| `program\SysPin.exe` | 111,144 | x64 | Valid / Xunlei |
| `program\thunder_helper.node` | 1,970,336 | x64 | Valid / Xunlei |
| `program\thunder.exe` | 1,300,128 | x64 | Valid / Xunlei |
| `program\ThunderCmd.exe` | 100,904 | x86 | Valid / Xunlei |
| `program\ThunderEv.exe` | 2,136,224 | x64 | Valid / Xunlei |
| `program\ThunderRepair.exe` | 212,186,272 | x64 | Valid / Xunlei |
| `program\ThunderStart.exe` | 2,995,872 | x64 | Valid / Xunlei |
| `program\ThunderUninstall.exe` | 5,887,648 | x64 | Valid / Xunlei |
| `program\upload\cloud_upload.dll` | 6,892,704 | x64 | Valid / Xunlei |
| `program\upload\libcrypto-3-x64.dll` | 6,418,472 | x64 | Valid / Xunlei |
| `program\upload\libcurl.dll` | 1,508,904 | x64 | Valid / Xunlei |
| `program\upload\libeSDKOBS.dll` | 1,266,216 | x64 | Valid / Xunlei |
| `program\upload\libeay32.dll` | 2,288,128 | x64 | NotSigned |
| `program\upload\libssl-3-x64.dll` | 1,436,200 | x64 | Valid / Xunlei |
| `program\upload\ssleay32.dll` | 472,104 | x64 | Valid / Xunlei |
| `program\upload\vcruntime140.dll` | 119,376 | x64 | Valid / Microsoft |
| `program\upnity.dll` | 1,293,864 | x64 | Valid / Xunlei |
| `program\vcruntime140.dll` | 119,376 | x64 | Valid / Microsoft |
| `program\vk_swiftshader.dll` | 5,144,616 | x64 | Valid / Xunlei |
| `program\vulkan-1.dll` | 926,248 | x64 | Valid / Xunlei |
| `program\Win7AppId.exe` | 97,832 | x86 | Valid / Xunlei |
| `program\XDASKernel.dll` | 157,723,688 | x64 | Valid / Xunlei |
| `program\xl_wer.dll` | 503,848 | x64 | Valid / Xunlei |
| `program\XLBugHandler.dll` | 694,824 | x64 | Valid / Xunlei |
| `program\XLBugReport.exe` | 1,354,792 | x64 | Valid / Xunlei |
| `program\xllite.exe` | 52,473,856 | x86 | NotSigned |
| `program\XLLiveUD.exe` | 8,761,504 | x64 | Valid / Xunlei |
| `program\XLLiveUpdateAgent.dll` | 1,969,824 | x64 | Valid / Xunlei |
| `program\xlstat4.dll` | 1,500,200 | x64 | Valid / Xunlei |
| `program\XLWFPSetup.exe` | 310,128 | x86 | Valid / Xunlei |
| `program\zlib1.dll` | 564,776 | x64 | Valid / Xunlei |
| `Thunder BHO Platform\libexpat.dll` | 289,832 | x64 | Valid / Xunlei |
| `Thunder BHO Platform\minizip.dll` | 180,776 | x64 | Valid / Xunlei |
| `Thunder BHO Platform\np_tdieplat.dll` | 1,735,680 | x86 | NotSigned |
| `Thunder BHO Platform\tdshareddata.dll` | 96,256 | x86 | NotSigned |
| `Thunder BHO Platform\XLBugReport.exe` | 1,354,792 | x64 | Valid / Xunlei |
| `Thunder BHO Platform\zlib1.dll` | 564,776 | x64 | Valid / Xunlei |

## 7. 最终结论

这台 Windows 机器上存在可校验的 x64 迅雷 SDK DLL/Server；旧版源码和历史日志记录了该固定版本下的窄范围成功结果。公开材料仍未确认这套本地 ABI 稳定受支持，也没有找到再分发许可文本。按用户后续明确要求，项目以隔离 sidecar 调用固定 SDK。SDK 副本已保存在新项目 vendor/thunder/sdk；Windows 构建只校验该目录，NSIS 将其放在 resources/thunder/sdk。开发版只使用 vendor 副本，打包版只使用随包 SDK；目标电脑不需要另装迅雷。此实现不代表厂商认可或保证 ABI 兼容。使用用户提供的 magnet 对当前包内 SDK 实测：元数据解析成功，得到 6.48 GB 的 Ubuntu ISO；真实传输收到 17,461,900 字节后按 16 MiB 测试上限停止，未下载完整 ISO。
