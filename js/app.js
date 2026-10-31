// =====================================================================
// app.js — 화면 렌더링 · 이벤트 · Firebase(익명 인증 + Firestore) 연동
// =====================================================================
import * as L from './logic.js';

const SDK_VERSION = '10.12.2';
const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}/`;
const SAVE_TIMEOUT_MS = 15000;

const STEPS = [
  { title: '참가자 이름', short: '이름', icon: '👤' },
  { title: '여행 일정', short: '일정', icon: '📅' },
  { title: '이동수단 (출국 루트)', short: '이동', icon: '🚄' },
  { title: '숙소', short: '숙소', icon: '🏨' },
  { title: '여행 활동', short: '활동', icon: '🎌' },
  { title: '추가 의견 · 최종 확인', short: '확인', icon: '✍️' },
];

// ---------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------
const state = {
  fb: null,            // { auth, db, A: authModule, F: firestoreModule }
  uid: null,
  isAdmin: false,
  adminChecked: false,
  conn: 'init',
  tab: 'survey',
  mode: 'loading',     // loading | form | done
  step: 0,
  draft: L.emptyDraft(),
  mine: null,          // 내 공개 응답 (Firestore)
  saving: false,
  deleting: null,      // 삭제 중인 uid
  responses: [],
  responsesLoaded: false,
  notes: {},           // 관리자 전용: uid → privateNotes
  notesError: null,
  teamPick: 0,
  unsubs: [],
};

// ---------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function avatar(name) {
  const first = [...String(name || '?').trim()][0] || '?';
  return `<span class="avatar" style="background:hsl(${hue(name)} 75% 72%)">${esc(first)}</span>`;
}
function fmtTime(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : null;
    if (!d) return '';
    return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), ms)),
  ]);
}
function errMsg(e) {
  const code = e?.code || '';
  if (code === 'timeout') return '서버 응답이 늦어요. 네트워크를 확인한 뒤 새로고침해서 저장 여부를 확인해 주세요.';
  if (code === 'permission-denied' || code === 'firestore/permission-denied') return '권한이 없거나 입력값이 보안 규칙에 맞지 않아 거부되었어요.';
  if (code === 'unavailable') return '서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.';
  if (code === 'name-taken') return '이미 다른 참가자가 사용 중인 이름이에요. 다른 이름(예: 이름+이니셜)을 써 주세요.';
  if (code === 'offline') return '오프라인 상태에서는 저장할 수 없어요. 연결 후 다시 시도해 주세요.';
  if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') return 'Firebase 콘솔에서 익명 로그인이 활성화되지 않았어요. (README 3단계)';
  if (code === 'auth/network-request-failed') return '로그인 중 네트워크 오류가 발생했어요.';
  if (code === 'auth/invalid-api-key' || code === 'auth/api-key-not-valid.-please-pass-a-valid-api-key.') return 'Firebase apiKey가 올바르지 않아요. index.html 설정 구역을 확인해 주세요.';
  if (code === 'failed-precondition') return 'Firestore 데이터베이스가 아직 생성되지 않았을 수 있어요. (README 4단계)';
  return `오류가 발생했어요${code ? ` (${code})` : ''}. 잠시 후 다시 시도해 주세요.`;
}

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, type === 'error' ? 5200 : 3000);
}

function confirmModal(title, body, okLabel = '확인') {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-body').textContent = body;
    $('#modal-ok').textContent = okLabel;
    modal.hidden = false;
    $('#modal-cancel').focus();
    const done = (v) => {
      modal.hidden = true;
      $('#modal-ok').onclick = null; $('#modal-cancel').onclick = null; modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    $('#modal-ok').onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    document.addEventListener('keydown', onKey);
  });
}

// ---------------------------------------------------------------------
// 연결 상태 표시
// ---------------------------------------------------------------------
const CONN = {
  init: ['pill-wait', '연결 확인 중'],
  auth: ['pill-wait', '익명 로그인 중'],
  syncing: ['pill-wait', '동기화 중'],
  online: ['pill-online', '실시간 연결됨'],
  offline: ['pill-error', '오프라인'],
  error: ['pill-error', '연결 오류'],
  unconfigured: ['pill-error', '설정 필요'],
};
function setConn(c, detail) {
  state.conn = c;
  const [cls, label] = CONN[c] || CONN.init;
  const pill = $('#conn-pill');
  pill.className = `pill ${cls}`;
  $('#conn-text').textContent = label;
  pill.title = detail || label;
  $('#offline-banner').hidden = c !== 'offline';
  if (detail && c === 'error') toast(detail, 'error');
  updateNav();
}
window.addEventListener('online', () => { if (state.fb) setConn('syncing'); });
window.addEventListener('offline', () => { if (state.fb) setConn('offline'); });

// ---------------------------------------------------------------------
// Firebase 초기화
// ---------------------------------------------------------------------
async function initFirebase() {
  if (!L.isConfigured(window.FIREBASE_CONFIG)) {
    $('#setup-banner').hidden = false;
    setConn('unconfigured', 'index.html에 Firebase 설정값을 입력해 주세요.');
    state.mode = 'form';
    renderAll();
    return;
  }
  setConn('init');
  let appM, authM, fsM;
  try {
    [appM, authM, fsM] = await Promise.all([
      import(`${SDK_BASE}firebase-app.js`),
      import(`${SDK_BASE}firebase-auth.js`),
      import(`${SDK_BASE}firebase-firestore.js`),
    ]);
  } catch (e) {
    console.error(e);
    state.mode = 'form';
    setConn('error', 'Firebase SDK를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.');
    renderAll();
    return;
  }
  try {
    const app = appM.initializeApp(window.FIREBASE_CONFIG);
    const auth = authM.getAuth(app);
    const db = fsM.getFirestore(app);
    state.fb = { auth, db, A: authM, F: fsM };
    if (!navigator.onLine) setConn('offline');

    authM.onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setConn('auth');
        try { await authM.signInAnonymously(auth); }
        catch (e) { console.error(e); state.mode = 'form'; setConn('error', errMsg(e)); renderAll(); }
        return;
      }
      if (state.uid === user.uid) return;
      state.uid = user.uid;
      await onSignedIn();
    });
  } catch (e) {
    console.error(e);
    state.mode = 'form';
    setConn('error', errMsg(e));
    renderAll();
  }
}

async function onSignedIn() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  setConn('syncing');
  await Promise.all([loadMine(), checkAdmin()]);
  subscribeResponses();
  if (state.isAdmin) subscribeNotes();
  renderAll();
}

async function loadMine() {
  const { db, F } = state.fb;
  try {
    const [r, n] = await Promise.all([
      F.getDoc(F.doc(db, 'responses', state.uid)),
      F.getDoc(F.doc(db, 'privateNotes', state.uid)),
    ]);
    if (r.exists()) {
      state.mine = r.data();
      state.draft = L.draftFromResponse(state.mine, n.exists() ? n.data() : null);
      state.mode = 'done';
    } else {
      state.mine = null;
      state.mode = 'form';
    }
  } catch (e) {
    console.error(e);
    state.mode = 'form';
    toast(`기존 응답을 불러오지 못했어요. ${errMsg(e)}`, 'error');
  }
}

async function checkAdmin() {
  const { db, F } = state.fb;
  try {
    const snap = await F.getDoc(F.doc(db, 'admins', state.uid));
    state.isAdmin = snap.exists();
  } catch (e) {
    console.warn('관리자 확인 실패', e);
    state.isAdmin = false;
  }
  state.adminChecked = true;
}

function subscribeResponses() {
  const { db, F } = state.fb;
  const unsub = F.onSnapshot(
    F.collection(db, 'responses'),
    { includeMetadataChanges: true },
    (snap) => {
      state.responses = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
      state.responsesLoaded = true;
      if (!navigator.onLine) setConn('offline');
      else setConn(snap.metadata.fromCache ? 'syncing' : 'online');

      // 관리자가 내 응답을 삭제한 경우 반영
      const serverConfirmed = !snap.metadata.fromCache && !snap.metadata.hasPendingWrites;
      if (serverConfirmed && state.mine && !state.saving && !state.responses.some((r) => r.id === state.uid)) {
        state.mine = null;
        state.mode = 'form';
        state.step = 0;
        toast('내 응답이 삭제되었어요. 다시 작성할 수 있어요.');
        renderSurvey(true);
      }
      renderResults(); renderTeams(); renderAdmin();
      if (state.mode === 'done') renderSurvey(false);
    },
    (err) => { console.error(err); setConn('error', `실시간 동기화 실패: ${errMsg(err)}`); },
  );
  state.unsubs.push(unsub);
}

function subscribeNotes() {
  const { db, F } = state.fb;
  const unsub = F.onSnapshot(
    F.collection(db, 'privateNotes'),
    (snap) => {
      state.notes = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      state.notesError = null;
      renderAdmin();
    },
    (err) => { console.error(err); state.notesError = errMsg(err); renderAdmin(); },
  );
  state.unsubs.push(unsub);
}

// ---------------------------------------------------------------------
// 저장 · 삭제
// ---------------------------------------------------------------------
function canWrite() {
  if (!state.fb || !state.uid) {
    toast(state.conn === 'unconfigured' ? 'Firebase 설정 후 제출할 수 있어요. (README 참고)' : '아직 서버에 연결되지 않았어요.', 'error');
    return false;
  }
  if (!navigator.onLine) { toast(errMsg({ code: 'offline' }), 'error'); return false; }
  return true;
}

async function submit() {
  if (state.saving) return;                       // 중복 제출 방지
  const invalid = L.validateAll(state.draft);
  if (invalid) { state.step = invalid.step; renderSurvey(true); showStepError(invalid.error); return; }
  if (!canWrite()) return;

  const key = L.nameKey(state.draft.name);
  const taken = state.responses.find((r) => r.nameKey === key && r.id !== state.uid);
  if (taken) { state.step = 0; renderSurvey(true); showStepError(errMsg({ code: 'name-taken' })); return; }

  state.saving = true;
  updateNav();
  const { db, F } = state.fb;
  try {
    const lockRef = F.doc(db, 'names', key);
    const lock = await withTimeout(F.getDoc(lockRef), SAVE_TIMEOUT_MS);
    if (lock.exists() && lock.data().uid !== state.uid) throw Object.assign(new Error('name-taken'), { code: 'name-taken' });

    const batch = F.writeBatch(db);
    const prev = state.mine;
    if (!lock.exists()) batch.set(lockRef, { uid: state.uid });
    if (prev && prev.nameKey && prev.nameKey !== key) batch.delete(F.doc(db, 'names', prev.nameKey));
    batch.set(F.doc(db, 'responses', state.uid), {
      ...L.toPublicPayload(state.draft),
      createdAt: prev?.createdAt ?? F.serverTimestamp(),
      updatedAt: F.serverTimestamp(),
    });
    batch.set(F.doc(db, 'privateNotes', state.uid), {
      ...L.toPrivatePayload(state.draft),
      updatedAt: F.serverTimestamp(),
    });
    await withTimeout(batch.commit(), SAVE_TIMEOUT_MS);

    const fresh = await F.getDoc(F.doc(db, 'responses', state.uid));
    state.mine = fresh.exists() ? fresh.data() : null;
    state.mode = 'done';
    toast(prev ? '수정한 응답을 저장했어요.' : '응답을 제출했어요. 고마워요!', 'success');
  } catch (e) {
    console.error(e);
    if (e.code === 'name-taken') { state.step = 0; renderSurvey(true); showStepError(errMsg(e)); }
    else toast(errMsg(e), 'error');
  } finally {
    state.saving = false;
    renderSurvey(true);
  }
}

async function deleteResponse(uid, isSelf) {
  if (state.deleting) return;
  if (!canWrite()) return;
  const target = state.responses.find((r) => r.id === uid) || (isSelf ? state.mine : null);
  const ok = await confirmModal(
    isSelf ? '내 응답 삭제' : '응답 삭제 (관리자)',
    `${target?.name ? `"${target.name}"` : '이'} 응답과 비공개 메모를 영구 삭제합니다.\n되돌릴 수 없어요.`,
    '삭제',
  );
  if (!ok) return;
  state.deleting = uid;
  renderSurvey(false); renderAdmin();
  const { db, F } = state.fb;
  try {
    const batch = F.writeBatch(db);
    batch.delete(F.doc(db, 'responses', uid));
    batch.delete(F.doc(db, 'privateNotes', uid));
    if (target?.nameKey) {
      const lock = await F.getDoc(F.doc(db, 'names', target.nameKey));
      if (lock.exists() && (lock.data().uid === uid)) batch.delete(lock.ref);
    }
    await withTimeout(batch.commit(), SAVE_TIMEOUT_MS);
    if (uid === state.uid) {
      state.mine = null;
      state.draft = L.emptyDraft();
      state.mode = 'form';
      state.step = 0;
    }
    toast('응답을 삭제했어요.', 'success');
  } catch (e) {
    console.error(e);
    toast(errMsg(e), 'error');
  } finally {
    state.deleting = null;
    renderAll();
  }
}

// ---------------------------------------------------------------------
// 설문 렌더링
// ---------------------------------------------------------------------
function optCard(o, on, action, radio = false) {
  return `<button type="button" class="opt ${radio ? 'radio' : ''} ${on ? 'on' : ''}" data-action="${action}" data-id="${o.id}" aria-pressed="${on}">
    <span class="ic" aria-hidden="true">${o.icon}</span>
    <span><b>${esc(o.label)}</b>${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</span>
    <span class="check" aria-hidden="true">✓</span>
  </button>`;
}

function stepHead(i, sub) {
  const s = STEPS[i];
  return `<div class="step-head"><span class="step-icon" aria-hidden="true">${s.icon}</span>
    <div><p class="eyebrow">STEP ${i + 1} / ${STEPS.length}</p><h2>${s.title}</h2><p class="sub">${sub}</p></div></div>`;
}

function counter(field, limit) {
  const len = state.draft[field].length;
  return `<span class="counter ${len > limit ? 'over' : ''}" data-counter="${field}">${len} / ${limit}</span>`;
}

function prefTags(dates) {
  return L.DATES.map((d) => {
    const v = dates?.[d.id];
    const p = L.PREF.find((x) => x.v === v);
    return p ? `<span class="tag p${v}" title="${esc(d.label)} ${p.label}">${d.month}/${d.day}(${d.weekday}) ${p.short}</span>` : '';
  }).join('');
}
const labels = (arr, ids) => (ids || []).map((id) => L.byId(arr, id)?.label).filter(Boolean).join(', ') || '—';

function summaryHtml(d, editable) {
  const rows = [
    ['이름', esc(d.name.trim()) || '—', 0],
    ['일정', prefTags(d.dates), 1],
    ['이동수단', esc(labels(L.TRANSPORT, d.transport)), 2],
    ['숙소', `${esc(L.byId(L.LODGING_TYPES, d.lodgingType)?.label || '—')} · ${esc(L.byId(L.LODGING_PRIORITY, d.lodgingPriority)?.label || '—')}${d.lodgingNote.trim() ? `<br><small class="privacy">🔒 ${esc(d.lodgingNote.trim())}</small>` : ''}`, 3],
    ['활동', esc(labels(L.ACTIVITIES, d.activities)), 4],
  ];
  if (!editable && d.memo.trim()) rows.push(['메모', `<small class="privacy">🔒 ${esc(d.memo.trim())}</small>`, 5]);
  return `<dl class="summary">${rows.map(([k, v, s]) => `<div class="summary-row"><dt>${k}</dt><dd>${v}</dd>${editable ? `<button type="button" class="linkbtn" data-action="goto-step" data-step="${s}">수정</button>` : '<span></span>'}</div>`).join('')}</dl>`;
}

function stepHtml(i) {
  const d = state.draft;
  switch (i) {
    case 0: return `${stepHead(0, '친구들이 알아볼 수 있는 이름을 적어 주세요. 이름은 투표 현황에 공개됩니다.')}
      ${state.mine ? '<div class="notice notice-info">✔ 이전에 제출한 응답을 불러왔어요. 수정 후 마지막 단계에서 저장하면 덮어써요.</div>' : ''}
      <label class="field"><span>이름 ${counter('name', L.LIMITS.name)}</span>
        <input id="in-name" type="text" data-field="name" maxlength="${L.LIMITS.name}" value="${esc(d.name)}" placeholder="예: 민지" autocomplete="nickname" enterkeyhint="next"></label>`;
    case 1: return `${stepHead(1, '2027년 2월 날짜별로 선호도를 골라 주세요. 모든 날짜를 선택해야 다음으로 넘어가요.')}
      <div class="date-list">${L.DATES.map((date) => `<div class="date-row">
        <div class="date-label"><span class="date-day">${date.month}/${date.day}</span><span class="wd wd-${date.weekdayIndex}">${date.weekday}요일</span></div>
        <div class="seg" role="radiogroup" aria-label="${esc(date.label)} 선호도">${L.PREF.map((p) => `<button type="button" role="radio" class="seg-btn p${p.v} ${d.dates[date.id] === p.v ? 'on' : ''}" aria-checked="${d.dates[date.id] === p.v}" data-action="pref" data-date="${date.id}" data-v="${p.v}">${p.label}</button>`).join('')}</div>
      </div>`).join('')}</div>
      <div class="mini-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="fill-dates" data-v="1">남은 날짜 모두 "가능"</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="fill-dates" data-v="reset">초기화</button></div>`;
    case 2: return `${stepHead(2, '대구에서 공항까지 이용 가능한 루트를 모두 골라 주세요. 복수 선택 가능해요.')}
      <div class="opt-grid">${L.TRANSPORT.map((o) => optCard(o, d.transport.includes(o.id), 'toggle-transport')).join('')}</div>`;
    case 3: return `${stepHead(3, '원하는 숙소 유형 하나와, 고를 때 가장 중요한 기준 하나를 선택해 주세요.')}
      <div class="opt-grid">${L.LODGING_TYPES.map((o) => optCard(o, d.lodgingType === o.id, 'lodging-type', true)).join('')}</div>
      <p class="sec-label">가장 중요한 기준</p>
      <div class="chips" role="radiogroup" aria-label="숙소 선택 기준">${L.LODGING_PRIORITY.map((o) => `<button type="button" role="radio" aria-checked="${d.lodgingPriority === o.id}" class="chip ${d.lodgingPriority === o.id ? 'on' : ''}" data-action="lodging-priority" data-id="${o.id}">${o.icon} ${esc(o.label)}</button>`).join('')}</div>
      <label class="field"><span>숙소 관련 추가 의견 (선택) ${counter('lodgingNote', L.LIMITS.lodgingNote)}</span>
        <textarea id="in-lodging-note" data-field="lodgingNote" maxlength="${L.LIMITS.lodgingNote}" placeholder="예: 난바역 근처면 좋겠어요 / 코골이 있어요">${esc(d.lodgingNote)}</textarea></label>
      <span class="privacy">🔒 이 의견은 본인과 관리자만 볼 수 있어요.</span>`;
    case 4: return `${stepHead(4, '오사카에서 꼭 하고 싶은 활동을 모두 골라 주세요. 복수 선택 가능해요.')}
      <div class="opt-grid">${L.ACTIVITIES.map((o) => optCard(o, d.activities.includes(o.id), 'toggle-activity')).join('')}</div>`;
    case 5: return `${stepHead(5, '하고 싶은 말을 남기고, 제출 전에 응답을 최종 확인해 주세요.')}
      <label class="field"><span>추가 의견 (선택) ${counter('memo', L.LIMITS.memo)}</span>
        <textarea id="in-memo" data-field="memo" maxlength="${L.LIMITS.memo}" placeholder="예: 못 먹는 음식, 꼭 가고 싶은 곳, 예산 등">${esc(d.memo)}</textarea></label>
      <span class="privacy">🔒 추가 의견은 공개 투표 현황에 표시되지 않아요. (본인 · 관리자만)</span>
      <p class="sec-label">최종 응답 확인</p>
      ${summaryHtml(d, true)}`;
    default: return '';
  }
}

