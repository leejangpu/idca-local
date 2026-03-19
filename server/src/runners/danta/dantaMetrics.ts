/**
 * 단타 v1 — 메트릭 수집
 *
 * in-memory 카운터 + 분포 추적.
 * 일일 요약 시 스냅샷 후 리셋.
 * 날짜가 바뀌면 자동 리셋.
 */

import { getKSTDateString } from '../../lib/marketUtils';

// ========================================
// Metric key 상수
// ========================================

export const M = {
  // 후보 퍼널
  CAND_RECEIVED: 'cand.received',
  CAND_NEW: 'cand.new',
  CAND_FILTER_OCCUPIED: 'cand.filter.occupied',
  CAND_FILTER_POSITION: 'cand.filter.position',
  CAND_FILTER_DUPLICATE: 'cand.filter.duplicate',
  CAND_FILTER_COOLDOWN: 'cand.filter.cooldown',
  CAND_FILTER_WINDOW: 'cand.filter.window',
  CAND_FILTER_PREFERRED: 'cand.filter.preferred',
  CAND_TRIGGER_OK: 'cand.trigger.ok',
  CAND_TRIGGER_FAIL: 'cand.trigger.fail',
  CAND_EXPIRED_TTL: 'cand.expired.ttl',
  CAND_EXPIRED_3MIN: 'cand.expired.3min',
  CAND_INVALIDATED: 'cand.invalidated',
  PHASE_NEW_TO_WAIT: 'phase.new_to_wait',
  PHASE_WAIT_TO_READY: 'phase.wait_to_ready',
  PHASE_WAIT_TO_INVALID: 'phase.wait_to_invalid',
  PHASE_READY_TO_INVALID: 'phase.ready_to_invalid',

  // 진입
  ENTRY_ATTEMPT: 'entry.attempt',
  ENTRY_SUCCESS: 'entry.success',
  ENTRY_BLOCK_SLOT: 'entry.block.slot',
  ENTRY_BLOCK_COOLDOWN: 'entry.block.cooldown',
  ENTRY_BLOCK_DUPLICATE: 'entry.block.duplicate',
  ENTRY_BLOCK_REENTRY: 'entry.block.reentry',
  ENTRY_BLOCK_CROSS: 'entry.block.cross',
  ENTRY_BLOCK_QTY: 'entry.block.qty_zero',
  ENTRY_BLOCK_ORDER: 'entry.block.order_fail',
  ENTRY_SKIP_STALE: 'entry.skip.stale_cache',
  ENTRY_SKIP_FALLBACK: 'entry.skip.fallback_minbar',

  // 청산
  EXIT_TARGET: 'exit.target',
  EXIT_STOP_LOSS: 'exit.stop_loss',
  EXIT_TIME_STOP: 'exit.time_stop',
  EXIT_MARKET_CLOSE: 'exit.market_close',

  // 시스템
  SYS_FALLBACK_EVENT: 'sys.fallback.event',
  SYS_SAFEMODE_EVENT: 'sys.safemode.event',
  SYS_MINBAR_FAIL: 'sys.minbar.fail',
  SYS_ERROR: 'sys.error',

  // 분포 (record 용)
  DIST_CAND_SURVIVAL: 'dist.cand.survival_ms',
  DIST_HOLD_TIME: 'dist.hold_time_ms',
  DIST_MFE: 'dist.mfe_pct',
  DIST_MAE: 'dist.mae_pct',
  DIST_LOOP_POLL: 'dist.loop.poll_ms',
  DIST_LOOP_ENTRY: 'dist.loop.entry_ms',
  DIST_LOOP_POSITION: 'dist.loop.position_ms',
  DIST_ENTRY_PRICE: 'dist.entry.price',
  DIST_ENTRY_LATENCY: 'dist.entry.latency_ms',
} as const;

// ========================================
// 내부 저장소
// ========================================

interface MetricsBag {
  date: string;
  counters: Map<string, number>;
  distributions: Map<string, number[]>;
}

const bags = new Map<string, MetricsBag>();

function getBag(accountId: string): MetricsBag {
  const today = getKSTDateString();
  let bag = bags.get(accountId);
  if (!bag || bag.date !== today) {
    bag = { date: today, counters: new Map(), distributions: new Map() };
    bags.set(accountId, bag);
  }
  return bag;
}

// ========================================
// 카운터 / 분포 조작
// ========================================

export function inc(accountId: string, key: string, amount = 1): void {
  const bag = getBag(accountId);
  bag.counters.set(key, (bag.counters.get(key) ?? 0) + amount);
}

