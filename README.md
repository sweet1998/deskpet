# 麦麦 AI 桌宠

面向 macOS 的 Live2D 桌面 AI 助手。当前交付版提供可安装 DMG、自动启动的本地 A 股研究服务，以及一套面向普通用户的豆包配置。

> [!IMPORTANT]
> 本仓库是 [Maboroshinatsu/maibot-deskpet-plugin](https://github.com/Maboroshinatsu/maibot-deskpet-plugin) 的二次开发项目，不是 MaiBot 官方项目，也不是从零创建的独立实现。原项目提供了 MaiBot 插件、Live2D 桌宠、消息管线、语音桥和表情动作系统等基础能力。
>
> 当前仓库为 [sweet1998/deskpet](https://github.com/sweet1998/deskpet)。二次开发重点包括 macOS 窗口交互、统一对话工作台、流式 AI 对话、角色系统、A 股研究工作流、内置后端和 DMG 发布链路。项目继续使用 GPL-3.0，保留原作者署名、许可证和致谢。

## 当前交付版

- 平台：macOS，当前构建机产出 Apple Silicon `arm64` DMG。
- 桌面端：Electron + Vue + Live2D。
- 默认 AI：豆包（火山方舟），普通用户不再选择 MaiBot、外部后端或 OpenD。
- 本地研究服务：随应用安装并自动启动，固定监听 `127.0.0.1:18540`。
- 行情：AKShare 主源，腾讯/东方财富分项兜底。
- 角色：麦麦、炒股专家。
- 签名发布：支持 Developer ID Application 签名、Apple 公证和 stapler 验证。

未签名测试包可在本机生成。面向外部用户分发时必须使用正式签名与公证命令。

## 使用方式

| 操作 | 结果 |
|---|---|
| 单击人物 | 打开对话历史和输入框并自动聚焦 |
| 按住人物拖动 | 移动桌宠，已打开的对话工作台跟随移动 |
| 右键人物 | 打开设置、表情和动作菜单 |
| 人物区域滚轮 | 缩放 Live2D 模型 |
| 拖动对话面板顶部 | 单独移动对话面板 |
| `Command + Alt + H` | 显示或隐藏桌宠 |
| `Command + Alt + F` | 开关悬停淡化 |
| `Command + Alt + L` | 开关锁定鼠标穿透 |

透明窗口只在人物边界和已打开的 UI 上响应鼠标。设置面板显示在屏幕中央，人物拖动时设置面板不会跟随。

## AI 与角色

普通用户只需在右键设置中填写两项：

1. 火山方舟豆包 API Key。
2. 模型 Endpoint ID，例如 `ep-2024xxxxxxxx`。

API Key 保存在 macOS 应用数据目录，不写入网页存储，也不随仓库或 DMG 分发。正式产品不应内置开发者的公共 API Key；每位用户应使用自己的凭据，或后续改为服务端账号与额度体系。

### 麦麦

用于日常陪伴和通用对话，采用自然温和的表达。用户称呼、偏好和明确要求记住的事项作为共享长期记忆保存。

### 炒股专家

严格限定在 A 股个股、行业/概念板块、主要指数、大盘和股票知识。复杂研究会展示可折叠的分析记录，简单行情和知识问答直接回答。天气、编程和生活等越界问题会提示切换到麦麦。

股票专家的流程为：

```text
领域与复杂度判断
  -> 识别个股、板块、指数或大盘
  -> 本地研究服务获取行情与详情
  -> 计算技术与风险指标
  -> 流式展示可核验的分析摘要
  -> 豆包生成正式回答
```

股票信息仅供研究参考，不构成投资建议。应用不读取账户、持仓，也不提供交易和自动下单。

## 安装 DMG

正式发布者提供经过 Developer ID 签名与 Apple 公证的 `MaiMai-DeskPet-<version>-<arch>.dmg` 后：

1. 双击 DMG。
2. 将“麦麦 AI 桌宠”拖入“应用程序”。
3. 从“应用程序”启动。
4. 右键人物打开设置，填写豆包 API Key 和 Endpoint ID。

应用启动时会自动检查本地研究服务。若 `18540` 端口已有兼容服务则复用；否则启动应用包内的后端。退出桌宠时只终止由本次桌宠进程启动的后端，不影响外部进程。

后端日志写入 Electron 应用数据目录下的 `logs/backend.log`。首次启动或网络数据源异常时，可在设置中点击“检查服务状态”。

## 源码开发

### 环境

- macOS。
- Node.js 20 和 npm。
- Python 3.9 或更高版本，用于开发与打包本地研究服务。
- 完整且有合法使用权的 Cubism 4 Live2D 模型资源。

安装前端依赖：

```bash
cd deskpet-app
npm install
```

准备后端虚拟环境：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

启动开发版：

```bash
cd deskpet-app
npm run dev
```

Electron 会自动使用 `backend/.venv` 启动 `backend/desktop_entry.py`。开发时也可以单独运行 `python run.py` 调试后端，但不要同时占用 `18540` 端口。

## Live2D 发布资源

默认入口为：

```text
deskpet-app/src/renderer/public/models/hiyori_pro_zh/hiyori_pro_zh/runtime/hiyori_pro_t11.model3.json
```

模型二进制、贴图和动作文件当前被 `.gitignore` 排除，仓库只跟踪适配器。干净克隆不会自动获得完整模型；发布者必须在构建前恢复完整模型目录。发布脚本会检查 `.model3.json`，缺失时直接终止，避免生成没有人物的 DMG。

公开分发前必须确认 Live2D 模型、贴图、动作、Cubism Core 和相关素材的再分发许可。构建成功不等于自动获得素材分发权。

自定义模型可放入 `deskpet-app/src/renderer/public/models/`。在 `.model3.json` 同目录添加 `deskpet-adapter.json`，可以把统一情绪和语义动作映射到模型自己的 Motion、Expression 和参数。

## 构建未签名测试 DMG

未签名包只用于本机开发验证，不适合直接发给普通用户：

```bash
cd deskpet-app
npm run dist:mac:unsigned
```

该命令会依次完成：

```text
检查 Live2D 与许可证文件
  -> 生成 1024 px macOS 图标
  -> PyInstaller 打包 AKShare 后端
  -> electron-vite 生产构建
  -> electron-builder 生成当前架构 DMG
```

输出位于 `deskpet-app/dist/`。

## 正式签名与 Apple 公证

需要 Apple Developer Program 账号、`Developer ID Application` 证书、证书导出的 `.p12` 文件，以及 Apple ID 的 app-specific password。凭据只能放在本机环境变量或私密 CI Secret 中，不要提交到仓库或发到聊天中。

```bash
export CSC_LINK=/absolute/path/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD='p12-password'
export APPLE_ID='developer@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='ABCDE12345'

cd deskpet-app
npm run dist:mac
```

正式命令会强制检查以上变量，执行 hardened runtime 签名和 Apple 公证，并在结束前验证：

- `.app` 的深度签名与严格校验。
- macOS Gatekeeper 接受应用。
- stapler 公证票据有效。
- DMG 校验和与主签名有效。

Apple Silicon 构建机默认生成 arm64 包。x64 包应在 Intel macOS 构建机或对应 CI runner 上生成，不能把 arm64 Python 后端直接放入 x64 应用。

## 项目结构

```text
deskpet/
├── README.md
├── LICENSE
├── backend/                       # FastAPI Agent 与 A 股研究服务
│   ├── app/
│   ├── tests/
│   ├── desktop_entry.py           # 桌面内置后端入口
│   └── deskpet-backend.spec       # PyInstaller 配置
├── deskpet-app/
│   ├── build/                     # macOS entitlements 与生成图标
│   ├── scripts/                   # 发布、签名、公证检查脚本
│   └── src/
│       ├── main/                  # Electron 主进程与后端生命周期
│       ├── preload/               # 安全 IPC
│       ├── renderer/              # Live2D、对话、设置和状态
│       └── shared/                # 角色、行情和研究协议
├── plugin.py                      # 上游 MaiBot 兼容入口
├── futu-market-bridge.py          # 保留的 OpenD 高级兼容桥
├── stt-bridge.py                  # 可选本地语音识别桥
└── gpt-sovits-bridge.py           # 可选语音合成桥
```

MaiBot、OpenD、外部后端地址等兼容实现仍保留在代码中，但不属于当前普通用户交付路径，也不显示在默认设置页。

## 测试

前端与 Electron：

```bash
cd deskpet-app
npm test
npx tsc --noEmit -p tsconfig.node.json
npx vue-tsc --noEmit
npm run build
```

后端：

```bash
cd backend
source .venv/bin/activate
python -m pytest -q
```

后端单元测试使用模拟数据，不依赖实时 AKShare 或 OpenD。后端详细 API、缓存和 Docker 说明见 [`backend/README.md`](backend/README.md)。

## 已知限制

- 当前交付物只在 Apple Silicon macOS 构建和验证，Intel 包尚未生成。
- 当前没有自动更新机制；升级需要重新安装新版 DMG。
- 豆包 API Key 由用户自行提供，尚未实现账号、套餐、额度和服务端密钥托管。
- 语音输入仍依赖外部 STT Bridge；当前交付版没有完整内置 TTS。
- 文件 Agent 和截图理解不属于豆包默认链路。
- AKShare 等公开数据源可能受网络、网页接口变化和访问频率影响，不是交易级授权行情。
- Live2D 模型文件未纳入 Git，干净克隆需要发布者自行恢复合法资源。

## 原项目与致谢

- [Maboroshinatsu/maibot-deskpet-plugin](https://github.com/Maboroshinatsu/maibot-deskpet-plugin)：直接上游与二次开发基础。
- [MaiBot](https://github.com/MaiM-with-u/MaiBot)：原插件宿主和消息管线。
- [Airi](https://github.com/moeru-ai/airi)：PixiJS Live2D 渲染参考。
- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)：可选语音合成引擎。
- [Sherpa-ONNX](https://github.com/k2-fsa/sherpa-onnx)：可选本地语音识别运行时。
- [AKShare](https://github.com/akfamily/akshare)：A 股公开数据聚合接口。

原项目署名：MaboroshiNatsu / DeepSeek-V4PRO。二次开发不改变上游项目与第三方资源各自的版权归属。

## 许可证

项目使用 [GPL-3.0](LICENSE)。修改、二次分发和发布时须继续遵守 GPL-3.0，并保留原项目来源、许可证和相关版权声明。