function doneHtml() {
  const busy = state.deleting === state.uid;
  return `<div class="done-hero"><span class="big" aria-hidden="true">✓</span>
      <h2>${esc(state.mine?.name || state.draft.name)}님, 응답 완료!</h2>
      <p>${state.mine?.updatedAt ? `마지막 저장: ${fmtTime(state.mine.updatedAt)}` : '응답이 저장되었어요.'}</p></div>
    ${summaryHtml(state.draft, false)}
    <div class="btn-row">
      <button type="button" class="btn btn-ghost" data-action="edit" ${busy ? 'disabled' : ''}>✏️ 응답 수정하기</button>
      <button type="button" class="btn btn-danger" data-action="delete-mine" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span> 삭제 중…' : '🗑 내 응답 삭제'}</button>
      <button type="button" class="btn btn-ghost" data-tab="results">📊 투표 현황 보기</button>
    </div>`;
}

function renderProgress() {
  const el = $('#survey-progress');
  if (state.mode === 'loading') { el.innerHTML = ''; return; }
  const done = state.mode === 'done';
  const pct = done ? 100 : Math.round((state.step / STEPS.length) * 100);
  el.innerHTML = `<div class="progress-top"><span>${done ? '<b>제출 완료</b>' : `<b>${state.step + 1}</b> / ${STEPS.length} 단계 · ${STEPS[state.step].title}`}</span><span>${pct}%</span></div>
    <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
    <div class="progress-steps">${STEPS.map((s, i) => {
      const cls = done || i < state.step ? 'done' : i === state.step ? 'cur' : '';
      const reachable = !done && i < state.step;
      return `<button type="button" class="${cls}" ${reachable ? `data-action="goto-step" data-step="${i}"` : 'disabled'} aria-label="${i + 1}단계 ${s.title}"><i>${done || i < state.step ? '✓' : i + 1}</i><span>${s.short}</span></button>`;
    }).join('')}</div>`;
}

