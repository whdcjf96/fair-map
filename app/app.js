/* 박람회 부스맵 — 배치도 이미지 위에 부스 오버레이를 얹고 개인 기록을 붙인다.
   기록은 브라우저 localStorage에만 저장되며 서버로 나가지 않는다. */
'use strict';

const FAIR_FILE = 'data/busan2026.json';
const TAGS = ['관심', '방문완료', '재방문', '샘플받음', '견적요청'];
const CATEGORIES = ['와인', '위스키', '맥주', '전통주·막걸리', '사케·니혼슈', '진·보드카·럼',
  '사이더·미드', '논알콜·음료', '안주·푸드', '주류수입·유통', '기타'];
// 카테고리별 지도 칠 색. 어두운 글씨가 얹히므로 밝고 채도 낮은 톤으로 고른다.
const CAT_COLOR = {
  '와인': '#eeb0c4', '위스키': '#e0b477', '맥주': '#f3e089', '전통주·막걸리': '#b3dd9e',
  '사케·니혼슈': '#9fd8cd', '진·보드카·럼': '#a6c4ee', '사이더·미드': '#cdb8e8',
  '논알콜·음료': '#bfe4f2', '안주·푸드': '#f2b79a', '주류수입·유통': '#d5d0c0', '기타': '#d9dde2',
};
const VISITED_COLOR = '#5fca92';
// 이 배율 아래에서는 글씨가 뭉개져 못 읽으므로 색만 칠하고 이름은 감춘다.
// 이름표 글자는 이미지 좌표계에서 11px 안팎이라 0.8배면 화면상 9px쯤 된다.
const LABEL_MIN_SCALE = 0.8;

let fair = null;              // 박람회 원본 데이터
let booths = [];              // 화면에 쓰는 부스 배열(사용자 보정 반영)
let boothByCode = new Map();
// 사용자 데이터. here는 "지금 내가 서 있는 부스" 번호.
// 실내라 GPS가 못 잡으니 사용자가 직접 찍는다 — 대신 부스 단위로 정확하다.
let store = { notes: {}, geom: {}, cats: {}, here: null };
let metersPerPx = 0;
let els = new Map();          // 부스코드 -> 오버레이 DOM

let selected = null;
let labelsOn = localStorage.getItem('fairmap:labels') !== 'off';
let filterCat = null;
let filterMark = null;        // '관심' | '방문완료' | '메모' | null
let query = '';

const $ = (id) => document.getElementById(id);
const storageKey = () => `fairmap:${fair.id}`;

/* ============ 저장소 ============ */
function loadStore() {
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw) {
      const p = JSON.parse(raw);
      store = { notes: p.notes || {}, geom: p.geom || {}, cats: p.cats || {}, here: p.here || null };
    }
  } catch (e) { console.warn('저장된 기록을 읽지 못했습니다', e); }
}
function saveStore() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(store));
  } catch (e) { toast('저장 공간이 부족합니다'); }
}
function note(code) {
  return store.notes[code] || (store.notes[code] = { tags: [], rating: 0, memo: '' });
}
function hasData(n) {
  return !!n && (n.rating > 0 || (n.memo && n.memo.trim()) || (n.tags && n.tags.length));
}

