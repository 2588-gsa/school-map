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
  closed:    { label: "이용 불가",   color: "#8e6bd6", staleMin: 24 * 60 },
  other:     { label: "기타",        color: "#5b8fb9", staleMin: 6 * 60 }   // 설명 필수
};
// "아닌 것 같아요"가 이만큼 이상이고 "지금도 맞아요"보다 많으면 믿기 어려운 정보로 표시
const DOUBT_MIN = 2;
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
  person: null,        // 검색한 선생님/학생/반 { kind, id }
  highlightId: null,   // 사람 검색 결과로 지도에서 강조할 교실
  timeOverride: null,  // 시간 바꿔보기 { date, period } (null이면 지금 시각)
  viewDay: null,       // 시간표에서 고른 요일 탭 (null이면 오늘)
  reports: [],         // 최신순으로 정렬된 제보 목록
  draft: { roomId: null, status: null, note: "" },
  myVotes: {},         // 내가 의견을 남긴 제보 { 제보 id: "confirm" | "dispute" }
  ranking: null,       // 제보 랭킹 (private/ranking)
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
  const db = firebase.firestore();
  const col = db.collection("reports");
  const FV = firebase.firestore.FieldValue;
  const toDate = (t) => (t ? t.toDate() : null);

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
              id: doc.id, spaceId: d.spaceId, status: d.status, note: d.note || "",
              createdAt: toDate(d.createdAt) || new Date(),
              confirms: d.confirms || 0, lastConfirmedAt: toDate(d.lastConfirmedAt),
              disputes: d.disputes || 0, lastDisputedAt: toDate(d.lastDisputedAt)
            };
          });
          callback(list);
        }, (err) => showToast("불러오기 실패: " + err.message, true));
    },
    // 제보 + 제보자 기록(관리자만 볼 수 있음)을 한 번에 저장
    add(r) {
      const ref = col.doc();
      const batch = db.batch();
      batch.set(ref, {
        spaceId: r.spaceId, status: r.status, note: r.note,
        createdAt: FV.serverTimestamp(),   // 기기 시계가 아니라 서버 시각
        confirms: 0, disputes: 0
      });
      batch.set(db.collection("reportAuthors").doc(ref.id), { by: auth.info.id });
      return batch.commit().then(() => ref.id);
    },
    // 의견: "confirm"(지금도 맞아요) / "dispute"(아닌 것 같아요). 한 사람당 제보 하나에 한 번
    vote(id, type) {
      const batch = db.batch();
      batch.update(col.doc(id), type === "confirm"
        ? { confirms: FV.increment(1), lastConfirmedAt: FV.serverTimestamp() }
        : { disputes: FV.increment(1), lastDisputedAt: FV.serverTimestamp() });
      batch.set(db.collection("votes").doc(`${id}_${auth.info.id}`),
        { report: id, by: auth.info.id, type, at: FV.serverTimestamp() });
      return batch.commit().catch((e) => {
        if (String(e.code || e.message).includes("permission")) throw new Error("이미 의견을 남겼거나 내가 올린 제보예요.");
        throw e;
      });
    },
    // 내가 의견을 남긴 제보들 { 제보 id: "confirm" | "dispute" }
    async myVotes() {
      if (!auth.info) return {};
      const snap = await db.collection("votes").where("by", "==", auth.info.id).get();
      const m = {};
      snap.docs.forEach((d) => { const x = d.data(); m[x.report] = x.type; });
      return m;
    }
  };
}

