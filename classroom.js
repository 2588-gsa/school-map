// =============================================================
//  과제: Google 클래스룸 연결 + 내 할 일 메모
//  - 클래스룸: 각자 자기 학교 구글 계정으로 "읽기만" 허락 → 내 수업의 과제·마감일을 가져옴
//    (과제 정보는 이 브라우저에서만 쓰고 서버에 저장하지 않음)
//  - 내 할 일: 직접 적는 메모. Firestore userData/{내 아이디} 에 저장 (나만 읽고 쓸 수 있음)
// =============================================================

const CLASSROOM_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",        // 내 수업 목록
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly"   // 내 과제와 제출 상태
].join(" ");
const CR_API = "https://classroom.googleapis.com/v1";
const CR_KEY = "classroomToken";
const TODO_MAX = 100;

const tasks = {
  crToken: null,        // { token, exp }
  crItems: null,        // 클래스룸 과제 목록 (불러오기 전 null)
  crError: "",
  crLoading: false,
  todos: [],            // 내 할 일 [{ id, title, due, done }]
  showDone: false
};
const crEnabled = () => typeof GOOGLE_CLIENT_ID === "string" && GOOGLE_CLIENT_ID.endsWith(".apps.googleusercontent.com");

// ----- 1. 클래스룸 로그인 (Google Identity Services) -----
let tokenClient = null;
function crTokenClient() {
  if (tokenClient || typeof google === "undefined" || !google.accounts) return tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: CLASSROOM_SCOPES,
    callback: (resp) => {
      clearTimeout(crWaitTimer);
      if (resp.error) { console.error("[클래스룸] 오류", resp); tasks.crError = crErrorText(resp.error); tasks.crLoading = false; renderPanel(); return; }
      tasks.crToken = { token: resp.access_token, exp: Date.now() + (resp.expires_in - 60) * 1000 };
      try { sessionStorage.setItem(CR_KEY, JSON.stringify(tasks.crToken)); } catch (e) {}
      loadClassroom();
    },
    error_callback: (err) => {   // 창을 닫았거나 팝업이 막힘
      console.error("[클래스룸] 창 오류", err);
      clearTimeout(crWaitTimer);
      tasks.crLoading = false;
      tasks.crError = err && err.type === "popup_failed_to_open" ? "팝업이 막혔어요. 브라우저에서 팝업을 허용해 주세요." : "";
      renderPanel();
    }
  });
  return tokenClient;
}
function crErrorText(code) {
  if (code === "access_denied") return "연결을 허락하지 않았어요.";
  return "연결 실패: " + code;
}
let crWaitTimer = null;
function connectClassroom() {
  let tc = null;
  try { tc = crTokenClient(); } catch (e) { console.error("[클래스룸] 준비 실패", e); }
  if (!tc) {
    tasks.crError = typeof google === "undefined"
      ? "Google 로그인 도구를 불러오지 못했어요. 광고 차단 확장 프로그램을 끄거나 새로고침해 보세요."
      : "Google 로그인 준비에 실패했어요. google-config.js의 클라이언트 ID를 확인해 주세요.";
    renderPanel(); return;
  }
  tasks.crError = ""; tasks.crLoading = true; renderPanel();
  try { tc.requestAccessToken({ prompt: tasks.crToken ? "" : "consent" }); }
  catch (e) { console.error("[클래스룸] 요청 실패", e); tasks.crLoading = false; tasks.crError = "연결 요청 실패: " + e.message; renderPanel(); return; }
  // 구글 창에서 아무 응답이 없으면 2분 뒤 풀어 줌
  clearTimeout(crWaitTimer);
  crWaitTimer = setTimeout(() => {
    if (tasks.crLoading && !tasks.crToken) {
      tasks.crLoading = false;
      tasks.crError = "구글 창에서 응답이 없어요. 창이 뒤에 숨어 있거나 팝업이 막혔는지 확인하고 다시 눌러 주세요.";
      renderPanel();
    }
  }, 120000);
}
function cancelClassroom() {
  clearTimeout(crWaitTimer);
  tasks.crLoading = false; tasks.crError = ""; renderPanel();
}
function disconnectClassroom() {
  if (tasks.crToken && typeof google !== "undefined") google.accounts.oauth2.revoke(tasks.crToken.token, () => {});
  tasks.crToken = null; tasks.crItems = null; tasks.crError = "";
  try { sessionStorage.removeItem(CR_KEY); } catch (e) {}
  renderPanel();
}

