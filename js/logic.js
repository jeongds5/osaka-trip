// =====================================================================
// logic.js — 설문 데이터 정의 · 검증 · 집계 · 팀 편성 · 여행 가이드
// Firebase에 의존하지 않는 순수 함수만 모아 두었습니다. (node 테스트 가능)
// =====================================================================

export const MAX_MEMBERS = 7;
export const TEAM_SIZES = [4, 3];

export const LIMITS = Object.freeze({ name: 20, lodgingNote: 200, memo: 500 });

// ---------------------------------------------------------------------
// 날짜 데이터 — 이 배열 한 곳에서만 관리합니다.
// 요일은 직접 적지 않고 Date로 계산하므로 날짜와 요일이 어긋날 수 없습니다.
// ---------------------------------------------------------------------
const TRIP_DATE_ISO = [
  '2027-02-05', '2027-02-06', '2027-02-07',
  '2027-02-08', '2027-02-09', '2027-02-10',
];
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export const DATES = Object.freeze(TRIP_DATE_ISO.map((iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return Object.freeze({
    id: `d${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`, // 예: d0205 (firestore.rules와 동일)
    iso, year: y, month: m, day: d,
    weekdayIndex: wd,
    weekday: WEEKDAYS[wd],
    label: `${m}월 ${d}일 (${WEEKDAYS[wd]})`,
  });
}));

export const PREF = Object.freeze([
  { v: 2, label: '선호', short: '선호' },
  { v: 1, label: '가능', short: '가능' },
  { v: 0, label: '불가', short: '불가' },
]);

// 3단계 — 출국 이동 루트 (대구 출발 기준 · 복수 선택: 가능한 루트를 모두 고르면 조율이 쉬움)
export const TRANSPORT = Object.freeze([
  { id: 'busan', icon: '🚄', label: '대구 → 부산 김해공항', desc: 'KTX·SRT·동해선으로 부산 이동 후 공항' },
  { id: 'seoul', icon: '🚅', label: '대구 → 인천·김포공항', desc: 'KTX로 서울 이동 후 공항철도' },
  { id: 'carpool', icon: '🚗', label: '자가용 카풀', desc: '대구에서 공항 주차장까지 함께' },
  { id: 'airportbus', icon: '🚌', label: '공항 리무진버스', desc: '대구에서 공항까지 버스로 한 번에' },
]);

// 4단계 — 숙소 유형(단일) + 가장 중요한 기준(단일)
export const LODGING_TYPES = Object.freeze([
  { id: 'hotel', icon: '🏨', label: '호텔', desc: '우메다 등 · 방 2~3개 나눠 예약' },
  { id: 'ryokan', icon: '♨️', label: '료칸', desc: '다다미방 · 대욕장 · 일본식 아침' },
  { id: 'apartment', icon: '🏠', label: '에어비앤비 독채', desc: '난바·도톤보리 · 7명이 한 집에서' },
  { id: 'hostel', icon: '🛏️', label: '게스트하우스', desc: '가성비 · 도미토리/단체실' },
]);

export const LODGING_PRIORITY = Object.freeze([
  { id: 'location', icon: '📍', label: '위치·역 접근성' },
  { id: 'price', icon: '💴', label: '가격' },
  { id: 'facility', icon: '✨', label: '청결·시설' },
  { id: 'space', icon: '🛋️', label: '넓은 공용 공간' },
]);

// 5단계 — 여행 활동 (복수 선택)
export const ACTIVITIES = Object.freeze([
  { id: 'sightseeing', icon: '🏯', label: '관광', desc: 'USJ · 교토 당일치기 · 오사카성' },
  { id: 'shopping', icon: '🛍️', label: '쇼핑', desc: '신사이바시 · 우메다' },
  { id: 'food', icon: '🍜', label: '맛집', desc: '도톤보리 먹방 · 야키니쿠' },
  { id: 'onsen', icon: '♨️', label: '온천 및 휴식', desc: '주유패스 온천 · 크루즈 · 휴식' },
  { id: 'nightview', icon: '🌃', label: '야경', desc: '전망대 · 네온 거리' },
  { id: 'free', icon: '🧭', label: '자유 일정', desc: '각자 · 팀별 자유 시간' },
]);

