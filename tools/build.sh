#!/usr/bin/env bash
# 원본 데이터에서 앱이 읽는 데이터 파일을 다시 만든다.
# 사용법: tools/build.sh [자를높이]   (기본 1400 — 도면 아래 업체 표를 잘라낸다)
set -euo pipefail

cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
CROP="${1:-1400}"

"$PY" tools/prepare_map.py data/map_source.png app/data/map.png "$CROP"
"$PY" tools/build_data.py data app/data/busan2026.json

echo
echo "완료. 앱 파일을 고쳤다면 app/sw.js 의 CACHE 버전도 올려야 캐시가 갱신됩니다."
