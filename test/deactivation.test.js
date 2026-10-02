import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

// 4 孔、容差 0.5：管 A=50 在孔 0，对径孔 2 必须放 50 g 配重 → 冻结图占用 50 g × 1
const cfg = { holes: 4, tolerance: 0.5, holeMaxMass: [100, 100, 100, 100] };
const T = (s) => `2027-01-02T${s}:00.000Z`;

let pubId;

test('准备：50 g × 2，发布可行装载图（占用 50 g × 1）', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] }]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  pubId = pub.json.id;
});

test('非法时间/数量/未知规格/缺原因被拒绝（400）且不留记录', async () => {
  const bad = [
    { mass: 50, quantity: 1, reason: '送检', startUtc: T('10:00'), endUtc: T('10:00') }, // 起点不早于终点
    { mass: 50, quantity: 1, reason: '送检', startUtc: T('11:00'), endUtc: T('10:00') },
    { mass: 50, quantity: 1, reason: '送检', startUtc: 'not-a-time', endUtc: T('10:00') },
    { mass: 50, quantity: 0, reason: '送检', startUtc: T('09:00'), endUtc: T('10:00') }, // 数量非法
    { mass: 50, quantity: 1.5, reason: '送检', startUtc: T('09:00'), endUtc: T('10:00') },
    { mass: 50, quantity: -2, reason: '送检', startUtc: T('09:00'), endUtc: T('10:00') },
    { mass: 999, quantity: 1, reason: '送检', startUtc: T('09:00'), endUtc: T('10:00') }, // 未知规格
    { mass: 50, quantity: 1, reason: '  ', startUtc: T('09:00'), endUtc: T('10:00') }, // 原因空
    { mass: 50, quantity: 1, startUtc: T('09:00'), endUtc: T('10:00') }, // 缺原因
  ];
  for (const body of bad) {
    const r = await call('POST', '/api/deactivations', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const list = await call('GET', '/api/deactivations');
  assert.equal(list.json.length, 0);
});

test('成功登记停用：201，字段回显，未开始可撤销', async () => {
  const r = await call('POST', '/api/deactivations', {
    mass: 50,
    quantity: 1,
    reason: '送检',
    startUtc: T('10:00'),
    endUtc: T('12:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.mass, 50);
  assert.equal(r.json.quantity, 1);
  assert.equal(r.json.reason, '送检');
  assert.equal(r.json.startUtc, T('10:00'));
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.phase, 'notStarted');
  assert.equal(r.json.revocable, true);
});

test('同规格重叠停用累加超量：409 指出规格与冲突时段，不留记录', async () => {
  // 已有 D1 [10,12) 停用 1 枚（当前数量 2）：再停用 2 枚 → [11,12) 内 1+2=3 > 2
  const r = await call('POST', '/api/deactivations', {
    mass: 50,
    quantity: 2,
    reason: '损坏待修',
    startUtc: T('11:00'),
    endUtc: T('13:00'),
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  const c = r.json.detail.conflicts[0];
  assert.equal(c.mass, 50);
  assert.equal(c.required, 2);
  assert.equal(c.capacity, 2);
  assert.equal(c.windows.length, 1);
  assert.equal(c.windows[0].start, T('11:00'));
  assert.equal(c.windows[0].end, T('12:00'));
  assert.equal(c.windows[0].used, 1); // 该窗内既有停用 1 枚

  // 单次停用超过当前数量同样拒绝
  const r2 = await call('POST', '/api/deactivations', {
    mass: 50,
    quantity: 3,
    reason: '整批停用',
    startUtc: T('14:00'),
    endUtc: T('15:00'),
  });
  assert.equal(r2.status, 409);

  const list = await call('GET', '/api/deactivations');
  assert.equal(list.json.length, 1); // 均不留记录
});

test('左闭右开：与既有停用终点相接的起点不累加', async () => {
  const r = await call('POST', '/api/deactivations', {
    mass: 50,
    quantity: 2,
    reason: '外借',
    startUtc: T('12:00'), // 与 D1 的终点相接
    endUtc: T('14:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('停用影响新预约：占用 + 停用超出库存整单拒绝（409）', async () => {
  // D1 [10,12) 停用 1 枚，当前数量 2 → 余量 1；预约需 1 枚 → 通过
  const ok = await call('POST', '/api/reservations', {
    batchNo: 'R1',
    publicationId: pubId,
    startUtc: T('10:30'),
    endUtc: T('11:00'),
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));

  // 再约 [10:30,11:30)：在 [10:30,11:00) 内 占用1 + 停用1 + 本次1 = 3 > 2 → 整单拒绝
  const r = await call('POST', '/api/reservations', {
    batchNo: 'R2',
    publicationId: pubId,
    startUtc: T('10:30'),
    endUtc: T('11:30'),
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  const c = r.json.detail.conflicts[0];
  assert.equal(c.mass, 50);
  assert.equal(c.capacity, 2);
  assert.equal(c.required, 1);
  assert.equal(c.windows.length, 1);
  assert.equal(c.windows[0].start, T('10:30'));
  assert.equal(c.windows[0].end, T('11:00'));
  assert.equal(c.windows[0].used, 1); // 既有预约占用
  assert.equal(c.windows[0].deactivated, 1); // 同期停用
  assert.ok(r.json.errors.join(' ').includes('停用 1 枚'));
  // 整单拒绝：预约列表只有 R1
  const list = await call('GET', '/api/reservations');
  assert.equal(list.json.filter((x) => x.status === 'active').length, 1);
});

test('停用可与既有预约重叠：登记停用只与同规格停用累加', async () => {
  // R1 [10:30,11:00) 已占用 1 枚；D3 与 R1 完全重叠仍允许登记
  // （停用校验：D1(1) + D3(1) = 2 ≤ 当前数量 2）
  const r = await call('POST', '/api/deactivations', {
    mass: 50,
    quantity: 1,
    reason: '临时封存',
    startUtc: T('10:30'),
    endUtc: T('11:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // 既有预约不被改写
  const list = await call('GET', '/api/reservations');
  const r1 = list.json.find((x) => x.batchNo === 'R1');
  assert.equal(r1.status, 'active');
  assert.deepEqual(r1.usage, [{ mass: 50, count: 1 }]);
});

test('日程：另展示停用量与「占用加停用」不足区段；不足字段含义不变', async () => {
  // 当前：R1 [10:30,11:00) 占用 1；D1 [10,12) 停用 1；D3 [10:30,11:00) 停用 1；数量 2
  const sch = await call(
    'GET',
    `/api/schedule?from=${T('10:00')}&to=${T('12:00')}`,
  );
  const spec = sch.json.specs.find((s) => s.mass === 50);
  assert.equal(spec.capacity, 2);
  assert.equal(spec.peak, 1); // 预约占用峰值（含义不变）
  assert.equal(spec.shortage, false); // 占用未超当前数量
  assert.equal(spec.deactivatedPeak, 2); // 停用峰值
  assert.equal(spec.combinedShortage, true); // [10:30,11:00) 占用1+停用2=3 > 2

  const seg = (start, end) =>
    spec.segments.find((g) => g.start === start && g.end === end);
  // 纯停用区段也展示
  assert.deepEqual(
    { used: seg(T('10:00'), T('10:30')).used, deactivated: seg(T('10:00'), T('10:30')).deactivated },
    { used: 0, deactivated: 1 },
  );
  const mid = seg(T('10:30'), T('11:00'));
  assert.equal(mid.used, 1);
  assert.equal(mid.deactivated, 2);
  assert.equal(mid.shortage, false); // 占用 1 ≤ 2：不足字段只看占用
  assert.equal(mid.combinedShortage, true); // 占用+停用 3 > 2

  // 数量减少不改写既有数据：容量降为 0 后占用本身即不足
  await call('PUT', '/api/weights', []);
  const sch2 = await call(
    'GET',
    `/api/schedule?from=${T('10:00')}&to=${T('12:00')}`,
  );
  const spec2 = sch2.json.specs.find((s) => s.mass === 50);
  assert.equal(spec2.capacity, 0);
  assert.equal(spec2.shortage, true); // 占用 1 > 0
  assert.equal(spec2.combinedShortage, true);
  // 恢复数量（数据指纹复原，发布记录重新可用）
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);
});

test('撤销：仅未开始可撤销；撤销留历史、幂等且释放后续容量', async () => {
  const list0 = await call('GET', '/api/deactivations');
  const d2 = list0.json.find((d) => d.reason === '外借'); // [12,14) 停用 2 枚

  // 未开始 → 可撤销
  let r = await call('POST', `/api/deactivations/${d2.id}/revoke`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'revoked');
  assert.equal(r.json.phase, 'revoked');
  assert.equal(r.json.revocable, false);
  assert.ok(r.json.revokedAt);

  // 重复撤销幂等返回原记录
  r = await call('POST', `/api/deactivations/${d2.id}/revoke`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'revoked');

  // 历史保留
  const list1 = await call('GET', '/api/deactivations');
  assert.equal(list1.json.find((d) => d.id === d2.id).status, 'revoked');

  // 容量已释放：同时段可重新登记 2 枚
  r = await call('POST', '/api/deactivations', {
    mass: 50,
    quantity: 2,
    reason: '重新登记',
    startUtc: T('12:00'),
    endUtc: T('14:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('撤销生效停用后，新预约容量随之释放', async () => {
  // [10:30,11:00) 现有：R1 占用 1 + D1 停用 1 + D3 停用 1 → 新预约 1 枚超限
  const blocked = await call('POST', '/api/reservations', {
    batchNo: 'R3',
    publicationId: pubId,
    startUtc: T('10:30'),
    endUtc: T('11:00'),
  });
  assert.equal(blocked.status, 409);

  // 撤销 D1 与 D3（均未开始）后：仅 R1 占用 1 + 本次 1 = 2 ≤ 2 → 通过
  const list = await call('GET', '/api/deactivations');
  for (const reason of ['送检', '临时封存']) {
    const d = list.json.find((x) => x.reason === reason);
    const rv = await call('POST', `/api/deactivations/${d.id}/revoke`);
    assert.equal(rv.status, 200);
  }
  const ok = await call('POST', '/api/reservations', {
    batchNo: 'R3',
    publicationId: pubId,
    startUtc: T('10:30'),
    endUtc: T('11:00'),
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
});

test('已开始的停用不能撤销（409）；未知记录 404', async () => {
  const now = Date.now();
  const r = await call('POST', '/api/deactivations', {
    mass: 50,
    quantity: 1,
    reason: '进行中停用',
    startUtc: new Date(now - 3600e3).toISOString(), // 1 小时前已开始
    endUtc: new Date(now + 3600e3).toISOString(),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.phase, 'ongoing');
  assert.equal(r.json.revocable, false);

  const c = await call('POST', `/api/deactivations/${r.json.id}/revoke`);
  assert.equal(c.status, 409);
  assert.ok(c.json.errors.join(' ').includes('未开始'));
  // 状态仍生效
  const fresh = await call('GET', `/api/deactivations/${r.json.id}`);
  assert.equal(fresh.json.status, 'active');

  const nf = await call('POST', '/api/deactivations/9999/revoke');
  assert.equal(nf.status, 404);
  const nf2 = await call('GET', '/api/deactivations/9999');
  assert.equal(nf2.status, 404);
});

test('状态接口携带停用列表；日程缺省窗口覆盖生效中停用', async () => {
  const s = await call('GET', '/api/state');
  assert.ok(Array.isArray(s.json.deactivations));
  assert.ok(s.json.deactivations.length >= 4);
  // 缺省 from/to：覆盖全部生效中预约与停用
  const sch = await call('GET', '/api/schedule');
  const spec = sch.json.specs.find((x) => x.mass === 50);
  assert.ok(spec);
  assert.ok(spec.segments.some((g) => g.deactivated > 0));
});
