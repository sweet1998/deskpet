import json

import httpx
import pytest

from app.agent.model_client import DEFAULT_MAX_TOKENS, OpenAICompatibleModel


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
