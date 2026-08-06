#!/usr/bin/env python3
"""배치도 원본에서 앱에 쓸 지도 이미지를 만든다.

공식 배치도에는 도면 아래에 '부스번호-업체명' 표가 붙어 있는데, 앱에는 목록 탭이
따로 있어 중복이다. 표를 잘라내면 화면에서 도면이 그만큼 크게 보인다.
아래쪽만 자르므로 부스 좌표(좌상단 기준)는 그대로 유효하다.

사용법: python3 prepare_map.py <원본이미지> <출력이미지> <자를높이>
"""
import json
import sys
from pathlib import Path

from PIL import Image


def main() -> None:
    src, dst, height = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
    img = Image.open(src).convert("RGB")
    out = img.crop((0, 0, img.width, min(height, img.height)))
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, optimize=True)
    meta = {"size": [out.width, out.height], "source": src.name, "cropHeight": height}
    (Path("data") / "map_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"{img.size} → {out.size}, {dst} 저장")


if __name__ == "__main__":
    main()
