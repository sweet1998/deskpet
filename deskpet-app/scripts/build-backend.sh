#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
repo_dir="$(cd "${app_dir}/.." && pwd)"
backend_dir="${repo_dir}/backend"
python="${DESKPET_BACKEND_PYTHON:-${backend_dir}/.venv/bin/python}"
target_arch="${DESKPET_TARGET_ARCH:-$(uname -m)}"
if [[ "${target_arch}" == "x64" ]]; then target_arch="x86_64"; fi
python_command=("${python}")
if [[ "$(uname -m)" == "arm64" && "${target_arch}" == "x86_64" ]]; then
  python_command=(arch -x86_64 "${python}")
fi

if [[ ! -x "${python}" ]]; then
  echo "缺少 backend/.venv。请先创建虚拟环境并安装 requirements-dev.txt。" >&2
  exit 1
fi

if ! "${python_command[@]}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "后端打包要求 Python 3.11 或更高版本，请重新创建 backend/.venv。" >&2
  exit 1
fi

if ! "${python_command[@]}" -c "import PyInstaller" >/dev/null 2>&1; then
  echo "缺少 PyInstaller。请运行 backend/.venv/bin/pip install -r backend/requirements-dev.txt。" >&2
  exit 1
fi

"${python_command[@]}" -m PyInstaller \
  --clean \
  --noconfirm \
  --distpath "${backend_dir}/dist" \
  --workpath "${backend_dir}/build/pyinstaller" \
  "${backend_dir}/deskpet-backend.spec"

executable="${backend_dir}/dist/deskpet-backend/deskpet-backend"
chmod +x "${executable}"
file "${executable}"
file "${executable}" | grep -F "Mach-O 64-bit executable ${target_arch}" >/dev/null
