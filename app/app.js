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
// 이름이 길수록 글자가 작아지므로, 이름표마다 읽을 만해지는 배율이 다르다.
// 화면상 8px는 되어야 읽히므로 필요 배율 = 8 / 글자크기 로 보고 세 단계로 나눈다.
// 짧은 이름은 축소 상태에서도 뜨고, 긴 이름은 더 확대해야 나타난다.
const LABEL_TIERS = [0.8, 1.05, 1.4];
const MIN_READABLE_PX = 8;

let fair = null;              // 박람회 원본 데이터
let booths = [];              // 화면에 쓰는 부스 배열(사용자 보정 반영)
let boothByCode = new Map();
// 사용자 데이터. here는 "지금 내가 서 있는 부스" 번호.
// 실내라 GPS가 못 잡으니 사용자가 직접 찍는다 — 대신 부스 단위로 정확하다.
let store = { notes: {}, cats: {}, here: null };
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
      store = { notes: p.notes || {}, cats: p.cats || {}, here: p.here || null };
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
  if (localStorage.getItem('fairmap:noticeSeen') !== '1') showNotice();

  if (img.complete) fitToScreen(); else img.onload = fitToScreen;
  window.addEventListener('resize', () => { if (scale <= fitScale * 1.02) fitToScreen(); });

  if ('serviceWorker' in navigator) setupUpdates();
}

/** 새 버전이 올라왔을 때 스스로 갈아입게 한다.
 *
 * 오프라인 우선이라 새 파일을 받아놔도 다음 실행에야 반영된다. 그러면 사용자는
 * 고친 게 반영된 건지 알 수 없다. 새 서비스 워커가 제어권을 넘겨받는 순간
 * 한 번만 새로고침해 바로 보이게 한다.
 */
function setupUpdates() {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 첫 방문(이전 제어자가 없던 경우)에는 새로고침할 이유가 없다.
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // 앱을 오래 켜둔 채 박람회를 도는 경우를 위해 가끔 새 버전을 확인한다.
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
}

/** 원본 부스 데이터에 사용자가 고친 카테고리를 얹어 booths를 다시 만든다. */
function rebuildBooths() {
  booths = fair.booths.map((b) => ({
    ...b,
    category: store.cats[b.booth] || b.category,
  }));
  boothByCode = new Map(booths.map((b) => [b.booth, b]));
}

/* ============ 오버레이 ============ */
let tierCount = {};

function renderOverlay() {
  const ov = $('overlay');
  ov.innerHTML = '';
  els = new Map();
  tierCount = {};

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
        const need = MIN_READABLE_PX / lay.size;
        const tier = LABEL_TIERS.findIndex((t) => need <= t);
        const n = tier < 0 ? LABEL_TIERS.length : tier + 1;
        tierCount[n] = (tierCount[n] || 0) + 1;
        const lbl = document.createElement('span');
        lbl.className = 'lbl t' + n;
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

const textWidth = (s) => [...s].reduce((acc, c) => acc + charWidth(c), 0);

/** 주어진 줄 수로 나누는 가장 보기 좋은 방법을 찾는다.
 *
 * 이름이 짧아 모든 분할을 다 따져도 부담이 없다. 세 가지를 함께 본다.
 *  - 가장 긴 줄이 짧을수록 글자를 크게 쓸 수 있다(제일 중요)
 *  - 단어 중간보다 공백에서 자르는 게 읽기 좋다
 *  - 줄 길이가 고를수록 보기 좋다('댕댕이/베이커/리'처럼 한 글자만 남지 않게)
 */
function bestSplit(label, lines) {
  const chars = [...label];
  const n = chars.length;
  if (lines === 1) return { rows: [label], widest: textWidth(label) };
  if (lines > n) return null;

  let best = null;
  const consider = (cuts) => {
    const bounds = [0, ...cuts, n];
    const rows = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      rows.push(chars.slice(bounds[i], bounds[i + 1]).join('').trim());
    }
    if (rows.some((r) => r === '')) return;
    const widths = rows.map(textWidth);
    const widest = Math.max(...widths);
    const wordBreaks = cuts.filter((i) => chars[i - 1] !== ' ' && chars[i] !== ' ').length;
    const spread = widest - Math.min(...widths);
    // 같은 조건이면 긴 줄이 앞에 오는 쪽이 자연스럽다('댕댕이/베이/커리' > '댕댕/이베/이커리').
    const growing = widths.filter((v, i) => i > 0 && v > widths[i - 1]).length;
    const score = widest + wordBreaks * 0.2 + spread * 0.35 + growing * 0.08;
    if (!best || score < best.score) best = { score, widest, rows };
  };
  const walk = (start, depth, acc) => {
    if (depth === 0) return consider(acc);
    for (let i = start; i <= n - depth; i++) walk(i + 1, depth - 1, [...acc, i]);
  };
  walk(1, lines - 1, []);
  return best;
}

