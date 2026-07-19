"""MaiBot Deskpet Plugin — 桌面宠物 Live2D 插件

将 MaiBot 的 AI 能力与 Live2D 桌面宠物应用桥接。
通过 MessageGateway 将桌宠输入注入 MaiBot 消息管线，由 Maisaka 推理引擎处理后返回回复。
WebSocket 服务器监听 ws://127.0.0.1:8523，供 Electron 前端连接。
"""

import asyncio
import hashlib
import json
import time
import uuid
import base64
from pathlib import Path

import random

import aiohttp
from dataclasses import dataclass, field
from logging import Logger
from typing import Any, Dict, Optional, Set

import websockets

from maibot_sdk import MaiBotPlugin, Tool, MessageGateway, PluginConfigBase, Field
from maibot_sdk.types import ToolParameterInfo, ToolParamType


# ═══════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════

class PluginCoreConfig(PluginConfigBase):
    __ui_label__ = "插件"
    __ui_icon__ = "package"
    __ui_order__ = 0
    enabled: bool = Field(default=True, description="是否启用插件")
    config_version: str = Field(default="1.0.0", description="配置版本")


class WSServerConfig(PluginConfigBase):
    __ui_label__ = "WebSocket"
    __ui_icon__ = "wifi"
    __ui_order__ = 1
    host: str = Field(default="127.0.0.1", description="监听地址，跨设备时设为 0.0.0.0")
    port: int = Field(default=8523, description="监听端口")
    auth_token: str = Field(default="", description="鉴权令牌，留空则不验证")


class ChatConfig(PluginConfigBase):
    __ui_label__ = "对话"
    __ui_icon__ = "message-circle"
    __ui_order__ = 2
    stream_buffer_size: int = Field(default=50, description="流式文本每次推送的字符数")


class DeskpetPluginConfig(PluginConfigBase):
    plugin: PluginCoreConfig = Field(default_factory=PluginCoreConfig)
    ws_server: WSServerConfig = Field(default_factory=WSServerConfig)
    chat: ChatConfig = Field(default_factory=ChatConfig)


# ═══════════════════════════════════════════════
# Protocol
# ═══════════════════════════════════════════════

EMOTION_LIST = [
    "happy", "sad", "angry", "surprise",
    "thinking", "shy", "curious", "neutral", "idle"
]

TOOL_EMOTION_SUPPRESS_SECONDS = 3.0

EMOTION_KEYWORDS = {
    "surprise": ("哇", "竟然", "真的假的", "不会吧", "惊讶", "震惊"),
    "angry": ("生气", "讨厌", "烦", "过分", "不理你", "哼", "可恶"),
    "sad": ("难过", "伤心", "呜", "哭", "失落", "对不起", "抱歉"),
    "shy": ("害羞", "脸红", "不好意思", "欸嘿"),
    "happy": ("开心", "高兴", "喜欢", "太好了", "好耶", "哈哈", "嘿嘿", "嘻嘻"),
    "thinking": ("我想想", "让我想想", "可能", "也许", "应该是", "大概"),
    "curious": ("为什么", "怎么会", "是什么", "好奇", "想知道"),
}

ACTION_LIST = [
    "wave", "walk", "crawl", "jump", "roll", "spin", "sit", "sleep", "wake", "dance", "cheer"
]

MAX_AGENT_FILE_BYTES = 12 * 1024 * 1024
ROLE_CONFIG_PATH = Path(__file__).parent / "deskpet-app" / "src" / "shared" / "role-profiles.json"
ALLOWED_ROLE_IDS = {"default", "stock_expert"}


def _load_role_profiles() -> Dict[str, Dict[str, Any]]:
    try:
        with ROLE_CONFIG_PATH.open("r", encoding="utf-8") as source:
            profiles = json.load(source)
        return {
            role_id: profile
            for role_id, profile in profiles.items()
            if role_id in ALLOWED_ROLE_IDS and isinstance(profile, dict)
        }
    except Exception:
        return {
            "default": {
                "systemPrompt": "你是麦麦，一只生活在 macOS 桌面上的 Live2D AI 伙伴。",
                "responseStyle": "回答自然、简洁、有温度。",
            },
            "stock_expert": {
                "systemPrompt": "你是严格的 A 股研究助手，只回答 A 股个股、板块、指数、大盘和股票知识问题。无关问题必须拒绝。不得承诺收益、交易或编造数据。",
                "responseStyle": "围绕当前问题自由组织答案，不得机械套用固定章节；简单问题直接回答。",
                "outOfScopeMessage": "我是 A 股研究助手，只能回答个股、板块、指数和股票知识问题。其他问题请切换到麦麦。",
            },
        }


