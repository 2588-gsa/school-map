// =============================================================
//  로그인 (Firebase Authentication)
//  - 아이디: 학생은 학번(예: 2101), 선생님은 이름(예: 김은석)
//  - 처음 비밀번호는 1234 → 처음 로그인하면 바로 바꾸게 함
//  - "로그인 유지"를 켜면 브라우저를 닫아도 자동 로그인
//  - 시간표는 명단에 있는 사람이 로그인했을 때만 Firestore에서 받아 옴
// =============================================================

const DEFAULT_PW = "1234";
// Firebase는 비밀번호가 6자 이상이어야 해서, 입력한 비밀번호 뒤에 이 글자를 붙여서 씀
const PW_SUFFIX = "#gsamap";
const EMAIL_DOMAIN = "school-map.local";
const NEW_PW_MIN = 4;

const auth = { ready: false, user: null, info: null, pendingDefault: null };   // info: { id, kind, name }

// 아이디 → Firebase용 이메일 주소
function toLoginId(input) {
  const raw = String(input || "").trim().replace(/\s+/g, "").replace(/(선생님|쌤)$/, "");
  if (/^\d{5}$/.test(raw)) return { id: raw, kind: "student" };
  if (/^\d{4}$/.test(raw)) return { id: raw[0] + "0" + raw.slice(1), kind: "student" };  // 2103 → 20103
  if (raw.toLowerCase() === "admin") return { id: "admin", kind: "admin" };
  if (!raw) return null;
  // 한글 이름은 이메일에 못 쓰므로 UTF-8 16진수로 바꿈 (예: 김은석 → tea...)
  const hex = [...new TextEncoder().encode(raw)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { id: "t" + hex, kind: "teacher", name: raw };
}
const toEmail = (id) => `${id}@${EMAIL_DOMAIN}`;
function decodeTeacher(id) {
  const bytes = id.slice(1).match(/../g).map((h) => parseInt(h, 16));
  return new TextDecoder().decode(new Uint8Array(bytes));
}
function infoFromUser(user) {
  const id = user.email.split("@")[0];
  if (id === "admin") return { id, kind: "admin", name: "관리자" };
  if (id.startsWith("t")) return { id, kind: "teacher", name: decodeTeacher(id) + " 선생님" };
  return { id, kind: "student", name: showId(id) };   // 이름은 시간표를 받은 뒤 채움
}

const mustChangeKey = (uid) => "mustChangePw:" + uid;

// ----- 로그인 -----
async function doLogin(input, pw, keep) {
  const who = toLoginId(input);
  if (!who) throw new Error("아이디를 입력해 주세요.");
  if (!pw) throw new Error("비밀번호를 입력해 주세요.");
  const fa = firebase.auth();
  await fa.setPersistence(keep ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION);
  const email = toEmail(who.id);
  // 1234로 로그인하면 "비밀번호 바꾸기"를 띄우기 위해 기억해 둠
  auth.pendingDefault = pw === DEFAULT_PW ? email : null;
  try {
    await fa.signInWithEmailAndPassword(email, pw + PW_SUFFIX);
  } catch (e) {
    const notFound = ["auth/user-not-found", "auth/invalid-credential", "auth/invalid-login-credentials"].includes(e.code);
    if (!(notFound && pw === DEFAULT_PW && who.kind !== "admin")) throw new Error(authMessage(e));
    // 처음 로그인: 기본 비밀번호(1234)로 계정을 만듦
    try {
      await fa.createUserWithEmailAndPassword(email, pw + PW_SUFFIX);
    } catch (e2) {
      if (e2.code === "auth/email-already-in-use") throw new Error("비밀번호가 틀렸어요.");
      throw new Error(authMessage(e2));
    }
  }
}

function authMessage(e) {
  const m = {
    "auth/invalid-credential": "아이디 또는 비밀번호가 틀렸어요.",
    "auth/invalid-login-credentials": "아이디 또는 비밀번호가 틀렸어요.",
    "auth/wrong-password": "비밀번호가 틀렸어요.",
    "auth/user-not-found": "아이디 또는 비밀번호가 틀렸어요.",
    "auth/too-many-requests": "시도가 너무 많아요. 잠시 후 다시 해 주세요.",
    "auth/network-request-failed": "인터넷 연결을 확인해 주세요.",
    "auth/operation-not-allowed": "Firebase에서 이메일/비밀번호 로그인이 꺼져 있어요.",
    "auth/requires-recent-login": "보안을 위해 다시 로그인한 뒤 바꿔 주세요."
  };
  return m[e.code] || e.message;
}

// ----- 비밀번호 변경 -----
async function changePassword(pw1, pw2) {
  if (pw1.length < NEW_PW_MIN) throw new Error(`비밀번호는 ${NEW_PW_MIN}자 이상이어야 해요.`);
  if (pw1 === DEFAULT_PW) throw new Error("1234가 아닌 비밀번호로 정해 주세요.");
  if (pw1 !== pw2) throw new Error("두 비밀번호가 달라요.");
  const user = firebase.auth().currentUser;
  try { await user.updatePassword(pw1 + PW_SUFFIX); }
  catch (e) { throw new Error(authMessage(e)); }
  try { localStorage.removeItem(mustChangeKey(user.uid)); } catch (e) {}
}

// ----- 로그인한 뒤: 시간표 받아 오기 -----
async function fetchTimetable() {
  const doc = await firebase.firestore().collection("private").doc("timetable").get();
  if (!doc.exists) throw new Error("시간표 데이터가 아직 업로드되지 않았어요.");
  return JSON.parse(doc.data().json);
}

// ----- 화면: 모달 -----
function openModal(build, closable = true) {
  closeModal();
  const back = el("div", { id: "modalBack" });
  const box = el("div", { class: "modal" });
  build(box);
  if (closable) {
    const x = el("button", { class: "modal-x", title: "닫기" }, "✕");
    x.addEventListener("click", closeModal);
    box.prepend(x);
    back.addEventListener("click", (e) => { if (e.target === back) closeModal(); });
  }
  back.appendChild(box);
  document.body.appendChild(back);
  const first = box.querySelector("input");
  if (first) first.focus();
}
function closeModal() { const m = $("modalBack"); if (m) m.remove(); }

function showLoginModal() {
  openModal((box) => {
    box.appendChild(el("h2", {}, "로그인"));
    box.appendChild(el("p", { class: "modal-help" },
      "학생은 학번(예: 2101), 선생님은 이름으로 로그인해요. 처음 비밀번호는 1234예요."));
    const idIn = el("input", { type: "text", placeholder: "학번 또는 선생님 이름", autocomplete: "username" });
    const pwIn = el("input", { type: "password", placeholder: "비밀번호", autocomplete: "current-password" });
    const keepLb = el("label", { class: "keep" });
    const keep = el("input", { type: "checkbox" }); keep.checked = true;
    keepLb.append(keep, document.createTextNode(" 로그인 유지 (다음에 자동 로그인)"));
    const err = el("div", { class: "modal-err" });
    const btn = el("button", { class: "primary" }, "로그인");
    const go = async () => {
      err.textContent = ""; btn.disabled = true; btn.textContent = "확인 중...";
      try { await doLogin(idIn.value, pwIn.value, keep.checked); closeModal(); }
      catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = "로그인"; }
    };
    btn.addEventListener("click", go);
    [idIn, pwIn].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); }));
    box.append(idIn, pwIn, keepLb, err, btn);
    box.appendChild(el("p", { class: "modal-help small" },
      "비밀번호를 잊으면 관리자에게 말해 주세요. 계정을 지우면 다시 1234로 시작할 수 있어요."));
  });
}