// ----- 2. 클래스룸 과제 불러오기 -----
async function crGet(path) {
  const r = await fetch(CR_API + path, { headers: { Authorization: "Bearer " + tasks.crToken.token } });
  if (r.status === 401) { const e = new Error("expired"); e.expired = true; throw e; }
  if (r.status === 403) {
    const body = await r.json().catch(() => ({}));
    const e = new Error((body.error && body.error.message) || "권한이 없어요.");
    e.forbidden = true; throw e;
  }
  if (!r.ok) throw new Error("클래스룸 응답 오류 " + r.status);
  return r.json();
}
// 페이지가 여러 장이면 끝까지
async function crList(path, key) {
  let out = [], token = "";
  do {
    const sep = path.includes("?") ? "&" : "?";
    const data = await crGet(path + (token ? `${sep}pageToken=${token}` : ""));
    out = out.concat(data[key] || []);
    token = data.nextPageToken || "";
  } while (token && out.length < 500);
  return out;
}
function dueOf(cw) {
  if (!cw.dueDate) return null;
  const { year, month, day } = cw.dueDate;
  const t = cw.dueTime || {};
  // 클래스룸 마감 시각은 UTC → 한국 시간으로 바뀌어 보이게 Date로 만듦
  return new Date(Date.UTC(year, month - 1, day, t.hours || 0, t.minutes || 0));
}
async function loadClassroom() {
  if (!tasks.crToken || Date.now() > tasks.crToken.exp) { tasks.crToken = null; renderPanel(); return; }
  tasks.crLoading = true; renderPanel();
  try {
    const courses = await crList("/courses?studentId=me&courseStates=ACTIVE&pageSize=50", "courses");
    const items = [];
    for (const c of courses) {
      const [works, subs] = await Promise.all([
        crList(`/courses/${c.id}/courseWork?courseWorkStates=PUBLISHED&orderBy=dueDate%20desc&pageSize=30`, "courseWork"),
        crList(`/courses/${c.id}/courseWork/-/studentSubmissions?userId=me&pageSize=100`, "studentSubmissions").catch(() => [])
      ]);
      const state = {};
      subs.forEach((s) => { state[s.courseWorkId] = s; });
      works.forEach((w) => {
        const due = dueOf(w);
        const sub = state[w.id];
        const done = !!sub && (sub.state === "TURNED_IN" || sub.state === "RETURNED");
        items.push({ id: "cr-" + w.id, title: w.title, course: c.name, due, done,
                     created: w.creationTime ? new Date(w.creationTime) : null,
                     late: !!(sub && sub.late), link: w.alternateLink, source: "classroom" });
      });
    }
    tasks.crItems = items;
    tasks.crError = "";
  } catch (e) {
    console.error("[클래스룸] 과제 불러오기 실패", e);
    if (e.expired) { tasks.crToken = null; tasks.crError = "연결이 만료됐어요. 다시 연결해 주세요."; }
    else if (e.forbidden) tasks.crError = "학교에서 이 앱의 클래스룸 접근을 막고 있어요. (" + e.message + ")";
    else tasks.crError = e.message;
  }
  tasks.crLoading = false;
  renderPanel();
}

// ----- 3. 내 할 일 (Firestore userData/{아이디}) -----
function todoDoc() {
  if (store.mode !== "firebase" || !auth.info) return null;
  return firebase.firestore().collection("userData").doc(auth.info.id);
}
async function loadTodos() {
  tasks.todos = [];
  try {
    const ref = todoDoc();
    if (ref) { const d = await ref.get(); tasks.todos = d.exists ? (d.data().todos || []) : []; }
    else tasks.todos = JSON.parse(localStorage.getItem("todos:local") || "[]");
  } catch (e) { tasks.todos = []; }
}
async function saveTodos() {
  const list = tasks.todos.slice(0, TODO_MAX);
  try {
    const ref = todoDoc();
    if (ref) await ref.set({ todos: list });
    else localStorage.setItem("todos:local", JSON.stringify(list));
  } catch (e) { showToast("할 일 저장 실패: " + e.message, true); }
}
function addTodo(title, due) {
  title = title.trim().slice(0, 100);
  if (!title) { showToast("할 일을 적어 주세요.", true); return false; }
  if (tasks.todos.length >= TODO_MAX) { showToast(`할 일은 ${TODO_MAX}개까지 적을 수 있어요.`, true); return false; }
  tasks.todos.push({ id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, due: due || "", done: false });
  saveTodos(); renderPanel();
  return true;
}
function toggleTodo(id) {
  const t = tasks.todos.find((x) => x.id === id);
  if (t) { t.done = !t.done; saveTodos(); renderPanel(); }
}
function removeTodo(id) {
  tasks.todos = tasks.todos.filter((x) => x.id !== id);
  saveTodos(); renderPanel();
}

// ----- 4. 화면: 과제·할 일 -----
function dueLabel(d) {
  if (!d) return { text: "마감 없음", cls: "" };
  const now = new Date();
  const days = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
                           new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (d < now) return { text: `${md} 마감 지남`, cls: "over" };
  if (days === 0) return { text: `오늘 ${hm}까지`, cls: "soon" };
  if (days === 1) return { text: `내일 ${hm}까지`, cls: "soon" };
  return { text: `${md} 마감 · D-${days}`, cls: days <= 3 ? "soon" : "" };
}
function todoDue(t) { return t.due ? new Date(t.due + "T23:59") : null; }