/* ============ 초기화 ============ */
async function init() {
  const res = await fetch(FAIR_FILE, { cache: 'no-cache' });
  fair = await res.json();
  loadStore();

  document.title = fair.title;
  $('fairTitle').textContent = fair.title;
  $('srcNote').textContent = `${fair.venue} · 출처 ${fair.source} · 기록은 이 브라우저에만 저장됩니다.`;

  const img = $('mapImg');
  img.src = fair.image;
  $('canvas').style.width = fair.imageSize[0] + 'px';
  const svg = $('route');
  svg.setAttribute('width', fair.imageSize[0]);
  svg.setAttribute('height', fair.imageSize[1]);

  rebuildBooths();
  // 기본부스 한 칸을 실제 크기(보통 3m)로 보고 픽셀↔미터 환산 비율을 잡는다.
  const widths = booths.flatMap((b) => b.rects.map((r) => r.w)).sort((a, b) => a - b);
  metersPerPx = (fair.boothSizeM || 3) / (widths[Math.floor(widths.length / 2)] || 37);
  renderOverlay();
  renderChips();
  renderList();
  bindUI();
  setLabels(labelsOn);
  renderHere();

  if (img.complete) fitToScreen(); else img.onload = fitToScreen;
  window.addEventListener('resize', () => { if (scale <= fitScale * 1.02) fitToScreen(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/** 원본 부스 데이터에 사용자 보정(좌표·카테고리)을 얹어 booths를 다시 만든다. */
function rebuildBooths() {
  booths = fair.booths.map((b) => {
    const g = store.geom[b.booth];
    return {
      ...b,
      rects: g ? g.rects : b.rects,
      category: store.cats[b.booth] || b.category,
    };
  });
  // 편집 모드에서 새로 추가한 부스
  for (const [code, g] of Object.entries(store.geom)) {
    if (!fair.booths.some((b) => b.booth === code)) {
      booths.push({ booth: code, name: g.name || code, rects: g.rects, desc: '', url: '',
        category: store.cats[code] || '기타' });
    }
  }
  boothByCode = new Map(booths.map((b) => [b.booth, b]));
}

/* ============ 오버레이 ============ */
function renderOverlay() {
  const ov = $('overlay');
  ov.innerHTML = '';
  els = new Map();

  for (const f of fair.facilities || []) {
    const d = document.createElement('div');
    d.className = 'facility';
    setRect(d, f);
    d.title = f.label;
    ov.appendChild(d);
  }

  for (const b of booths) {
    const group = [];
    // 이름표는 가장 큰 칸 하나에만 넣는다(A14처럼 칸이 나뉜 부스가 있다).
    let main = 0;
    b.rects.forEach((r, i) => { if (r.w * r.h > b.rects[main].w * b.rects[main].h) main = i; });
    b.rects.forEach((r, i) => {
      const d = document.createElement('div');
      d.className = 'booth';
      d.dataset.booth = b.booth;
      setRect(d, r);
      if (i === main) {
        const lay = layoutLabel(b.short || b.booth, r.w, r.h);
        const lbl = document.createElement('span');
        lbl.className = 'lbl';
        lbl.textContent = lay.text;
        lbl.style.fontSize = lay.size + 'px';
        d.appendChild(lbl);
      }
      ov.appendChild(d);
      group.push(d);
    });
    els.set(b.booth, group);
  }
  paintAll();
}
// 한글은 글자폭이 글자크기와 거의 같고, 영숫자는 그 절반쯤이다.
const charWidth = (c) => (/[가-힣ㄱ-ㆎ]/.test(c) ? 1 : 0.56);

/** 칸 안에 이름을 어떻게 앉힐지 정한다 — 줄 나누기와 글자 크기.
 *
 * 브라우저 자동 줄바꿈에 맡기면 '로얄살루/트'처럼 한 글자만 떨어져 읽기 나쁘다.
 * 1~3줄로 균등 분할해보고 글자가 가장 커지는 조합을 고른 뒤, 줄바꿈을 직접 넣는다.
 */
function layoutLabel(label, w, h) {
  const chars = [...label];
  const total = chars.reduce((s, c) => s + charWidth(c), 0);
  let best = null;
  for (const lines of [1, 2, 3]) {
    if (lines > chars.length) break;
    const target = total / lines;
    const rows = [];
    let cur = '', curW = 0;
    for (const c of chars) {
      if (curW >= target - 1e-9 && rows.length < lines - 1) {
        rows.push(cur); cur = ''; curW = 0;
      }
      cur += c; curW += charWidth(c);
    }
    rows.push(cur);
    if (rows.length !== lines) continue;
    const widest = Math.max(...rows.map((r) => [...r].reduce((s, c) => s + charWidth(c), 0)));
    // 상한을 먼저 걸어야 한다. 안 그러면 '13px로 잘릴 크기'를 서로 비교하게 되어
    // 실제로는 같은 크기인데도 줄을 더 쪼갠 쪽이 이긴다.
    const size = Math.max(4.5, Math.min(13,
      Math.min((w - 3) / widest, (h - 3) / (lines * 1.12))));
    // 줄을 늘리면 글자는 커지지만 읽기는 나빠진다('제임/슨'). 확실히 커질 때만 쪼갠다.
    const score = size * [1, 1, 0.82, 0.72][lines];
    if (!best || score > best.score) best = { score, size, text: rows.join('\n') };
  }
  best = best || { size: 6, text: label, score: 6 };
  return { text: best.text, size: best.size.toFixed(1) };
}
function setRect(el, r) {
  el.style.left = r.x + 'px';
  el.style.top = r.y + 'px';
  el.style.width = r.w + 'px';
  el.style.height = r.h + 'px';
}

/** 모든 부스의 상태 색·검색 하이라이트를 다시 칠한다. */
function paintAll() {
  const q = query.trim().toLowerCase();
  const filtering = !!(q || filterCat || filterMark);
  let hits = 0;
  for (const b of booths) {
    const n = store.notes[b.booth];
    const hit = matches(b, q);
    if (hit) hits++;
    const visited = !!n && n.tags.includes('방문완료');
    const memo = !!(n && n.memo && n.memo.trim());
    for (const el of els.get(b.booth) || []) {
      el.classList.toggle('star', !!n && n.tags.includes('관심'));
      el.classList.toggle('visited', visited);
      el.classList.toggle('sel', selected === b.booth);
      el.classList.toggle('hit', filtering && hit);
      el.classList.toggle('dim', filtering && !hit);
      // 이름표 모드에서는 칸을 카테고리 색으로 덮어 인쇄된 부스번호를 가린다.
      el.style.background = labelsOn
        ? (visited ? VISITED_COLOR : (CAT_COLOR[b.category] || CAT_COLOR['기타']))
        : '';
      let mark = el.querySelector('.memo');
      if (memo && !mark) {
        mark = document.createElement('span');
        mark.className = 'memo';
        mark.textContent = '✎';
        el.appendChild(mark);
      } else if (!memo && mark) {
        mark.remove();
      }
    }
  }
  lastHits = filtering ? hits : null;
  updateHint();
}

let lastHits = null;
/** 지도 왼쪽 아래 안내문 — 필터 결과 수, 또는 이름표가 왜 안 보이는지. */
function updateHint() {
  const cond = [query.trim() && `"${query.trim()}"`, filterCat, filterMark]
    .filter(Boolean).join(' · ');
  if (lastHits !== null) {
    $('hint').textContent = `${cond} — ${lastHits}개 부스`;
  } else if (labelsOn && scale < LABEL_MIN_SCALE) {
    $('hint').textContent = '확대하면 업체명이 보입니다';
  } else {
    $('hint').textContent = '';
  }
}

/** 현재 검색어·필터 조건에 부스가 걸리는지 */
function matches(b, q) {
  if (filterCat && b.category !== filterCat) return false;
  const n = store.notes[b.booth];
  if (filterMark === '메모') { if (!n || !n.memo || !n.memo.trim()) return false; }
  else if (filterMark) { if (!n || !n.tags.includes(filterMark)) return false; }
  if (!q) return true;
  return (b.booth + ' ' + b.name + ' ' + (b.desc || '') + ' ' + (b.officialName || ''))
    .toLowerCase().includes(q);
}

/* ============ 현위치 ============ */
/** 부스가 차지한 칸 전체의 중심점(이미지 좌표). */
function boothCenter(code) {
  const b = boothByCode.get(code);
  if (!b || !b.rects.length) return null;
  const x1 = Math.min(...b.rects.map((r) => r.x));
  const y1 = Math.min(...b.rects.map((r) => r.y));
  const x2 = Math.max(...b.rects.map((r) => r.x + r.w));
  const y2 = Math.max(...b.rects.map((r) => r.y + r.h));
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

const DIRS = ['오른쪽', '오른쪽 아래', '아래', '왼쪽 아래',
  '왼쪽', '왼쪽 위', '위', '오른쪽 위'];

/** 현위치에서 대상 부스까지의 방향·거리. 지도 기준이며 나침반 방위가 아니다. */
function relativeTo(fromCode, toCode) {
  const a = boothCenter(fromCode), b = boothCenter(toCode);
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const deg = Math.atan2(dy, dx) * 180 / Math.PI;
  const idx = ((Math.round(deg / 45) % 8) + 8) % 8;
  const meters = Math.hypot(dx, dy) * metersPerPx;
  return { deg, dir: DIRS[idx], meters };
}

function setHere(code) {
  store.here = code;
  saveStore();
  renderHere();
  toast(code ? `현위치를 ${code}로 잡았습니다` : '현위치를 지웠습니다');
}

/** 현위치 마커와 목적지까지의 안내선을 다시 그린다. */
function renderHere() {
  const marker = $('hereMarker');
  const line = $('routeLine');
  const code = store.here;
  const at = code ? boothCenter(code) : null;
  if (!at) {
    // 편집으로 부스가 사라졌으면 현위치도 무효다.
    if (code) { store.here = null; saveStore(); }
    marker.hidden = true;
    line.classList.remove('on');
    $('goHere').hidden = true;
    return;
  }
  marker.hidden = false;
  marker.style.left = at.x + 'px';
  marker.style.top = at.y + 'px';
  $('goHere').hidden = false;

  const target = selected && selected !== code ? boothCenter(selected) : null;
  if (target) {
    line.setAttribute('x1', at.x); line.setAttribute('y1', at.y);
    line.setAttribute('x2', target.x); line.setAttribute('y2', target.y);
    line.classList.add('on');
  } else {
    line.classList.remove('on');
  }
  scaleHere();
}
/** 확대해도 마커와 안내선 굵기가 화면상 일정하게 보이도록 역배율을 먹인다. */
function scaleHere() {
  document.querySelector('.hm-inner').style.setProperty('--inv', (1 / scale).toFixed(3));
  $('routeLine').setAttribute('stroke-width', (2.5 / scale).toFixed(2));
}

/* ============ 지도 확대/이동 ============ */
let scale = 1, tx = 0, ty = 0, fitScale = 1;

function applyTransform() {
  $('canvas').style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  // 너무 축소된 상태에서 이름을 띄우면 글씨가 뭉개지므로 색만 남긴다.
  document.body.classList.toggle('names', labelsOn && scale >= LABEL_MIN_SCALE);
  scaleHere();
  updateHint();
}
function setLabels(on) {
  labelsOn = on;
  localStorage.setItem('fairmap:labels', on ? 'on' : 'off');
  document.body.classList.toggle('labels', on);
  $('labelToggle').classList.toggle('on', on);
  applyTransform();
  paintAll();
}
function fitToScreen() {
  const vp = $('viewport');
  const iw = fair.imageSize[0], ih = fair.imageSize[1];
  fitScale = Math.min(vp.clientWidth / iw, vp.clientHeight / ih);
  scale = fitScale;
  tx = (vp.clientWidth - iw * scale) / 2;
  ty = 0;
  applyTransform();
}
function clampPan() {
  const vp = $('viewport');
  const w = fair.imageSize[0] * scale, h = fair.imageSize[1] * scale;
  const marginX = Math.min(60, vp.clientWidth * .2);
  const marginY = Math.min(60, vp.clientHeight * .2);
  tx = w <= vp.clientWidth ? (vp.clientWidth - w) / 2
    : Math.min(marginX, Math.max(vp.clientWidth - w - marginX, tx));
  ty = h <= vp.clientHeight ? (vp.clientHeight - h) / 2
    : Math.min(marginY, Math.max(vp.clientHeight - h - marginY, ty));
}
/** 화면 좌표(cx, cy)를 고정점으로 배율을 s로 바꾼다. */
function zoomAt(s, cx, cy) {
  const vp = $('viewport').getBoundingClientRect();
  const px = cx - vp.left, py = cy - vp.top;
  const ns = Math.max(fitScale * 0.9, Math.min(8, s));
  tx = px - (px - tx) * (ns / scale);
  ty = py - (py - ty) * (ns / scale);
  scale = ns;
  clampPan();
  applyTransform();
}
/** 특정 부스가 화면 중앙에 오도록 이동·확대 */
function focusBooth(code, targetScale) {
  const b = boothByCode.get(code);
  if (!b || !b.rects.length) return;
  const r = b.rects[0];
  const vp = $('viewport');
  scale = targetScale || Math.max(fitScale, Math.min(3.2, 260 / Math.max(r.w, r.h)));
  tx = vp.clientWidth / 2 - (r.x + r.w / 2) * scale;
  ty = vp.clientHeight / 2 - (r.y + r.h / 2) * scale;
  clampPan();
  applyTransform();
}

/** 두 부스가 모두 화면에 들어오도록 맞춘다(현위치 → 목적지 안내용). */
function fitBoth(codeA, codeB) {
  const a = boothCenter(codeA), b = boothCenter(codeB);
  if (!a || !b) { focusBooth(codeB); return; }
  const vp = $('viewport');
  const pad = 70;
  const w = Math.abs(a.x - b.x) + pad * 2;
  const h = Math.abs(a.y - b.y) + pad * 2;
  scale = Math.max(fitScale, Math.min(3, Math.min(vp.clientWidth / w, vp.clientHeight / h)));
  tx = vp.clientWidth / 2 - ((a.x + b.x) / 2) * scale;
  ty = vp.clientHeight / 2 - ((a.y + b.y) / 2) * scale;
  clampPan();
  applyTransform();
}

/* ============ 포인터 조작 (팬 / 핀치 / 탭) ============ */
function bindMapGestures() {
  const vp = $('viewport');
  const pts = new Map();
  let start = null, moved = false, pinch = null;

  vp.addEventListener('pointerdown', (e) => {
    vp.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 1) {
      start = { x: e.clientX, y: e.clientY, tx, ty, target: e.target, t: Date.now() };
      if (editing) editPointerDown(e);
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: dist(a, b), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, s: scale };
    }
  });

  vp.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = dist(a, b);
      if (pinch.d > 0) zoomAt(pinch.s * (d / pinch.d), pinch.cx, pinch.cy);
      moved = true;
      return;
    }
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
    if (editing && editDrag) { editPointerMove(e); return; }
    tx = start.tx + dx; ty = start.ty + dy;
    clampPan();
    applyTransform();
  });

  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (editing && editDrag) { editPointerUp(); return; }
    if (!moved && start && start.target.classList.contains('booth')) {
      openSheet(start.target.dataset.booth);
    }
    if (pts.size === 0) start = null;
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', end);

  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });

  vp.addEventListener('dblclick', (e) => {
    e.preventDefault();
    zoomAt(scale > fitScale * 2 ? fitScale : fitScale * 3, e.clientX, e.clientY);
  });
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ============ 필터 칩 ============ */
function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  const counts = {};
  for (const b of booths) counts[b.category] = (counts[b.category] || 0) + 1;

  const add = (label, on, onClick, n, color) => {
    const c = document.createElement('button');
    c.className = 'chip' + (on ? ' on' : '');
    // 카테고리 칩의 색 점이 곧 지도 색의 범례 역할을 한다.
    if (color) {
      const sw = document.createElement('i');
      sw.style.background = color;
      c.append(sw);
    }
    c.append(text(label));
    if (n != null) {
      const cnt = document.createElement('span');
      cnt.className = 'n';
      cnt.textContent = n;
      c.append(cnt);
    }
    c.onclick = onClick;
    box.appendChild(c);
  };

  add('전체', !filterCat && !filterMark, () => { filterCat = null; filterMark = null; refresh(); }, booths.length);
  const marks = [['관심', '⭐ 관심'], ['방문완료', '✅ 방문'], ['메모', '✎ 메모']];
  for (const [key, label] of marks) {
    const n = booths.filter((b) => {
      const nt = store.notes[b.booth];
      if (key === '메모') return nt && nt.memo && nt.memo.trim();
      return nt && nt.tags.includes(key);
    }).length;
    if (n > 0) {
      add(label, filterMark === key, () => { filterMark = filterMark === key ? null : key; refresh(); },
        n, key === '방문완료' ? VISITED_COLOR : null);
    }
  }
  for (const cat of CATEGORIES) {
    if (!counts[cat]) continue;
    add(cat, filterCat === cat, () => { filterCat = filterCat === cat ? null : cat; refresh(); },
      counts[cat], CAT_COLOR[cat]);
  }
}

