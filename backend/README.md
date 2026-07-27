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

默认使用 AKShare 聚合的东方财富公开数据，获取沪深北 A 股实时快照、前复权 120 日日 K、公司资料和最近一期主要财务指标。后端基于日 K 计算阶段收益、均线、20 日年化波动率和 60 日最大回撤。AKShare 的同步调用运行在最多 4 个线程的专用线程池中，不会阻塞 FastAPI 事件循环。

当 AKShare 的名称解析、快照或日 K 请求失败时，后端按数据分项回退腾讯/东方财富适配器；公司资料或财务指标失败不会阻断基础行情分析，响应中的 `dataSources` 和 `warnings` 会标明实际来源与缺失项。

```env
MARKET_PROVIDER=akshare
MARKET_FALLBACK_PROVIDER=tencent
MARKET_REQUEST_TIMEOUT=8
```

缓存时效：全市场实时快照 15 秒、名称解析 24 小时、公司资料 24 小时、财务指标 6 小时、日 K 15 分钟。交易时段数据超过 60 秒标记为陈旧。

AKShare 和兜底适配器均依赖公开网页接口，适合原型与研究辅助，不代表交易所授权行情；商业发布前必须确认数据展示与再分发授权。

股票专家只处理 A 股个股、行业与概念板块、主要指数、大盘和股票知识。越界请求在模型调用前直接拒绝。只有趋势、基本面、估值、对比、板块和市场等复杂研究任务会返回可折叠的研究摘要；简单报价和知识问答直接回答。

领域路由采用规则与 Qwen3 8B 混合模式：六位代码和固定知识表达优先走规则，模糊表达由独立的 `qwen3-8b` 生成白名单 JSON 意图。Qwen 只负责分类，不生成最终回答；回答仍由 `MODEL_NAME` 指定的模型完成。后端只采纳置信度不低于 0.72 的结果，并要求 `targetTerms` 必须逐字存在于当前问题或最近历史中；最终证券代码、板块和指数仍由行情服务解析验证。分类超时、不可用或结构无效时自动退回规则路由。

```env
# 正式回答模型
MODEL_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
MODEL_API_KEY=
MODEL_NAME=

# 意图分类模型，ROUTER_MODEL_API_KEY 为空时也会读取 DASHSCOPE_API_KEY
ROUTER_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
ROUTER_MODEL_API_KEY=
ROUTER_MODEL_NAME=qwen3-8b
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