function showChangePwModal(forced) {
  openModal((box) => {
    box.appendChild(el("h2", {}, forced ? "비밀번호를 바꿔 주세요" : "비밀번호 변경"));
    if (forced) box.appendChild(el("p", { class: "modal-help" },
      "처음 비밀번호(1234)는 모두가 알고 있어서, 바꿔야 다른 사람이 내 계정으로 들어오지 못해요."));
    const p1 = el("input", { type: "password", placeholder: `새 비밀번호 (${NEW_PW_MIN}자 이상)`, autocomplete: "new-password" });
    const p2 = el("input", { type: "password", placeholder: "새 비밀번호 확인", autocomplete: "new-password" });
    const err = el("div", { class: "modal-err" });
    const btn = el("button", { class: "primary" }, "바꾸기");
    const go = async () => {
      err.textContent = ""; btn.disabled = true;
      try { await changePassword(p1.value, p2.value); closeModal(); showToast("비밀번호를 바꿨어요."); }
      catch (e) { err.textContent = e.message; btn.disabled = false; }
    };
    btn.addEventListener("click", go);
    p2.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    box.append(p1, p2, err, btn);
    if (forced) {
      const out = el("button", { class: "link-btn" }, "로그아웃");
      out.addEventListener("click", () => { closeModal(); firebase.auth().signOut(); });
      box.appendChild(out);
    }
  }, !forced);
}