function renderSurvey(animate = false) {
  const card = $('#survey-card');
  renderProgress();
  if (state.mode === 'loading') {
    card.innerHTML = '<div class="skeleton" style="width:40%"></div><div class="skeleton"></div><div class="skeleton" style="width:70%"></div>';
  } else if (state.mode === 'done') {
    card.innerHTML = doneHtml();
  } else {
    card.innerHTML = `${stepHtml(state.step)}<p class="field-error" id="err-step" role="alert"></p>
      <div class="tip-box"><span aria-hidden="true">💡</span><div>${esc(L.STEP_TIPS[state.step])}</div></div>`;
  }
  if (animate) { card.classList.remove('enter'); void card.offsetWidth; card.classList.add('enter'); }
  updateNav();
}

function updateNav() {
  const nav = $('#survey-nav');
  if (!nav) return;
  nav.hidden = state.mode !== 'form';
  const prev = $('#btn-prev'), next = $('#btn-next');
  prev.disabled = state.step === 0 || state.saving;
  const last = state.step === STEPS.length - 1;
  next.disabled = state.saving || (last && state.conn === 'offline');
  next.innerHTML = state.saving
    ? '<span class="spinner"></span> 저장 중…'
    : last ? (state.mine ? '💾 수정 내용 저장' : '🚀 제출하기') : '다음 →';
}

