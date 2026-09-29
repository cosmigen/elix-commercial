# ELIX OS 架构

[English](architecture.md) | 中文

ELIX 是一个 Windows shell 平台：精简的 Cordis TypeScript 领域层运行在进程外 Rust 原生基础之上。它不是 agent harness；导入基线中的模型、工具、会话、沙箱和 agent runtime 包已经移除。Cordis 仅保留为 ELIX 能力的生命周期与服务组合内核。

## 系统分层

```text
CLI / profile 启动
        |
        v
Cordis 服务组合
        |
        +--> ctx.home --> 令牌化 React 渲染器
        +--> ctx.surface --> HWND / WebView2
        +--> ctx.windowsContext
        +--> ctx.shellNamespace
        +--> ctx.appRegistry
                     |
                     v
          TypeScript 原生适配器
                     |
              版本化 NDJSON
                     |
                     v
            Rust Native Core host
                     |
              Win32 / COM / NTFS
```

各层分别拥有以下职责：

- TypeScript 与 Cordis 拥有领域模型、目录、协调、服务生命周期、配置和公开能力语义。
- Rust 拥有底层 Win32、COM、显示器/DPI 查询、窗口观察、文件系统通知、文件身份、图标、快捷方式和进程启动操作。
- bridge 拥有进程隔离、协议分帧、代际隔离、背压、重启策略和原生观察意图恢复。
- Surface Core 拥有原生 shell 窗口生命周期；Home 拥有渲染投影与桌面交互模型。

## 启动与组合

[`apps/cli`](../apps/cli/README.md) 解析调用，并通过 [`packages/boot/app-boot`](../packages/boot/app-boot/README.md) 启动 profile。profile 是一棵 Cordis 配置树，由 base bundle、profile 本地配置、机器本地覆盖和显式命令行 overlay 组合而成。配置树卸载时，Cordis effect 负责释放服务资源。

[`packages/bundle/base`](../packages/bundle/base/README.md) 有意保持精简，只提供当前 ELIX 组合所需的共享 host 设施。已移除的 DeepSeek Harness 能力不是本产品的架构扩展点。

## 产品能力

| 领域 | 包 | 职责 |
|---|---|---|
| Home | [`packages/shell/home`](../packages/shell/home/README.md) | 桌面状态、布局、选择、文件夹、widget 占位、壁纸、持久化、渲染器意图与每显示器投影。 |
| Surface Core | [`packages/core/surface`](../packages/core/surface/README.md) | 权威 HWND/WebView2 生命周期、就绪状态、物理边界、焦点、z-order、恢复与销毁。 |
| Shell Namespace | [`packages/services/shell-namespace`](../packages/services/shell-namespace/README.md) | 权威文件、文件夹、快捷方式、Known Folder、桌面聚合、稳定条目身份、目录协调与规范化变更事件。 |
| App Registry | [`packages/services/app-registry`](../packages/services/app-registry/README.md) | 已安装应用发现、身份、规范化、协调、搜索、图标、缓存与启动语义。 |
| Windows Context | [`packages/core/windows-context`](../packages/core/windows-context/README.md) | 权威的不可变显示器拓扑、物理像素几何、每显示器 DPI、前台应用上下文与全屏分类。 |
| Native Core | [`native/`](phase-5-rust-native-core-architecture.md) 与 `packages/native/core` | 崩溃隔离的 Win32/COM 实现与类型化 TypeScript 适配器。 |
| Web host | [`packages/host/webserver`](../packages/host/webserver/README.md) | 通用 HTTP、upgrade、静态文件与 index transform 路由，不拥有 ELIX 领域语义。 |
| 工具包 | `packages/util/*` | 身份、路径、原子写入、超时、命令执行和启动环境快照等小型共享原语。 |

稳定的服务入口是 `ctx.home`、`ctx.surface`、`ctx.windowsContext`、`ctx.shellNamespace` 与 `ctx.appRegistry`。消费方依赖这些服务 API，而不依赖 bridge 方法或 Win32 原语。原生 Windows 状态不可用时，Windows Context 会显式失败；目录适配器可使用已记录的 TypeScript 回退，且不改变服务 API。

## Windows Context 权威性

[`ctx.windowsContext`](phase-6-windows-context-architecture.zh.md) 是显示器、DPI、前台窗口和全屏状态的唯一生产权威来源。Rust 捕获完整物理像素快照，并拥有一个带 WinEvent hook 和隐藏通知窗口的事件线程；TypeScript 验证并冻结替换状态、分配消费方 revision、在捕获失败后保留最后一个已知正确快照，并隔离 listener。Home 将该服务投影到 Phase 2 显示器模型；只有显式测试 fixture 可以绕过该投影。

