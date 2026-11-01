// =============================================================
//  학교 통합 지도 - 메인 코드
//  흐름: spaces.js(공간 정보) + reports(상태 제보) → 화면 그리기
// =============================================================

// ----- 1. 상태 종류와 "오래된 정보" 기준 -----
// staleMin: 이 시간(분)이 지나면 오래된 정보로 표시
// (사용 중 여부는 금방 바뀌고, 고장은 오래가므로 기준을 다르게 둠)
const STATUS = {
  available: { label: "사용 가능",   color: "#4caf72", staleMin: 180 },
  in_use:    { label: "사용 중",     color: "#f0b429", staleMin: 120 },
  broken:    { label: "기자재 이상", color: "#e25c5c", staleMin: 72 * 60 },
  closed:    { label: "이용 불가",   color: "#8e6bd6", staleMin: 24 * 60 }
};
const NO_INFO_COLOR = "#ffffff";
const LOOKBACK_DAYS = 3;   // 최근 며칠치 제보만 불러올지 (읽기 횟수 절약)
const CONFLICT_MIN = 60;   // 최신 제보 기준 몇 분 안의 "다른 상태" 제보를 충돌로 볼지
const NOTE_MAX = 200;

// ----- 2. 화면 상태 -----
const state = {
  view: "campus",      // "campus" 또는 "building"
  buildingId: null,
  floor: null,
  selectedId: null,    // 선택한 공간 id
  reports: [],         // 최신순으로 정렬된 제보 목록
  draft: { roomId: null, status: null, note: "" },   // 작성 중인 제보 (다시 그려도 유지)
  edit: new URLSearchParams(location.search).get("edit") === "1"
};

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const roomById = (id) => MAP_DATA.rooms.find((r) => r.id === id);
const buildingById = (id) => MAP_DATA.buildings.find((b) => b.id === id);

// ----- 3. 저장소: Firebase가 설정돼 있으면 공유 모드, 아니면 로컬 테스트 모드 -----
function isConfigured() {
  return typeof firebase !== "undefined" &&
         typeof FIREBASE_CONFIG === "object" &&
         FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("여기에");
}

function makeFirebaseStore() {
  firebase.initializeApp(FIREBASE_CONFIG);
  const col = firebase.firestore().collection("reports");
  const FV = firebase.firestore.FieldValue;

  return {
    mode: "firebase",
    // 최근 제보를 실시간으로 받아옴 (누가 등록하면 자동으로 다시 호출됨)
    subscribe(callback) {
      const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
      col.where("createdAt", ">=", since).orderBy("createdAt", "desc").limit(300)
        .onSnapshot((snap) => {
          const list = snap.docs.map((doc) => {
            // 방금 등록해서 서버 시각이 아직 없으면 예상 시각을 사용
            const d = doc.data({ serverTimestamps: "estimate" });
            return {
              id: doc.id,
              spaceId: d.spaceId,
              status: d.status,
              note: d.note || "",
              createdAt: d.createdAt ? d.createdAt.toDate() : new Date(),
              confirms: d.confirms || 0,
              lastConfirmedAt: d.lastConfirmedAt ? d.lastConfirmedAt.toDate() : null
            };
          });
          callback(list);
        }, (err) => showToast("불러오기 실패: " + err.message, true));
    },
    add(r) {
      return col.add({
        spaceId: r.spaceId, status: r.status, note: r.note,
        createdAt: FV.serverTimestamp(),   // 기기 시계가 아니라 서버 시각
        confirms: 0
      });
    },
    confirm(id) {
      return col.doc(id).update({
        confirms: FV.increment(1),
        lastConfirmedAt: FV.serverTimestamp()
      });
    }
  };
}

