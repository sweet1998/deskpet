import json
from pathlib import Path
from typing import Dict

from .models import RoleId, RoleProfile


ROLE_FILE = Path(__file__).resolve().parents[2] / "deskpet-app" / "src" / "shared" / "role-profiles.json"


def load_roles(path: Path = ROLE_FILE) -> Dict[RoleId, RoleProfile]:
    with path.open("r", encoding="utf-8") as source:
        raw = json.load(source)
    return {
        "default": RoleProfile.model_validate(raw["default"]),
        "stock_expert": RoleProfile.model_validate(raw["stock_expert"]),
    }


ROLE_PROFILES = load_roles()


def get_role(role_id: RoleId) -> RoleProfile:
    return ROLE_PROFILES[role_id]