function makeLocalStore() {
  const KEY = "campus-map-reports", VKEY = "campus-map-votes";
  let listener = null;
  const load = (k = KEY) => { try { return JSON.parse(localStorage.getItem(k)) || (k === KEY ? [] : {}); } catch (e) { return k === KEY ? [] : {}; } };
  const save = (v, k = KEY) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const d = (x) => (x ? new Date(x) : null);
  const emit = () => {
    if (!listener) return;
    listener(load().map((r) => ({ ...r, disputes: r.disputes || 0, createdAt: new Date(r.createdAt),
      lastConfirmedAt: d(r.lastConfirmedAt), lastDisputedAt: d(r.lastDisputedAt) }))
      .sort((a, b) => b.createdAt - a.createdAt));
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
      const id = "L" + Date.now() + Math.random().toString(36).slice(2, 6);
      arr.push({ id, ...r, createdAt: new Date().toISOString(), confirms: 0, disputes: 0 });
      save(arr); emit();
      return Promise.resolve(id);
    },
    vote(id, type) {
      const votes = load(VKEY);
      if (votes[id]) return Promise.reject(new Error("이미 의견을 남긴 제보예요."));
      const arr = load();
      const r = arr.find((x) => x.id === id);
      if (r && type === "confirm") { r.confirms = (r.confirms || 0) + 1; r.lastConfirmedAt = new Date().toISOString(); }
      if (r && type === "dispute") { r.disputes = (r.disputes || 0) + 1; r.lastDisputedAt = new Date().toISOString(); }
      votes[id] = type;
      save(arr); save(votes, VKEY); emit();
      return Promise.resolve();
    },
    async myVotes() { return load(VKEY); }
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

  // "아닌 것 같아요"가 많으면 믿기 어려운 정보
  const doubtful = latest.disputes >= DOUBT_MIN && latest.disputes > latest.confirms;

  return { latest, list, lastSeen, stale, conflicts, doubtful };
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
function bestDiffOf(words) {
  const len = (t) => [...t].length;
  let best = Infinity;
  for (let i = 1; i < words.length; i++)
    best = Math.min(best, Math.abs(len(words.slice(0, i).join(" ")) - len(words.slice(i).join(" "))));
  return best;
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
    }
    if (words.length === 1 || bestDiffOf(words) >= 3) {   // 띄어쓰기로 나누면 한쪽이 너무 짧을 때
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
        if (a && (a.stale || a.doubtful)) rect.classList.add("stale");
        if (room.id === state.selectedId || room.id === state.highlightId) rect.classList.add("selected");
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
  lg.appendChild(el("span", { style: "--c:repeating-linear-gradient(45deg,#ccc 0 3px,#fff 3px 6px)" }, "흐릿함 = 오래됐거나 👎가 많은 정보"));
}

// ----- 8. 오른쪽 패널 -----
function renderPanel() {
  const panel = $("panel");
  panel.innerHTML = "";
  if (state.person && HAS_TT) { renderPersonPanel(panel); return; }
  const room = state.selectedId ? roomById(state.selectedId) : null;

  if (!room) {
    if (myPerson()) renderMyHome(panel);
    else panel.appendChild(el("h2", {}, state.view === "campus" ? "건물을 선택하세요" : "공간을 선택하세요"));
    panel.appendChild(el("div", { class: "meta" }, "지도를 누르거나 위에서 교실·선생님·학생 이름으로 검색할 수 있어요."));
    if (!myPerson() && HAS_TT) panel.appendChild(el("div", { class: "now-line" }, "🕒 " + currentSlot(state.timeOverride).label));
    renderUpcoming(panel, !myPerson());   // 학사일정은 공개 정보라 로그인 안 해도 보임
    if (state.ranking) renderRanking(panel);
    renderRecentAll(panel);
    return;
  }

  const b = buildingById(room.building);
  panel.appendChild(el("h2", {}, room.name));
  panel.appendChild(el("div", { class: "meta" }, `${b.name} ${room.floor}층 · ${room.type}`));
  const isDorm = room.building === "DM" || room.building === "DW";
  if (isDorm) panel.appendChild(dormBox(room));
  else if (HAS_TT) panel.appendChild(roomScheduleBox(room));

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
      (a.latest.confirms > 0 ? ` · 👍 ${a.latest.confirms}명 (마지막 ${timeAgo(a.lastSeen)})` : "") +
      (a.latest.disputes > 0 ? ` · 👎 ${a.latest.disputes}명` : "")));
    if (a.latest.note) box.appendChild(el("div", { class: "note" }, a.latest.note));
    if (a.stale) box.appendChild(el("div", { class: "warn" },
      "⚠ 오래된 정보예요. 지금은 다를 수 있으니 직접 확인해 주세요."));
    if (a.conflicts > 0) box.appendChild(el("div", { class: "warn" },
      `⚠ 최근 ${CONFLICT_MIN}분 안에 다른 상태 제보가 ${a.conflicts}건 있어요.`));
    if (a.doubtful) box.appendChild(el("div", { class: "warn" },
      `⚠ ${a.latest.disputes}명이 "아닌 것 같아요"라고 했어요. 믿기 어려운 정보예요.`));
    else if (a.latest.disputes > 0) box.appendChild(el("div", { class: "warn soft" },
      `${a.latest.disputes}명이 "아닌 것 같아요"라고 했어요.`));

    if (canWrite()) box.appendChild(voteButtons(a.latest));
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

// 내가 올린 제보 (내 제보에는 의견을 못 남기게 화면에서 미리 막음, 실제로는 규칙이 막음)
function myReportIds() {
  try { return JSON.parse(localStorage.getItem("myReports:" + (auth.info ? auth.info.id : "local")) || "[]"); }
  catch (e) { return []; }
}
function rememberMyReport(id) {
  try { localStorage.setItem("myReports:" + (auth.info ? auth.info.id : "local"), JSON.stringify([...myReportIds(), id].slice(-200))); }
  catch (e) {}
}