/* ============ 목록 ============ */
function renderList() {
  const ul = $('list');
  const q = query.trim().toLowerCase();
  const items = booths.filter((b) => matches(b, q))
    .sort((a, b) => {
      const na = store.notes[a.booth], nb = store.notes[b.booth];
      const ra = (na && na.rating) || 0, rb = (nb && nb.rating) || 0;
      if (ra !== rb) return rb - ra;                 // 별점 높은 순
      return a.booth.localeCompare(b.booth);
    });

  $('listMeta').textContent = `${items.length}개 부스`
    + (filterCat ? ` · ${filterCat}` : '') + (filterMark ? ` · ${filterMark}` : '');

  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="empty" style="display:block">조건에 맞는 부스가 없습니다</li>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const b of items) {
    const n = store.notes[b.booth];
    const li = document.createElement('li');
    li.onclick = () => openSheet(b.booth);

    const code = document.createElement('div');
    code.className = 'li-code';
    code.textContent = b.booth;

    const body = document.createElement('div');
    body.className = 'li-body';
    const name = document.createElement('div');
    name.className = 'li-name';
    name.textContent = b.name || b.booth;
    const sub = document.createElement('div');
    sub.className = 'li-sub';
    sub.textContent = b.category + (b.desc ? ' · ' + b.desc.split('\n')[0] : '');
    body.append(name, sub);

    if (hasData(n)) {
      const marks = document.createElement('div');
      marks.className = 'li-marks';
      if (n.rating) marks.append(text('⭐'.repeat(n.rating)));
      for (const t of n.tags) marks.append(text(t === '방문완료' ? '✅ 방문완료' : t === '관심' ? '⭐ 관심' : t));
      body.append(marks);
      if (n.memo && n.memo.trim()) {
        const m = document.createElement('div');
        m.className = 'li-memo';
        m.textContent = n.memo.trim();
        body.append(m);
      }
    }
    li.append(code, body);
    frag.append(li);
  }
  ul.append(frag);
}
function text(s) { const e = document.createElement('span'); e.textContent = s; return e; }