function showStepError(msg) {
  const el = $('#err-step');
  if (!el) { toast(msg, 'error'); return; }
  el.textContent = '';
  void el.offsetWidth;
  el.textContent = msg;
}

function goNext() {
  if (state.saving) return;
  const err = L.validateStep(state.step, state.draft);
  if (err) { showStepError(err); return; }
  if (state.step === 0) {
    const key = L.nameKey(state.draft.name);
    if (state.responses.some((r) => r.nameKey === key && r.id !== state.uid)) { showStepError(errMsg({ code: 'name-taken' })); return; }
  }
  if (state.step < STEPS.length - 1) {
    state.step += 1;
    renderSurvey(true);
    $('#survey-progress').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    submit();
  }
}
function goPrev() {
  if (state.step > 0 && !state.saving) { state.step -= 1; renderSurvey(true); }
}

// ---------------------------------------------------------------------
// 투표 현황
// ---------------------------------------------------------------------
function barRows(items, total) {
  return `<div class="bars">${items.map((o) => `<div class="bar-row ${o.top ? 'top' : ''}">
    <span class="lbl">${o.icon ? `${o.icon} ` : ''}${esc(o.label)}</span>
    <span class="track"><span class="fill" style="width:${total ? (o.count / total) * 100 : 0}%"></span></span>
    <span class="num">${o.count}</span></div>`).join('')}</div>`;
}