function makeLocalStore() {
  const KEY = "campus-map-reports";
  let listener = null;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
  const save = (arr) => { try { localStorage.setItem(KEY, JSON.stringify(arr)); } catch (e) {} };
  const emit = () => {
    if (!listener) return;
    const list = load().map((r) => ({
      ...r,
      createdAt: new Date(r.createdAt),
      lastConfirmedAt: r.lastConfirmedAt ? new Date(r.lastConfirmedAt) : null
    })).sort((a, b) => b.createdAt - a.createdAt);
    listener(list);
  };

  return {
    mode: "local",
    subscribe(callback) {
      listener = callback;
      emit();
      window.addEventListener("storage", emit);   // 같은 브라우저의 다른 탭과 동기화
    },
    add(r) {
      const arr = load();
      arr.push({ id: "L" + Date.now() + Math.random().toString(36).slice(2, 6),
                 ...r, createdAt: new Date().toISOString(), confirms: 0, lastConfirmedAt: null });
      save(arr); emit();
      return Promise.resolve();
    },
    confirm(id) {
      const arr = load();
      const r = arr.find((x) => x.id === id);
      if (r) { r.confirms++; r.lastConfirmedAt = new Date().toISOString(); }
      save(arr); emit();
      return Promise.resolve();
    }
  };
}

// ----- 4. 핵심 판단: 공간별 최신 상태, 오래됨, 충돌 -----
function analyze(spaceId) {
  const list = state.reports.filter((r) => r.spaceId === spaceId);   // 이미 최신순
  if (list.length === 0) return null;

  const latest = list[0];
  // 누군가 "확인했어요"를 눌렀다면 그 시각부터 다시 계산
  const lastSeen = (latest.lastConfirmedAt && latest.lastConfirmedAt > latest.createdAt)
    ? latest.lastConfirmedAt : latest.createdAt;
  const ageMin = (Date.now() - lastSeen) / 60000;
  const stale = ageMin > STATUS[latest.status].staleMin;

  // 최신 제보 직전 CONFLICT_MIN분 안에 다른 상태로 올라온 제보 수
  const conflicts = list.slice(1).filter((r) =>
    r.status !== latest.status && (latest.createdAt - r.createdAt) / 60000 <= CONFLICT_MIN
  ).length;

  return { latest, list, lastSeen, stale, conflicts };
}