function refresh() {
  renderChips();
  renderList();
  paintAll();
}

/* ============ 상세 시트 ============ */
function openSheet(code) {
  const b = boothByCode.get(code);
  if (!b) return;
  selected = code;
  const n = note(code);

  $('sBooth').textContent = b.booth;
  $('sCat').textContent = b.category;
  $('sName').textContent = b.name || b.booth;
  $('sDesc').textContent = b.desc || '';
  const link = $('sUrl');
  if (b.url) { link.href = /^https?:/.test(b.url) ? b.url : 'https://' + b.url; link.hidden = false; }
  else link.hidden = true;

  const stars = $('sStars');
  stars.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement('button');
    s.textContent = '★';
    s.className = i <= n.rating ? 'on' : '';
    s.setAttribute('aria-label', `${i}점`);
    s.onclick = () => { n.rating = n.rating === i ? 0 : i; saveStore(); openSheet(code); refresh(); };
    stars.append(s);
  }

  const tagRow = $('sTags');
  tagRow.innerHTML = '';
  for (const t of TAGS) {
    const btn = document.createElement('button');
    btn.className = 'tag' + (n.tags.includes(t) ? ' on' : '');
    btn.dataset.tag = t;
    btn.textContent = t;
    btn.onclick = () => {
      const i = n.tags.indexOf(t);
      if (i >= 0) n.tags.splice(i, 1); else n.tags.push(t);
      saveStore(); openSheet(code); refresh();
    };
    tagRow.append(btn);
  }

  const memo = $('sMemo');
  memo.value = n.memo || '';
  memo.oninput = () => { n.memo = memo.value; saveStore(); };
  memo.onblur = () => refresh();

  const sel = $('sCatSel');
  sel.innerHTML = '';
  for (const c of CATEGORIES) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c; o.selected = c === b.category;
    sel.append(o);
  }
  sel.onchange = () => {
    store.cats[code] = sel.value;
    saveStore(); rebuildBooths(); refresh();
    $('sCat').textContent = sel.value;
  };

  const isHere = store.here === code;
  const hereRow = $('sHere');
  const rel = !isHere && store.here ? relativeTo(store.here, code) : null;
  if (rel) {
    const from = boothByCode.get(store.here);
    hereRow.hidden = false;
    hereRow.innerHTML = '';
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '➜';
    arrow.style.transform = `rotate(${rel.deg.toFixed(0)}deg)`;
    const fromName = from && from.short ? ` ${from.short}` : '';
    hereRow.append(
      text(`현위치(${store.here}${fromName})에서 `), arrow,
      text(` 지도 ${rel.dir} · 약 ${Math.round(rel.meters / 5) * 5}m`));
  } else {
    hereRow.hidden = true;
  }
  const hereBtn = $('sHereBtn');
  hereBtn.textContent = isHere ? '📍 현위치 해제' : '📍 여기 있음';
  hereBtn.onclick = () => { setHere(isHere ? null : code); openSheet(code); };

  $('sLocate').textContent = store.here && store.here !== code
    ? '지도에서 현위치부터 길 보기' : '지도에서 이 부스 보기';
  $('sLocate').onclick = () => {
    closeSheet(true);
    switchView('mapView');
    // 현위치가 있으면 둘 다 화면에 들어오게, 없으면 해당 부스를 크게 잡는다.
    if (store.here && store.here !== code) fitBoth(store.here, code);
    else focusBooth(code);
  };

  $('sheet').hidden = false;
  $('sheetScrim').hidden = false;
  paintAll();
  renderHere();
}
/** keepSelection: 시트만 닫고 선택은 유지한다.
 *  시트가 지도를 가려서, 현위치→목적지 안내선은 시트를 닫아야 비로소 보인다. */
