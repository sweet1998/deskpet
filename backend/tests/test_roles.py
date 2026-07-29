from app.roles import get_role
from app.agent.skills import SKILLS, skills_for_intent


def test_role_registry_is_server_controlled():
    assert get_role("default").name == "麦麦"
    stock = get_role("stock_expert")
    assert "不构成投资建议" in stock.riskNotice
    assert "不得承诺收益" in stock.systemPrompt
    assert "固定章节" in stock.systemPrompt
    assert "a_share_sector" in stock.capabilities
    assert "a_share_sector_scan" in stock.capabilities
    assert "请切换到麦麦" in stock.outOfScopeMessage


def test_sector_scan_uses_dedicated_skill_and_tool():
    skills = skills_for_intent("sector_scan", True)

    assert skills[0] == "sector-trend-scan"
    assert SKILLS["sector-trend-scan"].required_tools == ("scan_sectors",)