// 제보에 대한 의견 버튼 (한 사람당 한 번)
function voteButtons(rep) {
  const wrap = el("div", { class: "vote-row" });
  if (myReportIds().includes(rep.id)) {
    wrap.appendChild(el("span", { class: "voted" }, "✏️ 내가 올린 제보예요 (내 제보에는 의견을 남길 수 없어요)"));
    return wrap;
  }
  const mine = state.myVotes[rep.id];
  if (mine) {
    wrap.appendChild(el("span", { class: "voted" },
      mine === "confirm" ? "👍 '지금도 맞아요'를 남겼어요" : "👎 '아닌 것 같아요'를 남겼어요"));
    return wrap;
  }
  const make = (type, text) => {
    const b = el("button", {}, text);
    b.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach((x) => { x.disabled = true; });
      store.vote(rep.id, type)
        .then(() => {
          state.myVotes[rep.id] = type;
          showToast(type === "confirm" ? "확인해 주셔서 고마워요!" : "의견을 남겼어요. 맞는 상태를 새로 알려 주면 더 좋아요.");
          renderPanel();
        })
        .catch((e) => {
          showToast(e.message, true);
          if (e.message.includes("이미")) { state.myVotes[rep.id] = type; renderPanel(); }
          else wrap.querySelectorAll("button").forEach((x) => { x.disabled = false; });
        });
    });
    return b;
  };
  wrap.append(make("confirm", "👍 지금도 맞아요"), make("dispute", "👎 아닌 것 같아요"));
  return wrap;
}