function closeSheet(keepSelection) {
  $('sheet').hidden = true;
  $('sheetScrim').hidden = true;
  if (!keepSelection) selected = null;
  paintAll();
  renderHere();
}

/* ============ 내보내기 / 불러오기 ============ */
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportJson() {
  download(`${fair.id}-기록.json`,
    JSON.stringify({ fair: fair.id, exportedAt: new Date().toISOString(), ...store }, null, 1),
    'application/json');
}
function exportText() {
  const lines = [`# ${fair.title} 방문 기록`, ''];
  const rated = booths
    .filter((b) => hasData(store.notes[b.booth]))
    .sort((a, b) => (store.notes[b.booth].rating || 0) - (store.notes[a.booth].rating || 0));
  if (!rated.length) { toast('기록된 부스가 없습니다'); return; }
  for (const b of rated) {
    const n = store.notes[b.booth];
    lines.push(`## ${b.booth} ${b.name}`);
    lines.push(`- 카테고리: ${b.category}`);
    if (n.rating) lines.push(`- 별점: ${'★'.repeat(n.rating)}${'☆'.repeat(5 - n.rating)}`);
    if (n.tags.length) lines.push(`- 상태: ${n.tags.join(', ')}`);
    if (n.memo && n.memo.trim()) lines.push(`- 메모: ${n.memo.trim()}`);
    if (b.url) lines.push(`- 링크: ${b.url}`);
    lines.push('');
  }
  download(`${fair.id}-기록.md`, lines.join('\n'), 'text/markdown');
}
function importJson(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const p = JSON.parse(r.result);
      if (!p.notes) throw new Error('형식이 맞지 않습니다');
      store = { notes: p.notes || {}, geom: p.geom || {}, cats: p.cats || {}, here: p.here || null };
      saveStore(); rebuildBooths(); renderOverlay(); refresh(); renderHere();
      toast('기록을 불러왔습니다');
    } catch (e) { toast('불러오기 실패: ' + e.message); }
  };
  r.readAsText(file);
}

