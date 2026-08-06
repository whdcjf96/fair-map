#!/usr/bin/env python3
"""bilie.kr 참여업체 게시판(그누보드 갤러리 스킨)에서 업체 목록을 긁어 JSON으로 저장.

사용법: python3 scrape_partners.py [출력경로]
다른 박람회도 그누보드 갤러리 스킨이면 BASE_URL/BO_TABLE만 바꿔 재사용.
"""
import json
import re
import sys
import time

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://bilie.kr/bbs/board.php"
BO_TABLE = "n_partner"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}


def scrape_page(page: int) -> list[dict]:
    r = requests.get(
        BASE_URL,
        params={"bo_table": BO_TABLE, "page": page},
        headers=HEADERS,
        timeout=15,
    )
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    items = []
    for box in soup.select(".gall_box"):
        subject = box.select_one(".subject")
        if not subject:
            continue
        name = subject.get_text(strip=True)
        desc_el = box.select_one(".bo_cnt")
        desc = desc_el.get_text("\n", strip=True) if desc_el else ""
        link_el = box.select_one(".gall_text_href a.bo_tit")
        link = link_el.get("href", "") if link_el else ""
        if "bilie.kr" in link:
            link = ""
        img_el = box.select_one(".gall_img img")
        logo = img_el.get("src", "") if img_el else ""
        cate_el = box.select_one(".bo_cate_link")
        cate = cate_el.get_text(strip=True) if cate_el else ""
        items.append(
            {"name": name, "desc": desc, "url": link, "logo": logo, "cate": cate}
        )
    return items


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "partners_raw.json"
    all_items: list[dict] = []
    page = 1
    while True:
        items = scrape_page(page)
        if not items:
            break
        all_items.extend(items)
        print(f"page {page}: {len(items)}개 (누적 {len(all_items)})")
        page += 1
        time.sleep(0.5)
    # 업체명 기준 중복 제거(뒤 페이지에 같은 업체가 또 나오는 경우 대비)
    seen: dict[str, dict] = {}
    for it in all_items:
        key = re.sub(r"\s+", "", it["name"])
        if key not in seen:
            seen[key] = it
    result = list(seen.values())
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"총 {len(result)}개 업체 → {out_path}")


if __name__ == "__main__":
    main()