export function record(accountId: string, key: string, value: number): void {
  const bag = getBag(accountId);
  const arr = bag.distributions.get(key);
  if (arr) {
    arr.push(value);
  } else {
    bag.distributions.set(key, [value]);
  }
}

// ========================================
// 스냅샷
// ========================================

interface DistSummary {
  count: number;
  avg: number;
  min: number;
  max: number;
  median: number;
  p90: number;
}

export interface MetricsSnapshot {
  date: string;
  counters: Record<string, number>;
  distributions: Record<string, DistSummary>;
}

function summarizeDist(arr: number[]): DistSummary {
  if (arr.length === 0) return { count: 0, avg: 0, min: 0, max: 0, median: 0, p90: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    avg: Number((sum / sorted.length).toFixed(2)),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
  };
}

export function getSnapshot(accountId: string): MetricsSnapshot {
  const bag = getBag(accountId);
  const counters: Record<string, number> = {};
  for (const [k, v] of bag.counters) counters[k] = v;

  const distributions: Record<string, DistSummary> = {};
  for (const [k, v] of bag.distributions) distributions[k] = summarizeDist(v);

  return { date: bag.date, counters, distributions };
}

export function resetDaily(accountId: string): void {
  bags.delete(accountId);
}

// ========================================
// 리포트 생성
// ========================================