const ids = (arr) => arr.map((o) => o.id);
export const IDS = Object.freeze({
  dates: ids(DATES), transport: ids(TRANSPORT), lodgingType: ids(LODGING_TYPES),
  lodgingPriority: ids(LODGING_PRIORITY), activities: ids(ACTIVITIES),
});

export const byId = (arr, id) => arr.find((o) => o.id === id);

// ---------------------------------------------------------------------
// Firebase 설정값이 실제 값으로 교체되었는지 확인
// ---------------------------------------------------------------------
export function isConfigured(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const req = ['apiKey', 'authDomain', 'projectId', 'appId'];
  return req.every((k) => typeof cfg[k] === 'string' && cfg[k].length > 0 && !/YOUR_|여기에/.test(cfg[k]));
}

// ---------------------------------------------------------------------
// 초안(draft) · 검증
// ---------------------------------------------------------------------
export function emptyDraft() {
  return {
    name: '',
    dates: Object.fromEntries(DATES.map((d) => [d.id, null])),
    transport: [],
    lodgingType: null,
    lodgingPriority: null,
    lodgingNote: '',
    activities: [],
    memo: '',
  };
}

export function draftFromResponse(r, note) {
  const d = emptyDraft();
  if (!r) return d;
  d.name = typeof r.name === 'string' ? r.name : '';
  for (const date of DATES) {
    const v = r.dates?.[date.id];
    d.dates[date.id] = [0, 1, 2].includes(v) ? v : null;
  }
  d.transport = Array.isArray(r.transport) ? r.transport.filter((x) => IDS.transport.includes(x)) : [];
  d.lodgingType = IDS.lodgingType.includes(r.lodgingType) ? r.lodgingType : null;
  d.lodgingPriority = IDS.lodgingPriority.includes(r.lodgingPriority) ? r.lodgingPriority : null;
  d.activities = Array.isArray(r.activities) ? r.activities.filter((x) => IDS.activities.includes(x)) : [];
  d.lodgingNote = typeof note?.lodgingNote === 'string' ? note.lodgingNote : '';
  d.memo = typeof note?.memo === 'string' ? note.memo : '';
  return d;
}

// 문서 ID로 쓰이므로 공백 제거 + 소문자 + NFC 정규화
export function nameKey(name) {
  return String(name ?? '').normalize('NFC').trim().replace(/\s+/g, '').toLowerCase();
}