function notReadyHtml() {
  if (state.conn === 'unconfigured') return '<div class="card empty"><span class="ic">⚙️</span>Firebase 설정 후 실시간 현황이 표시돼요.</div>';
  if (state.conn === 'error' && !state.responsesLoaded) return '<div class="card empty"><span class="ic">⚠️</span>서버에 연결하지 못했어요. 새로고침해 주세요.</div>';
  return '<div class="card"><div class="skeleton" style="width:30%"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div>';
}

function renderResults() {
  const el = $('#view-results');
  if (!state.responsesLoaded) { el.innerHTML = notReadyHtml(); return; }
  const a = L.aggregate(state.responses);
  const names = state.responses.slice().sort((x, y) => String(x.name).localeCompare(String(y.name), 'ko'));
  const n = a.n;
  el.innerHTML = `
    <div class="stats">
      <div class="stat accent"><small>응답 인원</small><b>${n}<span> / ${L.MAX_MEMBERS}</span></b></div>
      <div class="stat"><small>미응답</small><b>${a.pending}<span>명</span></b></div>
      <div class="stat"><small>진행률</small><b>${Math.min(100, Math.round((n / L.MAX_MEMBERS) * 100))}<span>%</span></b></div>
    </div>
    ${a.over ? `<div class="notice notice-warn">⚠ 응답이 ${L.MAX_MEMBERS}명보다 ${a.over}건 많아요. 한 사람이 여러 기기로 응답했을 수 있으니 관리자가 확인해 주세요.</div>` : ''}
    <div class="card"><h3>👥 응답자 <span class="badge badge-good">실시간</span></h3>
      <div class="people">${names.map((r) => `<span class="person ${r.id === state.uid ? 'me' : ''}">${avatar(r.name)}${esc(r.name)}${r.id === state.uid ? ' (나)' : ''}</span>`).join('')}
      ${Array.from({ length: a.pending }, () => '<span class="person empty">대기 중</span>').join('')}</div>
      <p class="hint" style="margin:12px 0 0">숙소 의견 · 추가 메모는 공개되지 않아요.</p>
      ${n ? '<div class="btn-row" style="justify-content:flex-start"><button type="button" class="btn btn-ghost btn-sm" data-action="copy-summary">📋 단톡방 공유용 요약문 복사</button></div>' : ''}</div>
    ${n === 0 ? '<div class="card empty"><span class="ic">🗳️</span>아직 응답이 없어요. 첫 번째로 설문에 참여해 보세요!</div>' : `
    <div class="card date-chart"><h3>📅 날짜별 선호도</h3>
      <div class="legend"><span><i style="background:var(--good)"></i>선호</span><span><i style="background:var(--ok)"></i>가능</span><span><i style="background:var(--no)"></i>불가</span><span>★ 점수 최고 (선호 2점 · 가능 1점)</span></div>
      <div class="bars">${a.dates.map((d) => `<div class="bar-row ${d.top ? 'top' : ''}">
        <span class="lbl">${d.month}/${d.day} (${d.weekday})</span>
        <span class="track stack" title="선호 ${d.prefer} · 가능 ${d.ok} · 불가 ${d.no}"><span class="seg2" style="width:${(d.prefer / n) * 100}%"></span><span class="seg1" style="width:${(d.ok / n) * 100}%"></span><span class="seg0" style="width:${(d.no / n) * 100}%"></span></span>
        <span class="num">${d.prefer}·${d.ok}·${d.no}${d.allAvailable ? ' ✓' : ''}</span></div>`).join('')}</div>
      <p class="hint" style="margin:12px 0 0">숫자는 선호·가능·불가 인원, ✓는 불가 인원이 없는 날이에요.</p></div>
    <div class="grid-2">
      <div class="card"><h3>🚄 출국 이동 루트</h3><p class="hint">복수 선택 · 응답자 대비</p>${barRows(a.transport, n)}</div>
      <div class="card"><h3>🎌 여행 활동</h3><p class="hint">복수 선택 · 응답자 대비</p>${barRows(a.activities, n)}</div>
      <div class="card"><h3>🏨 숙소 유형</h3>${barRows(a.lodgingType, n)}</div>
      <div class="card"><h3>✨ 숙소 선택 기준</h3>${barRows(a.lodgingPriority, n)}</div>
    </div>`}`;
}

