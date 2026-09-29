# Agent Note: Home renderer ownership on Surface Core

Status: implemented

## Problem

Home 领域模型曾有独立的同步桌面窗口抽象，而 Surface Core 拥有生产环境的 HWND 与 WebView2 生命周期。保留两条路径会复制原生所有权、隐藏异步失败，并使可见渲染器脱离 Home 的布局、选择、壁纸和持久化权威。

## Decision

Home 消费 `SurfaceService`，并仅以显示器身份和壁纸运行时策略封装每个 `SurfaceInstance`。Surface Core 仍是 HWND、WebView2 controller、当前代际就绪状态、可见性、z-order、物理边界、恢复和原生销毁的唯一所有者。Home 等待每次原生变更，并串行协调显示器，确保每个 Windows Context 显示器只有一个逻辑 surface。

渲染器是 Home 状态的投影。Home 在共享 webserver 注册令牌化 loopback 路由，以 React server rendering 生成初始文档和后续 root，通过 server-sent events 发布权威替换，并且只接受有界的可辨识联合交互意图。小型客户端适配器拥有临时指针和框选反馈，但不能提交条目状态。快捷方式目标和本地资源路径不会进入渲染器数据。

Home 使用物理虚拟屏幕像素保存桌面几何。渲染器上报显示器本地 CSS 像素；Home 使用 Windows Context 的显示器原点和缩放比例完成转换，再执行选择、框选、拖放、碰撞或网格吸附。通用排除矩形仍是 Home 布局输入，不是 surface 边界、输入 hitbox 或 Windows 工作区预留。排除区更新仅通过既有最近空闲位置算法协调被覆盖的根条目。

壁纸偏好仍是 Home 的持久状态。静态图像和视频文件使用令牌化同源资源路由，视频支持 byte range，并在替换或卸载时释放媒体源；动态壁纸仅限封闭集合中的 ELIX 自有 CSS 场景。可见性和销毁会发布明确运行时状态，之后可以接收电源策略输入，而无需把该策略加入 Home。

## Alternatives considered

**保留 Phase 7 Home 适配器。** 该适配器把异步 Surface 操作转为 fire-and-forget 同步调用，并保留第二套原生窗口契约。直接消费 Surface 可以明确失败、顺序和所有权，并删除过时路径。

**新增原生 WebView 消息协议。** Surface Core 没有公开此通道。既有 loopback webserver 可以支持可恢复渲染器 URL、有界 HTTP 意图、媒体 range 请求和 server-sent 更新，无需扩展原生协议。

**在客户端 hydrate 第二个 Home store。** 客户端 store 会与 Home 持久化竞争，并使重载和原生 host 恢复复杂化。无状态 React 投影和类型化意图保留单一领域权威。

**允许下载的动态壁纸脚本。** Home 是没有第三方权限或沙箱模型的特权 shell 渲染器。封闭场景注册表可提供动画壁纸而不越过后续 runtime 边界。

## Consequences

生产环境的 Home 需要 Windows Context、Surface Core 和共享 webserver。渲染器重载与原生 host 重建从持久 Home 模型恢复，而令牌撤销和 stream 关闭遵循显示器及服务生命周期。Loopback 渲染器为每个活跃 WebView 增加一个 HTTP/SSE 连接，并在模型变化时替换完整 root；稳态不轮询，临时拖放反馈留在本地。

Dock、Status Bar、AppBar 预留、WorkerW 附着、共享 overlay、启动执行、任意 widget 或壁纸代码、窗口管理和全屏 shell 策略在所属能力实现前仍不可用。
