// 配重块时段预约与临时停用（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 时段一律按左闭右开 [start, end) 计算：终点与起点相接的两个预约互不重叠；
//   - 每条预约按其所依据的冻结装载图统计各质量规格的占用量；
//   - 任一时刻、任一质量规格，全部生效中（未取消）预约的占用总量加上生效中
//     （未撤销）停用的停用总量，不得超过当前录入的可选数量；
//   - 停用登记只与同规格生效中停用累加比较（不超过登记时该规格当前数量），
//     可与既有预约重叠；既有预约/停用均不因后续数据变化而被改写；
//   - 判定一律使用「当前录入数量」与「当前图可用性」；日程中占用超限区段
//     标记为「不足」，另展示停用量与「占用加停用」超限的不足区段。

// ISO 8601 形状（允许日期型、空格分隔、省略秒、省略时区——省略时区按 UTC 处理）
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:\s*(?:Z|z|[+-]\d{2}:?\d{2}))?)?$/;

// 解析 UTC 时间字符串 → 毫秒时间戳；非法返回 null。
export function parseUtcMs(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!ISO_RE.test(v)) return null;
  let norm = v.replace(' ', 'T');
  if (!/[T]/.test(norm)) norm += 'T00:00:00';
  if (!/(?:Z|z|[+-]\d{2}:?\d{2})$/.test(norm)) norm += 'Z';
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : ms;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