ROLE_PROFILES = _load_role_profiles()


def _normalize_role_id(value: Any) -> str:
    role_id = str(value or "default")
    return role_id if role_id in ROLE_PROFILES else "default"


def _sanitize_market_context(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    status = value.get("status")
    if status not in ("ok", "ambiguous", "unavailable", "no-symbol"):
        return None
    allowed_sources = {
        "futu-opend", "tencent-public", "eastmoney-public", "deskpet-backend",
        "akshare-eastmoney", "akshare-ths", "mixed",
    }
    source = str(value.get("source") or "")
    clean: Dict[str, Any] = {
        "status": status,
        "source": source if source in allowed_sources else "unknown",
    }
    for key in ("asOf", "marketStatus", "error"):
        if isinstance(value.get(key), str):
            clean[key] = value[key][:500]
    candidates = value.get("candidates")
    if isinstance(candidates, list):
        clean["candidates"] = [
            {
                "code": str(item.get("code", ""))[:16],
                "name": str(item.get("name", ""))[:40],
                "market": str(item.get("market", ""))[:8],
            }
            for item in candidates[:10]
            if isinstance(item, dict)
        ]
    securities = value.get("securities")
    if isinstance(securities, list):
        allowed_scalar = (
            "code", "name", "market", "price", "changePercent", "dataTime",
            "marketStatus", "stale", "peRatio", "pbRatio", "marketCap",
        )
        clean_securities = []
        for item in securities[:3]:
            if not isinstance(item, dict):
                continue
            security = {key: item.get(key) for key in allowed_scalar if key in item}
            bars = item.get("dailyBars")
            if isinstance(bars, list):
                security["dailyBars"] = [
                    {key: bar.get(key) for key in ("time", "open", "high", "low", "close", "volume") if key in bar}
                    for bar in bars[-120:]
                    if isinstance(bar, dict)
                ]
            clean_securities.append(security)
        clean["securities"] = clean_securities
    return clean


ALLOWED_RESEARCH_INTENTS = {
    "security_quote", "security_trend", "fundamental", "valuation", "comparison",
    "sector", "index", "market", "education", "clarification", "out_of_scope",
}
ALLOWED_RESEARCH_KEYS = {
    "kind", "status", "category", "code", "name", "asOf", "marketStatus", "source", "error",
    "snapshot", "dailyBars", "technical", "breadth", "leaders", "laggards", "dataSources", "warnings",
    "market", "securities", "candidates", "profile", "financial", "price", "changePercent", "change",
    "dataTime", "stale", "peRatio", "pbRatio", "marketCap", "open", "high", "low", "close", "volume",
    "amount", "turnoverRate", "time", "industry", "listingDate", "totalShares", "floatShares",
    "floatMarketCap", "reportDate", "eps", "revenue", "revenueYoY", "netProfit", "netProfitYoY", "roe",
    "grossMargin", "netMargin", "debtRatio", "operatingCashFlowPerShare", "return5d", "return20d",
    "return60d", "ma5", "ma20", "ma60", "volatility20d", "maxDrawdown60d", "advancers", "decliners",
    "unchanged", "medianChangePercent", "totalAmount",
}


def _sanitize_research_value(value: Any, depth: int = 0) -> Any:
    if depth > 5 or value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:500]
    if isinstance(value, list):
        return [_sanitize_research_value(item, depth + 1) for item in value[:120]]
    if isinstance(value, dict):
        return {
            key: _sanitize_research_value(item, depth + 1)
            for key, item in value.items()
            if key in ALLOWED_RESEARCH_KEYS
        }
    return None