// ----- 5. 시간 표시 -----
function timeAgo(date) {
  const min = Math.floor((Date.now() - date) / 60000);
  if (min < 1) return "방금 전";
  if (min < 60) return min + "분 전";
  if (min < 60 * 24) return Math.floor(min / 60) + "시간 전";
  return Math.floor(min / 1440) + "일 전";
}
function clock(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

// ----- 6. 작은 도우미: 요소 만들기 (사용자 글은 항상 textContent로 넣어 XSS 방지) -----
function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "class") e.className = attrs[k];
    else if (k === "style") e.style.cssText = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  if (text !== undefined) e.textContent = text;
  return e;
}
function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}
// 사각형(x,y,w,h) 또는 다각형(points: "x1,y1 x2,y2 ...") 모양 만들기
function svgShape(o, cls) {
  if (o.points) return svgEl("polygon", { points: o.points, class: cls });
  return svgEl("rect", { x: o.x, y: o.y, width: o.w, height: o.h, rx: 4, class: cls });
}
// 모양을 감싸는 사각형 (글자 위치, 배지 위치 계산용)
function bbox(o) {
  if (!o.points) return { x: o.x, y: o.y, w: o.w, h: o.h };
  const p = o.points.trim().split(/\s+/).map((s) => s.split(",").map(Number));
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
// 칸 크기에 맞춰 글자 크기를 줄이고, 길면 두 줄로 나눔
function svgLabel(o, text, cls = "label", maxSize = 18) {
  const b = bbox(o);
  let lines = [String(text)];
  const len = (t) => [...t].length;
  if (len(text) * maxSize > b.w - 6 && len(text) > 4) {
    const words = String(text).split(" ");
    if (words.length > 1) {
      // 띄어쓰기 기준으로 두 줄의 길이가 비슷해지게 나눔
      let best = 1, bestDiff = Infinity;
      for (let i = 1; i < words.length; i++) {
        const d = Math.abs(len(words.slice(0, i).join(" ")) - len(words.slice(i).join(" ")));
        if (d < bestDiff) { bestDiff = d; best = i; }
      }
      lines = [words.slice(0, best).join(" "), words.slice(best).join(" ")];
    } else {
      const chars = [...text], half = Math.ceil(chars.length / 2);
      lines = [chars.slice(0, half).join(""), chars.slice(half).join("")];
    }
  }
  const longest = Math.max(...lines.map(len));
  const size = Math.max(9, Math.min(maxSize, (b.w - 6) / longest, (b.h - 4) / (lines.length * 1.15)));
  const t = svgEl("text", { x: b.x + b.w / 2, y: b.y + b.h / 2, "text-anchor": "middle",
                           "dominant-baseline": "middle", class: cls, "font-size": size.toFixed(1) });
  lines.forEach((ln, i) => {
    const dy = lines.length === 1 ? 0 : (i === 0 ? -0.55 : 1.1);
    t.appendChild(svgEl("tspan", { x: b.x + b.w / 2, dy: dy + "em" }, ln));
  });
  return t;
}

// ----- 7. 지도 그리기 -----
function renderMap() {
  const svg = $("map");
  svg.innerHTML = "";

  if (state.view === "campus") {
    const c = MAP_DATA.campus;
    svg.setAttribute("viewBox", `${c.x || 0} ${c.y || 0} ${c.width} ${c.height}`);

    (c.decor || []).forEach((d) => {
      svg.appendChild(svgShape(d, "decor kind-" + (d.kind || "etc")));
      if (d.label) svg.appendChild(svgLabel(d, d.label, "decor-label", 26));
    });

    MAP_DATA.buildings.forEach((b) => {
      const g = svgEl("g");
      const r = svgShape(b, b.ready ? "building" : "building off");
      r.addEventListener("click", () => {
        if (state.edit) return;
        if (b.ready) openBuilding(b.id);
        else showToast(`${b.name}은(는) 아직 준비 중이에요.`);
      });
      g.appendChild(r);
      g.appendChild(svgLabel(b, b.name, b.ready ? "label campus-label" : "label campus-label off", 26));

      // 건물 안에 "기자재 이상/이용 불가"가 있으면 빨간 숫자 배지
      const issues = MAP_DATA.rooms.filter((room) => {
        if (room.building !== b.id) return false;
        const a = analyze(room.id);
        return a && !a.stale && (a.latest.status === "broken" || a.latest.status === "closed");
      }).length;
      if (issues > 0) {
        const bb = bbox(b);
        g.appendChild(svgEl("circle", { cx: bb.x + bb.w - 8, cy: bb.y + 8, r: 16, class: "badge" }));
        g.appendChild(svgEl("text", { x: bb.x + bb.w - 8, y: bb.y + 9, "text-anchor": "middle",
                                      "dominant-baseline": "middle", class: "badge-text" }, issues));
      }
      svg.appendChild(g);
    });
  } else {
    const f = MAP_DATA.floorSize;
    svg.setAttribute("viewBox", `0 0 ${f.width} ${f.height}`);

    MAP_DATA.floorDecor
      .filter((d) => d.building === state.buildingId && d.floor === state.floor)
      .forEach((d) => {
        svg.appendChild(svgShape(d, "decor kind-" + (d.kind || "etc")));
        if (d.label) svg.appendChild(svgLabel(d, d.label, "decor-label", 15));
      });

    MAP_DATA.rooms
      .filter((r) => r.building === state.buildingId && r.floor === state.floor)
      .forEach((room) => {
        const a = analyze(room.id);
        const rect = svgShape(room, "room");
        rect.setAttribute("fill", a ? STATUS[a.latest.status].color : NO_INFO_COLOR);
        if (a && a.stale) rect.classList.add("stale");
        if (room.id === state.selectedId) rect.classList.add("selected");
        rect.addEventListener("click", () => { if (!state.edit) selectRoom(room.id); });
        svg.appendChild(rect);
        svg.appendChild(svgLabel(room, room.name, "label", 17));
      });
  }
  renderToolbar();
}

function renderToolbar() {
  const tabs = $("floorTabs");
  tabs.innerHTML = "";
  if (state.view === "campus") {
    $("backBtn").classList.add("hidden");
    $("breadcrumb").textContent = "캠퍼스 전체";
    return;
  }
  const b = buildingById(state.buildingId);
  $("backBtn").classList.remove("hidden");
  $("breadcrumb").textContent = `${b.name} ${state.floor}층`;
  b.floors.forEach((fl) => {
    const btn = el("button", fl === state.floor ? { class: "on" } : {}, fl + "층");
    btn.addEventListener("click", () => { state.floor = fl; state.selectedId = null; renderAll(); });
    tabs.appendChild(btn);
  });
}

function renderLegend() {
  const lg = $("legend");
  lg.innerHTML = "";
  Object.values(STATUS).forEach((s) => lg.appendChild(el("span", { style: `--c:${s.color}` }, s.label)));
  lg.appendChild(el("span", { style: `--c:${NO_INFO_COLOR};` }, "정보 없음"));
  lg.appendChild(el("span", { style: "--c:repeating-linear-gradient(45deg,#ccc 0 3px,#fff 3px 6px)" }, "흐릿함 = 오래된 정보"));
}

// ----- 8. 오른쪽 패널 -----
function renderPanel() {
  const panel = $("panel");
  panel.innerHTML = "";
  const room = state.selectedId ? roomById(state.selectedId) : null;

  if (!room) {
    panel.appendChild(el("h2", {}, state.view === "campus" ? "건물을 선택하세요" : "공간을 선택하세요"));
    panel.appendChild(el("div", { class: "meta" }, "지도를 누르거나 위에서 검색할 수 있어요."));
    renderRecentAll(panel);
    return;
  }

  const b = buildingById(room.building);
  panel.appendChild(el("h2", {}, room.name));
  panel.appendChild(el("div", { class: "meta" }, `${b.name} ${room.floor}층 · ${room.type}`));

  // 현재 상태
  const a = analyze(room.id);
  if (!a) {
    const box = el("div", { class: "status-box" });
    box.appendChild(el("div", { class: "big" }, "등록된 정보 없음"));
    box.appendChild(el("div", { class: "time" }, `최근 ${LOOKBACK_DAYS}일 동안 제보가 없어요.`));
    panel.appendChild(box);
  } else {
    const s = STATUS[a.latest.status];
    const box = el("div", { class: "status-box", style: `--c:${s.color}` });
    box.appendChild(el("div", { class: "big" }, s.label));
    box.appendChild(el("div", { class: "time" },
      `등록 ${timeAgo(a.latest.createdAt)} (${clock(a.latest.createdAt)})` +
      (a.latest.confirms > 0 ? ` · ${a.latest.confirms}명 확인 (마지막 ${timeAgo(a.lastSeen)})` : "")));
    if (a.latest.note) box.appendChild(el("div", { class: "note" }, a.latest.note));
    if (a.stale) box.appendChild(el("div", { class: "warn" },
      "⚠ 오래된 정보예요. 지금은 다를 수 있으니 직접 확인해 주세요."));
    if (a.conflicts > 0) box.appendChild(el("div", { class: "warn" },
      `⚠ 최근 ${CONFLICT_MIN}분 안에 다른 상태 제보가 ${a.conflicts}건 있어요.`));

    const cbtn = el("button", { style: "margin-top:8px" }, "👍 지금도 맞아요");
    cbtn.addEventListener("click", () => {
      cbtn.disabled = true;
      store.confirm(a.latest.id)
        .then(() => showToast("확인해 주셔서 고마워요!"))
        .catch((e) => { showToast("실패: " + e.message, true); cbtn.disabled = false; });
    });
    box.appendChild(cbtn);
    panel.appendChild(box);
  }

  panel.appendChild(buildForm(room));

  // 이 공간의 최근 기록
  const hist = el("div", { class: "history" });
  hist.appendChild(el("h3", {}, "최근 기록"));
  const ul = el("ul");
  const list = a ? a.list.slice(0, 5) : [];
  if (list.length === 0) ul.appendChild(el("li", { class: "empty" }, "기록 없음"));
  list.forEach((r) => ul.appendChild(historyItem(r, STATUS[r.status].label)));
  hist.appendChild(ul);
  panel.appendChild(hist);
}

function historyItem(r, title) {
  const li = el("li");
  li.appendChild(el("span", { class: "dot", style: `--c:${STATUS[r.status].color}` }));
  li.appendChild(document.createTextNode(title));
  li.appendChild(el("span", { class: "when" }, timeAgo(r.createdAt)));
  if (r.note) li.appendChild(el("div", { class: "n" }, r.note));
  return li;
}

function renderRecentAll(panel) {
  const hist = el("div", { class: "history" });
  hist.appendChild(el("h3", {}, "학교 전체 최근 제보"));
  const ul = el("ul");
  const list = state.reports.filter((r) => roomById(r.spaceId)).slice(0, 8);
  if (list.length === 0) ul.appendChild(el("li", { class: "empty" }, "아직 제보가 없어요."));
  list.forEach((r) => {
    const room = roomById(r.spaceId);
    const li = historyItem(r, `${room.name} · ${STATUS[r.status].label}`);
    li.classList.add("clickable");
    li.addEventListener("click", () => goToRoom(room.id));
    ul.appendChild(li);
  });
  hist.appendChild(ul);
  panel.appendChild(hist);
}

function buildForm(room) {
  const form = el("div", { class: "form" });
  form.appendChild(el("h3", {}, "상태 알리기"));

  const choices = el("div", { class: "status-choices" });
  Object.entries(STATUS).forEach(([key, s]) => {
    const label = el("label");
    const input = el("input", { type: "radio", name: "st", value: key });
    if (state.draft.roomId === room.id && state.draft.status === key) input.checked = true;
    input.addEventListener("change", () => { state.draft = { ...state.draft, roomId: room.id, status: key }; });
    label.appendChild(input);
    label.appendChild(document.createTextNode(s.label));
    choices.appendChild(label);
  });
  form.appendChild(choices);

  const ta = el("textarea", { maxlength: NOTE_MAX, placeholder: "설명 (선택) 예: 프로젝터 전원이 안 켜져요" });
  if (state.draft.roomId === room.id) ta.value = state.draft.note;
  const count = el("div", { class: "count" }, `${ta.value.length} / ${NOTE_MAX}`);
  ta.addEventListener("input", () => {
    count.textContent = `${ta.value.length} / ${NOTE_MAX}`;
    state.draft = { ...state.draft, roomId: room.id, note: ta.value };
  });
  form.appendChild(ta);
  form.appendChild(count);

  const btn = el("button", { class: "primary" }, "등록하기");
  btn.addEventListener("click", () => {
    const checked = form.querySelector("input[name=st]:checked");
    if (!checked) { showToast("상태를 하나 골라 주세요.", true); return; }
    const note = ta.value.trim().slice(0, NOTE_MAX);

    btn.disabled = true;
    btn.textContent = "등록 중...";
    store.add({ spaceId: room.id, status: checked.value, note })
      .then(() => {
        state.draft = { roomId: null, status: null, note: "" };
        showToast("등록됐어요!");
        renderPanel();
      })
      .catch((e) => {
        showToast("등록 실패: " + e.message, true);
        btn.disabled = false; btn.textContent = "등록하기";
      });
  });
  form.appendChild(btn);
  return form;
}

// ----- 9. 이동 -----
function openBuilding(id) {
  const b = buildingById(id);
  state.view = "building";
  state.buildingId = id;
  state.floor = b.floors[0];
  state.selectedId = null;
  renderAll();
}
function selectRoom(id) { state.selectedId = id; renderAll(); }
function goToRoom(id) {
  const room = roomById(id);
  state.view = "building";
  state.buildingId = room.building;
  state.floor = room.floor;
  state.selectedId = id;
  renderAll();
}
function goCampus() {
  state.view = "campus";
  state.buildingId = null;
  state.selectedId = null;
  renderAll();
}

// ----- 10. 검색 -----
// 공백 제거 + 소문자로 바꿔서 비교 ("물리 실험실" = "물리실험실")
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, "");