## Home 渲染与 Surface Core

Home 为每个 Windows Context 显示器创建一个 Surface Core 实例。Surface Core 拥有 HWND 与 WebView2 生命周期，包括当前代际的就绪后显示和原生 host 恢复。Home 在渲染器重载与原生重建期间保留持久模型，并通过令牌化 loopback 文档、有界类型化意图和 server-sent 状态更新重新投影该模型。

Home 使用物理虚拟屏幕像素保存规范化条目与 shell 排除区几何。渲染器使用显示器本地 CSS 像素；Home 在选择、框选、拖放、碰撞或网格吸附前应用权威显示器原点与 DPI 比例。通用排除矩形仅影响 Home 布局，与原生 surface 边界、输入 hitbox 和 Windows 工作区预留保持独立。

## Shell Namespace 权威性

Shell Namespace 是文件系统派生目录状态的权威来源。原生 watcher 事件只是触发目录枚举与目录 diff 的提示，不直接作为权威条目变更。

原生事件精度丢失时，watcher 进入 degraded 状态，并为该容器发出一个 sticky invalidation。Shell Namespace 重新枚举容器、应用规范化 diff，并在协调完成后才由适配器重新启用原生细粒度事件。协调失败时 watcher 保持 degraded。该顺序同样覆盖原生缓冲区溢出、watcher 故障与 host 停机。

## 原生进程与协议

TypeScript bridge 启动一个 `elix-native-host.exe` 进程，并通过有界、版本化 NDJSON 请求与事件帧通信。协议版本与包版本是两个独立字段；协议版本不兼容会使握手失败。

每个 host 进程都有单调递增的客户端代际。待处理请求和原生 watcher ID 只属于创建它们的代际。host 终止时，bridge 会拒绝该代际的请求，并在重连开始前立即使所有原生订阅绑定失效。声明式 watcher 与 Windows Context 观察意图保留在 TypeScript 中，并在新握手成功后恢复；Windows Context 随后发布新的 `recovered` 替换状态。代际检查会在分发前拒绝旧进程事件。

响应和普通 watcher 事件使用有界通道。压力下可以丢弃细粒度事件，但每个受影响订阅最多保留一个 invalidation，直到 stdout 成功写出该帧。这样既保证最终协调，也避免优先事件无限增长。

supervisor 使用有界指数退避和稳定窗口。一次握手不会清除崩溃历史；只有持续健康达到配置窗口的 host 才会重置重启预算。重复 crash-flapping 最终进入终止性的 `faulted` 状态。

销毁时先请求 `bridge/shutdown`，在有界时间内等待进程退出，超时后才强制终止，并再次等待。watcher 销毁会通知 worker、通过 `CancelIoEx` 取消 overlapped I/O、join 线程，并通过 RAII 释放句柄。

## Phase 边界

已实现的产品基础分为：

1. Phase 1：模块化 host 基线与组合。
2. Phase 2：Home 领域模型与抽象 surface 生命周期。
3. Phase 3：Application Registry。
4. Phase 4：Shell Namespace 与 File Provider。
5. Phase 5：Rust Native Core 与崩溃隔离 bridge。
6. Phase 6：权威 Windows Context Core。
7. Phase 7：权威原生 Surface Core。
8. Phase 8：基于 Surface Core 的 Home Renderer V1。
9. Phase 9：Intent Router 与文件操作（File Operations）。

当前基础止于 Intent Router 与文件操作，不包含 WorkerW 集成、Dock、Status Bar、Windows AppBar 预留、Launcher UI、共享 overlay、任意 widget 或壁纸执行、窗口操作、持久 Window Registry 语义、全屏 shell 策略或 AI/agent runtime。

## 改动归属

- 领域行为与公开服务语义放在所属 TypeScript 服务中。
- 原始 Windows 操作与资源所有权放在 `native/crates/elix-native-core` 中。
- RPC 路由与有界传输行为放在 `native/crates/elix-native-bridge` 中。
- 进程监管、代际所有权与适配器转换放在 `packages/native/core` 中。
- 替换或扩展原生实现时保留 `ctx.shellNamespace` 与 `ctx.appRegistry`。
- Home 不依赖 Win32 句柄或 bridge 协议细节；它消费 `ctx.surface`，生产显示器状态由 `ctx.windowsContext` 投影。

测试遵循相同分层：Rust 单元测试覆盖资源与 watcher 机制；bridge 进程测试覆盖协议与恢复；Windows live 测试覆盖真实 Win32/COM 行为；服务测试覆盖目录和公开能力语义。
