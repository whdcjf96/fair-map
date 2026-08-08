#!/usr/bin/env python3
"""부스 좌표(cells.json) + 셀 라벨(cell_labels.json) + 부스↔업체 매핑(booth_map.json)
   + 공식 홈페이지 업체 정보(partners_raw.json)를 하나의 박람회 데이터 파일로 병합한다.

사용법: python3 build_data.py <입력디렉터리> <출력 json 경로>
"""
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

# 업체명·소개문에서 주종 카테고리를 초벌 분류하는 키워드 규칙.
# 앞쪽 규칙이 우선한다. 앱에서 사용자가 직접 고칠 수 있으므로 완벽할 필요는 없다.
CATEGORY_RULES = [
    ("위스키", ["위스키", "whisky", "whiskey", "distillery", "글렌", "제임슨", "발렌타인",
                "로얄살루트", "torabhaig", "버스커"]),
    ("와인", ["와인", "wine", "와이너리", "winery", "샴페인", "페리에주에", "모스카토",
              "falchetto", "peyrot", "카넬리", "스파클링"]),
    ("맥주", ["맥주", "브루", "brew", "beer", "에일", "라거", "펍"]),
    ("전통주·막걸리", ["막걸리", "약주", "청주", "탁주", "전통주", "양조장", "양조", "도가",
                       "명인", "소주", "증류소", "증류주", "안동", "우리술", "농주"]),
    ("사케·니혼슈", ["사케", "니혼슈", "일본주", "sake"]),
    ("진·보드카·럼", ["진 ", "gin", "보드카", "vodka", "럼", "rum", "데킬라", "tequila",
                      "리큐르", "liqueur", "스피릿", "spirit"]),
    ("사이더·미드", ["사이더", "cider", "미드", "mead", "허니와인"]),
    ("논알콜·음료", ["논알콜", "무알콜", "제로", "음료", "커피", "차 ", "슬러시", "빙수",
                     "크리머리", "사이다", "진저비어"]),
    ("안주·푸드", ["육포", "치즈", "소시지", "어묵", "튀김", "김부각", "빵", "베이커리",
                   "초콜릿", "닭강정", "골뱅이", "부추전", "묵", "빙수", "참치", "고등어",
                   "갈비", "삼겹", "키친", "푸드", "f&b", "안주", "떡", "과자", "햄"]),
]

FACILITY_KEYWORDS = ["센터", "세척장", "택배", "라운지", "이벤트", "화장실", "입구", "출구",
                     "설문", "사진"]


def normalize(s: str) -> str:
    """업체명 비교용 정규화 — 법인격·공백·기호 제거."""
    s = s.lower()
    s = re.sub(r"\(주\)|\(유\)|㈜|주식회사|농업회사법인|영농조합법인|유한회사|영어조합법인", "", s)
    s = re.sub(r"[^0-9a-z가-힣]", "", s)
    return s


def is_faithful_short(short: str, name: str) -> bool:
    """축약 이름이 원래 업체명을 그대로 줄인 것인지 검사한다.

    남에게 공유될 수 있는 화면이므로 업체명을 임의로 바꿔 표기해서는 안 된다.
    법인격 표기(주식회사 등)를 떼는 것까지는 허용하고, 그 외에는 원문에
    연속으로 등장하는 부분이어야 한다.
    """
    return normalize(short) in normalize(name)


def short_fallback(name: str) -> str:
    """축약 이름표가 지정되지 않은 부스용 임시 라벨 — 법인격을 떼고 앞 6자를 쓴다."""
    s = re.sub(r"\(주\)|\(유\)|㈜|주식회사|농업회사법인|영농조합법인|유한회사|영어조합법인", "", name)
    s = re.split(r"[/,·]", s)[0].strip()
    return s[:6] if s else name[:6]


def classify(text: str) -> str:
    low = text.lower()
    for cate, keys in CATEGORY_RULES:
        if any(k.lower() in low for k in keys):
            return cate
    return "기타"


MATCH_MIN = 0.80


def pair_score(booth_name: str, partner_name: str) -> float:
    """배치도 업체명과 홈페이지 업체명이 같은 업체일 가능성 점수.

    배치도는 '유어와인즈 이탈리아 1위 메이커 모스카토'처럼 홍보문구가 섞여 있고
    홈페이지는 '주식회사 유어와인즈'처럼 법인명이라, 부분 포함을 우선으로 본다.
    """
    nb, np_ = normalize(booth_name), normalize(partner_name)
    if not nb or not np_:
        return 0.0
    # 짧은 이름('WS', '화요')이 긴 문자열에 우연히 포함되는 오탐을 막기 위해
    # 포함 판정은 3글자 이상일 때만 인정하고, 길이로 가중한다.
    if len(np_) >= 3 and (np_ in nb or nb in np_):
        return 0.9 + min(len(np_), 12) / 200
    # 같은 업체인데 어순만 다른 경우('메소스 진저비어 / (주)퍼스' ↔ '㈜퍼스 메소스 진저비어')
    # 는 글자 순서 비교로는 점수가 낮게 나오므로 단어 단위 겹침을 따로 본다.
    tb = {t for t in map(normalize, re.split(r"[\s/,·]+", booth_name)) if len(t) >= 2}
    tp = {t for t in map(normalize, re.split(r"[\s/,·]+", partner_name)) if len(t) >= 2}
    if tb and tp:
        overlap = len(tb & tp) / min(len(tb), len(tp))
        if overlap == 1.0 and len(tb & tp) >= 2:
            return 0.88
    return SequenceMatcher(None, nb, np_).ratio()


