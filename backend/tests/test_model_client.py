import json

import httpx
import pytest

from app.agent.model_client import COMPLETION_MARKER, DEFAULT_MAX_TOKENS, OpenAICompatibleModel
from app.models import ChatMessage


def sse_response(*events):
    body = "".join(f"data: {json.dumps(event, ensure_ascii=False)}\n\n" for event in events)
    return httpx.Response(200, text=f"{body}data: [DONE]\n\n")


@pytest.mark.asyncio
async def test_stream_automatically_continues_after_length_finish_reason():
    requests = []
    stream_count = 0

    def handler(request):
        nonlocal stream_count
        requests.append(json.loads(request.content))
        if not requests[-1].get("stream"):
            return httpx.Response(200, json={
                "choices": [{"message": {"content": '{"complete":true}'}}],
            })
        stream_count += 1
        if stream_count == 1:
            return sse_response(
                {"choices": [{"delta": {"content": "我不方便瞎"}}]},
                {"choices": [{"delta": {}, "finish_reason": "length"}]},
            )
        return sse_response(
            {"choices": [{"delta": {"content": f"猜，仍需核实消息面。{COMPLETION_MARKER}"}}]},
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
    assert len(requests) == 3
    assert requests[0]["max_tokens"] == DEFAULT_MAX_TOKENS == 4096
    assert requests[1]["messages"][-2] == {"role": "assistant", "content": "我不方便瞎"}
    assert "从断点直接续写" in requests[1]["messages"][-1]["content"]
    assert COMPLETION_MARKER in requests[0]["messages"][0]["content"]
    assert COMPLETION_MARKER not in output


@pytest.mark.asyncio
async def test_stream_continues_when_marker_follows_an_unfinished_sentence():
    requests = []
    stream_count = 0
    verification_count = 0

    def handler(request):
        nonlocal stream_count, verification_count
        requests.append(json.loads(request.content))
        if not requests[-1].get("stream"):
            verification_count += 1
            return httpx.Response(200, json={
                "choices": [{"message": {"content": json.dumps({
                    "complete": verification_count > 1,
                })}}],
            })
        stream_count += 1
        if stream_count == 1:
            return sse_response(
                {"choices": [{"delta": {"content": f"市场风格偏{COMPLETION_MARKER}"}}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            )
        return sse_response(
            {"choices": [{"delta": {"content": f"成长。{COMPLETION_MARKER}"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatibleModel("https://example.test/v1", "secret", "test-model", client=client)
    try:
        output = "".join([chunk async for chunk in model.stream([
            {"role": "user", "content": "今天行情怎么样"},
        ])])
    finally:
        await client.aclose()

    assert output == "市场风格偏成长。"
    assert len(requests) == 4


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


@pytest.mark.asyncio
async def test_model_normalizes_inconsistent_out_of_scope_intent():
    def handler(request):
        return httpx.Response(200, json={
            "choices": [{"message": {"content": json.dumps({
                "scope": "out_of_scope",
                "intent": "education",
                "relation": "new_topic",
                "targetKind": "knowledge",
                "targetTerms": [],
                "requiresResearch": True,
                "confidence": 0.9,
            })}}],
        })

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatibleModel("https://example.test/v1", "secret", "qwen3-8b", client=client)
    try:
        route = await model.classify_stock_intent("你能告诉我怎么去北京吗", [])
    finally:
        await client.aclose()

    assert route is not None
    assert route.intent == "out_of_scope"
    assert route.targetKind == "none"
    assert route.requiresResearch is False