/** 칸 안에 이름을 어떻게 앉힐지 정한다 — 줄 나누기와 글자 크기.
 *  브라우저 자동 줄바꿈에 맡기면 '로얄살루/트'처럼 한 글자만 떨어져 읽기 나쁘다.
 */
function layoutLabel(label, w, h) {
  let best = null;
  for (const lines of [1, 2, 3]) {
    const split = bestSplit(label, lines);
    if (!split) break;
    // 상한을 먼저 걸어야 한다. 안 그러면 '13px로 잘릴 크기'를 서로 비교하게 되어
    // 실제로는 같은 크기인데도 줄을 더 쪼갠 쪽이 이긴다.
    const size = Math.max(4.5, Math.min(13,
      Math.min((w - 3) / split.widest, (h - 3) / (lines * 1.12))));
    // 줄을 늘리면 글자는 커지지만 읽기는 나빠진다('제임/슨'). 확실히 커질 때만 쪼갠다.
    const score = size * [1, 1, 0.82, 0.72][lines];
    if (!best || score > best.score) best = { score, size, text: split.rows.join('\n') };
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
      // 카테고리 색은 칸 위에 덧칠한다. 이름이 안 뜨는 배율에서는 이 덧칠을 옅게 해
      // 원본에 인쇄된 부스번호가 비쳐 보이게 한다(CSS에서 처리).
      el.style.setProperty('--fill',
        visited ? VISITED_COLOR : (CAT_COLOR[b.category] || CAT_COLOR['기타']));
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
/** 현재 배율에서 아직 안 뜬 이름표 수 */
function hiddenLabelCount() {
  return LABEL_TIERS.reduce(
    (n, t, i) => n + (scale < t ? (tierCount[i + 1] || 0) : 0), 0);
}
/** 지도 왼쪽 아래 안내문 — 필터 결과 수, 또는 이름표가 왜 안 보이는지. */
function updateHint() {
  const cond = [query.trim() && `"${query.trim()}"`, filterCat, filterMark]
    .filter(Boolean).join(' · ');
  const hint = $('hint');
  if (lastHits !== null) {
    hint.textContent = `${cond} — ${lastHits}개 부스`;
    hint.classList.remove('tappable');
  } else if (labelsOn && hiddenLabelCount() > 8) {
    // 얼마나 확대해야 하는지 짐작하게 두지 말고, 눌러서 바로 그 배율로 보내준다.
    // 남은 이름표가 몇 개뿐이면 굳이 안내하지 않는다.
    hint.textContent = scale < LABEL_TIERS[0]
      ? '👆 눌러서 업체명 보기'
      : '👆 눌러서 나머지 업체명까지 보기';
    hint.classList.add('tappable');
  } else {
    hint.textContent = '';
    hint.classList.remove('tappable');
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
  // 배율이 오를수록 더 작은 글씨의 이름표까지 차례로 켠다.
  LABEL_TIERS.forEach((t, i) => {
    document.body.classList.toggle('names' + (i + 1), labelsOn && scale >= t);
  });
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

// 기본 배율에서 부스 한 칸은 화면상 14px 남짓이라 손가락으로 정확히 누르기 어렵다.
// 빗나가도 이 반경(화면 기준 px) 안에서 가장 가까운 부스를 집어준다.
// 축소할수록 여유가 커지지만, 라운지 한복판을 눌렀는데 멀리 있는 부스가 잡히지 않도록
// 이미지 좌표 기준 상한도 함께 둔다(부스 한 칸이 37px).
const TAP_SLACK_PX = 26;
const TAP_SLACK_MAX_IMG = 55;

/** 화면 좌표에 가장 가까운 부스. 여유 반경을 벗어나면 null. */
function boothNear(clientX, clientY) {
  const vp = $('viewport').getBoundingClientRect();
  const ix = (clientX - vp.left - tx) / scale;
  const iy = (clientY - vp.top - ty) / scale;
  const q = query.trim().toLowerCase();
  const filtering = !!(q || filterCat || filterMark);
  let best = null, bestD = Infinity;
  for (const b of booths) {
    for (const r of b.rects) {
      // 사각형까지의 거리 — 안쪽이면 0
      const dx = Math.max(r.x - ix, 0, ix - (r.x + r.w));
      const dy = Math.max(r.y - iy, 0, iy - (r.y + r.h));
      let d = Math.hypot(dx, dy);
      // 검색·필터 중이면 걸린 부스를 먼저 집는다(흐려진 칸에 잘못 붙지 않게).
      if (filtering && !matches(b, q)) d += 14;
      if (d < bestD) { bestD = d; best = b.booth; }
    }
  }
  const slack = Math.min(TAP_SLACK_PX / scale, TAP_SLACK_MAX_IMG);
  return bestD <= slack ? best : null;
}

/** 손가락이 닿는 즉시 어느 칸이 잡혔는지 보여준다. */
let pressed = null;
function setPressed(code) {
  if (pressed === code) return;
  for (const el of els.get(pressed) || []) el.classList.remove('press');
  pressed = code;
  for (const el of els.get(pressed) || []) el.classList.add('press');
  // 안드로이드에서는 짧은 진동으로도 알린다(iOS Safari는 지원하지 않아 무시된다).
  if (code && navigator.vibrate) navigator.vibrate(8);
}

/* 손을 뗀 뒤 지도가 관성으로 미끄러지게 한다 — 지도 앱처럼 손에 붙는 느낌을 낸다. */

// 마지막 이동 몇 개를 기록해 손 뗀 순간의 속도를 낸다.
// 이벤트 하나만 보고 계산하면 고주사율 화면에서 간격이 0에 가까워져 속도가 0이거나
// 터무니없이 커진다. 최근 100ms 구간 전체로 재면 그런 튐이 사라진다.
const VEL_WINDOW_MS = 100;
const VEL_MAX = 3;                  // px/ms — 과하게 튀는 플릭 제한
let track = [];
let glideId = null;

function trackMove(t) {
  track.push({ x: tx, y: ty, t });
  while (track.length > 2 && t - track[0].t > VEL_WINDOW_MS) track.shift();
}
function releaseVelocity() {
  if (track.length < 2) return { x: 0, y: 0 };
  const last = track[track.length - 1];
  const first = track[0];
  const dt = last.t - first.t;
  if (dt <= 0) return { x: 0, y: 0 };
  const clamp = (v) => Math.max(-VEL_MAX, Math.min(VEL_MAX, v));
  return { x: clamp((last.x - first.x) / dt), y: clamp((last.y - first.y) / dt) };
}

function stopGlide() {
  if (glideId) { cancelAnimationFrame(glideId); glideId = null; }
}
function startGlide() {
  const v = releaseVelocity();
  if (Math.hypot(v.x, v.y) < 0.15) return;   // 살짝 움직인 정도면 미끄러뜨리지 않는다
  let vx = v.x, vy = v.y, last = performance.now();
  const step = (now) => {
    const dt = Math.min(now - last, 32);
    last = now;
    tx += vx * dt;
    ty += vy * dt;
    const before = { x: tx, y: ty };
    clampPan();
    // 가장자리에 부딪히면 그 방향 속도를 죽인다
    if (tx !== before.x) vx = 0;
    if (ty !== before.y) vy = 0;
    applyTransform();
    const decay = Math.pow(0.9945, dt);  // 프레임 간격이 달라도 감속이 일정하도록
    vx *= decay; vy *= decay;
    glideId = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : null;
  };
  glideId = requestAnimationFrame(step);
}

function bindMapGestures() {
  const vp = $('viewport');
  const pts = new Map();
  let start = null, moved = false, pinch = null;

  vp.addEventListener('pointerdown', (e) => {
    // 캡처는 손가락이 지도 밖으로 나가도 계속 따라오게 해줄 뿐, 없어도 동작해야 한다.
    // 첫 줄에서 예외가 나면 아래 제스처 처리가 통째로 죽으므로 감싸둔다.
    try { vp.setPointerCapture(e.pointerId); } catch { /* 있으면 좋은 정도 */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    stopGlide();
    if (pts.size === 1) {
      start = { x: e.clientX, y: e.clientY, tx, ty, target: e.target, t: Date.now() };
      track = [{ x: tx, y: ty, t: e.timeStamp }];
      setPressed(boothNear(e.clientX, e.clientY));
    } else if (pts.size === 2) {
      setPressed(null);
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
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // 확대 기준점을 현재 두 손가락 사이로 잡고, 손이 이동한 만큼 지도도 같이 끌어준다.
      // 기준점을 시작 위치에 고정하면 손가락과 지도가 어긋나 뻑뻑하게 느껴진다.
      if (pinch.d > 0) zoomAt(pinch.s * (d / pinch.d), mx, my);
      tx += mx - pinch.cx;
      ty += my - pinch.cy;
      pinch.cx = mx; pinch.cy = my;
      clampPan();
      applyTransform();
      moved = true;
      return;
    }
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) { moved = true; setPressed(null); }
    tx = start.tx + dx; ty = start.ty + dy;
    clampPan();
    applyTransform();
    trackMove(e.timeStamp);   // 손을 뗀 뒤 미끄러뜨리려면 최근 궤적이 필요하다
  });

  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!moved && start) {
      // 정확히 칸을 못 눌러도 가장 가까운 부스를 연다.
      const code = boothNear(start.x, start.y);
      if (code) openSheet(code);
    } else if (moved && pts.size === 0) {
      startGlide();
    }
    setPressed(null);
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
function importJson(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const p = JSON.parse(r.result);
      if (!p.notes) throw new Error('형식이 맞지 않습니다');
      store = { notes: p.notes || {}, cats: p.cats || {}, here: p.here || null };
      saveStore(); rebuildBooths(); renderOverlay(); refresh(); renderHere();
      toast('기록을 불러왔습니다');
    } catch (e) { toast('불러오기 실패: ' + e.message); }
  };
  r.readAsText(file);
}

/* ============ 시트 아래로 밀어 닫기 ============ */
/** 위쪽 손잡이가 끌 수 있게 생겼으니 실제로 끌리게 만든다.
 *  내용이 스크롤 가능하므로, 맨 위에 있을 때만 시트 끌기로 넘긴다. */
function bindSwipeToClose(sheet, onClose) {
  let sy = 0, dy = 0, dragging = false;

  sheet.addEventListener('pointerdown', (e) => {
    if (e.target.closest('textarea, select, input, button, a')) return;
    if (sheet.scrollTop > 0) return;
    sy = e.clientY; dy = 0; dragging = true;
    sheet.style.transition = 'none';
  });

  sheet.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = e.clientY - sy;
    if (dy < 0) dy = 0;                       // 위로는 안 끌린다
    // 따라오는 움직임을 먼저 그린다 — 포인터 캡처가 실패해도 피드백은 끊기지 않게.
    sheet.style.transform = `translateY(${dy}px)`;
    if (dy > 6) {
      try { sheet.setPointerCapture(e.pointerId); } catch { /* 캡처는 있으면 좋은 정도 */ }
    }
  });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = 'transform .2s ease-out';
    sheet.style.transform = '';
    // 시트 높이의 1/4 넘게 내렸으면 닫는다
    if (dy > Math.min(120, sheet.offsetHeight * 0.25)) onClose();
    dy = 0;
  };
  sheet.addEventListener('pointerup', finish);
  sheet.addEventListener('pointercancel', finish);
}

