# 麦麦桌宠后端

FastAPI 单体服务，统一处理角色提示词、A 股行情、模型调用、用户记忆、鉴权和限流。桌宠客户端只提交白名单 `roleId`，不能提交系统提示词或供应商 URL。

角色文案统一维护在 `deskpet-app/src/shared/role-profiles.json`，路由、研究、日期和回答完整性提示词统一维护在 `deskpet-app/src/shared/prompt-contract.json`。后端、豆包直连和 MaiBot 都读取这两份共享配置，不应在各自代码中复制提示词文案。

## 本地启动

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18540 --reload --env-file .env
```

服务默认不要求 Redis 和 PostgreSQL：缓存与用户记忆退回进程内存。生产环境应配置 `REDIS_URL` 和 `DATABASE_URL`。

## 接口

- `GET /health`：服务与配置状态。
- `POST /v1/market/context`：股票解析、快照、估值和最多 120 日日 K。
- `POST /v1/market/sector-scan`：扫描 A 股行业板块，按趋势持续性、风险、市场宽度和资金流返回候选排名。
- `POST /v1/research/prepare`：股票专家领域判断、复杂度路由以及个股、板块、指数和大盘研究准备。
- `POST /v1/research/prepare/stream`：SSE 研究准备；计算过程中发送 `reasoning`，完成后发送一次 `result`。
- `POST /v1/agent/chat`：SSE Agent 对话，事件为 `state`、`research`、`reasoning`、`delta`、`done`、`error`。
- `GET|POST /v1/memories`：读取或新增当前设备的长期记忆。
- `DELETE /v1/memories/{id}`：删除当前设备的长期记忆。
- `GET /docs`：OpenAPI 调试页面。

请求头：

```text
Authorization: Bearer <DESKPET_API_TOKEN>
X-Device-Id: <稳定的匿名设备 ID>
```

## 行情数据

默认使用 AKShare 聚合的东方财富公开数据获取沪深北 A 股实时快照，并按数据能力选择供应商。配置 Tushare 后，证券主数据、前复权 120 日日 K、每日估值、公司资料、财务历史和交易日历优先使用 Tushare Pro；官方公告优先使用巨潮资讯。新闻、盘中快照和板块数据继续使用现有公开源。后端基于统一日 K 计算阶段收益、均线、20 日年化波动率和 60 日最大回撤。

Tushare 接口权限取决于个人账号。某项接口无权限或请求失败时，后端按数据分项回退 AKShare、腾讯或东方财富；公司资料或财务指标失败不会阻断基础行情分析。响应中的 `dataSources`、`sourceRecordId` 和 `warnings` 会标明实际来源、财报期、公告时间与缺失项，不会把降级数据标记成 Tushare 数据。

```env
MARKET_PROVIDER=akshare
MARKET_FALLBACK_PROVIDER=tencent
MARKET_REQUEST_TIMEOUT=8
PROFESSIONAL_DATA_PROVIDER=tushare
TUSHARE_TOKEN=
TUSHARE_FINANCIAL_ENABLED=false
OFFICIAL_ANNOUNCEMENT_PROVIDER=cninfo
```

`TUSHARE_TOKEN` 只能写入本机 `backend/.env` 或服务端环境变量，不能提交到仓库。即使配置了 Tushare，盘中实时快照仍由 AKShare/腾讯链路提供，避免把收盘数据伪装成实时行情。Tushare 日线通过每日 `pre_close` 连续重建前复权价格，避免依赖低额度账号受限的逐证券复权因子接口。只有账号已取得 `fina_indicator` 和 `income` 权限时才能设置 `TUSHARE_FINANCIAL_ENABLED=true`；否则多期财务自动使用 AKShare/东方财富。财务数据保留报告期 `reportDate`、披露日 `announcedAt` 和来源记录 `sourceRecordId`，用于避免历史研究中的未来数据泄漏。

缓存时效：全市场实时快照 15 秒、名称解析 24 小时、公司资料 24 小时、财务指标 6 小时、日 K 15 分钟。交易时段数据超过 60 秒标记为陈旧。

AKShare 和兜底适配器均依赖公开网页接口，适合原型与研究辅助，不代表交易所授权行情；商业发布前必须确认数据展示与再分发授权。

股票专家只处理 A 股个股、行业与概念板块、主要指数、大盘和股票知识。越界请求在模型调用前直接拒绝。只有趋势、基本面、估值、对比、板块和市场等复杂研究任务会返回可折叠的研究摘要；简单报价和知识问答直接回答。

领域路由采用受控 Agent 模式。第一阶段由独立的 `qwen3.7-max` 只读取当前问题，输出白名单 JSON 计划，包括 `intent`、`relation`、`targetKind`、`targetSource`、`requestedData` 和 `timeRangeDays`。只有当前问题缺少可执行目标或属于解释性追问时，第二阶段才读取最近历史；历史标的必须逐字存在，并且只有 `followup` 或 `answer_explanation` 可以继承。这样新问题不会被上一轮标的覆盖。

问题信息不足或行情解析返回多个有效候选时，研究响应通过 `clarification` 返回结构化卡片，包括问题、最多 6 个真实候选项、自由输入配置以及 `round/maxRounds`。同一澄清链最多两轮；第三次仍不完整时停止研究并要求重新提问。新主题由语义路由重置轮次。行情源故障和路由服务异常不会伪装成澄清卡片。

规则层只处理证券代码格式、权限、参数范围、目标来源和工具结果类型，不承担自然语言句式枚举。结构化意图映射到白名单 Skill 和只读 MCP 工具，执行后还会校验 context 类型与计划意图是否一致。Qwen 不生成最终回答；回答仍由 `MODEL_NAME` 指定的模型完成。分类不可用时明确返回服务错误，最终证券代码、板块和指数仍由行情服务解析验证。

```env
# 正式回答模型
MODEL_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
MODEL_API_KEY=
MODEL_NAME=

# 意图分类模型，ROUTER_MODEL_API_KEY 为空时也会读取 DASHSCOPE_API_KEY
ROUTER_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ROUTER_MODEL_API_KEY=
ROUTER_MODEL_NAME=qwen3.7-max
ROUTER_MODEL_TIMEOUT=5
```

Qwen 路由请求关闭思考模式并限制为结构化输出。不要把 DashScope Key 写入前端代码或提交到仓库；本地开发写入 `backend/.env`，Electron 自动启动后端时也会读取该文件；部署时使用服务端环境变量。

“科技板块”这类宽泛主题会先映射到标准行业再聚合研究。当前科技主题覆盖半导体、软件开发、IT 服务、通信设备和消费电子；每个行业的行情、历史趋势、市场宽度和领涨股会分别进入模型上下文。

研究进度来自实际数据工作流，不是前端延时动画。板块扫描会依次报告快照获取、候选筛选、历史趋势计算进度和排名完成；多个请求等待同一次后台扫描时会共享该任务的进度。命中 15 分钟缓存时只报告缓存命中，不伪造计算过程。

板块筛选请求示例：

```bash
curl -X POST http://127.0.0.1:18540/v1/market/sector-scan \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <DESKPET_API_TOKEN>' \
  -H 'X-Device-Id: <设备 ID>' \
  -d '{"universe":"industry","trend":"steady_up","windowDays":60,"limit":5}'
```

`windowDays` 支持 `20` 或 `60`，`limit` 支持 `1` 到 `10`。接口先用全行业快照筛出候选，再并发获取候选板块日 K，返回严格匹配、接近匹配和观察名单；结果缓存 15 分钟。

## Docker

```bash
cd backend
cp .env.example .env
docker compose up --build
```
