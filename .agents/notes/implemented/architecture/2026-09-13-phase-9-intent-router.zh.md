# Agent Note: Phase 9 Intent Router 与文件操作

状态：已实现

## 问题

ELIX Home、Launcher 以及未来的 shell 界面需要一种解耦且权威的机制，将用户交互转换为真实的操作系统行为，而不能绕过能力边界、在 UI 渲染器内嵌入进程启动逻辑，或破坏现有的 App Registry 和 Shell Namespace 状态。直接操作未经校验的文件系统路径可能引入路径穿越、控制字符注入、递归目录嵌套死循环以及静默失败模式。

## 决策

我们引入了 `@deepseek-ai/dsh-intent-router`（`@elix/plugin-intent-router`）作为独立的 Cordis 服务（`ctx.intentRouter`）。Intent Router 充当统一的路由与动作协调中枢。它定义了强类型的 intent 模式（`open-app`、`open-file`、`open-folder`、`open-shortcut`、`reveal-in-folder`、`rename`、`delete`、`move`、`copy`、`create-folder`、`resolve-target` 和 `get-available-actions`），并返回带有确定状态码（`success`、`invalid-request`、`not-found`、`permission-denied`、`already-exists`、`unsupported`、`native-failure`）的结构化结果。

严格的输入验证强制执行 Windows 路径规则，禁止相对穿越序列（`..`），过滤控制字符，验证基文件名是否命中 Windows 保留设备名称（`CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`），并确保目录移动/复制操作绝不会将文件夹嵌套至自身或其后代中。

路由器作为既有能力所有者之间的动作协调器，而不是重新造轮子：应用激活委托给 App Registry（`ctx.appRegistry`），shell 项查找与解析委托给 Shell Namespace（`ctx.shellNamespace`），快捷方式目标解析通过带环检测与上限为 16 层的递归遍历 `.lnk` 目标，文件操作（`rename`、`move`、`copy`、`createFolder`、`delete`）通过文件系统原语执行。永久删除需要显式确认（`permanent: true`），而回收站软删除在挂载原生 IFileOperation 回收站能力前显式返回 `unsupported`。

`DesktopProjector` 子系统利用最近空闲槽位（nearest-free-slot）布局将物理 Desktop 目录项同步至 Home 屏幕，并通过实时 Shell Namespace 变更观察协调新增、重命名、更新和移除。

## 替代方案考虑

**将动作逻辑直接嵌入 Home 渲染器或 UI 组件。** 让 Home 或 WebView2 组件直接启动进程会破坏能力边界，在不同 UI 视图间重复 Win32 执行逻辑，并阻止无头测试或非渲染器 shell 组件（如 Launcher 或键盘快捷键）复用动作处理。

**在 Intent Router 内部实现自定义 Win32 进程生成。** Shell 项启动和应用执行已由 Native Core 和 App Registry 拥有。Intent Router 协调目标与选项，但将底层生成委托给既有的 launcher。

**回收站软删除静默回退为永久删除。** 在请求软删除时静默永久删除文件会导致不可逆的数据丢失。在 Phase 11+ 之前，路由器显式将软删除请求拒绝为 `unsupported`。

## 影响

UI 组件发出高阶 intent 并接收类型化结果，无需了解底层 Win32 API、COM 套间线程或进程机制。能力边界得到严格维护。Intent Router 没有引入任何新的 UI 组件，将 Dock、Status Bar 和上下文菜单留给后续阶段。
