# macOS 桌宠模型适配器与行为性格系统设计

状态：已确认
日期：2026-07-14
上游基线：`Maboroshinatsu/maibot-deskpet-plugin@9c76de231804fe6032b8bd48c7e598298c6e3c8e`

## 1. 背景

本项目基于 `maibot-deskpet-plugin` 二次开发。保留 Electron、Vue 3、TypeScript、PixiJS、`pixi-live2d-display` 和 Live2D Cubism 4 渲染链路，将现有 MaiBot 强耦合桌宠重构为：

1. 无需 MaiBot 即可完整运行的独立桌宠核心。
2. 可选启用的 MaiBot 集成。
3. 版本化模型适配协议。
4. 由长期性格、短期心情和统一事件共同驱动的自主行为系统。

目标平台为 macOS 13 及以上，Apple Silicon 为主要验证平台，同时输出 Universal 构建以兼容 Intel Mac。应用通过官网或其他站外渠道直接分发，不以 Mac App Store 沙盒为首版约束。

## 2. 目标与非目标

### 2.1 首版目标

- 独立运行并保留可选 MaiBot Transport。
- 支持内置模型和用户导入的 Cubism 4 模型。
- 通过 `deskpet-adapter.json` v2 映射统一动作、表情和模型参数。
- 内置模型完整支持 `idle`、`walk`、`crawl`、`jump`、`roll`、`pickup`、`drop`。
- 支持活泼、安静、粘人等性格预设，并允许调整性格参数。
- 使用轻量心情和行为记忆产生连续但非养成游戏式的体验。
- 支持拖拽、右键切换表情和手动触发动作。
- 支持多显示器；拖到哪块显示器，就在该显示器内自主活动。
- 宠物位于桌面交互层，普通应用窗口会覆盖宠物。
- 为未来 MaiBot、系统状态、音乐等事件源预留统一事件接口。

### 2.2 首版非目标

- 不开发可视化模型适配编辑器；首版使用 JSON Schema、示例和诊断信息。
- 不加入完整行为树编辑器或通用规则脚本语言。
- 不加入等级、饥饿、经验、道具等完整养成系统。
- 不把 TTS、STT、截图识图作为独立桌宠核心的必需依赖。
- 不接入音乐、专注模式、电量、当前应用等 macOS 状态事件。
- 不允许宠物自主跨越显示器。
- 不以 App Store 上架为首版验收条件。

## 3. 技术决策

采用“有限状态机 + 效用评分”的混合行为架构：

- 有限状态机保证拖拽、跳跃、落地和恢复等状态转换合法。
- 效用评分根据性格、心情、事件、冷却和重复惩罚选择自主动作。
- 行为引擎只产生统一语义动作，不了解具体 Live2D motion 名称。
- 模型适配器负责语义动作到模型能力的解析和回退。
- 主进程负责行为调度、桌面坐标和窗口运动。
- 渲染进程负责 Live2D 加载、播放、表情、参数和 hit area。
- Pinia 仅承载设置页和显示状态，不承载核心行为逻辑。

不采用纯行为树，因为首版不需要任意图形化编排；不采用简单加权随机规则，因为它难以可靠处理优先级、打断、落地和动作超时。

## 4. 总体架构

```text
Electron Main
├── PetEventBus
├── BehaviorEngine
│   ├── PersonalityProfile
│   ├── MoodState
│   ├── UtilityScorer
│   ├── ActionPlanner
│   └── PetStateMachine
├── ExpressionController
├── ModelAdapterRegistry
├── MotionCoordinator
├── DesktopWindowController
├── MacDesktopLevelBridge
├── NativeContextMenu
├── RuntimeStateStore
└── IntegrationManager
    ├── StandaloneIntegration
    └── MaiBotIntegration

Electron Renderer
├── Live2DRenderer
├── ModelCapabilityScanner
├── ModelMotionPlayer
├── ModelBoundsHitTester
├── Settings UI
└── Diagnostics UI
```

