// =============================================================
//  시간표 계산 (화면과 관계없는 순수 계산만 모아 둔 파일)
//  - 지금이 몇 요일 몇 교시인지
//  - 어떤 교실/선생님/학생/반이 지금 무슨 수업인지
// =============================================================

// 시간표는 로그인한 뒤에 Firestore에서 받아 loadTimetable()로 넣음
let TIMETABLE = null;
let HAS_TT = false;
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
const ttNorm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
const toMin = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };

// ----- 1. 데이터 정리 (배열 → 객체, 찾기 쉽게 색인) -----
let TT = emptyTT();
function emptyTT() {
  return { sessions: [], bySlot: {}, teachers: {}, students: [], classes: {}, freeBySlot: {},
           extra: [], extraBySlot: {}, teacherExtra: {}, dorm: {}, dormOf: {} };
}

function loadTimetable(data) {
  TIMETABLE = data;
  TT = emptyTT();
  TT.sessions = data.sessions.map(([day, period, title, group, teachers, room], i) =>
    ({ i, day, period, title, group, teachers, room }));
  TT.sessions.forEach((s) => {
    (TT.bySlot[`${s.day}-${s.period}`] ||= []).push(s);
    s.teachers.forEach((t) => (TT.teachers[t] ||= []).push(s));
    if (/^1-\d반$/.test(s.group)) (TT.classes[s.group] ||= []).push(s);
  });
  // 방과후: 특정 날짜에만 있는 수업
  TT.extra = (data.extra || []).map(([date, period, title, group, teachers, room], i) =>
    ({ i, date, period, title, group, teachers, room }));
  TT.extra.forEach((e) => {
    (TT.extraBySlot[`${e.date}-${e.period}`] ||= []).push(e);
    e.teachers.forEach((t) => (TT.teacherExtra[t] ||= []).push(e));
  });
  TT.students = data.students.map(([id, name, idx, eidx, personal]) =>
    ({ id, name, sessions: idx.map((n) => TT.sessions[n]), extra: (eidx || []).map((n) => TT.extra[n]),
       personal: (personal || []).map(([day, period, text, room]) => ({ day, period, text, room })) }));
  data.free.forEach((f) => { TT.freeBySlot[`${f.day}-${f.period}`] = f; });
  // 수업 → 듣는 학생 (수업을 누르면 학생 목록을 보여 주려고)
  TT.studentsOf = {};
  TT.students.forEach((st) => [...st.sessions, ...st.extra].forEach((x) =>
    (TT.studentsOf[sessionId(x)] ||= []).push(st)));
  // 기숙사 방 배정: 방 id → [[학번, 이름]], 학번 → 방 id
  TT.dorm = data.dorm || {};
  TT.dormOf = {};
  Object.entries(TT.dorm).forEach(([room, occ]) => occ.forEach(([id]) => { if (id) TT.dormOf[id] = room; }));
  HAS_TT = true;
}

// 수업 id: 정규 수업 "s12", 방과후 "x3"
function sessionId(x) { return (x.date ? "x" : "s") + x.i; }
function findSession(id) {
  const n = Number(id.slice(1));
  return id[0] === "x" ? TT.extra[n] : TT.sessions[n];
}

function unloadTimetable() {   // 로그아웃하면 메모리에서 지움
  TIMETABLE = null; TT = emptyTT(); HAS_TT = false;
}