function buildForm(room) {
  const form = el("div", { class: "form" });
  form.appendChild(el("h3", {}, "상태 알리기"));
  if (!canWrite()) {
    const b = el("button", { class: "primary" }, "로그인하고 상태 알리기");
    b.addEventListener("click", showLoginModal);
    form.appendChild(b);
    return form;
  }

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
    if (checked.value === "other" && !ta.value.trim()) { showToast("'기타'는 어떤 상황인지 설명을 꼭 적어 주세요.", true); ta.focus(); return; }
    const note = ta.value.trim().slice(0, NOTE_MAX);

    btn.disabled = true;
    btn.textContent = "등록 중...";
    store.add({ spaceId: room.id, status: checked.value, note })
      .then((id) => {
        if (id) rememberMyReport(id);
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

// ----- 8-1. 시간표 화면: 공간 ↔ 수업 ↔ 선생님 ↔ 학생 을 서로 링크로 연결 -----
const PERSON_LABEL = { teacher: "선생님", student: "학생", class: "1학년 반", session: "수업" };
const WEEKDAYS = ["월", "화", "수", "목", "금"];

// 누르면 이동하는 글자
function link(text, onClick, cls = "tt-link") {
  const a = el("a", { class: cls, href: "#" }, text);
  a.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
  return a;
}
function personLink(kind, id, label) { return link(label || id, () => openPerson(kind, id)); }
function sessionLink(x) { return link(x.title, () => openPerson("session", sessionId(x)), "tt-link strong"); }
function roomLink(text) {
  if (!text) return el("span", { class: "tt-sub" }, "교실 미정");
  const r = resolveRoom(text);
  if (!r) return el("span", { class: "tt-sub" }, text);
  return link("📍" + roomLabel(r), () => goToRoom(r.id), "tt-room");
}
function roomLabel(r) { return /^\d/.test(r.name) ? `${buildingById(r.building).name} ${r.name}` : r.name; }
function teacherLinks(x) {
  const span = el("span", { class: "tt-sub" });
  x.teachers.forEach((t, i) => {
    if (i) span.appendChild(document.createTextNode(", "));
    span.appendChild(t === "원어민" ? document.createTextNode(t) : personLink("teacher", t, t));
  });
  return span;
}
// 사이에 " · " 를 넣어 이어 붙이기
function joinParts(parent, parts) {
  parts.filter(Boolean).forEach((p, i) => {
    if (i) parent.appendChild(el("span", { class: "tt-sep" }, " · "));
    parent.appendChild(p);
  });
  return parent;
}
// 수업 한 줄: 수업 · 선생님 · 교실 (보여 줄 것만)
function sessionLine(x, { teacher = true, room = true } = {}) {
  return joinParts(el("div", { class: "tt-line" }), [
    sessionLink(x), teacher && x.teachers.length ? teacherLinks(x) : null, room ? roomLink(x.room) : null
  ]);
}

// 요일 탭
function viewDay(slot) { return state.viewDay || (WEEKDAYS.includes(slot.day) ? slot.day : "월"); }
function dayTabs(slot) {
  const box = el("div", { class: "day-tabs" });
  const cur = viewDay(slot);
  WEEKDAYS.forEach((d) => {
    const b = el("button", { class: d === cur ? "on" : "" }, d);
    b.addEventListener("click", () => { state.viewDay = d; renderPanel(); });
    box.appendChild(b);
  });
  return box;
}
function slotOn(slot, day, period) {
  return { day, period, date: dateOfWeekday(slot.date, day), inClass: true };
}
// 요일별 시간표 표: rowFn(slot) → 그 교시 칸에 넣을 요소(없으면 null)
function weekTable(slot, title, rowFn) {
  const wrap = el("div", { class: "history" });
  wrap.appendChild(el("h3", {}, title));
  wrap.appendChild(dayTabs(slot));
  const day = viewDay(slot);
  TIMETABLE.periods.forEach((p) => {
    const isNow = slot.inClass && slot.day === day && slot.period === p.p;
    const row = el("div", { class: "tt-row" + (isNow ? " now" : "") });
    row.appendChild(el("span", { class: "tt-p" }, p.p + "교시"));
    const cell = rowFn(slotOn(slot, day, p.p));
    row.appendChild(cell || el("span", { class: "tt-empty" }, "—"));
    wrap.appendChild(row);
  });
  return wrap;
}

// ===== 공간을 눌렀을 때 =====
function roomScheduleBox(room) {
  const slot = currentSlot(state.timeOverride);
  const frag = el("div");
  const box = el("div", { class: "tt-box" });
  box.appendChild(el("div", { class: "tt-head" }, "🕒 " + slot.label));
  if (slot.inClass) {
    const { list, study } = roomAt(room.id, slot);
    if (list.length) list.forEach((x) => {
      box.appendChild(sessionLine(x, { room: false }));
      box.appendChild(studentsLine(x));
    });
    else if (study) box.appendChild(el("div", { class: "tt-line" }, `공강 자습실 (${study.ids.length}명)`));
    else box.appendChild(el("div", { class: "tt-empty" }, "지금 이 공간에서 하는 수업이 없어요."));
  }
  frag.appendChild(box);
  frag.appendChild(weekTable(slot, "이 공간 시간표", (sl) => {
    const { list, study } = roomAt(room.id, sl);
    if (!list.length && !study) return null;
    const cell = el("span", { class: "tt-cell" });
    list.forEach((x, i) => {
      if (i) cell.appendChild(el("br"));
      joinParts(cell, [sessionLink(x), x.teachers.length ? teacherLinks(x) : null]);
    });
    if (!list.length && study) cell.appendChild(document.createTextNode(`공강 자습 (${study.ids.length}명)`));
    return cell;
  }));
  return frag;
}
// 기숙사 방: 사는 학생 (로그인한 사람만 받는 비공개 데이터)
function dormBox(room) {
  const box = el("div", { class: "tt-box" });
  box.appendChild(el("div", { class: "tt-head" }, "🛏 이 방 학생"));
  // 방 배정은 비공개 데이터라 로그인해야 받을 수 있음
  if (!HAS_TT) {
    box.appendChild(el("div", { class: "tt-empty" }, "로그인하면 이 방에 사는 학생을 볼 수 있어요."));
    if (store.mode === "firebase") box.appendChild(link("로그인하기", showLoginModal));
    return box;
  }
  if (!TIMETABLE.dorm) {
    box.appendChild(el("div", { class: "tt-empty" },
      "기숙사 배정 데이터가 아직 없어요. 관리자 페이지에서 최신 timetable-data.json을 다시 올려 주세요."));
    return box;
  }
  const occ = TT.dorm[room.id] || [];
  if (!occ.length) box.appendChild(el("div", { class: "tt-empty" }, "배정 정보가 없어요. (지금은 2학년만 있어요)"));
  occ.forEach(([id, name]) => {
    // 학번이 없는 학생(예: 복학생)은 이름으로 찾음
    const key = id || (TT.students.some((x) => !x.id && x.name === name) ? name : "");
    const line = el("div", { class: "tt-line" });
    line.appendChild(key ? personLink("student", key, id ? `${name} (${showId(id)})` : name)
                         : el("span", {}, name + " (학번 확인 필요)"));
    box.appendChild(line);
  });
  return box;
}

// "학생 23명" → 누르면 그 수업 화면
function studentsLine(x) {
  const n = (TT.studentsOf[sessionId(x)] || []).length;
  const line = el("div", { class: "tt-line tt-sub" });
  if (n) line.appendChild(link(`👥 학생 ${n}명 보기`, () => openPerson("session", sessionId(x))));
  else if (/^1-\d반$/.test(x.group)) line.appendChild(personLink("class", x.group, `👥 ${x.group} 시간표`));
  return line;
}

// ===== 선생님 / 학생 / 반 / 수업을 열 때 =====
function openPerson(kind, id) {
  state.person = { kind, id };
  state.selectedId = null;
  state.highlightId = null;
  // 지금 있는 교실을 알면 지도에서 그 층으로 이동해서 강조
  const slot = currentSlot(state.timeOverride);
  const roomText = kind === "session" ? findSession(id).room : personNow(kind, id, slot).room;
  const r = roomText ? resolveRoom(roomText) : null;
  if (r) {
    state.view = "building"; state.buildingId = r.building; state.floor = r.floor; state.highlightId = r.id;
  }
  renderAll();
}

function findStudent(id) { return TT.students.find((s) => (s.id || s.name) === id); }

// 그 시간에 어디서 무엇을 하는지 → { text, sessions, room }
function personNow(kind, id, slot) {
  if (!slot.inClass) return { text: slot.label, sessions: [], room: null };
  if (kind === "teacher" || kind === "class") {
    const list = kind === "teacher" ? teacherAt(id, slot) : classAt(id, slot);
    return list.length ? { sessions: list, room: list[0].room } : { text: "수업 없음", sessions: [], room: null };
  }
  const v = studentAt(findStudent(id), slot);
  if (v.kind === "class") return { sessions: v.sessions, room: v.sessions[0].room };
  if (v.kind === "study") return { text: v.text || "공강 · 자습", sessions: [], room: v.room || null };
  if (v.kind === "activity") return { text: v.activity, sessions: [], room: null };
  return { text: "수업 없음", sessions: [], room: null };
}

function renderPersonPanel(panel) {
  const { kind, id } = state.person;
  if (kind === "session") return renderSessionPanel(panel, findSession(id));
  const slot = currentSlot(state.timeOverride);
  const st = kind === "student" ? findStudent(id) : null;
  panel.appendChild(el("h2", {}, kind === "teacher" ? `${id} 선생님` : st ? st.name : id));
  const meta = st && st.id ? `${st.id[0]}학년 학생 · ${showId(st.id)}`
    : kind === "teacher" ? `담당 수업 주 ${(TT.teachers[id] || []).length}시간` : PERSON_LABEL[kind];
  panel.appendChild(el("div", { class: "meta" }, meta));
  if (st && TT.dormOf[st.id]) {
    const r = roomById(TT.dormOf[st.id]);
    if (r) panel.appendChild(joinParts(el("div", { class: "tt-line dorm-line" }),
      [document.createTextNode("🛏 기숙사"), link(`${buildingById(r.building).name} ${r.name}`, () => goToRoom(r.id), "tt-room")]));
  }

  // 지금
  const box = el("div", { class: "tt-box" });
  box.appendChild(el("div", { class: "tt-head" }, "🕒 " + slot.label));
  if (slot.inClass) {
    const now = personNow(kind, id, slot);
    if (now.sessions.length) now.sessions.forEach((x) => {
      box.appendChild(sessionLine(x, { teacher: kind !== "teacher" }));
      if (kind === "teacher") box.appendChild(studentsLine(x));
    });
    else box.appendChild(joinParts(el("div", { class: "tt-line" }),
      [el("b", {}, now.text), now.room ? roomLink(now.room) : null]));
  }
  panel.appendChild(box);

  // 요일별 시간표
  panel.appendChild(weekTable(slot, "시간표", (sl) => {
    const v = personNow(kind, id, sl);
    const cell = el("span", { class: "tt-cell" });
    if (v.sessions.length) {
      v.sessions.forEach((x, i) => {
        if (i) cell.appendChild(el("br"));
        joinParts(cell, [sessionLink(x), kind !== "teacher" && x.teachers.length ? teacherLinks(x) : null, roomLink(x.room)]);
      });
      return cell;
    }
    if (v.text === "수업 없음") return null;
    joinParts(cell, [document.createTextNode(v.text), v.room ? roomLink(v.room) : null]);
    return cell;
  }));
}

// ===== 수업을 눌렀을 때: 언제 · 어디서 · 누가 가르치고 · 누가 듣는지 =====
function renderSessionPanel(panel, x) {
  panel.appendChild(el("h2", {}, x.title));
  const p = TIMETABLE.periods.find((q) => q.p === x.period);
  const when = x.date ? `${mdLabel(x.date, x.day || DAY_NAMES[new Date(x.date + "T00:00").getDay()])}` : `매주 ${x.day}요일`;
  panel.appendChild(el("div", { class: "meta" }, `${when} ${x.period}교시 (${p.start}~${p.end}) · ${x.group}`));

  const box = el("div", { class: "tt-box" });
  box.appendChild(joinParts(el("div", { class: "tt-line" }), [el("b", {}, "장소"), roomLink(x.room)]));
  if (x.teachers.length) box.appendChild(joinParts(el("div", { class: "tt-line" }), [el("b", {}, "선생님"), teacherLinks(x)]));
  panel.appendChild(box);

  // 같은 수업의 다른 시간
  const order = (y) => y.date ? y.date + y.period : WEEKDAYS.indexOf(y.day) * 10 + y.period;
  const same = (x.date ? TT.extra : TT.sessions).filter((y) => y.title === x.title && y !== x)
    .sort((a, b) => (order(a) > order(b) ? 1 : -1));
  if (same.length) {
    const other = el("div", { class: "history" });
    other.appendChild(el("h3", {}, "같은 수업의 다른 시간"));
    same.forEach((y) => {
      const row = el("div", { class: "tt-row" });
      row.appendChild(el("span", { class: "tt-p wide" }, y.date ? `${mdLabel(y.date, DAY_NAMES[new Date(y.date + "T00:00").getDay()])} ${y.period}교시` : `${y.day} ${y.period}교시`));
      row.appendChild(joinParts(el("span", { class: "tt-cell" }), [link("열기", () => openPerson("session", sessionId(y))), teacherLinks(y), roomLink(y.room)]));
      other.appendChild(row);
    });
    panel.appendChild(other);
  }

  // 듣는 학생
  const list = TT.studentsOf[sessionId(x)] || [];
  const stu = el("div", { class: "history" });
  if (list.length) {
    stu.appendChild(el("h3", {}, `듣는 학생 ${list.length}명`));
    const grid = el("div", { class: "stu-grid" });
    [...list].sort((a, b) => (a.id || "").localeCompare(b.id || "")).forEach((s) =>
      grid.appendChild(personLink("student", s.id || s.name, s.name)));
    stu.appendChild(grid);
  } else if (/^1-\d반$/.test(x.group)) {
    stu.appendChild(el("h3", {}, "듣는 학생"));
    stu.appendChild(personLink("class", x.group, `${x.group} 전체 (반 시간표 보기)`));
  }
  panel.appendChild(stu);
}

// 시간 바꿔보기 (테스트·발표용): 날짜와 교시를 고르면 그 시간 기준으로 보여 줌
function setupTimeBox() {
  const box = $("timeBox");
  box.innerHTML = "";
  state.timeOverride = null;
  if (!HAS_TT) return;
  const mode = el("select", { title: "기준 시간" });
  mode.appendChild(el("option", { value: "" }, "🕒 지금"));
  mode.appendChild(el("option", { value: "pick" }, "📅 날짜 선택"));
  const dateIn = el("input", { type: "date", class: "hidden", value: ymd(new Date()) });
  const perSel = el("select", { title: "교시", class: "hidden" });
  TIMETABLE.periods.forEach((p) => perSel.appendChild(el("option", { value: p.p }, p.p + "교시")));
  const apply = () => {
    const pick = mode.value === "pick" && dateIn.value;
    state.timeOverride = pick ? { date: dateIn.value, period: Number(perSel.value) } : null;
    state.viewDay = null;   // 기준 시간을 바꾸면 그 날 요일 탭으로
    dateIn.classList.toggle("hidden", mode.value !== "pick");
    perSel.classList.toggle("hidden", mode.value !== "pick");
    if (state.person) openPerson(state.person.kind, state.person.id); else renderAll();
  };
  [mode, dateIn, perSel].forEach((x) => x.addEventListener("change", apply));
  box.append(mode, dateIn, perSel);
}

// ===== 로그인한 사람의 "오늘 내 일정" =====
function myPerson() {
  if (!HAS_TT || !auth.info) return null;
  if (auth.info.kind === "student" && findStudent(auth.info.id)) return { kind: "student", id: auth.info.id };
  if (auth.info.kind === "teacher") {
    const n = decodeTeacher(auth.info.id);
    if (TT.teachers[n] || TT.teacherExtra[n]) return { kind: "teacher", id: n };
  }
  return null;
}
function goHome() {
  state.person = null; state.selectedId = null; state.highlightId = null;
  renderAll();
}
// 그 교시에 할 일을 한 줄로 (수업이면 수업·선생님·교실, 아니면 공강·활동)
function planLine(me, sl) {
  const v = personNow(me.kind, me.id, sl);
  const line = el("div", { class: "tt-line" });
  if (v.sessions.length) {
    v.sessions.forEach((x, i) => {
      if (i) line.appendChild(el("br"));
      joinParts(line, [sessionLink(x), me.kind !== "teacher" && x.teachers.length ? teacherLinks(x) : null, roomLink(x.room)]);
    });
    return { line, has: true, room: v.room };
  }
  if (v.text === "수업 없음") return { line: null, has: false };
  joinParts(line, [el("b", {}, v.text), v.room ? roomLink(v.room) : null]);
  return { line, has: true, room: v.room };
}
function renderMyHome(panel) {
  const me = myPerson();
  const slot = currentSlot(state.timeOverride);
  const box = el("div", { class: "my-box" });
  box.appendChild(el("h2", {}, "📌 오늘 내 일정"));
  box.appendChild(el("div", { class: "tt-head" }, "🕒 " + slot.label));

  // 오늘 학사일정
  const today = eventsOn(slot.date);
  if (today.length) box.appendChild(el("div", { class: "today-ev" }, "📅 오늘: " + today.map((e) => e.title).join(", ")));
  if (today.some((e) => e.kind === "exam"))
    box.appendChild(el("div", { class: "warn soft" }, "정기시험 기간이라 실제 일정은 시간표와 다를 수 있어요."));

  const weekday = WEEKDAYS.includes(slot.day) && !slot.holiday;
  if (weekday) {
    // 지금
    if (slot.inClass) {
      box.appendChild(el("div", { class: "my-sec" }, `지금 · ${slot.period}교시`));
      const now = planLine(me, slot);
      box.appendChild(now.line || el("div", { class: "tt-empty" }, "지금은 수업이 없어요."));
    }
    // 다음 (지금보다 뒤에 시작하는 교시 중 할 일이 있는 첫 교시)
    const later = TIMETABLE.periods.filter((p) => toMin(p.start) > slot.min);
    let next = null;
    for (const p of later) {
      const r = planLine(me, { ...slot, period: p.p, inClass: true });
      if (r.has) { next = { p, r }; break; }
    }
    if (next) {
      const mins = toMin(next.p.start) - slot.min;
      const when = mins >= 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분 후` : `${mins}분 후`;
      box.appendChild(el("div", { class: "my-sec" }, `다음 · ${next.p.p}교시 ${next.p.start} (${when})`));
      box.appendChild(next.r.line);
    } else if (!slot.inClass || later.length) {
      box.appendChild(el("div", { class: "my-sec" }, "다음"));
      box.appendChild(el("div", { class: "tt-empty" }, "오늘 남은 수업이 없어요."));
    }
    // 오늘 남은 수업 수
    const left = later.filter((p) => planLine(me, { ...slot, period: p.p, inClass: true }).has).length;
    if (left > 1) box.appendChild(link(`오늘 남은 일정 ${left}개 모두 보기 →`, () => openPerson(me.kind, me.id)));
  } else {
    box.appendChild(el("div", { class: "tt-empty" }, slot.holiday ? `${slot.holiday}이라 수업이 없어요.` : "오늘은 수업이 없어요."));
  }
  // 기숙사
  if (me.kind === "student" && TT.dormOf[me.id]) {
    const r = roomById(TT.dormOf[me.id]);
    if (r) box.appendChild(joinParts(el("div", { class: "tt-line dorm-line2" }),
      [document.createTextNode("🛏 내 방"), link(`${buildingById(r.building).name} ${r.name}`, () => goToRoom(r.id), "tt-room")]));
  }
  box.appendChild(link("내 시간표 전체 보기 →", () => openPerson(me.kind, me.id)));
  panel.appendChild(box);
  renderTasks(panel);   // 📝 과제 · 할 일 (classroom.js)
}

// 다가오는 학사일정 (2주) + 시험 D-day
function renderUpcoming(panel, showToday) {
  if (typeof CALENDAR !== "object" || typeof TIMETABLE === "undefined") return;
  const slot = HAS_TT ? currentSlot(state.timeOverride) : { date: ymd(new Date()) };
  const box = el("div", { class: "history" });
  box.appendChild(el("h3", {}, "📅 다가오는 학사일정"));
  // 60일 안의 시험은 D-day로
  CALENDAR.events.filter((e) => e.kind === "exam" && e.date > slot.date && daysBetween(slot.date, e.date) <= 60)
    .forEach((e) => box.appendChild(el("div", { class: "dday" }, `${e.title} D-${daysBetween(slot.date, e.date)}`)));
  if (showToday) {
    const today = eventsOn(slot.date);
    if (today.length) box.appendChild(el("div", { class: "today-ev" }, "오늘: " + today.map((e) => e.title).join(", ")));
  }
  const list = upcomingEvents(slot.date, 14);
  if (!list.length) box.appendChild(el("div", { class: "tt-empty" }, "2주 안에 일정이 없어요."));
  list.forEach((e) => {
    const row = el("div", { class: "tt-row" });
    const dn = DAY_NAMES[new Date(e.date + "T00:00").getDay()];
    row.appendChild(el("span", { class: "tt-p wide" }, `${mdLabel(e.date, dn)}`));
    const end = e.end ? ` (~${Number(e.end.slice(5, 7))}/${Number(e.end.slice(8))})` : "";
    row.appendChild(el("span", { class: "ev-" + e.kind }, e.title + end));
    box.appendChild(row);
  });
  panel.appendChild(box);
}

// 🏆 제보 랭킹 (관리자 페이지가 계산해서 올려 둔 private/ranking)
function renderRanking(panel) {
  const rk = state.ranking;
  const box = el("div", { class: "history" });
  box.appendChild(el("h3", {}, `🏆 믿을 만한 제보 랭킹 (최근 ${rk.days}일)`));
  const medal = ["🥇", "🥈", "🥉"];
  const rows = rk.rows.filter((r) => r.score > 0);
  if (!rows.length) box.appendChild(el("div", { class: "tt-empty" }, "아직 순위가 없어요. 제보에 👍를 받으면 점수가 올라가요."));
  rows.slice(0, 5).forEach((r, i) => box.appendChild(rankRow(r, medal[i] || `${i + 1}위`)));
  const myIdx = auth.info ? rows.findIndex((r) => r.id === auth.info.id) : -1;
  if (myIdx >= 5) { box.appendChild(el("div", { class: "tt-empty" }, "⋯")); box.appendChild(rankRow(rows[myIdx], `${myIdx + 1}위`, true)); }
  else if (auth.info && myIdx < 0) box.appendChild(el("div", { class: "tt-empty" }, "나는 아직 순위에 없어요."));
  box.appendChild(el("div", { class: "tt-note" },
    `점수 = 확인된 제보×3 + 받은 👍 − 받은 👎×2 · 확인된 제보: 👍가 👎보다 많은 제보 · 갱신 ${rk.updated || ""}`));
  panel.appendChild(box);
}
function rankRow(r, rank, me) {
  const row = el("div", { class: "tt-row rank" + (me || (auth.info && r.id === auth.info.id) ? " now" : "") });
  row.appendChild(el("span", { class: "tt-p" }, rank));
  row.appendChild(el("span", { class: "rk-name" }, r.name));
  row.appendChild(el("span", { class: "rk-num" }, `확인 ${r.confirmed} · 👍${r.up} 👎${r.down} · ${r.score}점`));
  return row;
}

// 상태 등록·확인은 로그인한 사람만 (로컬 테스트 모드는 예외)
function canWrite() { return store.mode !== "firebase" || !!auth.user; }

// ----- 9. 이동 -----
function openBuilding(id) {
  const b = buildingById(id);
  state.view = "building";
  state.buildingId = id;
  state.floor = b.floors[0];
  state.selectedId = null;
  state.person = null;
  state.highlightId = null;
  renderAll();
}
function selectRoom(id) { state.selectedId = id; state.person = null; state.highlightId = null; renderAll(); }
function goToRoom(id) {
  const room = roomById(id);
  state.view = "building";
  state.buildingId = room.building;
  state.floor = room.floor;
  state.selectedId = id;
  state.person = null;
  state.highlightId = null;
  renderAll();
}
function goCampus() {
  state.view = "campus";
  state.buildingId = null;
  state.selectedId = null;
  state.person = null;
  state.highlightId = null;
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
  ttSearchItems().forEach((it) => {
    const s = score(it.keys.filter(Boolean));
    if (s) results.push({ ...it, s });
  });
  return results.sort((a, b) => b.s - a.s).slice(0, 10);
}

function setupSearch() {
  const input = $("search");
  const ul = $("searchResults");
  let current = [];

  const choose = (item) => {
    ul.classList.add("hidden");
    input.value = item.name;
    if (item.kind === "room") goToRoom(item.id);
    else if (item.kind === "building") openBuilding(item.id);
    else openPerson(item.kind, item.id);
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
  if (store.mode !== "firebase") console.log("로컬 테스트 모드: 제보가 이 브라우저에만 저장돼요.");

  $("backBtn").addEventListener("click", goCampus);
  setupSearch();
  setupEditMode();
  renderLegend();
  setupTimeBox();
  setupAuth();

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