/* ============ 편집 모드 (부스 좌표 보정) ============ */
let editing = false, editDrag = null, editTarget = null;

function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  $('editBar').hidden = !on;
  if (!on) { editTarget = null; document.querySelectorAll('.handle').forEach((h) => h.remove()); }
  updateEditInfo();
}
function updateEditInfo() {
  $('editInfo').textContent = editTarget
    ? `선택: ${editTarget.dataset.booth} — 끌어서 이동, 모서리로 크기 조절`
    : '편집: 부스를 탭해 선택하세요';
}
function editPointerDown(e) {
  if (e.target.classList.contains('handle')) {
    const r = curRect(editTarget);
    editDrag = { mode: 'resize', sx: e.clientX, sy: e.clientY, ...r };
    return;
  }
  if (e.target.classList.contains('booth')) {
    selectEdit(e.target);
    const r = curRect(editTarget);
    editDrag = { mode: 'move', sx: e.clientX, sy: e.clientY, ...r };
  } else {
    selectEdit(null);
  }
}
function editPointerMove(e) {
  if (!editDrag || !editTarget) return;
  const dx = (e.clientX - editDrag.sx) / scale;
  const dy = (e.clientY - editDrag.sy) / scale;
  if (editDrag.mode === 'move') {
    editTarget.style.left = Math.round(editDrag.x + dx) + 'px';
    editTarget.style.top = Math.round(editDrag.y + dy) + 'px';
  } else {
    editTarget.style.width = Math.max(8, Math.round(editDrag.w + dx)) + 'px';
    editTarget.style.height = Math.max(8, Math.round(editDrag.h + dy)) + 'px';
  }
}
function editPointerUp() {
  if (editDrag && editTarget) commitEdit();
  editDrag = null;
}
function curRect(el) {
  return { x: parseFloat(el.style.left), y: parseFloat(el.style.top),
    w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
}
function selectEdit(el) {
  document.querySelectorAll('.handle').forEach((h) => h.remove());
  document.querySelectorAll('.booth.sel').forEach((b) => b.classList.remove('sel'));
  editTarget = el;
  if (el) {
    el.classList.add('sel');
    const h = document.createElement('div');
    h.className = 'handle';
    el.appendChild(h);
  }
  updateEditInfo();
}
/** 편집 중인 부스의 모든 사각형을 저장소에 반영 */
function commitEdit() {
  const code = editTarget.dataset.booth;
  const rects = [...els.get(code)].map(curRect);
  store.geom[code] = { rects, name: (boothByCode.get(code) || {}).name };
  saveStore();
  rebuildBooths();
}

function bindEditor() {
  $('editAdd').onclick = () => {
    const code = prompt('추가할 부스 번호 (예: J01)');
    if (!code) return;
    const c = code.trim().toUpperCase();
    if (boothByCode.has(c)) { toast('이미 있는 부스입니다'); return; }
    const name = prompt('업체명 (비워도 됩니다)') || c;
    const vp = $('viewport');
    const x = Math.round((vp.clientWidth / 2 - tx) / scale) - 18;
    const y = Math.round((vp.clientHeight / 2 - ty) / scale) - 18;
    store.geom[c] = { rects: [{ x, y, w: 37, h: 37 }], name };
    saveStore(); rebuildBooths(); renderOverlay(); refresh();
    toast(`${c} 추가됨 — 끌어서 위치를 맞추세요`);
  };
  $('editDelete').onclick = () => {
    if (!editTarget) { toast('삭제할 부스를 먼저 선택하세요'); return; }
    const code = editTarget.dataset.booth;
    if (!confirm(`${code} 의 위치 보정을 초기화할까요?`)) return;
    delete store.geom[code];
    saveStore(); rebuildBooths(); renderOverlay(); refresh(); renderHere();
    selectEdit(null);
  };
  $('editExport').onclick = () => {
    const out = booths.map((b) => ({ booth: b.booth, name: b.name, rects: b.rects }));
    download(`${fair.id}-좌표.json`, JSON.stringify(out, null, 1), 'application/json');
  };
  $('editExit').onclick = () => { setEditing(false); renderOverlay(); refresh(); renderHere(); };
}

/* ============ 기타 UI ============ */
function switchView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === id));
  if (id === 'mapView') requestAnimationFrame(() => { clampPan(); applyTransform(); });
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}
function renderStats() {
  const total = booths.length;
  const star = booths.filter((b) => (store.notes[b.booth] || { tags: [] }).tags.includes('관심')).length;
  const visited = booths.filter((b) => (store.notes[b.booth] || { tags: [] }).tags.includes('방문완료')).length;
  const memo = booths.filter((b) => { const n = store.notes[b.booth]; return n && n.memo && n.memo.trim(); }).length;
  $('stats').textContent = `전체 ${total}개 · ⭐관심 ${star} · ✅방문 ${visited} · ✎메모 ${memo}`;
}