export function validateName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return '이름을 입력해 주세요.';
  if (name.length > LIMITS.name) return `이름은 ${LIMITS.name}자 이하로 입력해 주세요.`;
  if (/[\/\\.#$\[\]~*`<>]/.test(name)) return '이름에 / \\ . # $ [ ] ~ * ` < > 기호는 쓸 수 없어요.';
  if (name.includes('__')) return '밑줄(_)을 연속으로 두 번 쓸 수 없어요.';
  if (!nameKey(name)) return '이름을 입력해 주세요.';
  return null;
}

export function validateStep(step, d) {
  switch (step) {
    case 0: return validateName(d.name);
    case 1: {
      const vals = DATES.map((x) => d.dates[x.id]);
      if (vals.some((v) => v === null || v === undefined)) return '모든 날짜에 선호도를 선택해 주세요.';
      if (vals.every((v) => v === 0)) return '최소 하루는 "가능" 또는 "선호"를 골라 주세요.';
      return null;
    }
    case 2: return d.transport.length ? null : '이동수단을 하나 이상 선택해 주세요.';
    case 3:
      if (!d.lodgingType) return '숙소 유형을 선택해 주세요.';
      if (!d.lodgingPriority) return '숙소를 고를 때 가장 중요한 기준을 선택해 주세요.';
      if (d.lodgingNote.length > LIMITS.lodgingNote) return `숙소 의견은 ${LIMITS.lodgingNote}자 이하로 입력해 주세요.`;
      return null;
    case 4: return d.activities.length ? null : '하고 싶은 활동을 하나 이상 선택해 주세요.';
    case 5: return d.memo.length > LIMITS.memo ? `추가 의견은 ${LIMITS.memo}자 이하로 입력해 주세요.` : null;
    default: return null;
  }
}

export function validateAll(d) {
  for (let s = 0; s < 6; s++) {
    const e = validateStep(s, d);
    if (e) return { step: s, error: e };
  }
  return null;
}

// Firestore에 저장할 공개 응답 (메모 제외) — firestore.rules의 허용 필드와 일치해야 함
export function toPublicPayload(d) {
  const order = (list, allowed) => allowed.filter((id) => list.includes(id));
  return {
    name: d.name.trim(),
    nameKey: nameKey(d.name),
    dates: Object.fromEntries(DATES.map((x) => [x.id, d.dates[x.id]])),
    transport: order(d.transport, IDS.transport),
    lodgingType: d.lodgingType,
    lodgingPriority: d.lodgingPriority,
    activities: order(d.activities, IDS.activities),
  };
}

// 본인 + 관리자만 읽는 비공개 메모
export function toPrivatePayload(d) {
  return { lodgingNote: d.lodgingNote.trim(), memo: d.memo.trim() };
}

// ---------------------------------------------------------------------
// 집계 (투표 현황)
// ---------------------------------------------------------------------
function rankBy(arr, key) {
  const max = Math.max(0, ...arr.map((o) => o[key]));
  return arr.map((o) => ({ ...o, top: max > 0 && o[key] === max }));
}

export function aggregate(responses) {
  const list = Array.isArray(responses) ? responses : [];
  const n = list.length;
  const dates = DATES.map((d) => {
    const c = { 2: 0, 1: 0, 0: 0 };
    for (const r of list) { const v = r.dates?.[d.id]; if (v in c) c[v] += 1; }
    return { ...d, prefer: c[2], ok: c[1], no: c[0], score: c[2] * 2 + c[1] };
  });
  const bestScore = Math.max(0, ...dates.map((d) => d.score));
  const datesRanked = dates.map((d) => ({ ...d, top: bestScore > 0 && d.score === bestScore, allAvailable: n > 0 && d.no === 0 }));
  const countMulti = (opts, field) => rankBy(opts.map((o) => ({ ...o, count: list.filter((r) => Array.isArray(r[field]) && r[field].includes(o.id)).length })), 'count');
  const countSingle = (opts, field) => rankBy(opts.map((o) => ({ ...o, count: list.filter((r) => r[field] === o.id).length })), 'count');
  return {
    n,
    pending: Math.max(0, MAX_MEMBERS - n),
    over: Math.max(0, n - MAX_MEMBERS),
    dates: datesRanked,
    transport: countMulti(TRANSPORT, 'transport'),
    lodgingType: countSingle(LODGING_TYPES, 'lodgingType'),
    lodgingPriority: countSingle(LODGING_PRIORITY, 'lodgingPriority'),
    activities: countMulti(ACTIVITIES, 'activities'),
  };
}

// ---------------------------------------------------------------------
// 팀 편성 (4명 + 3명)
// 7명 중 3명을 고르는 35가지 조합을 모두 계산해 날짜·활동 궁합 점수가
// 높은 순으로 정렬하고, "재편성" 버튼은 상위 조합을 차례로 보여줍니다.
// ---------------------------------------------------------------------
export const TEAM_TOP_K = 8;

function pairScore(a, b) {
  let s = 0;
  for (const d of DATES) {
    const x = a.dates?.[d.id], y = b.dates?.[d.id];
    if (typeof x === 'number' && typeof y === 'number') s += 2 - Math.abs(x - y);
    if (x === 0 && y === 0) s -= 0.5; // 같이 불가인 날은 큰 의미 없음
  }
  const acts = new Set(a.activities || []);
  for (const act of b.activities || []) if (acts.has(act)) s += 1.5;
  return s;
}

function teamScore(team) {
  let s = 0;
  for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) s += pairScore(team[i], team[j]);
  return s;
}