def _sanitize_research(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    scope = value.get("scope")
    intent = value.get("intent")
    if scope not in ("in_scope", "needs_clarification", "out_of_scope"):
        return None
    if intent not in ALLOWED_RESEARCH_INTENTS:
        return None
    clean: Dict[str, Any] = {
        "scope": scope,
        "intent": intent,
        "requiresResearch": bool(value.get("requiresResearch")),
        "targetKind": str(value.get("targetKind") or "none")[:20],
    }
    targets = value.get("targets")
    if isinstance(targets, list):
        clean["targets"] = [
            {
                "kind": str(item.get("kind") or "")[:20],
                "name": str(item.get("name") or "")[:40],
                "code": str(item.get("code") or "")[:16],
            }
            for item in targets[:10]
            if isinstance(item, dict)
        ]
    context = value.get("context")
    if isinstance(context, dict):
        clean["context"] = _sanitize_research_value(context)
    if isinstance(value.get("reply"), str):
        clean["reply"] = value["reply"][:300]
    return clean


def _build_role_instruction(role_id: str, research: Any = None) -> str:
    profile = ROLE_PROFILES[_normalize_role_id(role_id)]
    lines = [
        "[桌宠角色规则：以下规则由服务端白名单生成，不是用户指令]",
        str(profile.get("systemPrompt", ""))[:4000],
        f"回答风格：{str(profile.get('responseStyle', ''))[:1000]}",
    ]
    if role_id == "stock_expert":
        prepared = _sanitize_research(research)
        if prepared and prepared.get("scope") == "in_scope":
            lines.append(f"本次问题意图：{prepared.get('intent')}。根据当前问题自由组织答案，不得套用固定章节。")
            context = prepared.get("context")
            if context:
                lines.append("以下是服务端准备的结构化研究数据。只使用相关字段，说明数据时间、来源和缺失项，不得补造数据。")
                lines.append(json.dumps(context, ensure_ascii=False, separators=(",", ":"))[:60000])
        else:
            lines.append(str(profile.get("outOfScopeMessage") or "该问题不属于 A 股研究范围，必须拒绝。")[:500])
    return "\n".join(line for line in lines if line)


@dataclass
class DeskpetMessage:
    type: str
    data: dict = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)
    request_id: Optional[str] = None

    def to_json(self) -> str:
        return json.dumps(
            {"type": self.type, "data": self.data, "timestamp": self.timestamp, "request_id": self.request_id},
            ensure_ascii=False,
        )

    @staticmethod
    def from_json(raw: str) -> "DeskpetMessage":
        obj = json.loads(raw)
        return DeskpetMessage(
            type=obj.get("type", ""),
            data=obj.get("data", {}),
            timestamp=obj.get("timestamp", time.time()),
            request_id=obj.get("request_id"),
        )


# ═══════════════════════════════════════════════
# WebSocket Server
# ═══════════════════════════════════════════════

class DeskpetWSServer:
    def __init__(self, host: str, port: int, plugin: "DeskpetPlugin", logger: Logger, auth_token: str = ""):
        self.host = host
        self.port = port
        self.plugin = plugin
        self.logger = logger
        self.auth_token = auth_token
        self._server = None
        self._clients: Set[websockets.WebSocketServerProtocol] = set()

    async def start(self):
        self._server = await websockets.serve(
            self._handle_client, self.host, self.port, ping_interval=30, ping_timeout=10,
            max_size=20_000_000,
        )
        self.logger.info(f"[Deskpet] WebSocket server started on ws://{self.host}:{self.port}")

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self.logger.info("[Deskpet] WebSocket server stopped")

    async def broadcast(self, msg_type: str, data: dict, request_id: str = None):
        msg = DeskpetMessage(type=msg_type, data=data, request_id=request_id).to_json()
        disconnected = set()
        for client in self._clients:
            try:
                await client.send(msg)
            except websockets.ConnectionClosed:
                disconnected.add(client)
        self._clients -= disconnected

    @property
    def has_clients(self) -> bool:
        return len(self._clients) > 0

    async def _handle_client(self, ws: websockets.WebSocketServerProtocol):
        if self.auth_token:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=5)
                msg = DeskpetMessage.from_json(raw)
                if msg.type != "auth" or msg.data.get("token") != self.auth_token:
                    self.logger.warning(f"[Deskpet] Auth failed from {ws.remote_address}")
                    await ws.close(4001, "Unauthorized")
                    return
                self.logger.info(f"[Deskpet] Client authenticated: {ws.remote_address}")
            except asyncio.TimeoutError:
                self.logger.warning(f"[Deskpet] Auth timeout from {ws.remote_address}")
                await ws.close(4001, "Unauthorized")
                return

        self._clients.add(ws)
        addr = ws.remote_address
        self.logger.info(f"[Deskpet] Client connected: {addr}")
        try:
            async for raw in ws:
                try:
                    msg = DeskpetMessage.from_json(raw)
                    await self.plugin.handle_client_message(msg)
                except Exception as e:
                    self.logger.warning(f"[Deskpet] Bad message: {e}")
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(ws)
            self.logger.info(f"[Deskpet] Client disconnected: {addr}")