function renderTasks(panel) {
  const box = el("div", { class: "history task-box" });
  box.appendChild(el("h3", {}, "📝 과제 · 할 일"));

  // 클래스룸 연결 상태
  if (crEnabled()) {
    const bar = el("div", { class: "cr-bar" });
    if (tasks.crLoading) {
      bar.appendChild(el("span", { class: "tt-sub" }, tasks.crToken ? "클래스룸 과제를 불러오는 중..." : "구글 창에서 계정을 고르고 허용해 주세요..."));
      bar.appendChild(link("취소", cancelClassroom));
    }
    else if (tasks.crToken) {
      bar.appendChild(el("span", { class: "tt-sub" }, tasks.crError ? "🟡 연결은 됐지만 과제를 못 불러왔어요" : "🟢 클래스룸 연결됨"));
      bar.appendChild(link("새로고침", loadClassroom));
      bar.appendChild(link("연결 끊기", disconnectClassroom));
    } else {
      const b = el("button", { class: "cr-btn" }, "Google 클래스룸 연결");
      b.addEventListener("click", connectClassroom);
      bar.appendChild(b);
    }
    box.appendChild(bar);
    if (tasks.crError) box.appendChild(el("div", { class: "warn" }, tasks.crError));
  }

  // 클래스룸 과제 + 내 할 일을 마감 순으로 합치기
  const now = Date.now();
  const cr = (tasks.crItems || []).filter((x) => {
    // 마감 있는 과제: 마감 지나도 7일까지 보여 줌 / 제출한 과제는 "완료한 것도 보기"에서만
    if (x.due) return x.due.getTime() > now - 7 * 86400000;
    // 마감 없는 과제: 최근 2주 안에 올라온 것만 (예전 자료가 쌓이지 않게)
    return x.created && x.created.getTime() > now - 14 * 86400000;
  });
  const td = tasks.todos.map((t) => ({ ...t, due: todoDue(t), source: "todo" }));
  const all = [...cr, ...td].filter((x) => tasks.showDone || !x.done)
    .sort((a, b) => (a.done - b.done) || ((a.due ? a.due.getTime() : Infinity) - (b.due ? b.due.getTime() : Infinity)));

  if (!all.length) box.appendChild(el("div", { class: "tt-empty" },
    tasks.crItems ? "남은 과제가 없어요. 👍" : "아래에 할 일을 적거나 클래스룸을 연결해 보세요."));
  all.slice(0, 15).forEach((x) => {
    const row = el("div", { class: "task-row" + (x.done ? " done" : "") });
    const dl = dueLabel(x.due);
    if (x.source === "todo") {
      const cb = el("input", { type: "checkbox" });
      cb.checked = x.done;
      cb.addEventListener("change", () => toggleTodo(x.id));
      row.appendChild(cb);
    } else row.appendChild(el("span", { class: "task-ico" }, x.done ? "✅" : "📘"));
    const main = el("div", { class: "task-main" });
    if (x.link) { const a = el("a", { href: x.link, target: "_blank", rel: "noopener", class: "task-title" }, x.title); main.appendChild(a); }
    else main.appendChild(el("span", { class: "task-title" }, x.title));
    main.appendChild(el("div", { class: "task-sub" },
      (x.course ? x.course + " · " : "내 할 일 · ") + (x.done ? (x.source === "classroom" ? "제출함" : "완료") : dl.text)));
    row.appendChild(main);
    if (!x.done && dl.cls) row.appendChild(el("span", { class: "task-badge " + dl.cls }, dl.cls === "over" ? "지남" : "임박"));
    if (x.source === "todo") {
      const del = el("button", { class: "task-del", title: "삭제" }, "✕");
      del.addEventListener("click", () => removeTodo(x.id));
      row.appendChild(del);
    }
    box.appendChild(row);
  });
  if (all.length > 15) box.appendChild(el("div", { class: "tt-note" }, `외 ${all.length - 15}개`));

  // 할 일 추가
  const form = el("div", { class: "todo-form" });
  const ti = el("input", { type: "text", placeholder: "할 일 (예: 화학 보고서)", maxlength: 100 });
  const di = el("input", { type: "date" });
  const add = el("button", { class: "primary" }, "추가");
  const go = () => { if (addTodo(ti.value, di.value)) { ti.value = ""; di.value = ""; } };
  add.addEventListener("click", go);
  ti.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  form.append(ti, di, add);
  box.appendChild(form);
  box.appendChild(link(tasks.showDone ? "완료한 것 숨기기" : "완료한 것도 보기", () => { tasks.showDone = !tasks.showDone; renderPanel(); }));
  panel.appendChild(box);
}

// ----- 5. 시작: 로그인할 때마다 불러오기 -----
async function setupTasksForUser() {
  tasks.crItems = null; tasks.crError = "";
  await loadTodos();
  // 같은 탭에서 연결해 둔 토큰이 아직 유효하면 다시 묻지 않고 불러옴
  try {
    const saved = JSON.parse(sessionStorage.getItem(CR_KEY) || "null");
    tasks.crToken = saved && saved.exp > Date.now() ? saved : null;
  } catch (e) { tasks.crToken = null; }
  if (tasks.crToken) loadClassroom();
}
function clearTasks() {
  tasks.todos = []; tasks.crItems = null; tasks.crToken = null; tasks.crError = "";
  try { sessionStorage.removeItem(CR_KEY); } catch (e) {}
}