// ---------- 冻结图占用统计 ----------
// publication: getPublication 返回的冻结记录（含 result.arrangement）。
// 返回 [{mass, count}]（按质量升序），仅含配重块；纯离心管图为空数组。
export function planUsage(publication) {
  const counts = new Map();
  const arrangement =
    publication && publication.result && Array.isArray(publication.result.arrangement)
      ? publication.result.arrangement
      : [];
  for (const slot of arrangement) {
    if (slot && slot.kind === 'weight' && typeof slot.mass === 'number') {
      counts.set(slot.mass, (counts.get(slot.mass) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([mass, count]) => ({ mass, count }))
    .sort((a, b) => a.mass - b.mass);
}

// ---------- 扫描线：时段内分段常量占用 ----------
// intervals: [{startMs, endMs, count}]（调用前不要求裁剪，函数内裁剪到 [s,e)）。
// 返回 [{startMs, endMs, used}]：在 [s,e) 上占用量分段恒定，相邻段 used 不同；
// 左闭右开语义由「同一时刻先处理结束事件再处理开始事件」保证。
export function occupancySegments(intervals, s, e) {
  const events = [];
  for (const it of intervals) {
    const a = Math.max(it.startMs, s);
    const b = Math.min(it.endMs, e);
    if (a < b && it.count > 0) {
      events.push({ t: a, d: it.count });
      events.push({ t: b, d: -it.count });
    }
  }
  // 同一时刻：结束（负增量）先于开始（正增量）——左闭右开
  events.sort((x, y) => x.t - y.t || x.d - y.d);

  const segments = [];
  let cur = 0;
  let i = 0;
  let prev = s;
  while (i < events.length && events[i].t <= s) {
    cur += events[i].d;
    i += 1;
  }
  while (i < events.length) {
    const t = events[i].t;
    if (t > prev) segments.push({ startMs: prev, endMs: t, used: cur });
    while (i < events.length && events[i].t === t) {
      cur += events[i].d;
      i += 1;
    }
    prev = t;
  }
  if (prev < e) segments.push({ startMs: prev, endMs: e, used: cur });
  return segments;
}

// ---------- 双维度合并：占用（预约）× 停用 ----------
// usedSegs / deactSegs 均为 occupancySegments 的输出（在 [s,e) 上分段恒定、完整覆盖）。
// 返回 [{startMs, endMs, used, deactivated}]：同一时间轴上两个维度分别分段恒定，
// 相邻段的 (used, deactivated) 不完全相同。
export function mergeSegments(usedSegs, deactSegs, s, e) {
  const bounds = new Set([s, e]);
  for (const seg of usedSegs) {
    bounds.add(seg.startMs);
    bounds.add(seg.endMs);
  }
  for (const seg of deactSegs) {
    bounds.add(seg.startMs);
    bounds.add(seg.endMs);
  }
  const pts = [...bounds].sort((a, b) => a - b);
  const at = (segs, t) => {
    for (const seg of segs) {
      if (seg.startMs <= t && t < seg.endMs) return seg.used;
    }
    return 0;
  };
  const out = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a >= b) continue;
    const used = at(usedSegs, a);
    const deactivated = at(deactSegs, a);
    const last = out[out.length - 1];
    if (last && last.endMs === a && last.used === used && last.deactivated === deactivated) {
      last.endMs = b;
    } else {
      out.push({ startMs: a, endMs: b, used, deactivated });
    }
  }
  return out;
}

// 把扁平停用列表 [{startMs, endMs, mass, count}] 中某规格的区间取出
function deactivationIntervals(deactivations, mass) {
  const intervals = [];
  for (const d of deactivations || []) {
    if (d.mass === mass && d.count > 0) {
      intervals.push({ startMs: d.startMs, endMs: d.endMs, count: d.count });
    }
  }
  return intervals;
}

// ---------- 容量判定 ----------
// usage:         本次预约各规格占用 [{mass, count}]
// capacityOf:    (mass) => 当前录入可选数量（无该规格返回 0）
// overlapping:   与 [startMs,endMs) 重叠的生效中预约 [{startMs, endMs, usage:[{mass,count}]}]
// deactivations: 与 [startMs,endMs) 重叠的生效中停用 [{startMs, endMs, mass, count}]（可缺省）
// 判定：任一时刻「既有占用 + 生效停用 + 本次需求 ≤ 当前数量」。
// 返回 { ok, conflicts }；conflicts 元素：
//   { mass, required, capacity, peak, deactivatedPeak,
//     windows:[{start, end, used, deactivated}] }
//   peak/used 仅统计预约占用（保持原字段含义），deactivatedPeak/deactivated 为停用量；
//   windows 为「既有占用 + 停用 + 本次需求 > 当前数量」的合并时段（ISO 字符串，
//   used/deactivated 取窗内峰值）。
export function checkCapacity({ usage, capacityOf, overlapping, deactivations, startMs, endMs }) {
  const conflicts = [];
  for (const u of usage) {
    if (!(u.count > 0)) continue;
    const capacity = capacityOf(u.mass);
    const intervals = [];
    for (const r of overlapping) {
      const ru = (r.usage || []).find((x) => x.mass === u.mass);
      if (ru && ru.count > 0) {
        intervals.push({ startMs: r.startMs, endMs: r.endMs, count: ru.count });
      }
    }
    const usedSegs = occupancySegments(intervals, startMs, endMs);
    const deactSegs = occupancySegments(
      deactivationIntervals(deactivations, u.mass),
      startMs,
      endMs,
    );
    const segments = mergeSegments(usedSegs, deactSegs, startMs, endMs);
    const peak = segments.reduce((m, seg) => Math.max(m, seg.used), 0);
    const deactivatedPeak = segments.reduce((m, seg) => Math.max(m, seg.deactivated), 0);

    // 超限时窗：used + deactivated > capacity - required 的连续段
    // （相邻合并，used/deactivated 各取段内峰值）
    const limit = capacity - u.count;
    const windows = [];
    for (const seg of segments) {
      if (seg.used + seg.deactivated <= limit) continue;
      const last = windows[windows.length - 1];
      if (last && last.endMs === seg.startMs) {
        last.endMs = seg.endMs;
        last.used = Math.max(last.used, seg.used);
        last.deactivated = Math.max(last.deactivated, seg.deactivated);
      } else {
        windows.push({
          startMs: seg.startMs,
          endMs: seg.endMs,
          used: seg.used,
          deactivated: seg.deactivated,
        });
      }
    }
    if (windows.length === 0) continue;
    conflicts.push({
      mass: u.mass,
      required: u.count,
      capacity,
      peak,
      deactivatedPeak,
      windows: windows.map((w) => ({
        start: toIso(w.startMs),
        end: toIso(w.endMs),
        used: w.used,
        deactivated: w.deactivated,
      })),
    });
  }
  return { ok: conflicts.length === 0, conflicts };
}

// ---------- 日程（展示已有占用、停用量及不足） ----------
// reservations: 生效中预约 [{startMs, endMs, usage:[{mass,count}]}]
// deactivations: 生效中停用 [{startMs, endMs, mass, count}]（可缺省）
// masses:       需要展示的规格集合（当前录入规格 ∪ 预约涉及规格 ∪ 停用涉及规格）
// capacityOf:   (mass) => 当前录入可选数量
// 返回 specs: [{mass, capacity, peak, shortage, deactivatedPeak, combinedShortage,
//   segments:[{start, end, used, deactivated, shortage, combinedShortage}]}]
// segments 仅保留 used>0 或 deactivated>0 的区段；
// shortage 保持原含义：该时刻预约占用超过当前数量（不足）；
// combinedShortage：该时刻「占用 + 停用」超过当前数量（占用加停用不足）。
export function buildSchedule({ reservations, deactivations, masses, capacityOf, fromMs, toMs }) {
  const specs = [];
  for (const mass of masses) {
    const capacity = capacityOf(mass);
    const intervals = [];
    for (const r of reservations) {
      const ru = (r.usage || []).find((x) => x.mass === mass);
      if (ru && ru.count > 0) {
        intervals.push({ startMs: r.startMs, endMs: r.endMs, count: ru.count });
      }
    }
    const usedSegs = occupancySegments(intervals, fromMs, toMs);
    const deactSegs = occupancySegments(
      deactivationIntervals(deactivations, mass),
      fromMs,
      toMs,
    );
    const segments = mergeSegments(usedSegs, deactSegs, fromMs, toMs)
      .filter((seg) => seg.used > 0 || seg.deactivated > 0)
      .map((seg) => ({
        start: toIso(seg.startMs),
        end: toIso(seg.endMs),
        used: seg.used,
        deactivated: seg.deactivated,
        shortage: seg.used > capacity,
        combinedShortage: seg.used + seg.deactivated > capacity,
      }));
    const peak = segments.reduce((m, seg) => Math.max(m, seg.used), 0);
    const deactivatedPeak = segments.reduce((m, seg) => Math.max(m, seg.deactivated), 0);
    const combinedPeak = segments.reduce((m, seg) => Math.max(m, seg.used + seg.deactivated), 0);
    specs.push({
      mass,
      capacity,
      peak,
      shortage: peak > capacity,
      deactivatedPeak,
      combinedShortage: combinedPeak > capacity,
      segments,
    });
  }
  return specs;
}