主进程和渲染进程通过窄接口 IPC 通信。所有消息使用共享 TypeScript 类型并进行运行时校验，不暴露通用 `ipcRenderer.send` 或任意文件读取能力。

核心数据流：

```text
时间/用户事件
  -> PetEventBus
  -> BehaviorEngine 更新 mood 并选择 SemanticAction
  -> ModelAdapterRegistry 解析 ResolvedAction
  -> MotionCoordinator 同步窗口位移与 Live2D motion
  -> 完成/失败事件回到 PetEventBus
```

## 5. macOS 桌面窗口策略

Electron 官方文档说明，macOS 的 `BrowserWindow` `type: "desktop"` 会处于桌面背景层，但不会接收焦点、键盘或鼠标事件。因此该类型不能满足拖拽和右键菜单需求。

首版采用一个最小 Objective-C++ N-API 桥接模块 `MacDesktopLevelBridge`。不使用 Electron 的 `desktop` 或 `panel` 窗口类型；创建普通透明 BrowserWindow 后再调整原生窗口：

- Electron 继续创建透明、无边框、无阴影的交互窗口。
- 原生桥接通过窗口 native handle 将初始 level 设置为 `CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) + 1`，目标是高于桌面图标、低于普通应用窗口。
- collection behavior 设置为 `canJoinAllSpaces | stationary | ignoresCycle`，Electron 同时设置 `hiddenInMissionControl` 和 `skipTaskbar`。
- macOS 启动时调用 `app.dock.hide()`；设置界面使用独立普通窗口，并从状态栏菜单打开。
- 窗口保持可接收鼠标移动、左键拖拽和右键点击。
- 窗口不在 Dock、任务切换器和 Mission Control 中显示。
- 自主移动不能激活应用或抢占当前应用焦点。
- 普通应用窗口必须覆盖宠物。
- 若原生桥接加载失败，回退为 `alwaysOnTop: false` 的普通透明窗口，并在诊断页明确显示降级状态。

上述 level 在某个目标 macOS 版本不满足排序时，只允许在原生桥接内部按该版本调整为相邻 desktop-icon level，外部接口和目标行为不变。所有目标版本均须实机验证。不得用 `type: "desktop"` 加全局鼠标钩子的方式绕过交互限制。

