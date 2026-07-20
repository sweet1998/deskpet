#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
repo_dir="$(cd "${app_dir}/.." && pwd)"
backend_dir="${repo_dir}/backend"
python="${backend_dir}/.venv/bin/python"

if [[ ! -x "${python}" ]]; then
  echo "缺少 backend/.venv。请先创建虚拟环境并安装 requirements-dev.txt。" >&2
  exit 1
fi

if ! "${python}" -c "import PyInstaller" >/dev/null 2>&1; then
  echo "缺少 PyInstaller。请运行 backend/.venv/bin/pip install -r backend/requirements-dev.txt。" >&2
  exit 1
fi

"${python}" -m PyInstaller \
  --clean \
  --noconfirm \
  --distpath "${backend_dir}/dist" \
  --workpath "${backend_dir}/build/pyinstaller" \
  "${backend_dir}/deskpet-backend.spec"

executable="${backend_dir}/dist/deskpet-backend/deskpet-backend"
chmod +x "${executable}"
file "${executable}"