// ---------------------------------------------------------------------
// 팀 편성
// ---------------------------------------------------------------------
function renderTeams() {
  const el = $('#view-teams');
  if (!state.responsesLoaded) { el.innerHTML = notReadyHtml(); return; }
  const res = L.formTeams(state.responses, state.teamPick);
  const head = `<div class="card"><h3>👥 7인 팀 편성 <span class="badge badge-sim">시뮬레이션</span></h3>
    <p class="hint" style="margin:0">응답한 인원만 4명 + 3명으로 나눕니다. 날짜·활동 취향이 비슷한 사람끼리 묶이도록 35가지 조합을 모두 계산해요.
    <b>이 결과는 화면에서만 계산되며 저장되지 않아요.</b></p></div>`;

  if (!res.ok) {
    const filled = res.members.slice(0, L.MAX_MEMBERS);
    el.innerHTML = `${head}<div class="card shortage">
      ${res.reason === 'shortage'
        ? `<div class="big">${res.n} / ${L.MAX_MEMBERS}명</div><p class="sub">팀을 편성하려면 <b>${res.need}명</b>이 더 응답해야 해요.</p>`
        : `<div class="big">${res.n}명</div><p class="sub">응답이 ${L.MAX_MEMBERS}명보다 <b>${res.extra}건</b> 많아 팀을 편성할 수 없어요. 관리자가 중복 응답을 정리해 주세요.</p>`}
      <div class="slots">${Array.from({ length: L.MAX_MEMBERS }, (_, i) => filled[i]
        ? `<span class="slot filled" style="background:hsl(${hue(filled[i].name)} 75% 72%)" title="${esc(filled[i].name)}">${esc([...String(filled[i].name)][0] || '?')}</span>`
        : '<span class="slot"></span>').join('')}</div></div>`;
    return;
  }

  const teamCard = (t, i) => {
    const conflictIds = new Set(t.best.conflicts.map((m) => m.id));
    return `<div class="card team ${i ? 'b' : ''}"><h3><span>${t.label} · ${t.members.length}명</span></h3>
      <div class="team-members">${t.members.map((m, j) => `<div class="member ${conflictIds.has(m.id) ? 'conflict' : ''}" style="animation-delay:${j * 60}ms">${avatar(m.name)}${esc(m.name)}${m.id === state.uid ? ' (나)' : ''}${conflictIds.has(m.id) ? '<em>이 날 불가</em>' : ''}</div>`).join('')}</div>
      <p class="kv">팀 추천 날짜: <b>${esc(t.best.date.label)}</b></p>
      <p class="kv">공통 관심 활동: <b>${t.shared.length ? t.shared.map((x) => `${x.icon} ${esc(x.label)}`).join(', ') : '없음'}</b></p>
      ${t.best.conflicts.length
        ? `<div class="notice notice-warn">⚠ 날짜 충돌: ${t.best.conflicts.map((m) => esc(m.name)).join(', ')}님은 ${esc(t.best.date.label)}에 불가예요. 팀 안에서 모두 가능한 날이 없어요.</div>`
        : '<div class="notice notice-good">✓ 이 팀은 추천 날짜에 모두 참여 가능해요.</div>'}
    </div>`;
  };

  el.innerHTML = `${head}
    <div class="card">
      <p class="kv">전체 추천 날짜: <b>${esc(res.trip.date.label)}</b> ${res.trip.conflicts.length ? '' : '<span class="badge badge-good">7명 모두 가능</span>'}</p>
      ${res.trip.conflicts.length ? `<div class="notice notice-warn">⚠ 7명 전원이 가능한 날이 없어요. 가장 나은 날(${esc(res.trip.date.label)})에도 ${res.trip.conflicts.map((m) => esc(m.name)).join(', ')}님이 불가예요.</div>` : ''}
      <p class="kv">인원 검증: <b>${res.check.assigned}명 배정 · 중복 0 · 누락 ${res.check.total - res.check.unique}</b> ${res.check.ok ? '✓' : '✗'}</p>
      <p class="kv">조합 순위: <b>${res.rank} / ${res.topK}</b> (전체 ${res.totalCombos}가지 중 궁합 상위)</p>
      <div class="btn-row" style="justify-content:flex-start"><button type="button" class="btn btn-ghost" data-action="reteam">🔀 팀 재편성 (다음 조합)</button></div>
    </div>
    <div class="teams">${res.teams.map(teamCard).join('')}</div>`;
}