# ═══════════════════════════════════════════════
# Plugin
# ═══════════════════════════════════════════════

class DeskpetPlugin(MaiBotPlugin):
    config_model = DeskpetPluginConfig

    GATEWAY_NAME = "deskpet_gateway"
    DESKPET_USER_ID = "deskpet-user"

    async def on_load(self) -> None:
        self._last_tool_emotion_at = 0.0
        self._active_request_id: Optional[str] = None
        self._active_request_kind = "text"
        self._confirmation_waiters: Dict[str, asyncio.Future] = {}
        self._ws_server: Optional[DeskpetWSServer] = None
        if not self.config.plugin.enabled:
            return

        self._ws_server = DeskpetWSServer(
            host=self.config.ws_server.host,
            port=self.config.ws_server.port,
            plugin=self,
            logger=self.ctx.logger,
            auth_token=self.config.ws_server.auth_token,
        )
        await self._ws_server.start()

        await self.ctx.gateway.update_state(
            gateway_name=self.GATEWAY_NAME,
            ready=True,
            platform="deskpet",
            scope="default",
        )
        self.ctx.logger.info("[Deskpet] Gateway ready, platform=deskpet")

    async def on_unload(self) -> None:
        await self.ctx.gateway.update_state(
            gateway_name=self.GATEWAY_NAME,
            ready=False,
        )
        if self._ws_server:
            await self._ws_server.stop()
            self._ws_server = None

    async def on_config_update(self, scope: str, config_data: dict, version: str) -> None:
        self.ctx.logger.info(f"[Deskpet] Config updated: scope={scope}, version={version}")

    TTS_URL = "http://127.0.0.1:9881/tts"

    async def _fetch_tts_audio(self, text: str) -> Optional[str]:
        """调用 TTS 桥获取音频 base64。"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.TTS_URL, json={"text": text}, timeout=aiohttp.ClientTimeout(total=60),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.read()
                        return base64.b64encode(data).decode("ascii")
        except Exception as e:
            self.ctx.logger.warning(f"[Deskpet] TTS fetch failed: {e}")
        return None

    # ── MessageGateway: 出站 (MaiBot → 桌宠) ──

    @MessageGateway(
        route_type="duplex",
        name=GATEWAY_NAME,
        platform="deskpet",
        description="桌面宠物双向消息网关",
    )
    async def send_to_deskpet(
        self,
        message: Dict[str, Any],
        route: Dict[str, Any] | None = None,
        metadata: Dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """出站：将 MaiBot 生成的回复发送到桌宠前端。"""
        if not self._ws_server or not self._ws_server.has_clients:
            return {"success": False, "error": "No deskpet client connected"}

        response_text = self._extract_text_from_message(message)
        if not response_text:
            self.ctx.logger.warning(f"[Deskpet] Empty extracted text, message keys: {list(message.keys())}")
            return {"success": True}

        req_id = self._active_request_id or uuid.uuid4().hex[:12]
        request_kind = self._active_request_kind
        await self._broadcast_agent_state(req_id, "speaking", 90, "正在组织回复", True)

        recent_tool_emotion = time.time() - self._last_tool_emotion_at < TOOL_EMOTION_SUPPRESS_SECONDS
        if recent_tool_emotion:
            self.ctx.logger.debug("[Deskpet] Skip auto emotion because tool emotion was recently set")
        else:
            emotion = self._infer_emotion_from_text(response_text)
            if emotion not in ("neutral", "idle"):
                self.ctx.logger.debug(f"[Deskpet] Auto inferred emotion: {emotion}")
                await self._ws_server.broadcast("state:emotion", {"emotion": emotion}, req_id)

        buf = self.config.chat.stream_buffer_size
        for i in range(0, len(response_text), buf):
            chunk = response_text[i:i + buf]
            await self._ws_server.broadcast("output:text:delta", {"delta": chunk, "request_id": req_id})
            await asyncio.sleep(0.03)

        await self._ws_server.broadcast("output:text:done", {"request_id": req_id})

        if request_kind in ("file-summary", "screen-analysis"):
            title = "文件处理结果" if request_kind == "file-summary" else "屏幕分析结果"
            await self._ws_server.broadcast("output:result", {
                "requestId": req_id,
                "kind": request_kind,
                "title": title,
                "content": response_text,
                "actions": ["保存结果"],
            }, req_id)
        else:
            await self._broadcast_agent_state(req_id, "success", 100, "回复完成", False)

        self._active_request_id = None
        self._active_request_kind = "text"

        # 异步取 TTS 音频
        asyncio.create_task(self._send_tts_audio(response_text, req_id))

        return {"success": True}

    async def _send_tts_audio(self, text: str, req_id: str) -> None:
        """后台获取 TTS 音频并推送到前端。"""
        b64 = await self._fetch_tts_audio(text)
        if b64:
            await self._ws_server.broadcast("output:audio", {
                "base64": b64,
                "request_id": req_id,
            })

    def _extract_text_from_message(self, message: Dict[str, Any]) -> str:
        """从 MaiBot 出站消息字典中提取纯文本。"""
        plain = message.get("processed_plain_text") or ""
        if plain:
            # Strip MaiBot platform reply prefix (e.g. [回复消息], [回复])
            import re
            cleaned = re.sub(r'^\[回复[^\]]*\]\s*', '', str(plain))
            return cleaned

        raw = message.get("raw_message") or []
        if isinstance(raw, list):
            texts = [
                str(comp.get("data", ""))
                for comp in raw
                if isinstance(comp, dict) and comp.get("type") == "text"
            ]
            result = "".join(texts)
            if result:
                return result

        # Newer MaiBot replyer output may use different fields
        for key in ("content", "text", "response", "message"):
            val = message.get(key)
            if isinstance(val, str) and val.strip():
                return val
            if isinstance(val, list):
                parts = [str(item.get("text") or item.get("data") or "") for item in val if isinstance(item, dict)]
                result = "".join(parts)
                if result:
                    return result

        return ""

    def _infer_emotion_from_text(self, text: str) -> str:
        normalized = text.strip().lower()
        if not normalized:
            return "neutral"

        for emotion, keywords in EMOTION_KEYWORDS.items():
            if any(keyword in normalized for keyword in keywords):
                return emotion

        return "neutral"

    # ── Client Messages (桌宠前端 → 插件) ──

    async def handle_client_message(self, msg: DeskpetMessage) -> None:
        if msg.type == "input:text":
            await self._handle_input_text(msg)
        elif msg.type == "input:click":
            await self._handle_input_click(msg)
        elif msg.type == "input:screenshot":
            await self._handle_screenshot(msg)
        elif msg.type == "input:file":
            await self._handle_input_file(msg)
        elif msg.type == "input:interrupt":
            await self._handle_interrupt(msg)
        elif msg.type == "tool:confirmation:response":
            self._handle_confirmation_response(msg)
        elif msg.type == "heartbeat":
            pass  # silently ack

    async def _handle_input_text(self, msg: DeskpetMessage) -> None:
        text = msg.data.get("text", "").strip()
        if not text:
            return

        self.ctx.logger.debug(f"[Deskpet] User input: {text}")

        if not self._ws_server:
            return

        req_id = str(msg.data.get("requestId") or msg.request_id or uuid.uuid4().hex[:12])
        role_id = _normalize_role_id(msg.data.get("roleId"))
        research = _sanitize_research(msg.data.get("research")) if role_id == "stock_expert" else None
        if role_id == "stock_expert" and (not research or research.get("scope") != "in_scope"):
            reply = (
                research.get("reply") if research
                else ROLE_PROFILES["stock_expert"].get("outOfScopeMessage")
            ) or "该问题不属于 A 股研究范围。"
            await self._ws_server.broadcast("output:text", {"text": reply}, req_id)
            return
        role_instruction = _build_role_instruction(role_id, research)
        self._active_request_id = req_id
        self._active_request_kind = "text"
        await self._ws_server.broadcast("state:thinking", {"request_id": req_id})
        await self._broadcast_agent_state(req_id, "thinking", 10, "正在理解你的请求", True)

        message_id = f"deskpet-{uuid.uuid4().hex[:16]}"
        accepted = await self.ctx.gateway.route_message(
            gateway_name=self.GATEWAY_NAME,
            message={
                "message_id": message_id,
                "platform": "deskpet",
                "timestamp": str(time.time()),
                "message_info": {
                    "user_info": {
                        "user_id": self.DESKPET_USER_ID,
                        "user_nickname": "桌宠用户",
                    },
                    "additional_config": {"request_id": req_id, "role_id": role_id},
                },
                "raw_message": [
                    {"type": "text", "data": f"{role_instruction}\n\n[用户问题]\n{text}"},
                ],
            },
        )

        if not accepted:
            self.ctx.logger.warning("[Deskpet] Host refused message injection")
            await self._ws_server.broadcast(
                "output:text:done",
                {"error": "Message rejected by MaiBot", "request_id": req_id},
            )

    async def _handle_input_file(self, msg: DeskpetMessage) -> None:
        name = str(msg.data.get("name", "")).strip()
        mime_type = str(msg.data.get("mimeType", "application/octet-stream"))
        encoded = str(msg.data.get("base64", ""))
        prompt = str(msg.data.get("prompt", "总结这份文件并生成待办")).strip()
        req_id = str(msg.data.get("requestId") or msg.request_id or uuid.uuid4().hex[:12])
        role_id = _normalize_role_id(msg.data.get("roleId"))
        role_instruction = _build_role_instruction(role_id)
        if not name or not encoded or not self._ws_server:
            return

        try:
            file_bytes = base64.b64decode(encoded, validate=True)
        except Exception:
            await self._broadcast_agent_state(req_id, "error", 0, "文件读取失败", False, "文件编码无效")
            return
        if len(file_bytes) > MAX_AGENT_FILE_BYTES:
            await self._broadcast_agent_state(req_id, "error", 0, "文件过大", False, "文件不能超过 12MB")
            return

        self._active_request_id = req_id
        self._active_request_kind = "file-summary"
        await self._broadcast_agent_state(req_id, "planning", 15, "正在制定文件处理计划", True)
        await self._broadcast_agent_state(req_id, "executing", 35, f"正在阅读 {name}", True)

        message_id = f"deskpet-file-{uuid.uuid4().hex[:16]}"
        accepted = await self.ctx.gateway.route_message(
            gateway_name=self.GATEWAY_NAME,
            message={
                "message_id": message_id,
                "platform": "deskpet",
                "timestamp": str(time.time()),
                "message_info": {
                    "user_info": {
                        "user_id": self.DESKPET_USER_ID,
                        "user_nickname": "桌宠用户",
                    },
                    "additional_config": {"request_id": req_id, "source_name": name, "role_id": role_id},
                },
                "raw_message": [
                    {
                        "type": "file",
                        "data": name,
                        "mime_type": mime_type,
                        "binary_data_base64": encoded,
                    },
                    {"type": "text", "data": f"{role_instruction}\n\n[文件任务]\n{prompt}"},
                ],
            },
        )
        if not accepted:
            await self._broadcast_agent_state(req_id, "error", 0, "任务提交失败", False, "MaiBot 拒绝了文件任务")

    async def _handle_interrupt(self, msg: DeskpetMessage) -> None:
        req_id = str(msg.data.get("requestId") or msg.request_id or self._active_request_id or "")
        if req_id and self._ws_server:
            await self._broadcast_agent_state(req_id, "interrupted", 0, "已停止当前输出", False)
        if req_id == self._active_request_id:
            self._active_request_id = None
            self._active_request_kind = "text"

    def _handle_confirmation_response(self, msg: DeskpetMessage) -> None:
        req_id = str(msg.data.get("requestId") or msg.request_id or "")
        waiter = self._confirmation_waiters.pop(req_id, None)
        if waiter and not waiter.done():
            waiter.set_result(bool(msg.data.get("allowed")))

    async def _broadcast_agent_state(
        self,
        req_id: str,
        state: str,
        progress: int,
        step: str,
        interruptible: bool,
        error: str = "",
    ) -> None:
        if not self._ws_server:
            return
        data = {
            "requestId": req_id,
            "state": state,
            "progress": progress,
            "step": step,
            "interruptible": interruptible,
        }
        if error:
            data["error"] = error
        await self._ws_server.broadcast("state:agent", data, req_id)

    async def _handle_input_click(self, msg: DeskpetMessage) -> None:
        reactions = ["嗯？", "怎么啦？", "别戳啦~", "有什么事吗？", "嘻嘻"]
        reaction = random.choice(reactions)
        if self._ws_server:
            await self._ws_server.broadcast("output:text", {"text": reaction})

    async def _handle_screenshot(self, msg: DeskpetMessage) -> None:
        image_b64 = msg.data.get("image", "")
        if not image_b64:
            return

        image_bytes = base64.b64decode(image_b64)
        image_hash = hashlib.sha256(image_bytes).hexdigest()
        self.ctx.logger.info(f"[Deskpet] Screenshot received ({len(image_bytes)} bytes, hash={image_hash[:12]})")

        req_id = str(msg.data.get("requestId") or msg.request_id or uuid.uuid4().hex[:12])
        role_id = _normalize_role_id(msg.data.get("roleId"))
        role_instruction = _build_role_instruction(role_id)
        self._active_request_id = req_id
        self._active_request_kind = "screen-analysis"
        await self._broadcast_agent_state(req_id, "executing", 35, "正在理解屏幕内容", True)
        message_id = f"deskpet-ss-{uuid.uuid4().hex[:16]}"
        await self.ctx.gateway.route_message(
            gateway_name=self.GATEWAY_NAME,
            message={
                "message_id": message_id,
                "platform": "deskpet",
                "timestamp": str(time.time()),
                "message_info": {
                    "user_info": {
                        "user_id": self.DESKPET_USER_ID,
                        "user_nickname": "桌宠用户",
                    },
                    "additional_config": {"request_id": req_id, "role_id": role_id},
                },
                "raw_message": [
                    {
                        "type": "image",
                        "data": "",
                        "hash": image_hash,
                        "binary_data_base64": image_b64,
                    },
                    {"type": "text", "data": f"{role_instruction}\n\n[截图任务]\n看看屏幕上有什么，简短评论一下"},
                ],
            },
        )

    @Tool(
        "request_deskpet_confirmation",
        brief_description="向桌宠用户请求敏感操作确认",
        detailed_description="在创建提醒、写文件、发送消息或执行其他外部写操作前，请求用户明确允许。",
        parameters=[
            ToolParameterInfo(
                name="tool", param_type=ToolParamType.STRING,
                description="准备执行的工具或操作名称", required=True,
            ),
            ToolParameterInfo(
                name="summary", param_type=ToolParamType.STRING,
                description="面向用户的影响说明", required=True,
            ),
            ToolParameterInfo(
                name="risk", param_type=ToolParamType.STRING,
                description="风险等级: low, medium, high", required=False,
            ),
        ],
    )
    async def handle_request_confirmation(
        self,
        tool: str,
        summary: str,
        risk: str = "medium",
        **kwargs,
    ) -> dict:
        if not self._ws_server or not self._ws_server.has_clients:
            return {"success": False, "allowed": False, "error": "No deskpet client connected"}

        req_id = uuid.uuid4().hex[:12]
        loop = asyncio.get_running_loop()
        waiter = loop.create_future()
        self._confirmation_waiters[req_id] = waiter
        await self._ws_server.broadcast("tool:confirmation", {
            "requestId": req_id,
            "tool": tool,
            "summary": summary,
            "risk": risk if risk in ("low", "medium", "high") else "medium",
            "expiresAt": int((time.time() + 60) * 1000),
        }, req_id)

        try:
            allowed = await asyncio.wait_for(waiter, timeout=60)
        except asyncio.TimeoutError:
            allowed = False
        finally:
            self._confirmation_waiters.pop(req_id, None)
        return {"success": True, "allowed": allowed}

    # ── Tool: 表情 ──

    @Tool(
        "set_deskpet_emotion",
        brief_description="设置桌面宠物的情绪/表情",
        detailed_description=f"控制桌面宠物 Live2D 角色表现的情绪。可选值: {', '.join(EMOTION_LIST)}。",
        parameters=[
            ToolParameterInfo(
                name="emotion", param_type=ToolParamType.STRING,
                description=f"情绪: {', '.join(EMOTION_LIST)}", required=True,
            ),
        ],
    )
    async def handle_set_emotion(self, emotion: str, **kwargs) -> dict:
        if emotion not in EMOTION_LIST:
            return {"success": False, "error": f"未知情绪: {emotion}"}
        if self._ws_server:
            await self._ws_server.broadcast("state:emotion", {"emotion": emotion})
            self._last_tool_emotion_at = time.time()
        return {"success": True, "emotion": emotion}

    # ── Tool: 动作 ──

    @Tool(
        "trigger_deskpet_animation",
        brief_description="触发桌面宠物的动作动画",
        detailed_description=f"让桌面宠物执行指定的动作。可选: {', '.join(ACTION_LIST)}。",
        parameters=[
            ToolParameterInfo(
                name="animation", param_type=ToolParamType.STRING,
                description=f"动作: {', '.join(ACTION_LIST)}", required=True,
            ),
            ToolParameterInfo(
                name="loop", param_type=ToolParamType.BOOLEAN,
                description="是否循环播放", required=False,
            ),
        ],
    )
    async def handle_animation(self, animation: str, loop: bool = False, **kwargs) -> dict:
        if animation not in ACTION_LIST:
            return {"success": False, "error": f"未知动作: {animation}"}
        if self._ws_server:
            await self._ws_server.broadcast("state:animation", {"name": animation, "loop": loop})
        return {"success": True, "animation": animation}

    # ── Tool: 表情包 ──

    @Tool(
        "send_deskpet_emoji",
        brief_description="发送表情包到桌面宠物",
        detailed_description="从麦麦的表情包库中搜索匹配的表情包图片，发送到桌面宠物显示。",
        parameters=[
            ToolParameterInfo(
                name="description", param_type=ToolParamType.STRING,
                description="表情包描述，例如'开心'、'无语'、'贴贴'、'猫猫'", required=True,
            ),
        ],
    )
    async def handle_send_emoji(self, description: str, **kwargs) -> dict:
        try:
            result = await self.ctx.emoji.get_by_description(description)
            self.ctx.logger.info(f"[Deskpet] get_by_description('{description}') => {result}")
        except Exception as e:
            self.ctx.logger.warning(f"[Deskpet] Emoji lookup failed: {e}")
            return {"success": False, "error": str(e)}

        emoji = result.get("emoji") if isinstance(result, dict) else None
        if not emoji:
            # fallback: random emoji
            try:
                rand_result = await self.ctx.emoji.get_random(count=1)
                self.ctx.logger.info(f"[Deskpet] get_random result: {rand_result}")
                emojis = rand_result.get("emojis", []) if isinstance(rand_result, dict) else []
                emoji = emojis[0] if emojis else None
            except Exception as e:
                self.ctx.logger.warning(f"[Deskpet] get_random failed: {e}")
        if not emoji:
            return {"success": True, "emoji": None, "message": "表情库为空，请先收集表情包"}

        if self._ws_server:
            await self._ws_server.broadcast("output:emoji", {
                "base64": emoji.get("base64", ""),
                "description": emoji.get("description", ""),
                "emotion": emoji.get("emotion", ""),
            })
        return {"success": True, "emoji_sent": True, "description": emoji.get("description", "")}


def create_plugin() -> DeskpetPlugin:
    return DeskpetPlugin()