function search(query) {
  const q = norm(query);
  if (!q) return [];
  const score = (names) => {
    let best = 0;
    names.map(norm).forEach((n) => {
      if (n === q) best = Math.max(best, 3);
      else if (n.startsWith(q)) best = Math.max(best, 2);
      else if (n.includes(q)) best = Math.max(best, 1);
    });
    return best;
  };
  const results = [];
  MAP_DATA.rooms.forEach((r) => {
    const s = score([r.name, r.id, ...(r.aliases || [])]);
    if (s) results.push({ kind: "room", id: r.id, name: r.name,
                          sub: `${buildingById(r.building).name} ${r.floor}층`, s });
  });
  MAP_DATA.buildings.filter((b) => b.ready).forEach((b) => {
    const s = score([b.name, ...(b.aliases || [])]);
    if (s) results.push({ kind: "building", id: b.id, name: b.name, sub: "건물", s });
  });
  return results.sort((a, b) => b.s - a.s).slice(0, 8);
}

function setupSearch() {
  const input = $("search");
  const ul = $("searchResults");
  let current = [];

  const choose = (item) => {
    ul.classList.add("hidden");
    input.value = item.name;
    if (item.kind === "room") goToRoom(item.id); else openBuilding(item.id);
  };

  input.addEventListener("input", () => {
    current = search(input.value);
    ul.innerHTML = "";
    if (!input.value.trim()) { ul.classList.add("hidden"); return; }
    if (current.length === 0) {
      ul.appendChild(el("li", { class: "empty" }, "검색 결과가 없어요"));
    }
    current.forEach((item, i) => {
      const li = el("li", i === 0 ? { class: "active" } : {}, item.name);
      li.appendChild(el("span", { class: "sub" }, item.sub));
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(item); });
      ul.appendChild(li);
    });
    ul.classList.remove("hidden");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (current.length > 0) choose(current[0]);
      else if (!input.value.trim()) showToast("검색어를 입력해 주세요.", true);
    }
    if (e.key === "Escape") ul.classList.add("hidden");
  });
  input.addEventListener("blur", () => ul.classList.add("hidden"));
}

