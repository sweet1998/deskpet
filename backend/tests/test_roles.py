from app.roles import get_role


def test_role_registry_is_server_controlled():
    assert get_role("default").name == "麦麦"
    stock = get_role("stock_expert")
    assert "不构成投资建议" in stock.riskNotice
    assert "不得承诺收益" in stock.systemPrompt
    assert "固定章节" in stock.systemPrompt
    assert "a_share_sector" in stock.capabilities
    assert "请切换到麦麦" in stock.outOfScopeMessage