export function bestDateFor(members) {
  let best = null;
  for (const d of DATES) {
    let score = 0, no = 0;
    for (const m of members) { const v = m.dates?.[d.id]; if (typeof v === 'number') score += v; if (v === 0) no += 1; }
    // 우선순위: 불가 인원 적은 날 → 점수 높은 날 → 이른 날짜
    if (!best || no < best.no || (no === best.no && score > best.score)) best = { date: d, score, no };
  }
  const conflicts = members.filter((m) => m.dates?.[best.date.id] === 0);
  return { ...best, conflicts };
}

function combinations(n, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < n; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

function sharedActivities(team) {
  const half = Math.ceil(team.length / 2);
  return ACTIVITIES.filter((a) => team.filter((m) => (m.activities || []).includes(a.id)).length >= half);
}

export function verifyTeams(teams, members) {
  const assigned = teams.flat().map((m) => m.id);
  const unique = new Set(assigned);
  const memberIds = new Set(members.map((m) => m.id));
  const sizesOk = teams.length === TEAM_SIZES.length && teams.every((t, i) => t.length === TEAM_SIZES[i]);
  const ok = sizesOk && unique.size === assigned.length && assigned.length === members.length
    && assigned.every((id) => memberIds.has(id));
  return { ok, assigned: assigned.length, unique: unique.size, total: members.length };
}

export function formTeams(responses, pick = 0) {
  // 응답 문서 ID(=익명 UID) 기준으로 중복 제거
  const seen = new Set();
  const members = [];
  for (const r of responses || []) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    members.push(r);
  }
  const n = members.length;
  if (n < MAX_MEMBERS) return { ok: false, reason: 'shortage', n, need: MAX_MEMBERS - n, members };
  if (n > MAX_MEMBERS) return { ok: false, reason: 'over', n, extra: n - MAX_MEMBERS, members };

  const sorted = members.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const splits = combinations(n, TEAM_SIZES[1]).map((three) => {
    const small = three.map((i) => sorted[i]);
    const big = sorted.filter((_, i) => !three.includes(i));
    return { teams: [big, small], score: teamScore(big) + teamScore(small), key: three.join('') };
  }).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  const top = splits.slice(0, Math.min(TEAM_TOP_K, splits.length));
  const idx = ((pick % top.length) + top.length) % top.length;
  const chosen = top[idx];
  const check = verifyTeams(chosen.teams, members);
  if (!check.ok) throw new Error('팀 편성 검증 실패: 중복 또는 누락된 인원이 있습니다.');

  return {
    ok: true, n,
    rank: idx + 1, topK: top.length, totalCombos: splits.length,
    score: chosen.score,
    check,
    trip: bestDateFor(members),
    teams: chosen.teams.map((t, i) => ({
      label: i === 0 ? 'A팀' : 'B팀',
      members: t.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko')),
      best: bestDateFor(t),
      shared: sharedActivities(t),
    })),
  };
}

