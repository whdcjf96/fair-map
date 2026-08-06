#!/usr/bin/env python3
"""배치도 이미지에서 부스 셀의 사각형 좌표를 자동 검출하고,
번호 판독용 확대 대조표(contact sheet)를 생성한다.

사용법: python3 extract_booths.py <배치도이미지> <출력디렉터리>

출력:
  cells.json        검출된 셀 좌표 목록 [{id, x, y, w, h}] (좌상단 기준, 픽셀)
  sheet_N.png       셀을 4배 확대해 격자로 배열한 판독용 이미지(셀마다 인덱스 표시)
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SCALE = 4  # 대조표 확대 배율
PER_SHEET = 30  # 대조표 한 장당 셀 수
SHEET_COLS = 6


def detect_cells(img: Image.Image) -> list[dict]:
    a = np.array(img.convert("RGB")).astype(int)
    white = (a > 246).all(axis=2)
    dark = (a.sum(axis=2) < 420)
    mask = ~white & ~dark
    lab, _ = ndimage.label(mask)
    cells = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        ys, xs = sl
        h, w = ys.stop - ys.start, xs.stop - xs.start
        if w * h == 0:
            continue
        fill = (lab[sl] == i).sum() / (w * h)
        # 부스 셀 크기 범위 + 채움 비율로 걸러낸다.
        # 폭이 큰 블록(라운지, 헤더 등)은 판독 단계에서 사람이/모델이 제외한다.
        if w >= 25 and h >= 25 and w <= 260 and h <= 260 and fill > 0.55:
            cells.append(
                {"x": int(xs.start), "y": int(ys.start), "w": int(w), "h": int(h)}
            )
    # 위→아래, 좌→우 순서로 정렬 (같은 행으로 볼 y 오차 허용치 12px)
    cells.sort(key=lambda c: (round(c["y"] / 12), c["x"]))
    for idx, c in enumerate(cells, 1):
        c["id"] = idx
    return cells


def make_sheets(img: Image.Image, cells: list[dict], outdir: Path) -> int:
    tile = 37 * SCALE
    pad = 26
    sheets = 0
    for start in range(0, len(cells), PER_SHEET):
        chunk = cells[start : start + PER_SHEET]
        rows = (len(chunk) + SHEET_COLS - 1) // SHEET_COLS
        sheet = Image.new(
            "RGB", (SHEET_COLS * (tile + 8), rows * (tile + pad + 8)), "white"
        )
        d = ImageDraw.Draw(sheet)
        for k, c in enumerate(chunk):
            crop = img.crop((c["x"], c["y"], c["x"] + c["w"], c["y"] + c["h"]))
            crop = crop.resize(
                (min(crop.width * SCALE, tile), min(crop.height * SCALE, tile)),
                Image.LANCZOS,
            )
            cx = (k % SHEET_COLS) * (tile + 8)
            cy = (k // SHEET_COLS) * (tile + pad + 8)
            d.text((cx + 4, cy + 4), f"#{c['id']}", fill="red")
            sheet.paste(crop, (cx + 4, cy + pad))
        path = outdir / f"sheet_{sheets + 1}.png"
        sheet.save(path)
        sheets += 1
    return sheets


def main() -> None:
    img_path = Path(sys.argv[1])
    outdir = Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    img = Image.open(img_path).convert("RGB")
    cells = detect_cells(img)
    (outdir / "cells.json").write_text(
        json.dumps(
            {"image": img_path.name, "size": list(img.size), "cells": cells},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    n = make_sheets(img, cells, outdir)
    print(f"셀 {len(cells)}개 검출 → cells.json, 대조표 {n}장")


if __name__ == "__main__":
    main()
