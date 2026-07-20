# 麦麦 AI 桌宠

面向 macOS 的 Live2D 桌面宠物实验项目。当前版本包含模型边界交互、统一对话工作台、可切换 AI 角色，以及基于 AKShare 的 A 股研究工作流。

> [!IMPORTANT]
> 本仓库是基于 [Maboroshinatsu/maibot-deskpet-plugin](https://github.com/Maboroshinatsu/maibot-deskpet-plugin) 的二次开发项目，不是 MaiBot 官方项目，也不是从零创建的独立实现。原项目提供了 MaiBot 插件、Live2D 桌宠、消息管线、语音桥和表情动作系统等基础能力。本仓库在此基础上重点改造了 macOS 桌面交互、窗口布局、统一对话界面、AI Agent 状态、角色系统和 A 股研究后端。
>
> 原项目署名：MaboroshiNatsu / DeepSeek-V4PRO。当前二次开发仓库：[sweet1998/deskpet](https://github.com/sweet1998/deskpet)。项目继续使用 GPL-3.0 许可证，并保留原作者、原项目和相关开源项目的署名与致谢。

## 当前状态

- 主要开发和验证平台：macOS。
- 当前以源码开发方式运行，尚未提供 DMG、自动更新或免安装发行包。
- 默认模型：仓库内的 Live2D 官方示例模型 Hiyori Pro。
- 默认 AI 服务商：豆包（火山方舟）。
- 完整股票研究能力需要同时启动 `backend/` 服务。
- MaiBot、SenseVoice、GPT-SoVITS 和富途 OpenD 都是可选组件，不是显示和拖拽桌宠的前置条件。

## 已实现功能

### 桌宠交互

- 透明 Electron 窗口，仅 Live2D 人物边界和已打开的 UI 响应鼠标。
- 按住人物拖拽桌宠；单击人物直接打开历史记录和输入框。
- 右键人物打开原生菜单，可进入设置或切换当前模型支持的表情和动作。
- 在人物区域滚动鼠标滚轮缩放模型。
- 支持视线跟随、空闲动画、跳跃、走路、爬行、打滚等适配器动作。
- 设置面板打开后固定在屏幕中央，人物仍可独立移动。
- 支持置顶、仅桌面显示、锁定鼠标穿透、悬停淡化和布局重置。

“仅桌面显示”会取消浮层置顶，使浏览器等普通窗口能够覆盖桌宠；关闭后桌宠会以浮动窗口显示在其他应用上方。

### 统一对话工作台

- 历史消息、分析记录、流式回答和输入框位于同一个可拖拽面板。
- 单击人物后输入框自动聚焦，不需要再点击文字输入或历史按钮。
- 输入区常驻麦克风和发送按钮，回答期间可编辑下一条草稿。
- 对话历史和未发送草稿按角色保存在本机；每个角色最多保留最近 100 条可持久化消息。
- 支持流式回答、无活动超时、停止回答、错误提示和重试。
- 复杂研究任务显示可折叠的“分析记录”；简单问答不会显示伪造的思考过程。

### 角色系统

当前内置两个角色，共用同一个 Live2D 模型：

| 角色 | 定位 | 行为边界 |
|---|---|---|
| 麦麦 | 日常陪伴和通用对话 | 语气自然温和，使用共享称呼、偏好和长期记忆 |
| 炒股专家 | A 股研究助手 | 只回答 A 股个股、行业/概念板块、主要指数、大盘和股票知识 |

- 可以在对话面板标题栏切换角色，也可以在设置中选择默认角色。
- 用户称呼、偏好和长期记忆跨角色共享，对话历史和草稿按角色隔离。
- 切换角色会中断当前请求，迟到回复不会写入新角色的历史。
- 股票专家遇到天气、编程、生活等无关问题时会直接拒绝，并提示切换到麦麦。
- 股票分析仅供研究参考，不构成投资建议，不接入账户、持仓或交易接口。

### A 股研究

股票研究后端位于 `backend/`，当前工作流为：

```text
领域与复杂度判断
  -> 识别个股、板块、指数或大盘目标
  -> AKShare 获取行情与详情
  -> 腾讯/东方财富按数据分项兜底
  -> 计算技术和风险指标
  -> 流式输出可核验的分析摘要
  -> 模型生成正式回答
```

已覆盖：

- 沪深北 A 股代码与名称解析，最多同时研究 3 只股票。
- 实时快照、前复权 120 日日 K、PE/PB、市值、公司资料和最近一期财务指标。
- 5/20/60 日收益率、MA5/20/60、20 日年化波动率和 60 日最大回撤。
- 行业板块扫描、趋势持续性、市场宽度、领涨股和资金流信息。
- 主要指数、大盘、个股走势、基本面、估值和多标的对比。
- 数据来源、更新时间、降级情况和缺失项提示。

AKShare 和兜底适配器使用公开网页数据，适合原型与研究辅助，不代表交易所授权行情。商业发布前需要自行确认数据展示与再分发授权。

## AI 接入方式

设置面板提供三种 AI 服务商。不同接入方式的能力并不完全相同：

| 能力 | 豆包直连 | 桌宠后端 | MaiBot |
|---|---:|---:|---:|
| 麦麦文字对话 | 支持 | 支持 | 支持 |
| 正式回答流式输出 | 支持 | 支持 | 取决于 MaiBot 消息管线 |
| 炒股专家 | 支持，需要研究后端 | 支持 | 支持，需要研究后端 |
| 文件 Agent | 不支持 | 不支持 | 支持 |
| 截图理解 | 不支持 | 不支持 | 支持 |
| 本地语音转文字 | 需要 STT Bridge | 需要 STT Bridge | 需要 STT Bridge |
| MaiBot 工具、TTS 和表情包 | 不支持 | 不支持 | 支持 |

### 豆包直连

这是客户端默认模式。API Key 保存在 Electron 应用数据目录，不写入网页 `localStorage`。

1. 右键人物，选择“设置...”。
2. 在“AI 服务”中选择“豆包（火山方舟）”。
3. 填写火山方舟 API Key 和模型 Endpoint ID。
4. 保存并测试连接。

只使用麦麦进行通用对话时，不需要启动 Python 后端。切换到炒股专家后，客户端仍会请求本地研究后端获取股票、板块和指数数据，因此需要完成后面的“启动股票研究后端”。

### 桌宠后端

推荐用于完整的麦麦和炒股专家对话。角色 Prompt、研究路由、行情上下文和最终模型调用都由后端统一管理，客户端只能提交白名单 `roleId`。

后端兼容 OpenAI 风格的 `/chat/completions` 接口，默认基础地址为火山方舟。完整环境变量见 [`backend/.env.example`](backend/.env.example)。

### MaiBot

该模式保留原项目的 MaiBot MessageGateway 集成，适合需要文件处理、截图理解、TTS、表情包和 MaiBot 工具管线的用户。

- MaiBot 版本范围以 [`_manifest.json`](_manifest.json) 为准，当前最低宿主版本为 1.0.0，最低 SDK 版本为 2.0.0。
- 将本仓库作为插件放入 MaiBot 的 `plugins` 目录，并让 MaiBot 加载 `plugin.py`。
- WebSocket 默认地址为 `ws://127.0.0.1:8523/ws`，服务端配置见 [`config.toml`](config.toml)。
- 在桌宠设置中选择“MaiBot”，按需填写 WS 地址和 Token，然后刷新应用建立连接。
- 使用炒股专家时仍需要本仓库的研究后端；MaiBot 负责最终对话和工具管线。

原始 MaiBot 插件的配置背景可参考[上游项目](https://github.com/Maboroshinatsu/maibot-deskpet-plugin)。不同 MaiBot 版本的 Prompt 和平台配置可能存在差异，应以实际安装版本为准。

## 本地启动

### 1. 环境要求

必需：

- macOS。
- Node.js 和 npm。
- 支持 Cubism 4 的 Live2D Web 运行环境；所需 Cubism Core 已随当前开发目录配置。

按功能选装：

- Python 3：股票研究后端、STT Bridge 或 OpenD Bridge。
- MaiBot：文件、截图、TTS 和原插件工具能力。
- 富途 OpenD：仅当主动选择本地 OpenD 高级行情源时需要。
- GPT-SoVITS：仅当使用 MaiBot 语音合成管线时需要。

### 2. 获取代码

```bash
git clone git@github.com:sweet1998/deskpet.git
cd deskpet
```

也可以使用 HTTPS：

```bash
git clone https://github.com/sweet1998/deskpet.git
cd deskpet
```

### 3. 启动桌宠前端

```bash
cd deskpet-app
npm install
npm run dev
```

Electron 启动后应显示 Hiyori Pro。单击人物打开对话，右键人物进入设置。

如果只想确认 Live2D 显示、拖拽和右键设置是否正常，到这里已经足够。AI 对话需要继续配置豆包、桌宠后端或 MaiBot 中的一种。

## 启动股票研究后端

在仓库根目录执行：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
python run.py
```

默认监听 `http://127.0.0.1:18540`，OpenAPI 文档位于 `http://127.0.0.1:18540/docs`。

启动前建议编辑 `backend/.env`：

| 环境变量 | 用途 | 何时必填 |
|---|---|---|
| `DESKPET_API_TOKEN` | 后端访问令牌 | `.env` 中设置非空值时，前端必须填写相同令牌 |
| `MODEL_BASE_URL` | OpenAI 兼容模型 API 基础地址 | 使用“桌宠后端”生成最终回答时 |
| `MODEL_API_KEY` | 模型 API Key | 使用“桌宠后端”生成最终回答时 |
| `MODEL_NAME` | 模型名或 Endpoint ID | 使用“桌宠后端”生成最终回答时 |
| `MARKET_PROVIDER` | 主行情源，默认 `akshare` | 通常无需修改 |
| `MARKET_FALLBACK_PROVIDER` | 兜底行情源，默认 `tencent` | 通常无需修改 |
| `REDIS_URL` | 跨进程缓存 | 生产部署可选 |
| `DATABASE_URL` | 长期记忆数据库 | 生产部署可选 |

两种典型配置：

- 豆包直连 + 股票研究：后端只负责研究准备，`MODEL_API_KEY` 和 `MODEL_NAME` 可以留空；前端的 AI 服务商仍选择豆包。
- 完整桌宠后端：填写模型配置，前端 AI 服务商选择“桌宠后端”，并在“行情数据”中填写后端地址和访问令牌。

更详细的 API、缓存和 Docker 部署说明见 [`backend/README.md`](backend/README.md)。

## 可选组件

### 富途 OpenD 高级行情

普通用户不需要安装 OpenD。默认股票数据来自桌宠后端的 AKShare 和兜底适配器。

只有选择“本地富途 OpenD（高级）”时才需要：

```bash
python3 -m pip install futu-api aiohttp
```

然后启动并登录富途 OpenD。默认配置为：

- OpenD：`127.0.0.1:11111`
- 本地行情桥：`http://127.0.0.1:18531`

Electron 会检查外部行情桥；未运行时会尝试通过系统 `python3` 启动 [`futu-market-bridge.py`](futu-market-bridge.py)。该桥只创建行情上下文，不读取账户、持仓或交易接口。OpenD 高级模式当前主要补充个股行情，板块、指数和市场研究仍依赖桌宠后端。

### SenseVoice 语音识别

语音输入需要运行 [`stt-bridge.py`](stt-bridge.py)：

```bash
python3 -m pip install aiohttp numpy sherpa-onnx
python3 stt-bridge.py
```

脚本默认从 `deskpet-app/sensevoice/` 读取：

```text
deskpet-app/sensevoice/model.onnx
deskpet-app/sensevoice/tokens.txt
```

仓库不内置这两个模型文件。STT Bridge 默认监听 `http://127.0.0.1:18530/stt`，需要在设置页保持相同地址。

### GPT-SoVITS

[`gpt-sovits-bridge.py`](gpt-sovits-bridge.py) 保留了原项目的 GPT-SoVITS HTTP 适配能力，默认监听端口 `9881`。它当前属于 MaiBot 语音输出链路，不是豆包直连或桌宠后端文字对话的必需组件。

使用前需要自行安装 GPT-SoVITS、准备角色权重和参考音频，并根据本地环境配置桥接脚本。相关实现来源和背景见上游项目及 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)。

## 端口与本地服务

| 默认端口 | 服务 | 必需性 |
|---:|---|---|
| `5173` | Electron renderer 开发服务 | `npm run dev` 自动启动 |
| `18540` | 桌宠后端 | 炒股专家必需；完整后端模式必需 |
| `8523` | MaiBot WebSocket | 仅 MaiBot 模式 |
| `18530` | SenseVoice STT Bridge | 仅语音输入 |
| `9881` | GPT-SoVITS Bridge | 仅 MaiBot TTS |
| `11111` | 富途 OpenD | 仅 OpenD 高级模式 |
| `18531` | OpenD 本地行情桥 | 仅 OpenD 高级模式 |

这些服务默认面向本机开发。不要在没有鉴权、反向代理和访问控制的情况下直接暴露到公网。

## 操作说明

| 操作 | 结果 |
|---|---|
| 单击人物 | 打开完整对话历史和输入框，并自动聚焦 |
| 按住人物拖动 | 移动桌宠窗口 |
| 右键人物 | 打开设置、表情和动作菜单 |
| 人物区域滚轮 | 缩放 Live2D 模型 |
| 拖动对话面板顶部 | 单独移动对话面板 |
| `Command/Ctrl + Alt + H` | 显示或隐藏桌宠 |
| `Command/Ctrl + Alt + F` | 开关悬停淡化 |
| `Command/Ctrl + Alt + L` | 开关锁定鼠标穿透 |

如果误开“锁定鼠标穿透”后无法点击人物，可以使用快捷键或托盘菜单取消。

## 自定义 Live2D 模型

将 Cubism 4 模型放入：

```text
deskpet-app/src/renderer/public/models/
```

然后在右键设置中填写 `.model3.json` 路径，或修改 [`model-config.ts`](deskpet-app/src/renderer/services/model-config.ts) 的默认路径。模型目录约定见 [`public/models/README.md`](deskpet-app/src/renderer/public/models/README.md)。

### 模型适配器

在 `.model3.json` 同目录添加 `deskpet-adapter.json`，可以把统一情绪和语义动作映射到模型自己的 Motion、Expression 和参数：

```json
{
  "version": 1,
  "modelId": "your-model",
  "emotions": {
    "happy": {
      "expression": "smile",
      "motion": { "group": "Tap", "index": 0 }
    },
    "neutral": {
      "parameters": { "ParamMouthForm": 0 }
    }
  },
  "animations": {
    "wave": {
      "motion": { "group": "Tap", "index": 1 },
      "effect": "wave"
    }
  }
}
```

没有适配器的标准 Cubism 4 模型仍可以加载，但右键菜单、Agent 状态和语义动作无法保证正确映射。适配器中的 Motion 分组、索引和参数必须与具体模型资源一致。

## 项目结构

```text
deskpet/
├── README.md
├── LICENSE
├── _manifest.json                 # MaiBot 插件清单
├── config.toml                    # MaiBot WebSocket 配置
├── plugin.py                      # MaiBot MessageGateway 插件入口
├── backend/                       # FastAPI Agent 与 A 股研究后端
│   ├── app/
│   ├── tests/
│   ├── .env.example
│   ├── requirements.txt
│   └── docker-compose.yml
├── deskpet-app/                   # Electron + Vue 桌宠客户端
│   └── src/
│       ├── main/                  # Electron 主进程、窗口和本地密钥
│       ├── preload/               # 安全 IPC 接口
│       ├── renderer/              # Live2D、统一对话、设置和状态管理
│       └── shared/                # 角色、行情和研究协议
├── futu-market-bridge.py          # 可选 OpenD 行情桥
├── stt-bridge.py                  # 可选 SenseVoice STT 桥
├── gpt-sovits-bridge.py           # 可选 GPT-SoVITS 桥
└── start.bat                      # 上游保留的 Windows/MaiBot 启动脚本
```

`start.bat` 仍保留用于兼容原项目环境，但不是当前 macOS 主启动方式。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面客户端 | Electron 34、electron-vite |
| 前端 | Vue 3.5、Pinia、TypeScript、Lucide |
| Live2D | PixiJS 6、pixi-live2d-display、Cubism 4 |
| Agent 后端 | FastAPI、Pydantic、SSE |
| 模型接口 | OpenAI 兼容 Chat Completions、火山方舟豆包 |
| A 股数据 | AKShare 1.18.64、腾讯/东方财富兜底 |
| 可选存储 | Redis、PostgreSQL |
| MaiBot 通信 | WebSocket MessageGateway |
| 可选语音 | SenseVoice/sherpa-onnx、GPT-SoVITS |

## 测试与构建

前端：

```bash
cd deskpet-app
npm test
npx tsc --noEmit -p tsconfig.node.json
npm run build
```

后端：

```bash
cd backend
source .venv/bin/activate
python -m pytest -q
```

后端单元测试使用模拟数据，不要求实时连接 AKShare 或 OpenD。

## 已知限制

- 当前没有面向普通用户的一键安装包，前端和后端需要分别启动。
- 主要在 macOS 开发验证；Windows 保留上游脚本和大部分 Electron 兼容性，但不是当前验收平台。
- Linux 尚未验证。
- 豆包直连和桌宠后端模式暂不支持文件 Agent 与截图理解。
- 语音输入依赖外部 STT Bridge；豆包直连和桌宠后端当前不提供完整 TTS 输出链路。
- OpenD 不是股票专家的完整后端替代品，板块和指数研究仍需要 `backend/`。
- AKShare 等公开数据源可能受网络、网页接口变化和访问频率影响，客户端会显示降级或缺失提示，但无法保证交易级实时性。
- 当前只有“麦麦”和“炒股专家”两个角色，尚未实现投资专家和前端专家。

## 常见问题

### 桌面上没有人物

确认 `npm run dev` 仍在运行，并检查终端是否提示缺少 Cubism Core 或模型文件。默认模型入口为：

```text
deskpet-app/src/renderer/public/models/hiyori_pro_zh/hiyori_pro_zh/runtime/hiyori_pro_t11.model3.json
```

### 单击人物没有反应

先确认没有锁定鼠标穿透。可使用 `Command/Ctrl + Alt + L` 或托盘菜单取消。开发过程中如果修改了 Pinia Store 结构，建议重启 Electron 进程后再验证。

### 麦麦可以回答，但炒股专家报后端连接失败

股票专家会先调用 `http://127.0.0.1:18540/v1/research/prepare/stream`。请启动 `backend/`，并确认设置中的后端地址和 `DESKPET_API_TOKEN` 一致。

### 后端可连接，但无法生成正式回答

如果前端 AI 服务商选择“桌宠后端”，需要在 `backend/.env` 配置 `MODEL_API_KEY` 和 `MODEL_NAME`。`GET /health` 中的 `modelConfigured` 应为 `true`。

### OpenD 未启动

如果没有主动选择 OpenD，将行情来源切回“桌宠后端”即可。普通用户不需要安装 OpenD。

### 语音输入没有反应

确认 `stt-bridge.py` 正在运行、SenseVoice 模型文件存在，并且设置中的 STT 地址为 `http://127.0.0.1:18530/stt`。

## 原项目与致谢

本项目建立在以下项目和方案之上：

- [Maboroshinatsu/maibot-deskpet-plugin](https://github.com/Maboroshinatsu/maibot-deskpet-plugin)：本仓库的直接上游和二次开发基础。
- [MaiBot](https://github.com/MaiM-with-u/MaiBot)：原插件宿主和消息管线。
- [Airi](https://github.com/moeru-ai/airi)：PixiJS Live2D 渲染参考。
- [Shinsekai / NachoBot](https://github.com/RachelForster/Shinsekai)：GPT-SoVITS 与音频处理管线参考。
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)：可选语音合成引擎。
- [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx)：SenseVoice 本地语音识别运行时。
- [AKShare](https://github.com/akfamily/akshare)：A 股公开数据聚合接口。

感谢原项目作者和所有相关开源项目贡献者。本仓库的二次开发不改变原项目及第三方资源各自的版权归属。

## 许可证

本项目使用 [GPL-3.0](LICENSE) 许可证。二次分发、修改和发布时，请继续遵守 GPL-3.0，并保留原项目来源、许可证及相关版权声明。
