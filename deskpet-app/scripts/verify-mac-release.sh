#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
app_path="$(find "${app_dir}/dist" -maxdepth 3 -type d -name '麦麦 AI 桌宠.app' -print -quit)"
dmg_path="$(find "${app_dir}/dist" -maxdepth 1 -type f -name 'MaiMai-DeskPet-*.dmg' -print | sort | tail -n 1)"

if [[ -z "${app_path}" || -z "${dmg_path}" ]]; then
  echo "没有找到待验证的 .app 或 DMG。" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "${app_path}"
spctl --assess --type execute --verbose=4 "${app_path}"
xcrun stapler validate "${app_path}"
hdiutil verify "${dmg_path}"
spctl --assess --type open --context context:primary-signature --verbose=4 "${dmg_path}"

echo "签名、公证票据、Gatekeeper 和 DMG 完整性验证通过。"
