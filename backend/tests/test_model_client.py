import json

import httpx
import pytest

from app.agent.model_client import DEFAULT_MAX_TOKENS, OpenAICompatibleModel
from app.models import ChatMessage


def sse_response(*events):
    body = "".join(f"data: {json.dumps(event, ensure_ascii=False)}\n\n" for event in events)
    return httpx.Response(200, text=f"{body}data: [DONE]\n\n")


@pytest.mark.asyncio
async def test_stream_automatically_continues_after_length_finish_reason():
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            return sse_response(
                {"choices": [{"delta": {"content": "我不方便瞎"}}]},
                {"choices": [{"delta": {}, "finish_reason": "length"}]},
            )
        return sse_response(
            {"choices": [{"delta": {"content": "猜，仍需核实消息面。"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatibleModel(
        base_url="https://example.test/v1",
        api_key="secret",
        model="test-model",
        client=client,
    )
    try:
        output = "".join([chunk async for chunk in model.stream([
            {"role": "system", "content": "保持严谨"},
            {"role": "user", "content": "分析医药板块"},
        ], max_tokens=4096)])
    finally:
        await client.aclose()

    assert output == "我不方便瞎猜，仍需核实消息面。"
    assert len(requests) == 2
    assert requests[0]["max_tokens"] == DEFAULT_MAX_TOKENS == 4096
    assert requests[1]["messages"][-2] == {"role": "assistant", "content": "我不方便瞎"}
    assert "从中断处直接续写" in requests[1]["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_model_classifies_stock_intent_as_validated_json():
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": json.dumps({
                "scope": "in_scope",
                "intent": "answer_followup",
                "relation": "answer_explanation",
                "targetKind": "knowledge",
                "targetTerms": [],
                "requiresResearch": False,
                "confidence": 0.97,
            })}}],
        })

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatibleModel("https://example.test/v1", "secret", "test-model", client=client)
    try:
        route = await model.classify_stock_intent("为什么这么说", [
            ChatMessage(role="assistant", content="白酒板块近期偏弱。"),
        ])
    finally:
        await client.aclose()

    assert route is not None
    assert route.intent == "answer_followup"
    assert requests[0]["temperature"] == 0
    assert requests[0]["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_qwen_router_disables_thinking_and_uses_router_model():
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "<think>ignored</think>" + json.dumps({
                "scope": "in_scope",
                "intent": "sector",
                "relation": "followup",
                "targetKind": "sector",
                "targetTerms": ["白酒"],
                "requiresResearch": True,
                "confidence": 0.96,
            })}}],
        })

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=5)
    model = OpenAICompatibleModel(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "secret",
        "qwen3-8b",
        client=client,
        route_extra_body={"enable_thinking": False},
    )
    try:
        route = await model.classify_stock_intent("它最近怎么样", [
            ChatMessage(role="user", content="看看白酒板块"),
        ])
    finally:
        await client.aclose()

    assert route is not None
    assert route.intent == "sector"
    assert requests[0]["model"] == "qwen3-8b"
    assert requests[0]["enable_thinking"] is False
