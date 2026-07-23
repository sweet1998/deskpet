#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
dist_dir="${app_dir}/dist"
machine_arch="${DESKPET_RELEASE_ARCH:-$(uname -m)}"
if [[ "${machine_arch}" == "x86_64" || "${machine_arch}" == "x64" ]]; then
  artifact_arch="x64"
  file_arch="x86_64"
else
  artifact_arch="arm64"
  file_arch="arm64"
fi
find_app_for_arch() {
  local candidate executable
  while IFS= read -r candidate; do
    executable="$(find "${candidate}/Contents/MacOS" -maxdepth 1 -type f -print -quit 2>/dev/null || true)"
    if [[ -n "${executable}" ]] && file "${executable}" | grep -E "Mach-O 64-bit executable ${file_arch}" >/dev/null; then
      echo "${candidate}"
      return 0
    fi
  done < <(find "${dist_dir}" -maxdepth 3 -type d -name '麦麦 AI 桌宠.app' -print)
  return 1
}
app_path="$(find_app_for_arch || true)"
dmg_path="$(find "${dist_dir}" -maxdepth 1 -type f -name "MaiMai-DeskPet-*-${artifact_arch}.dmg" -print | sort | tail -n 1)"
zip_path="$(find "${dist_dir}" -maxdepth 1 -type f -name "MaiMai-DeskPet-*-${artifact_arch}.zip" -print | sort | tail -n 1)"
manifest="${dist_dir}/latest-mac.yml"

if [[ -z "${app_path}" || -z "${dmg_path}" || -z "${zip_path}" || ! -f "${manifest}" ]]; then
  echo "测试发布缺少 .app、DMG、ZIP 或 latest-mac.yml。" >&2
  exit 1
fi

backend="${app_path}/Contents/Resources/backend/deskpet-backend"
stt_helper="${app_path}/Contents/Resources/native/deskpet-stt"
ocr_helper="${app_path}/Contents/Resources/native/deskpet-ocr"
asar="${app_path}/Contents/Resources/app.asar"
license="${app_path}/Contents/Resources/LICENSE.txt"
privacy="${app_path}/Contents/Resources/PRIVACY.md"
terms="${app_path}/Contents/Resources/TERMS.md"
require_executable() { [[ -x "$1" ]] || { echo "缺少可执行资源：$1" >&2; exit 1; }; }
require_file() { [[ -f "$1" ]] || { echo "缺少打包资源：$1" >&2; exit 1; }; }
require_executable "${backend}"
require_executable "${stt_helper}"
require_executable "${ocr_helper}"
require_file "${asar}"
require_file "${license}"
require_file "${privacy}"
require_file "${terms}"
file "${backend}" | grep -E "Mach-O 64-bit executable ${file_arch}" >/dev/null
file "${stt_helper}" | grep -E "Mach-O 64-bit executable ${file_arch}" >/dev/null
file "${ocr_helper}" | grep -E "Mach-O 64-bit executable ${file_arch}" >/dev/null
"${app_dir}/node_modules/.bin/asar" list "${asar}" | grep -F 'hiyori_pro_t11.model3.json' >/dev/null
"${app_dir}/node_modules/.bin/asar" list "${asar}" | grep -F 'live2dcubismcore.min.js' >/dev/null
"${app_dir}/node_modules/.bin/asar" list "${asar}" | grep -F '/node_modules/exceljs/package.json' >/dev/null
"${app_dir}/node_modules/.bin/asar" list "${asar}" | grep -F '/node_modules/mammoth/package.json' >/dev/null
hdiutil verify "${dmg_path}"
unzip -tq "${zip_path}"
grep -F "$(basename "${zip_path}")" "${manifest}" >/dev/null
shasum -a 256 "${dmg_path}" "${zip_path}" "${manifest}"

echo "未签名测试包的应用资源、内置后端、DMG、ZIP 和更新元数据验证通过。"