// ---------------------------------------------------------------------
// 여행 가이드
// ---------------------------------------------------------------------
function guideItem(it) {
  const link = it.link && /^https:\/\//.test(it.link.href)
    ? `<a class="ext" href="${esc(it.link.href)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(it.link.label)}</a>` : '';
  return `<div class="guide-item">${it.area ? `<small>${esc(it.area)}</small>` : ''}<b>${esc(it.title)}</b><p>${esc(it.body)}</p>${link}</div>`;
}
// ---------------------------------------------------------------------
function renderGuide() {
  const el = $('#view-guide');
  const g = L.buildGuide(state.draft);
  el.innerHTML = `<div class="card"><h3>🗺️ 오사카 여행 가이드</h3>
      <p class="hint" style="margin:0">${g.personalized ? '내가 설문에서 고른 활동을 기준으로 정리했어요.' : '설문에서 활동을 고르면 내 취향에 맞춰 정리돼요. 지금은 전체 안내를 보여줘요.'}</p>
      <div class="notice notice-info">ℹ 이 안내는 <b>미리 작성해 둔 일반 정보</b>예요. AI가 생성한 답변이 아니고 실시간 검색도 하지 않아요. 영업시간 · 요금 · 운행 정보는 방문 전에 공식 사이트에서 꼭 확인하세요.</div></div>
    ${g.sections.map((s) => `<div class="card guide-sec"><h3>${s.activity.icon} ${esc(s.activity.label)}</h3>
      <div class="guide-items">${s.items.map(guideItem).join('')}</div></div>`).join('')}
    ${g.lodging ? `<div class="card guide-sec"><h3>${g.lodging.type.icon} 숙소 팁 · ${esc(g.lodging.type.label)}</h3><p class="sub">${esc(g.lodging.tip)}</p></div>` : ''}
    <div class="card guide-sec"><h3>🚄 대구 → 공항 이동</h3>
      <div class="guide-items">${g.departure.map(guideItem).join('')}</div>
      ${g.carpoolNote ? '<div class="notice notice-warn">🚗 카풀을 고르셨네요. 7명과 캐리어면 보통 차 2대가 필요해요.</div>' : ''}</div>
    <div class="card guide-sec"><h3>🚆 오사카 현지 교통</h3>
      <div class="guide-items">${g.transport.map(guideItem).join('')}</div></div>
    <div class="card guide-sec"><h3>🌤️ 날씨 · 옷차림</h3><div class="guide-items">${guideItem(g.weather)}</div></div>`;
}

// ---------------------------------------------------------------------
// 관리자
// ---------------------------------------------------------------------
function renderAdmin() {
  const el = $('#view-admin');
  if (!state.fb || !state.uid) {
    el.innerHTML = `<div class="card empty"><span class="ic">🔐</span>${state.conn === 'unconfigured' ? 'Firebase 설정 후 관리자 기능을 쓸 수 있어요.' : '서버 연결을 기다리는 중이에요…'}</div>`;
    return;
  }
  if (!state.adminChecked) { el.innerHTML = notReadyHtml(); return; }

  if (!state.isAdmin) {
    el.innerHTML = `<div class="card"><h3>🔐 관리자 인증 상태: <span class="badge badge-sim">일반 참가자</span></h3>
      <p class="sub">관리자 권한은 이 화면의 버튼이 아니라 <b>Firestore 보안 규칙</b>이 서버에서 검증해요. 버튼을 억지로 띄워도 메모 조회 · 남의 응답 삭제는 서버가 거부합니다.</p>
      <p class="sec-label">이 브라우저의 익명 UID</p>
      <div class="uid-box"><code id="my-uid">${esc(state.uid)}</code><button type="button" class="btn btn-ghost btn-sm" data-action="copy-uid">복사</button></div>
      <p class="sec-label">관리자로 등록하는 방법 (여행 총무 1명만)</p>
      <ol class="steps">
        <li>위 UID를 복사합니다.</li>
        <li>Firebase 콘솔 → <b>Firestore Database</b> → <b>데이터</b> 탭 → <b>컬렉션 시작</b></li>
        <li>컬렉션 ID: <code>admins</code> · 문서 ID: <b>복사한 UID</b> · 필드: <code>role</code> (string) = <code>admin</code> → 저장</li>
        <li>이 페이지를 새로고침하면 관리자 화면이 열려요.</li>
      </ol>
      <p class="hint" style="margin:8px 0 0">※ 이 브라우저의 사이트 데이터를 지우면 UID가 바뀌어 다시 등록해야 해요.</p></div>`;
    return;
  }

  const list = state.responses.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
  const a = L.aggregate(state.responses);
  el.innerHTML = `<div class="card"><h3>🔐 관리자 인증 상태: <span class="badge badge-admin">관리자 확인됨</span></h3>
      <p class="sub">admins/${esc(state.uid.slice(0, 8))}… 문서가 존재해 Firestore 규칙이 관리자 권한을 허용하고 있어요.</p>
      <div class="btn-row" style="justify-content:flex-start"><button type="button" class="btn btn-ghost btn-sm" data-tab="results">📊 투표 현황</button><button type="button" class="btn btn-ghost btn-sm" data-tab="teams">👥 팀 편성 결과</button></div></div>
    <div class="stats">
      <div class="stat accent"><small>응답자</small><b>${a.n}<span> / ${L.MAX_MEMBERS}</span></b></div>
      <div class="stat"><small>미응답</small><b>${a.pending}<span>명</span></b></div>
      <div class="stat"><small>메모 작성</small><b>${Object.values(state.notes).filter((x) => x.memo || x.lodgingNote).length}<span>건</span></b></div>
    </div>
    ${state.notesError ? `<div class="notice notice-warn">비공개 메모를 불러오지 못했어요: ${esc(state.notesError)}</div>` : ''}
    <div class="card"><h3>📋 전체 응답 (비공개 메모 포함)</h3>
      ${list.length === 0 ? '<div class="empty">아직 응답이 없어요.</div>' : `<div class="resp-list">${list.map((r) => {
        const note = state.notes[r.id] || {};
        const busy = state.deleting === r.id;
        return `<div class="resp"><div class="resp-head"><span style="display:flex;align-items:center;gap:8px">${avatar(r.name)}<b>${esc(r.name)}</b>${r.id === state.uid ? '<span class="badge badge-admin">나</span>' : ''}</span>
          <span class="resp-meta">${esc(fmtTime(r.updatedAt))} · ${esc(r.id.slice(0, 6))}…</span>
          <button type="button" class="btn btn-danger btn-sm" data-action="admin-delete" data-uid="${esc(r.id)}" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span>' : '🗑 삭제'}</button></div>
          <div class="resp-body">
            <div><span class="k">일정</span>${prefTags(r.dates)}</div>
            <div><span class="k">이동수단</span>${esc(labels(L.TRANSPORT, r.transport))}</div>
            <div><span class="k">숙소</span>${esc(L.byId(L.LODGING_TYPES, r.lodgingType)?.label || '—')} · ${esc(L.byId(L.LODGING_PRIORITY, r.lodgingPriority)?.label || '—')}</div>
            <div><span class="k">활동</span>${esc(labels(L.ACTIVITIES, r.activities))}</div>
            ${note.lodgingNote ? `<div class="note-box">🏨 ${esc(note.lodgingNote)}</div>` : ''}
            ${note.memo ? `<div class="note-box">✍️ ${esc(note.memo)}</div>` : ''}
          </div></div>`;
      }).join('')}</div>`}
    </div>`;
}