// ---------------------------------------------------------------------
// 여행 가이드 — 미리 작성한 일반 정보 (AI 생성 아님 · 실시간 정보 아님)
// ---------------------------------------------------------------------
export const GUIDE = Object.freeze({
  departure: [
    { title: '대구 → 김해공항', body: '동대구역에서 KTX·SRT로 부산역까지 약 50분 안팎, 이후 경전철·리무진으로 김해공항 이동. 7명이 같은 열차를 타려면 좌석을 미리 예매하세요.', link: { href: 'https://www.letskorail.com', label: '코레일 열차 시간표' } },
    { title: '대구 → 인천공항', body: 'KTX로 서울역까지 이동한 뒤 공항철도로 인천공항. 이동 시간이 길어 새벽·아침 출국편이면 전날 이동도 고려하세요.' },
    { title: '자가용 카풀', body: '7명과 캐리어를 한 번에 싣기는 어려워 보통 차 2대가 필요해요. 공항 주차 요금과 주차장 혼잡 여부를 미리 확인하세요.' },
  ],
  transportBasics: [
    { title: '간사이공항 → 시내', body: '난바 방면은 난카이 전철(특급 라피트 포함), 텐노지·신오사카·교토 방면은 JR 특급 하루카가 일반적입니다. 짐이 많다면 공항 리무진버스도 선택지예요.' },
    { title: '교통카드 · 패스', body: 'ICOCA 같은 IC 교통카드 하나면 대부분의 전철·버스를 탈 수 있어요. 관광지를 많이 돈다면 오사카 주유패스도 비교해 보세요(구성·가격은 바뀔 수 있음).', link: { href: 'https://www.osaka-info.jp/page/osaka-amazing-pass', label: '오사카 주유패스 공식 안내' } },
    { title: '시내 기본 동선', body: '오사카 메트로 미도스지선이 우메다 – 신사이바시 – 난바 – 텐노지를 잇는 핵심 노선입니다. 숙소를 이 노선 근처로 잡으면 이동이 단순해집니다.' },
    { title: '7명이 택시 탈 때', body: '일본 일반 택시는 보통 승객 4명까지라 7명이면 2대로 나눠야 해요. 팀 편성(4+3)을 그대로 쓰면 편리합니다.' },
  ],
  weather: { title: '2월 오사카 날씨', body: '한국의 늦겨울과 비슷하게 쌀쌀해요. 두꺼운 코트나 경량 패딩, 발열 내의를 챙기세요. 출발 전 실제 예보를 꼭 확인하세요.', link: { href: 'https://www.jma.go.jp/jma/index.html', label: '일본 기상청' } },
  activities: {
    sightseeing: [
      { title: '유니버설 스튜디오 재팬 (USJ)', area: '유니버설시티', body: '하루를 통째로 쓰는 일정. 인기 어트랙션은 대기가 길어 익스프레스 패스나 입장 예약을 미리 확인하세요.' },
      { title: '오사카성 공원', area: '모리노미야 · 오사카비즈니스파크', body: '천수각과 넓은 공원. 오전에 가면 비교적 한산합니다.' },
      { title: '신세카이 · 츠텐카쿠', area: '에비스초 · 도부츠엔마에', body: '레트로한 거리 분위기. 쿠시카츠 골목과 묶어서 다니기 좋아요.' },
      { title: '교토 · 나라 당일치기', area: '근교', body: '교토는 JR·한큐·게이한, 나라는 킨테츠·JR로 1시간 안팎. 2월은 비수기라 상대적으로 덜 붐비는 편입니다.' },
    ],
    shopping: [
      { title: '신사이바시스지 상점가', area: '신사이바시 ~ 난바', body: '지붕 있는 긴 상점가라 비·추위에도 걷기 좋아요. 드럭스토어·패션 매장이 밀집.' },
      { title: '우메다 백화점 · 복합몰', area: '우메다 · 오사카역', body: '백화점과 대형 복합몰, 지하상가가 연결되어 있어 한 구역에서 오래 쇼핑 가능.' },
      { title: '덴덴타운', area: '닛폰바시', body: '애니메이션 굿즈 · 피규어 · 전자제품 거리.' },
    ],
    food: [
      { title: '도톤보리', area: '난바', body: '다코야키 · 오코노미야키 · 라멘 등 오사카 대표 먹거리 거리. 저녁 시간은 줄이 길 수 있어요.' },
      { title: '7인 단체 야키니쿠', area: '난바 · 우메다', body: '7명이 한 테이블·룸에 앉으려면 예약이 사실상 필수예요. 지도 앱에서 단체석·룸 여부와 예약 가능 여부를 확인하세요.' },
      { title: '구로몬 시장', area: '닛폰바시', body: '해산물 · 과일 · 길거리 음식 시장. 오전~이른 오후가 활기찹니다.' },
      { title: '쿠시카츠', area: '신세카이 등', body: '공용 소스에 두 번 찍지 않는 것이 일반적인 매너예요.' },
    ],
    onsen: [
      { title: '아리마 온천', area: '고베 북쪽', body: '오사카에서 버스·전철로 대략 1시간 남짓 걸리는 대표 온천 마을. 반나절 일정으로 다녀오기 좋습니다.' },
      { title: '대욕장 있는 숙소', area: '시내', body: '시내 호텔 중에도 대욕장을 갖춘 곳이 있어요. 숙소 선택 시 확인해 보세요.' },
      { title: '리버 크루즈', area: '도톤보리 · 오사카성 주변', body: '강 위에서 도시를 둘러보는 짧은 유람선. 주유패스 포함 여부는 시즌마다 달라질 수 있어요.' },
      { title: '나카노시마 산책', area: '요도야바시 · 기타하마', body: '강변 공원과 오래된 건물 사이를 걷는 여유로운 코스.' },
    ],
    nightview: [
      { title: '우메다 스카이빌딩 공중정원', area: '우메다', body: '두 빌딩을 잇는 옥상 전망대. 해 질 무렵에 올라가면 낮과 밤 풍경을 모두 볼 수 있어요.' },
      { title: '아베노 하루카스 전망대', area: '텐노지', body: '고층 빌딩 꼭대기 전망대. 텐노지 · 신세카이 일정과 연결하기 좋습니다.' },
      { title: '도톤보리 네온 거리', area: '난바', body: '글리코 간판 주변 운하 산책로. 무료로 즐기는 오사카 대표 야경.' },
    ],
    free: [
      { title: '팀별 자유 시간', area: '난바 · 우메다', body: '팀 편성 탭의 4+3 팀으로 나눠 움직이고, 저녁에 한 곳에서 다시 모이는 방식을 추천해요.' },
      { title: '집합 장소 정하기', area: '공통', body: '큰 역은 출구가 많아 길을 잃기 쉬워요. "OO역 O번 출구 앞"처럼 구체적으로 정하세요.' },
    ],
  },
  lodging: {
    hotel: '7명이면 트윈·트리플 객실을 섞어 2~3개 예약하는 구성이 흔합니다. 같은 층 배정을 요청해 보세요.',
    ryokan: '료칸은 인원 단위 요금이 많고 식사 포함 여부가 다양해요. 체크인 시간과 저녁 식사 시간을 미리 확인하세요.',
    apartment: '아파트형 숙소는 7명이 한 공간을 쓰기 좋지만 최대 인원 · 침구 수 · 현지 등록 여부를 꼭 확인하세요.',
    hostel: '게스트하우스 단체실을 쓰면 비용을 크게 줄일 수 있어요. 샤워실 수와 짐 보관 가능 여부를 확인하세요.',
  },
});