// ----- 11. 개발용 좌표 찍기 모드 (?edit=1) -----
function setupEditMode() {
  if (!state.edit) return;
  $("editBox").classList.remove("hidden");
  const svg = $("map");
  const out = $("editOutput");
  let start = null, draft = null;

  const toSvg = (evt) => {
    const p = svg.createSVGPoint();
    p.x = evt.clientX; p.y = evt.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse());
    return { x: Math.round(q.x / 5) * 5, y: Math.round(q.y / 5) * 5 };   // 5단위로 맞춤
  };
  const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                           w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  svg.addEventListener("pointerdown", (e) => {
    start = toSvg(e);
    draft = svgEl("rect", { class: "draft" });
    svg.appendChild(draft);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!start) return;
    const r = box(start, toSvg(e));
    draft.setAttribute("x", r.x); draft.setAttribute("y", r.y);
    draft.setAttribute("width", r.w); draft.setAttribute("height", r.h);
  });
  svg.addEventListener("pointerup", (e) => {
    if (!start) return;
    const r = box(start, toSvg(e));
    start = null;
    if (r.w < 10 || r.h < 10) { draft.remove(); return; }
    const where = state.view === "campus" ? "캠퍼스" : `${state.buildingId} ${state.floor}층`;
    out.value += `// ${where}\nx: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h},\n`;
    out.scrollTop = out.scrollHeight;
  });
  $("editClear").addEventListener("click", () => { out.value = ""; renderMap(); });
}