参考：[Electron BaseWindowConstructorOptions `type`](https://www.electronjs.org/docs/latest/api/structures/base-window-options#type-string-optional)。

## 6. 模型适配协议 v2

### 6.1 文件与示例

模型目录中的 `deskpet-adapter.json` 使用如下结构：

```json
{
  "schemaVersion": 2,
  "model": {
    "id": "hiyori",
    "name": "Hiyori",
    "model3": "runtime/hiyori.model3.json"
  },
  "calibration": {
    "groundOffset": 16
  },
  "emotions": {
    "neutral": { "expression": "default" },
    "happy": { "expression": "smile" },
    "sad": { "expression": "sad" }
  },
  "actions": {
    "walk": {
      "motion": { "group": "Walk", "index": 0 },
      "movement": { "kind": "ground", "speedScale": 1.0 },
      "loop": true,
      "interruptible": true
    },
    "jump": {
      "motion": { "group": "Jump", "index": 0 },
      "movement": { "kind": "jump", "heightScale": 0.8 },
      "loop": false,
      "interruptible": false
    }
  },
  "fallbacks": {
    "crawl": "walk",
    "roll": "idle"
  }
}
```

### 6.2 统一语义

核心动作：

- `idle`
- `walk`
- `crawl`
- `jump`
- `roll`
- `pickup`
- `drop`

`pickup` 和 `drop` 的空间语义由拖拽状态机提供。模型可以为它们配置专用 motion；未配置时使用已验证的视觉 no-op，因此不会因为缺少专用 motion 而阻止拖拽。

核心表情：

- `neutral`
- `happy`
- `sad`
- `angry`
- `surprised`
- `curious`
- `sleepy`

模型可以声明命名空间扩展动作，例如 `hiyori:wave`。核心性格和行为配置不得依赖扩展动作，避免更换模型后行为引擎失效。

### 6.3 动作字段语义

- `motion`：Live2D motion group 和 index。
- `expression`：可选的表情 ID。
- `parameters`：动作开始时应用的模型参数。
- `movement`：模型校准信息，不决定性格行为。
- `movement.speedScale`：相同桌面速度在该模型上的视觉校准系数。
- `movement.heightScale`：跳跃轨迹相对模型高度的校准系数。
- `loop`：motion 是否允许循环直到行为计划结束。
- `interruptible`：除拖拽外，动作是否允许被更高优先级动作打断。
- `minPlayMs`：允许普通打断前的最短播放时间，缺省为 250 ms。
- `timeoutMs`：动作硬超时；缺省取 motion 元数据时长加 1000 ms，无法读取时为 6000 ms。
- `calibration.groundOffset`：模型视觉脚底到窗口底部的逻辑点距离。

桌面速度、方向、持续时间和行为概率由行为引擎决定，不写入模型人格配置。

### 6.4 校验、扫描与迁移

- 使用 JSON Schema Draft 2020-12 描述协议，运行时使用 Ajv 校验。
- 所有验证错误包含 JSON Pointer、错误类型和可操作的修复提示。
- v1 配置加载后只在内存中迁移为 v2，不覆盖原文件。
- 用户显式保存或未来编辑器导出时才写入 v2。
- 导入模型后扫描 `.model3.json`、motion group、expression、parameter 和 hit area。
- 扫描器根据大小写无关别名生成推测配置草稿，但不会自动标记为已验证。
- 每项能力状态为 `verified`、`inferred` 或 `unsupported`。
- 右键菜单默认只显示 `verified` 和 `inferred` 能力；`inferred` 项带诊断标记。

### 6.5 回退规则

解析统一动作或表情时严格按以下顺序执行：

1. 使用明确配置且已验证的能力。
2. 使用适配文件的显式 `fallbacks`。
3. 使用扫描器推测的同义 motion 或 expression。
4. 回退到 `idle` 或 `neutral`。
5. `idle` 或 `neutral` 也不可用时保持当前姿态并返回可诊断的 no-op 结果。

回退链必须检测循环和最大深度。循环配置在加载时判为无效，不在运行期递归尝试。

### 6.6 外部模型存储与安全

- 外部模型复制到 `app.getPath("userData")/models/<model-id>/`。
- 内置模型保持只读，外部模型不得覆盖内置 ID。
- 渲染进程通过受控的 `app-model://` 自定义协议读取资源，不直接开放任意 `file://` 路径。
- 所有相对路径解析后必须仍位于对应模型目录。
- JSON 最大 10 MiB、解析深度最大 64；单文件最大 128 MiB。
- 纹理编码文件最大 64 MiB，解码尺寸最大 8192 x 8192。
- 单个模型最多 4096 个文件，总导入大小最大 1 GiB。
- 不执行模型目录中的 JavaScript、HTML、Shell 或原生二进制文件。

## 7. 性格与心情

### 7.1 长期性格

`PersonalityProfile` 包含四个 0 到 1 的参数：

| 参数 | 含义 |
| --- | --- |
| `activity` | 自主动作频率和移动时长 |
| `affection` | 对用户互动和鼠标接近的反应强度 |
| `curiosity` | 探索、转向和响应新事件的倾向 |
| `playfulness` | 跳跃、打滚等玩耍动作的权重 |

内置预设初始值：

| 预设 | activity | affection | curiosity | playfulness |
| --- | ---: | ---: | ---: | ---: |
| 平衡（默认） | 0.55 | 0.60 | 0.55 | 0.45 |
| 活泼 | 0.85 | 0.65 | 0.75 | 0.80 |
| 安静 | 0.25 | 0.45 | 0.35 | 0.20 |
| 粘人 | 0.55 | 0.90 | 0.55 | 0.45 |

用户修改滑块后保存为“自定义”，同时保留来源预设，便于恢复。

### 7.2 短期心情

`MoodState` 包含：

- `energy`：动作消耗、休息恢复；`sleepiness = 1 - energy`。
- `valence`：范围 `-1...1` 的正负情绪，缓慢回归 0。
- `boredom`：无互动和无动作时上升，探索或玩耍后下降。
- `socialNeed`：距上次互动越久越高，互动后下降。

初始值为 `energy=0.75`、`valence=0`、`boredom=0.20`、`socialNeed=0.20`。所有状态更新后必须钳制到合法区间。

默认调参常量集中在版本化 tuning 配置中：

- 空闲每秒恢复 `energy +0.002`。
- 移动每秒消耗 `energy -0.004`。
- `jump` 和 `roll` 完成时额外消耗 `energy -0.08`。
- `valence` 以 10 分钟半衰期回归 0；正向点击增加 0.08。
- 连续空闲时每秒增加 `boredom +0.0015`；自主动作完成减少 0.12，互动减少 0.08。
- `socialNeed` 每秒增加 0.0008；用户互动减少 0.20。

这些值是首版可测试基线，不作为用户可见高级设置。

### 7.3 轻量记忆

长期保存：

- 当前性格预设和参数覆盖。
- 心情的平滑趋势值。
- 最近互动时间。
- 最近 20 个动作及完成结果。
- 按动作和互动类型聚合的计数。

不保存等级、饥饿、经验或必须定期照料的负向数值。应用离线后根据时间差一次性推算恢复和衰减，不逐秒补算。

## 8. 行为选择

行为调度器每 1 秒评估一次。先应用硬约束，再计算效用分。

硬约束包括：

- 当前模型是否支持或可回退该动作。
- 当前状态是否允许转换。
- 动作是否处于冷却期。
- 当前显示器是否有足够空间。
- 能量是否高于动作最低阈值。
- 当前是否处于拖拽、恢复或暂停状态。

效用公式：

```text
utility = clamp(
  baseWeight
  + traitWeights
  + moodWeights
  + eventWeights
  + noveltyBonus
  - cooldownPenalty
  - repetitionPenalty,
  0,
  1
)
```

从效用最高的三个候选中按 `exp(utility / 0.25)` 加权抽样。随机数生成器支持固定种子；生产环境种子来自运行会话，测试环境使用显式种子。

规则：

- 同一动作连续执行一次后，下一轮重复惩罚为 0.35；连续两次后为 0.70。
- `jump`、`roll` 默认冷却 20 秒，`walk`、`crawl` 默认冷却 5 秒。
- 手动动作绕过自主评分和普通冷却，但仍执行能力、空间和状态安全检查。
- 事件反应优先于自主动作。
- 拖拽始终拥有最高优先级。

优先级固定为：

```text
drag > manual > reaction > autonomous > idle
```

## 9. 状态机与动作执行

### 9.1 状态

```text
Starting -> Idle -> Acting -> Recovering -> Idle
               \-> Dragging -> Dropping -> Recovering
任意状态 -> Paused
任意可恢复错误 -> Recovering
不可恢复启动错误 -> Error
```

- `Starting`：加载设置、模型和适配器。
- `Idle`：允许行为调度。
- `Acting`：执行一个带 `executionId` 的动作计划。
- `Dragging`：用户持有宠物；立即停止窗口自主运动。
- `Dropping`：计算目标显示器和安全落点。
- `Recovering`：清理 motion、参数和空间速度，恢复落地姿态。
- `Paused`：用户暂停或应用进入安全模式。
- `Error`：模型无法启动且没有可用回退模型。

### 9.2 动作计划

```ts
interface ActionPlan {
  executionId: string
  action: SemanticAction
  priority: "autonomous" | "reaction" | "manual" | "drag"
  visual: ResolvedModelMotion
  spatial: SpatialMotion
  timeoutMs: number
  interruptible: boolean
  createdAt: number
}
```

主进程创建计划并同时启动：

1. 渲染进程的 Live2D motion/expression。
2. 主进程的窗口空间运动。

视觉和空间部分均完成后发布 `action.completed`。任何部分失败时发布 `action.failed`，取消另一部分并进入 `Recovering`。所有完成和失败事件必须匹配当前 `executionId`，过期事件直接丢弃。

### 9.3 空间运动

- 主进程使用单调时钟，以约 30 FPS 更新窗口位置。
- Live2D 渲染活动时目标为 60 FPS，空闲时可降到 30 FPS。
- `walk`、`crawl` 沿当前显示器 `workArea` 底部移动，触边后转向。
- `jump` 使用抛物线轨迹，起点和落点均位于当前显示器安全区域。
- `roll` 同步 Live2D motion 和水平位移，不旋转整个 BrowserWindow。
- 自主动作不能跨显示器边界。
- 用户拖拽时以窗口中心所在显示器作为目标显示器。
- `groundOffset` 用于将模型视觉脚底与 `workArea` 底部对齐。

### 9.4 命中、拖拽与右键

- 移除 `.deskpet-stage::after` 的悬停阴影；鼠标进入窗口时不再出现矩形暗边。
- 用户主动启用的“悬停淡化模型”保留，它与悬停阴影是独立功能。
- Renderer 使用 Pixi Live2D 模型的渲染边界判断鼠标是否位于人物区域，不使用整个透明窗口，也不要求模型提供 Cubism hit area。
- `ModelBoundsHitTester` 将 `model.getBounds()` 的渲染坐标转换为 canvas CSS 坐标；缩放、偏移和窗口尺寸变化后必须立即反映到命中结果。
- 窗口的可交互区域是“模型边界 + 当前可见 UI 控件”的并集；设置面板、聊天、输入框和按钮始终保持可操作。
- 鼠标位于上述并集之外的透明区域时启用 `setIgnoreMouseEvents(true, { forward: true })`；进入任一可交互区域时恢复鼠标接收。
- 只有在模型边界内左键按下才发布 `interaction.drag.start`；拖拽真实 BrowserWindow，不再修改模型在窗口内的 offset。
- 只有在模型边界内右键才阻止浏览器默认菜单并发布 `interaction.contextMenu`。
- 主进程显示 Electron 原生菜单，固定包含“设置”，并根据当前 adapter 动态生成“表情”和“动作”子菜单。
- 选择“设置”打开现有设置面板；选择表情发布 `command.emotion`；选择动作发布 `command.action`。
- 现有齿轮、聊天、语音按钮和底部拖动短横条在本次调整中保留，后续再单独决定是否移除。

手动表情采用独立覆盖通道：选择非中性表情后保持 10 秒，重复选择刷新时限，选择 `neutral` 立即清除覆盖。覆盖期间自主行为不能替换该表情，但拖拽和模型安全恢复仍可清理不兼容参数。表情来源优先级为 `manual > integration > reaction > mood > neutral`。

## 10. 统一事件接口

每个事件使用统一信封：

```ts
interface PetEventEnvelope<TType extends string, TPayload> {
  id: string
  type: TType
  source: "clock" | "user" | "runtime" | "maibot" | "system"
  occurredAt: number
  traceId: string
  payload: TPayload
}
```

首版事件：

- `clock.tick`
- `interaction.click`
- `interaction.pointer.enter`
- `interaction.pointer.leave`
- `interaction.drag.start`
- `interaction.drag.move`
- `interaction.drag.end`
- `interaction.contextMenu`
- `command.action`
- `command.emotion`
- `expression.expired`
- `motion.started`
- `motion.completed`
- `motion.failed`
- `action.completed`
- `action.failed`
- `display.changed`
- `runtime.pause`
- `runtime.resume`

事件总线规则：

- 所有 payload 在入口进行运行时校验。
- `clock.tick` 和 `interaction.drag.move` 只保留最新值。
- 队列默认上限 256；非关键自主事件可丢弃，拖拽结束、动作完成和错误事件不可丢弃。
- 同一 `traceId` 的同步递归发布深度上限为 16。
- 未来 MaiBot 和系统集成只能发布事件或提交语义命令，不能直接操作 Live2D 或窗口。

## 11. 独立运行与 MaiBot 集成

定义统一集成接口：

```ts
interface PetIntegration {
  id: string
  start(publish: (event: PetEventEnvelope) => void): Promise<void>
  stop(): Promise<void>
  getStatus(): IntegrationStatus
}
```

- `StandaloneIntegration` 始终启用，提供时间和用户互动事件。
- `MaiBotIntegration` 默认关闭，包装现有 WebSocket/Chimera transport。
- MaiBot 不可用、断线或协议错误不能阻止桌宠启动。
- MaiBot 的情绪与动作指令转换为 `command.emotion` 和 `command.action`。
- TTS、STT、截图识图保留为 MaiBot 可选能力，不进入桌宠核心依赖图。

## 12. 持久化

核心运行状态从 Renderer `localStorage` 迁移到主进程 `userData`：

- `settings.json`：模型 ID、性格预设、性格参数覆盖、用户设置、集成开关。
- `runtime-state.json`：心情趋势、最近互动、动作历史、聚合计数、窗口位置。
- `models/`：用户导入模型和适配文件。
- `logs/`：结构化诊断日志，每个文件最大 5 MiB，最多保留 5 个文件。

写入规则：

- 所有文件带 `schemaVersion`。
- 使用同目录临时文件、`fsync` 和原子替换。
- 运行状态最多每 30 秒写入一次，并在显著状态变化和正常退出时写入。
- 损坏文件重命名为带时间戳的备份，再加载默认值。
- 窗口位置保存“显示器指纹 + 归一化坐标”；显示器缺失时回到主屏安全区域。
- 不在每个动画帧或拖拽移动事件中写磁盘。

## 13. 异常、安全与性能

### 13.1 异常处理

- 适配文件无效：显示字段级诊断并使用扫描生成的临时配置。
- motion 缺失或播放失败：执行回退链并记录一次限频警告。
- 动作超时：停止空间运动，清理模型参数并回到安全落点。
- 显示器移除：立即将窗口修正到主屏 `workArea`。
- Renderer 崩溃：自动重载一次；再次失败进入安全模式，只显示设置和诊断。
- MaiBot 失败：更新集成状态，不影响独立行为。

### 13.2 Electron 安全基线

- 保持 `contextIsolation: true`。
- 启用 Renderer sandbox；若第三方渲染库存在明确兼容问题，必须记录最小复现后再做局部例外。
- 不启用 `nodeIntegration`。
- 移除上游的 `disable-gpu-sandbox` 和 `in-process-gpu` 启动参数，除非有可复现问题证明必须保留。
- Preload 只暴露带类型、带校验的窄接口。
- 不从远程 URL 加载 Renderer 页面或执行模型目录脚本。

### 13.3 性能目标

- 行为评分频率为 1 Hz。
- 窗口空间运动为约 30 FPS。
- 活动 Live2D 渲染目标为 60 FPS；空闲目标为 30 FPS。
- 窗口隐藏或确认被遮挡时暂停非必要渲染，行为调度保持 1 Hz。
- 以 Apple Silicon 基线机器为准，预热后空闲总 CPU 目标低于 5%，常驻内存目标低于 300 MB。
- 性能目标若未达成，不通过产品化阶段验收。

## 14. 测试策略

### 14.1 单元测试

使用 Vitest 覆盖：

- Adapter v1 到 v2 迁移。
- JSON Schema 校验和字段级诊断。
- 能力扫描、回退链、循环检测。
- 心情更新、离线恢复和边界钳制。
- 固定随机种子下的效用评分和候选选择。
- 状态转换、优先级、打断、超时和过期完成事件。
- 显示器坐标、落地线、触边转向和窗口修正。

使用 `fast-check` 生成事件序列，验证：

- 状态机不会进入未定义状态。
- mood 和 utility 永不越界或产生 `NaN`。
- 任意动作最终完成、失败或超时，不永久卡在 `Acting`。
- 任意显示器布局下窗口保留最小可见区域。

### 14.2 集成与端到端测试

- 主进程与 Renderer IPC 契约测试。
- 内置完整模型、缺动作模型、无 expression 模型和损坏配置 fixture。
- Playwright Electron 覆盖启动、模型导入、右键动作、拖拽、重启恢复和 MaiBot 禁用启动。
- macOS 实机覆盖多显示器、不同缩放比例、Spaces、Dock 位置、休眠唤醒和显示器热插拔。
- 窗口层级必须验证：Finder 桌面可交互、普通应用覆盖宠物、宠物自主移动不抢焦点。

## 15. 交付阶段

### 阶段 1：基线与安全

- 建立可构建的 macOS 分支。
- 将 Electron 34 升级到开发时仍受支持的稳定版本；升级单独提交。
- 加入测试框架、结构化日志和严格 IPC。
- 清理不安全的 GPU 和 Renderer 配置。

### 阶段 2：核心解耦

- 抽离 `PetEventBus`、`BehaviorEngine` 和 `IntegrationManager`。
- 让应用在 MaiBot、TTS、STT 均不可用时完整启动。
- 将 Pinia 中的核心运行状态迁移到主进程服务。

### 阶段 3：Adapter v2

- 完成 Schema、Ajv 校验、v1 迁移、能力扫描和回退链。
- 完成安全模型导入与诊断 UI。
- 为内置模型提供完整、已验证适配文件。

### 阶段 4：行为性格

- 完成性格预设、滑块、心情、轻量记忆和效用评分。
- 完成固定种子测试和行为分布测试。

### 阶段 5：桌面动作

- 完成状态机、MotionCoordinator、空间运动和原生桌面层桥接。
- 完成多显示器拖拽、动态点击穿透和原生右键菜单。
- 原生桥接必须分别构建 arm64 与 x86_64 产物，并随 Universal 应用完成签名和公证验证。

### 阶段 6：可选 MaiBot

- 将现有 Chimera/WebSocket 接入统一事件接口。
- 保留聊天、情绪和动作命令，语音与截图作为可选扩展。

### 阶段 7：产品化

- 使用 `electron-builder` 输出 Universal DMG。
- 完成 Developer ID 签名、Apple Notarization 和自动更新。
- 完成性能、稳定性、升级迁移和许可证检查。

可视化模型适配编辑器属于后续独立项目，在 v2 协议稳定后开发。

## 16. 验收标准

首版必须同时满足：

1. 未运行 MaiBot 时应用可以启动、互动、自动行动和持久化。
2. 内置模型支持全部核心动作和核心表情，能力状态均为 `verified`。
3. 外部 Cubism 4 模型缺少动作或表情时不崩溃，并显示明确能力诊断。
4. v1 适配文件可读，且不会被静默覆盖。
5. 平衡、活泼、安静、粘人性格在固定测试时长内表现出可统计差异。
6. 同一动作不会无限连续执行，任何动作都有完成、失败或超时终态。
7. 用户可以拖拽宠物跨显示器；自主动作始终限制在当前显示器。
8. 用户可以右键切换可用表情并手动触发可用动作。
9. 普通应用窗口覆盖宠物，宠物自主移动不抢焦点。
10. 重启后恢复模型、性格、心情趋势和有效桌面位置。
11. 损坏配置、Renderer 崩溃、显示器移除和 MaiBot 断线均有确定的恢复路径。
12. macOS 13 及以上的目标测试矩阵通过，性能目标达标。

## 17. 许可证与发布约束

- 本项目是 GPL-3.0 上游的派生作品；分发二进制时必须按 GPL-3.0 提供对应源码和许可证声明。
- Live2D Cubism SDK/Core 的使用和发布受 Live2D 自身许可约束，不能仅以 GPL-3.0 判断可分发性。
- 每个内置或用户分享的 Live2D 模型均有独立资源授权；官方示例模型也不能默认作为商业应用资源随意再分发。
- 产品化阶段必须生成第三方依赖清单、许可证清单和模型资源清单。

## 18. 已确定的延期项

以下内容不是未决问题，而是明确延期：

- 可视化模型适配编辑器。
- macOS 系统状态、音乐、电量和当前应用事件。
- 完整行为树编辑器。
- 完整养成系统。
- 多宠物同屏与宠物间互动。
- Mac App Store 发布。