export function generateReport(accountId: string): string {
  const snap = getSnapshot(accountId);
  const c = (key: string) => snap.counters[key] ?? 0;
  const d = (key: string) => snap.distributions[key] ?? { count: 0, avg: 0, min: 0, max: 0, median: 0, p90: 0 };

  const totalExits = c(M.EXIT_TARGET) + c(M.EXIT_STOP_LOSS)
    + c(M.EXIT_TIME_STOP) + c(M.EXIT_MARKET_CLOSE);
  const wins = c(M.EXIT_TARGET);
  const losses = totalExits - wins;
  const winRate = totalExits > 0 ? (wins / totalExits * 100).toFixed(1) : '0.0';

  // 전환율
  const candNew = c(M.CAND_NEW);
  const entrySuccess = c(M.ENTRY_SUCCESS);
  const candToEntry = candNew > 0 ? (entrySuccess / candNew * 100).toFixed(1) : '0.0';
  const triggerOk = c(M.CAND_TRIGGER_OK);
  const triggerToEntry = triggerOk > 0 ? (entrySuccess / triggerOk * 100).toFixed(1) : '0.0';

  // exit reason 분포 (%)
  const exitPct = (key: string) => totalExits > 0 ? (c(key) / totalExits * 100).toFixed(1) : '0.0';

  const mfe = d(M.DIST_MFE);
  const mae = d(M.DIST_MAE);
  const hold = d(M.DIST_HOLD_TIME);
  const survival = d(M.DIST_CAND_SURVIVAL);
  const entryLatency = d(M.DIST_ENTRY_LATENCY);

  // 가격대별 진입 분포
  const bag = getBag(accountId);
  const rawPrices = bag.distributions.get(M.DIST_ENTRY_PRICE) ?? [];
  let priceTierStr = '(데이터 없음)';
  if (rawPrices.length > 0) {
    const tiers: Record<string, number> = {};
    for (const p of rawPrices) {
      let tier: string;
      if (p < 5_000) tier = '~5K';
      else if (p < 20_000) tier = '5K~20K';
      else if (p < 50_000) tier = '20K~50K';
      else if (p < 200_000) tier = '50K~200K';
      else tier = '200K~';
      tiers[tier] = (tiers[tier] ?? 0) + 1;
    }
    priceTierStr = Object.entries(tiers)
      .sort(([, a], [, b]) => b - a)
      .map(([tier, cnt]) => `${tier}=${cnt}`)
      .join(', ');
  }

  const lines: string[] = [
    `=== 단타 v1 일일 리포트 (${snap.date}) ===`,
    '',
    '[후보 퍼널]',
    `  조건검색 수신: ${c(M.CAND_RECEIVED)}건 / 신규 등록: ${candNew}건`,
    `  필터 탈락: 타전략=${c(M.CAND_FILTER_OCCUPIED)}, 보유중=${c(M.CAND_FILTER_POSITION)}, ` +
    `풀중복=${c(M.CAND_FILTER_DUPLICATE)}, 쿨다운=${c(M.CAND_FILTER_COOLDOWN)}, ` +
    `우선주=${c(M.CAND_FILTER_PREFERRED)}, 윈도우외=${c(M.CAND_FILTER_WINDOW)}`,
    `  triggerHigh: 성공 ${triggerOk} / 실패 ${c(M.CAND_TRIGGER_FAIL)}`,
    `  전이: NEW→WAIT=${c(M.PHASE_NEW_TO_WAIT)}, WAIT→READY=${c(M.PHASE_WAIT_TO_READY)}, ` +
    `WAIT→INVALID=${c(M.PHASE_WAIT_TO_INVALID)}, READY→INVALID=${c(M.PHASE_READY_TO_INVALID)}`,
    `  만료: TTL=${c(M.CAND_EXPIRED_TTL)}, 3분=${c(M.CAND_EXPIRED_3MIN)}, 무효=${c(M.CAND_INVALIDATED)}`,
    `  후보 평균 생존: avg=${(survival.avg / 1000).toFixed(1)}s, median=${(survival.median / 1000).toFixed(1)}s, p90=${(survival.p90 / 1000).toFixed(1)}s (${survival.count}건)`,
    `  전환율: 신규→진입 ${candToEntry}%, trigger→진입 ${triggerToEntry}%`,
    '',
    '[진입]',
    `  시도: ${c(M.ENTRY_ATTEMPT)} / 성공: ${entrySuccess}`,
    `  차단: 슬롯=${c(M.ENTRY_BLOCK_SLOT)}, 쿨다운=${c(M.ENTRY_BLOCK_COOLDOWN)}, ` +
    `중복=${c(M.ENTRY_BLOCK_DUPLICATE)}, 재진입=${c(M.ENTRY_BLOCK_REENTRY)}, ` +
    `타전략=${c(M.ENTRY_BLOCK_CROSS)}, 수량0=${c(M.ENTRY_BLOCK_QTY)}, 주문실패=${c(M.ENTRY_BLOCK_ORDER)}`,
    `  skip: 캐시stale=${c(M.ENTRY_SKIP_STALE)}, fallback분봉=${c(M.ENTRY_SKIP_FALLBACK)}`,
    `  등록→진입 소요: avg=${(entryLatency.avg / 1000).toFixed(1)}s, median=${(entryLatency.median / 1000).toFixed(1)}s, p90=${(entryLatency.p90 / 1000).toFixed(1)}s`,
    `  진입 가격대: ${priceTierStr}`,
    '',
    '[청산]',
    `  총 ${totalExits}건: 익절=${c(M.EXIT_TARGET)}(${exitPct(M.EXIT_TARGET)}%), ` +
    `손절=${c(M.EXIT_STOP_LOSS)}(${exitPct(M.EXIT_STOP_LOSS)}%), ` +
    `시간청산=${c(M.EXIT_TIME_STOP)}(${exitPct(M.EXIT_TIME_STOP)}%), ` +
    `장마감=${c(M.EXIT_MARKET_CLOSE)}(${exitPct(M.EXIT_MARKET_CLOSE)}%)`,
    `  시간청산 비율: ${exitPct(M.EXIT_TIME_STOP)}% — 높으면 진입 타이밍/시간청산 기준 재검토 필요`,
    `  보유시간: avg=${(hold.avg / 1000).toFixed(1)}s, median=${(hold.median / 1000).toFixed(1)}s, p90=${(hold.p90 / 1000).toFixed(1)}s`,
    `  MFE: avg=${mfe.avg.toFixed(3)}%, max=${mfe.max.toFixed(3)}%`,
    `  MAE: avg=${mae.avg.toFixed(3)}%, min=${mae.min.toFixed(3)}%`,
    `  승률: ${winRate}% (${wins}W/${losses}L)`,
    '',
    '[시스템]',
    `  fallback 발생: ${c(M.SYS_FALLBACK_EVENT)}회`,
    `  safe mode 진입: ${c(M.SYS_SAFEMODE_EVENT)}회`,
    `  캐시 stale skip: ${c(M.ENTRY_SKIP_STALE)}회`,
    `  분봉 조회 실패: ${c(M.SYS_MINBAR_FAIL)}회`,
    `  에러: ${c(M.SYS_ERROR)}건`,
    `  루프 실행시간: poll avg=${d(M.DIST_LOOP_POLL).avg.toFixed(0)}ms, ` +
    `entry avg=${d(M.DIST_LOOP_ENTRY).avg.toFixed(0)}ms, ` +
    `position avg=${d(M.DIST_LOOP_POSITION).avg.toFixed(0)}ms`,
  ];

  return lines.join('\n');
}
