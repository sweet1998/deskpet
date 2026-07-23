#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
stt_source="${app_dir}/native/macos-stt.m"
ocr_source="${app_dir}/native/macos-ocr.m"
output_dir="${app_dir}/build/native"
stt_output="${output_dir}/deskpet-stt"
ocr_output="${output_dir}/deskpet-ocr"
target_arch="${DESKPET_TARGET_ARCH:-$(uname -m)}"
if [[ "${target_arch}" == "x64" ]]; then target_arch="x86_64"; fi
if [[ "${target_arch}" != "arm64" && "${target_arch}" != "x86_64" ]]; then
  echo "不支持的原生工具目标架构：${target_arch}" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "内置语音识别工具仅支持 macOS。" >&2
  exit 1
fi

clang="$(xcrun --find clang)"
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
mkdir -p "${output_dir}"
"${clang}" \
  -fobjc-arc \
  -O \
  -arch "${target_arch}" \
  -isysroot "${sdk_path}" \
  -mmacosx-version-min=12.0 \
  -framework Foundation \
  -framework Speech \
  "${stt_source}" \
  -o "${stt_output}"
"${clang}" \
  -fobjc-arc \
  -fblocks \
  -O \
  -arch "${target_arch}" \
  -isysroot "${sdk_path}" \
  -mmacosx-version-min=12.0 \
  -framework AppKit \
  -framework Foundation \
  -framework ImageIO \
  -framework PDFKit \
  -framework Vision \
  "${ocr_source}" \
  -o "${ocr_output}"
chmod +x "${stt_output}" "${ocr_output}"
file "${stt_output}" "${ocr_output}"
file "${stt_output}" | grep -F "Mach-O 64-bit executable ${target_arch}" >/dev/null
file "${ocr_output}" | grep -F "Mach-O 64-bit executable ${target_arch}" >/dev/null