// ----- 12. 알림 -----
let toastTimer = null;
function showToast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isError ? "error" : "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2500);
}

// ----- 13. 시작 -----
function renderAll() {
  const typing = document.activeElement && document.activeElement.tagName === "TEXTAREA";
  renderMap();
  renderPanel();
  if (typing) {
    const ta = document.querySelector("#panel textarea");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

let store;
function start() {
  try {
    store = isConfigured() ? makeFirebaseStore() : makeLocalStore();
  } catch (e) {
    console.error(e);
    showToast("Firebase 연결 실패 → 로컬 모드로 실행", true);
    store = makeLocalStore();
  }
  $("modeBadge").textContent = store.mode === "firebase"
    ? "🟢 공유 모드 (모두에게 보임)" : "🟡 로컬 테스트 모드 (이 브라우저에만 저장)";

  $("backBtn").addEventListener("click", goCampus);
  setupSearch();
  setupEditMode();
  renderLegend();

  store.subscribe((list) => {
    // 알 수 없는 상태값이나 없는 공간의 제보는 무시
    state.reports = list.filter((r) => STATUS[r.status]);
    renderAll();
  });

  // 1분마다 다시 그려서 "N분 전", 오래됨 표시를 갱신
  setInterval(renderAll, 60000);
  renderAll();
}

start();