// ---------------------------------------------------------------------
// 탭 · 이벤트
// ---------------------------------------------------------------------
const RENDERERS = { survey: () => renderSurvey(false), results: renderResults, teams: renderTeams, guide: renderGuide, admin: renderAdmin };

function setTab(tab) {
  if (!RENDERERS[tab]) return;
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${tab}`; });
  RENDERERS[tab]();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderAll() {
  renderSurvey(true); renderResults(); renderTeams(); renderGuide(); renderAdmin();
}

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { setTab(tabBtn.dataset.tab); return; }

  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const d = state.draft;
  const { action } = btn.dataset;
  switch (action) {
    case 'pref': d.dates[btn.dataset.date] = Number(btn.dataset.v); renderSurvey(false); break;
    case 'fill-dates':
      for (const date of L.DATES) {
        if (btn.dataset.v === 'reset') d.dates[date.id] = null;
        else if (d.dates[date.id] === null) d.dates[date.id] = 1;
      }
      renderSurvey(false); break;
    case 'toggle-transport': toggle(d.transport, btn.dataset.id); renderSurvey(false); break;
    case 'toggle-activity': toggle(d.activities, btn.dataset.id); renderSurvey(false); renderGuide(); break;
    case 'lodging-type': d.lodgingType = btn.dataset.id; renderSurvey(false); break;
    case 'lodging-priority': d.lodgingPriority = btn.dataset.id; renderSurvey(false); break;
    case 'goto-step': state.step = Number(btn.dataset.step); state.mode = 'form'; renderSurvey(true); break;
    case 'edit': state.mode = 'form'; state.step = 0; renderSurvey(true); break;
    case 'delete-mine': deleteResponse(state.uid, true); break;
    case 'admin-delete': deleteResponse(btn.dataset.uid, btn.dataset.uid === state.uid); break;
    case 'reteam': state.teamPick += 1; renderTeams(); break;
    case 'copy-summary': copySummary(); break;
    case 'copy-uid':
      navigator.clipboard?.writeText(state.uid).then(() => toast('UID를 복사했어요.', 'success'), () => toast('복사에 실패했어요. 직접 선택해 복사해 주세요.', 'error'));
      break;
    default: break;
  }
});

function copySummary() {
  const list = state.responses.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
  if (!list.length) { toast('복사할 응답이 없어요.', 'error'); return; }
  const a = L.aggregate(list);
  const best = a.dates.filter((d) => d.top).map((d) => d.label).join(', ') || '-';
  const lines = [
    `[✈️ 오사카 7인 우정여행 현황] ${a.n}/${L.MAX_MEMBERS}명 응답`,
    `• 가장 많이 원하는 날짜: ${best}`,
    ...list.map((r) => `• ${r.name}: 선호 ${L.DATES.filter((d) => r.dates?.[d.id] === 2).map((d) => `${d.month}/${d.day}(${d.weekday})`).join(' ') || '-'} | 불가 ${L.DATES.filter((d) => r.dates?.[d.id] === 0).map((d) => `${d.month}/${d.day}`).join(' ') || '없음'} | ${labels(L.TRANSPORT, r.transport)}`),
    a.pending ? `• 아직 ${a.pending}명 미응답` : '• 7명 모두 응답 완료!',
    '',
    `참여 링크: ${location.origin}${location.pathname}`,
  ];
  navigator.clipboard?.writeText(lines.join('\n')).then(
    () => toast('📋 단톡방 공유용 요약문을 복사했어요.', 'success'),
    () => toast('복사에 실패했어요. 브라우저 권한을 확인해 주세요.', 'error'),
  );
}

function toggle(list, id) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
}

document.addEventListener('input', (e) => {
  const field = e.target.dataset?.field;
  if (!field || !(field in state.draft)) return;
  state.draft[field] = e.target.value;
  const limit = L.LIMITS[field];
  const c = document.querySelector(`[data-counter="${field}"]`);
  if (c && limit) { c.textContent = `${e.target.value.length} / ${limit}`; c.classList.toggle('over', e.target.value.length > limit); }
  const err = $('#err-step'); if (err) err.textContent = '';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'in-name' && !e.isComposing) { e.preventDefault(); goNext(); }
});

$('#btn-next').addEventListener('click', goNext);
$('#btn-prev').addEventListener('click', goPrev);

// 시작
setTab('survey');
renderAll();
initFirebase();