// ----- 화면: 상단 사용자 영역 -----
function renderUserBox() {
  const box = $("userBox");
  if (!box) return;
  box.innerHTML = "";
  if (store.mode !== "firebase") return;
  if (!auth.user) {
    const b = el("button", { class: "login-btn" }, "로그인");
    b.addEventListener("click", showLoginModal);
    box.appendChild(b);
    return;
  }
  const home = el("button", { class: "small-btn" }, "📌 내 일정");
  home.addEventListener("click", goHome);
  if (myPerson()) box.appendChild(home);
  const name = el("span", { class: "user-name" }, "👤 " + auth.info.name);
  const pw = el("button", { class: "small-btn" }, "비밀번호 변경");
  pw.addEventListener("click", () => showChangePwModal(false));
  const out = el("button", { class: "small-btn" }, "로그아웃");
  out.addEventListener("click", () => firebase.auth().signOut());
  box.append(name, pw, out);
}

// ----- 시작 -----
function setupAuth() {
  if (store.mode !== "firebase") {
    auth.ready = true; renderUserBox(); updateSearchPlaceholder();
    store.myVotes().then((m) => { state.myVotes = m; renderPanel(); });
    return;
  }
  firebase.auth().onAuthStateChanged(async (user) => {
    auth.user = user;
    auth.info = user ? infoFromUser(user) : null;
    unloadTimetable();
    state.person = null; state.highlightId = null; state.myVotes = {}; state.ranking = null;
    if (!user) clearTasks();
    state.selectedId = null;
    if (user && auth.pendingDefault === user.email) {
      try { localStorage.setItem(mustChangeKey(user.uid), "1"); } catch (e) {}
      auth.pendingDefault = null;
    }
    if (user) {
      try {
        loadTimetable(await fetchTimetable());
        if (auth.info.kind === "student") {
          const st = TT.students.find((s) => s.id === auth.info.id);
          if (st) auth.info.name = `${st.name} (${showId(st.id)})`;
        }
      } catch (e) {
        if (String(e.code || e.message).includes("permission")) {
          // 명단에 없는 아이디: 방금 만든 계정이면 지우고 로그아웃
          showToast("명단에 없는 아이디예요. 학번이나 이름을 다시 확인해 주세요.", true);
          try { if (localStorage.getItem(mustChangeKey(user.uid))) await user.delete(); } catch (e2) {}
          await firebase.auth().signOut();
          return;
        }
        showToast(e.message, true);
      }
      try { state.myVotes = await store.myVotes(); } catch (e) { state.myVotes = {}; }
      await setupTasksForUser();   // 내 할 일 + (연결돼 있으면) 클래스룸 과제
      try {   // 관리자 페이지가 올려 둔 랭킹
        const rk = await firebase.firestore().collection("private").doc("ranking").get();
        state.ranking = rk.exists ? rk.data() : null;
      } catch (e) { state.ranking = null; }
      let must = false;
      try { must = !!localStorage.getItem(mustChangeKey(user.uid)); } catch (e) {}
      if (must) showChangePwModal(true);
    }
    auth.ready = true;
    setupTimeBox();
    renderUserBox();
    updateSearchPlaceholder();
    renderAll();
  });
}

function updateSearchPlaceholder() {
  $("search").placeholder = HAS_TT ? "교실·선생님·학생 이름 검색" : "교실·건물 이름 검색 (로그인하면 시간표 검색)";
}