function bindUI() {
  bindMapGestures();
  bindEditor();

  const search = $('search');
  search.addEventListener('input', () => {
    query = search.value;
    $('clearSearch').hidden = !query;
    refresh();
  });
  search.addEventListener('search', () => { if (!search.value) { query = ''; refresh(); } });
  $('clearSearch').onclick = () => { search.value = ''; query = ''; $('clearSearch').hidden = true; refresh(); };

  document.querySelectorAll('#tabs button').forEach((b) => {
    b.onclick = () => switchView(b.dataset.view);
  });

  $('labelToggle').onclick = () => setLabels(!labelsOn);
  $('goHere').onclick = () => { if (store.here) focusBooth(store.here); };
  $('zoomIn').onclick = () => centerZoom(scale * 1.4);
  $('zoomOut').onclick = () => centerZoom(scale / 1.4);
  $('zoomFit').onclick = fitToScreen;

  $('sheetClose').onclick = closeSheet;
  $('sheetScrim').onclick = closeSheet;

  $('menuBtn').onclick = () => { renderStats(); $('menu').hidden = false; $('menuScrim').hidden = false; };
  const closeMenu = () => { $('menu').hidden = true; $('menuScrim').hidden = true; };
  $('menuClose').onclick = closeMenu;
  $('menuScrim').onclick = closeMenu;

  $('exportBtn').onclick = exportJson;
  $('exportMdBtn').onclick = exportText;
  $('importFile').onchange = (e) => { if (e.target.files[0]) { importJson(e.target.files[0]); closeMenu(); } };
  $('editToggle').onclick = () => { closeMenu(); switchView('mapView'); setEditing(true); };
  $('resetBtn').onclick = () => {
    if (!confirm('메모·별점·상태를 모두 지웁니다. 계속할까요?')) return;
    store = { notes: {}, geom: {}, cats: {}, here: null };
    saveStore(); rebuildBooths(); renderOverlay(); refresh(); renderHere(); closeMenu();
    toast('기록을 모두 삭제했습니다');
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet(); closeMenu(); }
  });
}
function centerZoom(s) {
  const r = $('viewport').getBoundingClientRect();
  zoomAt(s, r.left + r.width / 2, r.top + r.height / 2);
}

init().catch((e) => {
  document.body.innerHTML = `<p style="padding:24px">데이터를 불러오지 못했습니다: ${e.message}</p>`;
});