// ----- 2. 지금 시각 → 요일·교시 -----
// 날짜 → "2026-11-20" (방과후는 날짜로 찾음)
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mdLabel = (date, day) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${day})`;

// override: { date: "2026-11-05", period: 8 } 이면 그 시간으로 가정 (테스트용)
function currentSlot(override) {
  if (override) {
    const [y, m, d] = override.date.split("-").map(Number);
    const day = DAY_NAMES[new Date(y, m - 1, d).getDay()];
    const p = TIMETABLE.periods.find((x) => x.p === override.period);
    if (day === "토" || day === "일")
      return { day, date: override.date, period: null, inClass: false, label: `${mdLabel(override.date, day)} 주말이라 수업이 없어요` };
    return { day, date: override.date, period: override.period, inClass: true,
             label: `${mdLabel(override.date, day)} ${override.period}교시 (${p.start}~${p.end}) · 시간 바꿔보기 중` };
  }
  const now = new Date();
  const day = DAY_NAMES[now.getDay()];
  const date = ymd(now);
  const t = now.getHours() * 60 + now.getMinutes();
  if (day === "토" || day === "일") return { day, date, period: null, inClass: false, label: `${mdLabel(date, day)} 주말이라 수업이 없어요` };

  const ps = TIMETABLE.periods;
  const cur = ps.find((p) => toMin(p.start) <= t && t < toMin(p.end));
  if (cur) return { day, date, period: cur.p, inClass: true, label: `${mdLabel(date, day)} ${cur.p}교시 (${cur.start}~${cur.end})` };

  // 점심·저녁·야간 자습 시간
  const blk = (TIMETABLE.blocks || []).find((x) => toMin(x.start) <= t && t < toMin(x.end));
  if (blk) return { day, date, period: null, inClass: false, label: `${mdLabel(date, day)} · ${blk.name} (${blk.start}~${blk.end})` };

  if (t < toMin(ps[0].start))
    return { day, date, period: null, inClass: false, label: `${mdLabel(date, day)} · 수업 시작 전 (1교시 ${ps[0].start} 시작)` };

  // 다음 일정 (교시 또는 점심·야간 자습 중 가장 가까운 것)
  const upcoming = [...ps.map((p) => ({ name: p.p + "교시", start: p.start })),
                    ...(TIMETABLE.blocks || []).map((x) => ({ name: x.name, start: x.start }))]
    .filter((x) => t < toMin(x.start)).sort((a, b) => toMin(a.start) - toMin(b.start));
  if (!upcoming.length) return { day, date, period: null, inClass: false, label: `${mdLabel(date, day)} · 오늘 일과가 끝났어요` };
  return { day, date, period: null, inClass: false,
           label: `${mdLabel(date, day)} · 쉬는 시간 (다음 ${upcoming[0].name} ${upcoming[0].start} 시작)` };
}

// 같은 주의 다른 요일 날짜 (요일 탭에서 방과후를 찾을 때 씀)
function dateOfWeekday(baseDate, day) {
  const [y, m, d] = baseDate.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  base.setDate(base.getDate() + DAY_NAMES.indexOf(day) - base.getDay());
  return ymd(base);
}

// ----- 3. 시간표의 교실 이름 → 지도 공간 -----
// 예: "본408" → 본관 408, "303강의실" → 본관 303, "화학실험실1" → 과학동 화학 실험실1
const roomCache = {};
function resolveRoom(text) {
  if (!text) return null;
  if (text in roomCache) return roomCache[text];
  const t = ttNorm(text);
  let found = null, m;
  if ((m = t.match(/^본(\d{3})/)) || (m = t.match(/^(\d{3})(강의실|교실)?$/)))
    found = MAP_DATA.rooms.find((r) => r.building === "M" && r.name === m[1]);
  else if ((m = t.match(/^과(\d{3})/)))
    found = MAP_DATA.rooms.find((r) => r.building === "S" && r.name === "과" + m[1]);
  if (!found)
    found = MAP_DATA.rooms.find((r) => [r.name, ...(r.aliases || [])].some((n) => ttNorm(n) === t));
  return (roomCache[text] = found || null);
}

// ----- 4. 조회 함수 -----
// 교실: 그 시간에 그 교실에서 하는 수업들 (+ 공강 자습실이면 자습)
// slot = { day, date, period }
function sessionsAt(slot) {
  return [...(TT.bySlot[`${slot.day}-${slot.period}`] || []), ...(TT.extraBySlot[`${slot.date}-${slot.period}`] || [])];
}
function roomAt(spaceId, slot) {
  const { day, period } = slot;
  const list = sessionsAt(slot).filter((s) => resolveRoom(s.room)?.id === spaceId);
  const f = TT.freeBySlot[`${day}-${period}`];
  const study = f && f.ids.length && resolveRoom(f.room)?.id === spaceId ? f : null;
  return { list, study };
}

// 선생님: 그 시간에 맡은 수업들
function teacherAt(name, slot) {
  return [...(TT.teachers[name] || []).filter((s) => s.day === slot.day && s.period === slot.period),
          ...(TT.teacherExtra[name] || []).filter((e) => e.date === slot.date && e.period === slot.period)];
}

// 학생: 그 시간에 듣는 수업, 없으면 공강 자습실/전체 활동/수업 없음
function studentAt(stu, slot) {
  const { day, period } = slot;
  const list = [...stu.sessions.filter((x) => x.day === day && x.period === period),
                ...stu.extra.filter((e) => e.date === slot.date && e.period === period)];
  if (list.length) return { kind: "class", sessions: list };
  // 학생별 추가 일정 (예: 공강 자습실, 심화 R&E)
  const pe = stu.personal.find((x) => x.day === day && x.period === period);
  if (pe) return { kind: "study", text: pe.text, room: pe.room };
  const f = TT.freeBySlot[`${day}-${period}`];
  if (f && f.ids.includes(stu.id)) return { kind: "study", room: f.room };
  if (f && f.activity) return { kind: "activity", activity: f.activity };
  return { kind: "none" };
}

// 1학년 반: 그 시간의 수업
function classAt(group, slot) {
  return (TT.classes[group] || []).filter((s) => s.day === slot.day && s.period === slot.period);
}

// 하루 시간표 (교시 순서대로)
function dayRows(slot, fn) {
  return TIMETABLE.periods.map((p) => ({ period: p.p, time: p.start, value: fn({ ...slot, period: p.p, inClass: true }) }));
}

// ----- 5. 검색용 목록 -----
function ttSearchItems() {
  if (!HAS_TT) return [];
  const items = [];
  [...new Set([...Object.keys(TT.teachers), ...Object.keys(TT.teacherExtra)])].forEach((t) =>
    items.push({ kind: "teacher", id: t, name: t, sub: "선생님", keys: [t, t + "선생님", t + "쌤"] }));
  TT.students.forEach((s) =>
    items.push({ kind: "student", id: s.id || s.name, name: s.name,
                 sub: s.id ? `${s.id[0]}학년 학생 · ${s.id}` : "학생", keys: [s.name, s.id] }));
  Object.keys(TT.classes).forEach((c) =>
    items.push({ kind: "class", id: c, name: c, sub: "1학년 반 시간표", keys: [c, c.replace("반", "")] }));
  return items;
}
