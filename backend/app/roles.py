import json
import sys
from pathlib import Path
from typing import Dict

from .models import RoleId, RoleProfile


def _role_file() -> Path:
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        return Path(bundle_root) / "deskpet-app" / "src" / "shared" / "role-profiles.json"
    return Path(__file__).resolve().parents[2] / "deskpet-app" / "src" / "shared" / "role-profiles.json"


ROLE_FILE = _role_file()


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