export function buildGuide(draft) {
  const acts = draft?.activities?.length ? draft.activities : IDS.activities;
  const personalized = Boolean(draft?.activities?.length);
  return {
    personalized,
    sections: acts.map((id) => ({ activity: byId(ACTIVITIES, id), items: GUIDE.activities[id] || [] })),
    lodging: draft?.lodgingType ? { type: byId(LODGING_TYPES, draft.lodgingType), tip: GUIDE.lodging[draft.lodgingType] } : null,
    departure: GUIDE.departure,
    transport: GUIDE.transportBasics,
    weather: GUIDE.weather,
    carpoolNote: (draft?.transport || []).includes('carpool'),
  };
}

// 단계별 💡 팁 (기존 웹앱의 팁 박스 유지)
export const STEP_TIPS = [
  '7명의 친구들이 쉽게 알아볼 수 있는 이름이나 닉네임을 적어 주세요. 같은 이름은 한 번만 쓸 수 있어요.',
  '날짜마다 선호 · 가능 · 불가를 골라 주세요. "불가"가 적은 날을 중심으로 일정이 정해져요.',
  '대구에서 공항까지 가능한 루트를 모두 골라 주세요. 많이 고를수록 조율이 쉬워져요.',
  '7명이면 에어비앤비 독채 한 채, 또는 호텔 방 2~3개로 나누는 방식이 흔해요.',
  '하고 싶은 활동을 모두 골라 주세요. 팀 편성 때 취향이 비슷한 사람끼리 묶는 데 쓰여요.',
  '알레르기, 못 먹는 음식, 예산 등 꼭 알려야 할 내용을 적어 주세요. 메모는 관리자만 볼 수 있어요.',
];
