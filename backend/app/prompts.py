import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from .models import RoleProfile


def _prompt_file() -> Path:
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        return Path(bundle_root) / "deskpet-app" / "src" / "shared" / "prompt-contract.json"
    return Path(__file__).resolve().parents[2] / "deskpet-app" / "src" / "shared" / "prompt-contract.json"


PROMPT_FILE = _prompt_file()
with PROMPT_FILE.open("r", encoding="utf-8") as source:
    PROMPT_CONTRACT: Dict[str, Any] = json.load(source)


def _render(template: str, **values: Any) -> str:
    return re.sub(
        r"\{([A-Za-z][A-Za-z0-9]*)\}",
        lambda match: str(values.get(match.group(1), match.group(0))),
        template,
    )


COMPLETION_MARKER = str(PROMPT_CONTRACT["completion"]["marker"])
COMPLETION_INSTRUCTION = _render(
    PROMPT_CONTRACT["completion"]["instructionTemplate"],
    marker=COMPLETION_MARKER,
)
CONTINUATION_PROMPT = _render(
    PROMPT_CONTRACT["completion"]["continuationTemplate"],
    marker=COMPLETION_MARKER,
)
COMPLETION_VERIFIER_PROMPT = str(PROMPT_CONTRACT["completion"]["verifierPrompt"])
STOCK_ROUTE_SYSTEM_PROMPT = str(PROMPT_CONTRACT["stockRouter"]["systemPrompt"])


def build_current_date_prompt(date: str) -> str:
    config = PROMPT_CONTRACT["date"]
    return _render(
        config["currentTemplate"],
        date=date,
        relativeTimeRule=config["relativeTimeRule"],
    )


def build_trading_calendar_prompt(calendar: Dict[str, Any]) -> Optional[str]:
    if calendar.get("status") != "ok":
        return None
    today = calendar.get("today")
    tomorrow = calendar.get("tomorrow")
    if not isinstance(today, dict) or not isinstance(tomorrow, dict):
        return None
    config = PROMPT_CONTRACT["date"]
    parts = [
        _render(
            config["calendarTodayTemplate"],
            date=today.get("date", ""),
            weekday=today.get("weekday", ""),
            source=calendar.get("source") or "akshare",
        ),
        _render(
            config["calendarTradingTemplate"],
            todayTrading="是" if today.get("isTradingDay") else "不是",
            tomorrowDate=tomorrow.get("date", ""),
            tomorrowWeekday=tomorrow.get("weekday", ""),
            tomorrowTrading="是" if tomorrow.get("isTradingDay") else "不是",
        ),
    ]
    next_trading = calendar.get("nextTradingDay")
    if isinstance(next_trading, dict):
        parts.append(_render(
            config["nextTradingDayTemplate"],
            date=next_trading.get("date", ""),
            weekday=next_trading.get("weekday", ""),
        ))
    parts.append(str(config["relativeTimeRule"]))
    return "".join(parts)


def build_research_prompt(intent: str, context: Any = None) -> str:
    config = PROMPT_CONTRACT["research"]
    lines = [
        _render(config["intentTemplate"], intent=intent),
        *[str(item) for item in config["baseInstructions"]],
    ]
    if context is not None:
        lines.extend(str(item) for item in config["contextInstructions"])
        lines.append(json.dumps(context, ensure_ascii=False, separators=(",", ":")))
    else:
        instruction = config["intentInstructions"].get(intent)
        if instruction:
            lines.append(str(instruction))
    return "\n".join(lines)


def build_role_system_prompt(
    profile: RoleProfile,
    date_context: str,
    user_name: Optional[str] = None,
    memories: Optional[Iterable[str]] = None,
    research_instruction: Optional[str] = None,
) -> str:
    config = PROMPT_CONTRACT["system"]
    lines = [
        profile.systemPrompt,
        date_context,
        _render(config["responseStyleTemplate"], responseStyle=profile.responseStyle),
    ]
    if user_name:
        lines.append(_render(config["userNameTemplate"], userName=user_name))
    memory_values = [item for item in (memories or []) if item]
    if memory_values:
        lines.append(_render(config["memoriesTemplate"], memories="；".join(memory_values)))
    if research_instruction:
        lines.append(research_instruction)
    return "\n".join(lines)