def match_partners(booths: dict[str, dict], booth_names: dict[str, str],
                   partners: list[dict]) -> dict[str, dict]:
    """부스↔업체를 1:1로 배정한다.

    한 업체가 여러 부스에 잘못 붙는 것을 막으려고, 모든 후보 쌍의 점수를 구해
    높은 쪽부터 확정하고 이미 쓰인 부스·업체는 건너뛴다.
    """
    pairs = []
    for code in booths:
        name = booth_names.get(code)
        if not name:
            continue
        for idx, p in enumerate(partners):
            s = pair_score(name, p["name"])
            if s >= MATCH_MIN:
                pairs.append((s, code, idx))
    pairs.sort(key=lambda t: -t[0])

    used_booth: set[str] = set()
    used_partner: set[int] = set()
    result: dict[str, dict] = {}
    for s, code, idx in pairs:
        if code in used_booth or idx in used_partner:
            continue
        used_booth.add(code)
        used_partner.add(idx)
        result[code] = partners[idx]
    return result


def main() -> None:
    indir = Path(sys.argv[1])
    outpath = Path(sys.argv[2])

    cells_doc = json.loads((indir / "cells.json").read_text(encoding="utf-8"))
    labels = {c["id"]: c["label"] for c in
              json.loads((indir / "cell_labels.json").read_text(encoding="utf-8"))}
    booth_names = {b["booth"]: b["name"] for b in
                   json.loads((indir / "booth_map.json").read_text(encoding="utf-8"))}
    partners = json.loads((indir / "partners_raw.json").read_text(encoding="utf-8"))
    # 키워드 규칙으로는 알 수 없는 브랜드(앱솔루트=보드카 등)를 손으로 보정한 표.
    ov_path = indir / "category_overrides.json"
    overrides = json.loads(ov_path.read_text(encoding="utf-8")) if ov_path.exists() else {}
    # 지도 위 작은 칸에 들어갈 축약 이름. 없으면 업체명 앞부분을 잘라 쓴다.
    sl_path = indir / "short_labels.json"
    shorts = json.loads(sl_path.read_text(encoding="utf-8")) if sl_path.exists() else {}

    booths: dict[str, dict] = {}
    facilities: list[dict] = []
    unmatched_cells: list[str] = []

    for c in cells_doc["cells"]:
        label = labels.get(c["id"], "").strip()
        rect = {"x": c["x"], "y": c["y"], "w": c["w"], "h": c["h"]}
        if re.fullmatch(r"[A-Z]\d{2}", label):
            b = booths.setdefault(label, {"booth": label, "rects": []})
            b["rects"].append(rect)
        elif any(k in label for k in FACILITY_KEYWORDS):
            facilities.append({"label": label, **rect})
        elif label:
            unmatched_cells.append(f"#{c['id']} {label}")

    pmap = match_partners(booths, booth_names, partners)
    matched = 0
    for code, b in booths.items():
        name = booth_names.get(code)
        b["name"] = name or ""
        p = pmap.get(code)
        if p:
            matched += 1
            b["desc"] = p["desc"]
            b["url"] = p["url"]
            b["logo"] = p["logo"]
            b["officialName"] = p["name"]
        else:
            b["desc"] = b["url"] = b["logo"] = b["officialName"] = ""
        b["category"] = overrides.get(code) or classify(f"{name or ''} {b['desc']}")
        b["short"] = shorts.get(code) or short_fallback(name or code)

    missing = sorted(set(booth_names) - set(booths))

    # prepare_map.py로 도면을 잘라냈으면 그 크기를 쓴다(아래쪽만 자르므로 좌표는 그대로).
    meta_path = indir / "map_meta.json"
    image_size = (json.loads(meta_path.read_text(encoding="utf-8"))["size"]
                  if meta_path.exists() else cells_doc["size"])

    doc = {
        "id": "busan-liquor-2026",
        "title": "2026 부산국제주류박람회",
        "venue": "벡스코 제1전시장 3홀",
        "source": "https://bilie.kr/sub/booth.php",
        "image": "data/map.png",
        "imageSize": image_size,
        # 기본부스 한 칸의 실제 크기(m). 거리 표시를 픽셀에서 미터로 환산할 때 쓴다.
        # 국내 박람회 기본부스는 보통 3m×3m다.
        "boothSizeM": 3,
        "booths": sorted(booths.values(), key=lambda b: b["booth"]),
        "facilities": facilities,
    }
    outpath.parent.mkdir(parents=True, exist_ok=True)
    outpath.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"부스 {len(doc['booths'])}개 / 편의시설 {len(facilities)}개 → {outpath}")
    print(f"공식 업체정보 매칭: {matched}/{len(booths)}")
    if missing:
        print(f"좌표 없는 부스({len(missing)}): {', '.join(missing)}")
    if unmatched_cells:
        print(f"분류 못한 셀: {', '.join(unmatched_cells)}")
    unfaithful = [f"{b['booth']} '{b['short']}' ← '{b['name']}'"
                  for b in doc["booths"]
                  if b["name"] and not is_faithful_short(b["short"], b["name"])]
    if unfaithful:
        print(f"\n경고: 원문에 없는 표현으로 줄인 업체명 {len(unfaithful)}개 "
              f"— 공유 시 오표기가 됩니다. data/short_labels.json 을 고치세요.")
        for u in unfaithful:
            print(f"  {u}")
    cats: dict[str, int] = {}
    for b in doc["booths"]:
        cats[b["category"]] = cats.get(b["category"], 0) + 1
    print("카테고리:", dict(sorted(cats.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