/* ============ 안내 ============ */
function showNotice() {
  $('noticeSrc').href = fair.source;
  $('notice').hidden = false;
  $('noticeScrim').hidden = false;
}
function hideNotice() {
  $('notice').hidden = true;
  $('noticeScrim').hidden = true;
  localStorage.setItem('fairmap:noticeSeen', '1');
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
/** 지금 돌고 있는 버전을 보여준다 — 새 배포가 반영됐는지 눈으로 확인할 수 있게. */
async function currentVersion() {
  try {
    const keys = await caches.keys();
    const hit = keys.find((k) => k.startsWith('fairmap-'));
    if (hit) return hit.replace('fairmap-', '');
  } catch { /* 캐시를 못 읽으면 표시만 생략한다 */ }
  return '?';
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
  $('hint').onclick = () => {
    if (!$('hint').classList.contains('tappable')) return;
    // 지금 배율에서 아직 안 뜬 이름표가 보이는 단계까지 한 번에 올린다.
    const next = LABEL_TIERS.find((t) => scale < t) || LABEL_TIERS[LABEL_TIERS.length - 1];
    centerZoom(next * 1.05);
  };
  $('goHere').onclick = () => { if (store.here) focusBooth(store.here); };
  $('zoomIn').onclick = () => centerZoom(scale * 1.4);
  $('zoomOut').onclick = () => centerZoom(scale / 1.4);
  $('zoomFit').onclick = fitToScreen;

  $('sheetClose').onclick = closeSheet;
  $('sheetScrim').onclick = closeSheet;

  $('menuBtn').onclick = async () => {
    renderStats();
    $('menu').hidden = false;
    $('menuScrim').hidden = false;
    $('appVer').textContent = `버전 ${await currentVersion()}`;
  };
  const closeMenu = () => { $('menu').hidden = true; $('menuScrim').hidden = true; };
  $('menuClose').onclick = closeMenu;
  $('menuScrim').onclick = closeMenu;

  bindSwipeToClose($('sheet'), closeSheet);
  bindSwipeToClose($('menu'), closeMenu);
  bindSwipeToClose($('notice'), hideNotice);

  $('noticeOk').onclick = hideNotice;
  $('noticeScrim').onclick = hideNotice;
  $('noticeAgain').onclick = () => { closeMenu(); showNotice(); };

  $('exportBtn').onclick = exportJson;
  $('importFile').onchange = (e) => { if (e.target.files[0]) { importJson(e.target.files[0]); closeMenu(); } };
  $('resetBtn').onclick = () => {
    if (!confirm('메모·별점·상태를 모두 지웁니다. 계속할까요?')) return;
    store = { notes: {}, cats: {}, here: null };
    saveStore(); rebuildBooths(); renderOverlay(); refresh(); renderHere(); closeMenu();
    toast('기록을 모두 삭제했습니다');
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet(); closeMenu(); hideNotice(); }
  });
}
function centerZoom(s) {
  const r = $('viewport').getBoundingClientRect();
  zoomAt(s, r.left + r.width / 2, r.top + r.height / 2);
}

init().catch((e) => {
  // 오류 메시지를 그대로 HTML로 심지 않는다 — 문자열 하나라도 마크업으로 해석될 여지를 남기지 않는다.
  const p = document.createElement('p');
  p.style.padding = '24px';
  p.textContent = `데이터를 불러오지 못했습니다: ${e.message}`;
  document.body.replaceChildren(p);
});
