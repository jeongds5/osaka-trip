// node --test tests/  로 실행
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

test('날짜와 요일이 일치한다 (2027년 2월 5~10일)', () => {
  const expected = [['d0205', '금'], ['d0206', '토'], ['d0207', '일'], ['d0208', '월'], ['d0209', '화'], ['d0210', '수']];
  assert.deepEqual(L.DATES.map((d) => [d.id, d.weekday]), expected);
  assert.equal(L.DATES[0].label, '2월 5일 (금)');
});

test('이름 검증', () => {
  assert.ok(L.validateName('   '));
  assert.ok(L.validateName('a/b'));
  assert.ok(L.validateName('x'.repeat(21)));
  assert.equal(L.validateName('민지'), null);
  assert.equal(L.nameKey('  Min Ji '), 'minji');
});

function fullDraft(name, prefs = [2, 1, 1, 0, 1, 2], acts = ['food']) {
  const d = L.emptyDraft();
  d.name = name;
  L.DATES.forEach((x, i) => { d.dates[x.id] = prefs[i]; });
  d.transport = ['carpool', 'busan'];
  d.lodgingType = 'hotel';
  d.lodgingPriority = 'price';
  d.activities = acts;
  return d;
}

test('단계 검증 · 빈 응답 차단', () => {
  const d = L.emptyDraft();
  assert.equal(L.validateAll(d).step, 0);
  d.name = '민지';
  assert.equal(L.validateAll(d).step, 1);
  L.DATES.forEach((x) => { d.dates[x.id] = 0; });
  assert.match(L.validateStep(1, d), /최소 하루/);
  assert.equal(L.validateAll(fullDraft('a')), null);
  const long = fullDraft('a'); long.memo = 'x'.repeat(501);
  assert.equal(L.validateAll(long).step, 5);
});

test('공개 payload에는 메모가 없고 허용 필드만 있다', () => {
  const d = fullDraft('민지'); d.memo = '비밀'; d.lodgingNote = '비밀2';
  const p = L.toPublicPayload(d);
  assert.deepEqual(Object.keys(p).sort(), ['activities', 'dates', 'lodgingPriority', 'lodgingType', 'name', 'nameKey', 'transport']);
  assert.deepEqual(p.transport, ['busan', 'carpool']); // 옵션 순서로 정렬
  assert.ok(!JSON.stringify(p).includes('비밀'));
});

const mk = (n) => Array.from({ length: n }, (_, i) => ({
  id: `uid${i}`, name: `사람${i}`, ...L.toPublicPayload(fullDraft(`사람${i}`, [i % 3, 1, 2, (i + 1) % 3, 1, i % 2 ? 2 : 0], i % 2 ? ['food', 'shopping'] : ['onsen'])),
}));

test('팀 편성: 7명 미만이면 부족 표시', () => {
  const r = L.formTeams(mk(5));
  assert.equal(r.ok, false); assert.equal(r.reason, 'shortage'); assert.equal(r.need, 2);
});

test('팀 편성: 7명 초과면 거부', () => {
  const r = L.formTeams(mk(8));
  assert.equal(r.ok, false); assert.equal(r.reason, 'over');
});

test('팀 편성: 같은 UID 중복은 1명으로 계산', () => {
  const list = mk(6); list.push({ ...list[0] });
  assert.equal(L.formTeams(list).reason, 'shortage');
});

test('팀 편성: 4+3, 중복·누락 없음, 재편성마다 검증 통과', () => {
  const members = mk(7);
  const seen = new Set();
  for (let pick = 0; pick < 20; pick++) {
    const r = L.formTeams(members, pick);
    assert.equal(r.ok, true);
    assert.equal(r.totalCombos, 35);
    assert.deepEqual(r.teams.map((t) => t.members.length), [4, 3]);
    const ids = r.teams.flatMap((t) => t.members.map((m) => m.id));
    assert.equal(new Set(ids).size, 7);
    assert.ok(r.check.ok);
    seen.add(ids.slice().sort().join() + '|' + r.teams[1].members.map((m) => m.id).sort().join());
  }
  assert.ok(seen.size > 1, '재편성 시 다른 조합이 나와야 함');
});

test('날짜 충돌 감지', () => {
  const m = mk(7);
  const r = L.bestDateFor(m);
  for (const c of r.conflicts) assert.equal(c.dates[r.date.id], 0);
});

test('집계', () => {
  const a = L.aggregate(mk(3));
  assert.equal(a.n, 3); assert.equal(a.pending, 4);
  const d = a.dates.find((x) => x.id === 'd0207');
  assert.equal(d.prefer, 3);
  assert.equal(a.transport.find((x) => x.id === 'busan').count, 3);
});

test('설정값 미입력 감지', () => {
  assert.equal(L.isConfigured({ apiKey: 'YOUR_API_KEY', authDomain: 'x', projectId: 'x', appId: 'x' }), false);
  assert.equal(L.isConfigured({ apiKey: 'AIza123', authDomain: 'p.firebaseapp.com', projectId: 'p', appId: '1:2:web:3' }), true);
});
