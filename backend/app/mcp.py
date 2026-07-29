from typing import TYPE_CHECKING, Any, Dict, Optional

from .agent.tools import ResearchTools, TOOL_DEFINITIONS
from .market.service import MarketService

if TYPE_CHECKING:
    from .quant.service import QuantService


MCP_PROTOCOL_VERSION = "2024-11-05"


def _error(request_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


async def handle_mcp_request(
    market: MarketService,
    body: Dict[str, Any],
    quant: Optional["QuantService"] = None,
) -> Dict[str, Any]:
    request_id = body.get("id")
    if body.get("jsonrpc") != "2.0" or not isinstance(body.get("method"), str):
        return _error(request_id, -32600, "Invalid Request")
    method = body["method"]
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "a-share-research", "version": "0.1.0"},
                "instructions": "只读 A 股研究工具。不得连接账户、下单或声称保证收益。",
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOL_DEFINITIONS}}
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        if not isinstance(name, str) or not name:
            return _error(request_id, -32602, "tools/call 缺少工具名称")
        tools = ResearchTools(market, quant)
        try:
            value = await tools.call(name, arguments)
        except KeyError:
            return _error(request_id, -32601, f"未知工具：{name}")
        except (TypeError, ValueError) as error:
            return _error(request_id, -32602, str(error))
        except Exception as error:
            result = tools.mcp_result({"status": "unavailable", "error": str(error)[:500]})
            result["isError"] = True
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        return {"jsonrpc": "2.0", "id": request_id, "result": tools.mcp_result(value)}
    return _error(request_id, -32601, f"Method not found: {method}")
