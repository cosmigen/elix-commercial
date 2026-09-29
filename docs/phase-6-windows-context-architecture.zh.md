# Phase 6 Windows Context Core

[English](phase-6-windows-context-architecture.md) | 中文

Windows Context 是 ELIX 对显示器拓扑、每显示器 DPI、当前前台应用上下文和全屏分类的唯一生产权威来源。公开入口为 `ctx.windowsContext`；Home 消费其投影，不直接查询 Win32，也不会虚构生产显示器。

## 状态与坐标

每个公开更新都是完整不可变的 `WindowsContextSnapshot`，并携带 TypeScript 所属的单调递增 revision。显示器边界、工作区和前台窗口边界采用带符号的虚拟屏幕物理像素，包括负坐标。DPI 公开为 `dpiX`、`dpiY` 与 `scaleFactor = dpiX / 96`；renderer DIP、CSS 像素、surface DPI 转换和 `WM_DPICHANGED` 属于 Phase 7。

Monitor ID 是活动 DisplayConfig target device path 的 SHA-256 稳定/尽力稳定投影。如果该路径缺失，键使用 adapter LUID、target ID、EDID 厂商/产品值和 connector instance。当前 GDI device name 仅为元数据，绝不单独定义身份。

## 原生捕获

Rust Native Core 使用 `EnumDisplayMonitors` 与 `GetMonitorInfoW` 枚举完整几何，通过 `GetDisplayConfigBufferSizes`、`QueryDisplayConfig` 和 `DisplayConfigGetDeviceInfo` 补充身份，并在作用域化 `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` 线程上下文中使用 `GetDpiForMonitor` 查询有效 DPI。只有当所有活动显示器均具备有效几何、DisplayConfig 身份、DPI 且恰有一个主显示器时才发布捕获；失败会保留先前快照。

前台捕获使用 `GetForegroundWindow`、`IsWindowVisible`、`IsIconic`、`DwmGetWindowAttribute(DWMWA_CLOAKED)`、`DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`（失败时回退到 `GetWindowRect`）、`GetWindowLongPtrW`、`GetWindowThreadProcessId`、`GetClassNameW` 和 `MonitorFromWindow`。不可见、最小化、cloaked、tool、桌面、WorkerW 和任务栏窗口不产生应用前台上下文。

全屏是一种分类，而非一个 Win32 标志。可见应用必须在两个物理像素容差内覆盖其前台显示器的完整边界，并通过 shell/tool/cloak/minimize 过滤。覆盖显示器的 popup 或无 caption 窗口分类为全屏；带 frame 的最大化窗口不是全屏，仅填满工作区也不充分。

## 观察与恢复

一个进程级原生 observer 拥有专用的 per-monitor-v2-aware 消息循环线程。该线程安装 out-of-context WinEvent hook，覆盖前台、最小化、窗口显示/隐藏/销毁、状态及前台窗口位置变更。一个隐藏的零尺寸顶层通知窗口接收显示、设置与设备广播；它仅是观察基础设施，不是 ELIX shell surface。原生过滤仅允许当前前台顶层窗口的位置/状态信号。

只有在通知窗口、hook 和初始快照均就绪后，启动才报告 ready。关闭会向所属线程投递消息，解除每个 `HWINEVENTHOOK`，销毁并注销通知窗口，恢复线程 DPI awareness，并 join 线程。捕获错误和意外线程终止会发出可观察 fault；listener panic 或异常会被隔离。

现有有界 NDJSON bridge 公开 `windowsContext/getSnapshot`、`windowsContext/start`、`windowsContext/stop`、`windowsContext/refresh` 和 `windowsContext/status`，并发送 `windowsContext/change` 与 `windowsContext/fault` 事件。Windows Context 变更使用 sticky latest-state 出站槽，压力不会产生无界事件，且最新完整状态仍可送达。TypeScript bridge 在 start 前安装 listener，在分发前拒绝陈旧 host-generation frame，重连后恢复一个声明式观察意图，并将新进程初始状态发布为 `recovered`。

## 公开服务

`ctx.windowsContext` 提供 `getSnapshot()`、`getMonitors()`、`getMonitor(id)`、`getPrimaryMonitor()`、`getForegroundContext()`、`refresh()` 与 `subscribe(listener)`。wire validation 会在替换状态前拒绝空或重复显示器集合、无效矩形、不一致主显示器、无效 DPI/scale 与应被过滤的前台记录。subscriber 异常不会中断后续 subscriber 或 revision。

## 延后归属

Windows Context 不创建 shell HWND、WorkerW parent、WebView2 controller、Dock、Status Bar、AppBar reservation、renderer、窗口控制 API、capture pipeline、workspace model 或持久 Window Registry。这些仍属于 Phase 7 或后续职责。
