/**
 * 단타 v1 — 스케줄러 (상시 실행 워커)
 *
 * cron이 아닌 setTimeout 기반 자체 루프로 동작.
 * 3개 독립 루프를 관리하며 각각 다른 주기로 실행:
 *   - candidatePoller: 15초
 *   - entryMonitor: 1초
 *   - positionMonitor: 400ms
 *
 * 장 시간(09:00~15:30 KST) 내에서만 활성화.
 * 서버 시작 시 startDantaWorker() 호출, 종료 시 stopDantaWorker() 호출.
 */

import { type AccountContext } from '../../lib/accountContext';
import { getKRMarketHolidayName, getKSTDateString } from '../../lib/marketUtils';
import {
  type DantaV1Config,
  DEFAULT_DANTA_CONFIG,
} from './dantaTypes';
import {
  candidatePollerTick,
  entryMonitorTick,
  positionMonitorTick,
  forceCloseOrphanPositions,
  getCandidatePool,
  setMarketDataProvider,
  getMarketDataProvider,
} from './dantaEngine';
import { logError, logDailySummary } from './dantaLogger';
import { createMarketDataProvider } from './dantaMarketData';
import { record, M, generateReport, getSnapshot, resetDaily } from './dantaMetrics';
import { sendTelegramMessage, getUserTelegramChatId } from '../../lib/telegram';

const TAG = '[DantaV1:Scheduler]';

// ========================================
// 워커 상태
// ========================================

interface WorkerState {
  accountId: string;
  running: boolean;
  candidateTimer: ReturnType<typeof setTimeout> | null;
  entryTimer: ReturnType<typeof setTimeout> | null;
  positionTimer: ReturnType<typeof setTimeout> | null;
  marketCheckTimer: ReturnType<typeof setTimeout> | null;
  loopsActive: boolean;
  dailySummaryDone: boolean;
}

const workers = new Map<string, WorkerState>();

// ========================================
// 장 시간 체크
// ========================================

function getKSTNow(): { kstTime: Date; kstMinute: number } {
  const kstTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const kstMinute = kstTime.getHours() * 60 + kstTime.getMinutes();
  return { kstTime, kstMinute };
}

function isMarketOpen(): boolean {
  const { kstTime, kstMinute } = getKSTNow();
  // 공휴일 체크
  if (getKRMarketHolidayName(kstTime)) return false;
  // 주말 체크
  const day = kstTime.getDay();
  if (day === 0 || day === 6) return false;
  // 09:00 ~ 15:30
  return kstMinute >= 540 && kstMinute <= 930;
}

// ========================================
// 설정 로드
// ========================================

function validateConfig(config: DantaV1Config): string[] {
  const errors: string[] = [];

  if (!config.conditionSeq) errors.push('conditionSeq is required');
  if (!config.htsUserId) errors.push('htsUserId is required');
  if (config.amountPerStock <= 0) errors.push(`amountPerStock must be > 0 (got ${config.amountPerStock})`);
  if (config.maxSlots < 1 || config.maxSlots > 10) errors.push(`maxSlots must be 1~10 (got ${config.maxSlots})`);
  if (config.targetTicks < 1) errors.push(`targetTicks must be >= 1 (got ${config.targetTicks})`);
  if (config.stopTicks < 1) errors.push(`stopTicks must be >= 1 (got ${config.stopTicks})`);
  if (config.timeStopSec < 5) errors.push(`timeStopSec must be >= 5 (got ${config.timeStopSec})`);
  if (config.candidatePollIntervalMs < 5_000) errors.push(`candidatePollIntervalMs must be >= 5000 (got ${config.candidatePollIntervalMs})`);
  if (config.entryMonitorIntervalMs < 200) errors.push(`entryMonitorIntervalMs must be >= 200 (got ${config.entryMonitorIntervalMs})`);
  if (config.positionMonitorIntervalMs < 100) errors.push(`positionMonitorIntervalMs must be >= 100 (got ${config.positionMonitorIntervalMs})`);
  if (config.entryStartMinute >= config.entryEndMinute) errors.push(`entryStartMinute(${config.entryStartMinute}) must be < entryEndMinute(${config.entryEndMinute})`);
  if (config.costRatePct < 0 || config.costRatePct > 5) errors.push(`costRatePct must be 0~5 (got ${config.costRatePct})`);

  return errors;
}

function loadConfig(ctx: AccountContext): DantaV1Config | null {
  const stored = ctx.store.getStrategyConfig<Partial<DantaV1Config>>('domestic', 'dantaV1');
  if (!stored?.enabled) return null;

  const config = {
    ...DEFAULT_DANTA_CONFIG,
    ...stored,
    htsUserId: stored.htsUserId || ctx.credentials.htsUserId || '',
    conditionSeq: stored.conditionSeq || '',
    conditionName: stored.conditionName || '',
  } as DantaV1Config;

  // Real mode 안전 가드: pending_buy/pending_sell 체결확인 미구현
  if (!config.shadowMode) {
    console.error(`${TAG} Real mode blocked — pending order lifecycle not implemented. Set shadowMode=true.`);
    return null;
  }

  // 설정값 검증
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error(`${TAG} Config validation failed:\n  ${errors.join('\n  ')}`);
    return null;
  }

  return config;
}

// ========================================
// 루프 실행기 (setTimeout 기반, 겹침 방지)
// ========================================

// 루프 이름 → 메트릭 키 매핑
const loopMetricKey: Record<string, string> = {
  CandidatePoller: M.DIST_LOOP_POLL,
  EntryMonitor: M.DIST_LOOP_ENTRY,
  PositionMonitor: M.DIST_LOOP_POSITION,
};

function scheduleLoop(
  ws: WorkerState,
  name: string,
  fn: () => Promise<void>,
  intervalMs: number,
  timerKey: 'candidateTimer' | 'entryTimer' | 'positionTimer',
): void {
  if (!ws.running || !ws.loopsActive) return;

  const run = async () => {
    if (!ws.running || !ws.loopsActive) return;

    const start = Date.now();
    try {
      await fn();
    } catch (err) {
      console.error(`${TAG} ${name} unhandled error:`, err);
    }

    // 루프 실행 시간 메트릭
    const elapsed = Date.now() - start;
    const metricKey = loopMetricKey[name];
    if (metricKey) record(ws.accountId, metricKey, elapsed);

    // 다음 실행 예약 (실행 시간을 빼서 drift 보정)
    const nextDelay = Math.max(0, intervalMs - elapsed);

    if (ws.running && ws.loopsActive) {
      ws[timerKey] = setTimeout(run, nextDelay);
    }
  };

  ws[timerKey] = setTimeout(run, intervalMs);
}

// ========================================
// 루프 시작/정지
// ========================================

async function startLoops(ws: WorkerState, ctx: AccountContext, config: DantaV1Config): Promise<void> {
  if (ws.loopsActive) return;
  ws.loopsActive = true;

  // MarketDataProvider 시작 (WebSocket 우선, 실패 시 내부에서 REST fallback)
  try {
    const provider = createMarketDataProvider(ctx, 'websocket');
    setMarketDataProvider(ctx.accountId, provider);
    await provider.start();
    console.log(`${TAG} MarketDataProvider started (${provider.type})`);
  } catch (err) {
    console.error(`${TAG} MarketDataProvider start failed:`, err);
    // provider 없이도 엔진은 REST fallback으로 동작 가능
  }

  console.log(`${TAG} Loops started (${ctx.accountId}) — ` +
    `poll=${config.candidatePollIntervalMs}ms, entry=${config.entryMonitorIntervalMs}ms, ` +
    `position=${config.positionMonitorIntervalMs}ms, shadow=${config.shadowMode}`);

  // Candidate Poller
  scheduleLoop(ws, 'CandidatePoller',
    () => candidatePollerTick(ctx, config),
    config.candidatePollIntervalMs,
    'candidateTimer',
  );

  // Entry Monitor
  scheduleLoop(ws, 'EntryMonitor',
    () => entryMonitorTick(ctx, config),
    config.entryMonitorIntervalMs,
    'entryTimer',
  );

  // Position Monitor
  scheduleLoop(ws, 'PositionMonitor',
    () => positionMonitorTick(ctx, config),
    config.positionMonitorIntervalMs,
    'positionTimer',
  );
}

async function stopLoops(ws: WorkerState): Promise<void> {
  ws.loopsActive = false;
  if (ws.candidateTimer) { clearTimeout(ws.candidateTimer); ws.candidateTimer = null; }
  if (ws.entryTimer) { clearTimeout(ws.entryTimer); ws.entryTimer = null; }
  if (ws.positionTimer) { clearTimeout(ws.positionTimer); ws.positionTimer = null; }

  // MarketDataProvider 정지
  const provider = getMarketDataProvider(ws.accountId);
  if (provider) {
    await provider.stop();
    console.log(`${TAG} MarketDataProvider stopped`);
  }

  console.log(`${TAG} Loops stopped (${ws.accountId})`);
}

// ========================================
// 마켓 체크 루프 (30초마다 장 시간 확인)
// ========================================

function startMarketCheck(ws: WorkerState, ctx: AccountContext): void {
  const check = async () => {
    if (!ws.running) return;

    const config = loadConfig(ctx);

    if (!config) {
      // 비활성화됨
      if (ws.loopsActive) stopLoops(ws);
      ws.marketCheckTimer = setTimeout(check, 30_000);
      return;
    }

    if (isMarketOpen()) {
      if (!ws.loopsActive) {
        ws.dailySummaryDone = false;
        startLoops(ws, ctx, config);
      }
    } else {
      if (ws.loopsActive) {
        // 잔존 포지션 강제 청산 (safety net)
        await forceCloseOrphanPositions(ctx, config);

        stopLoops(ws);

        // 장 종료 후 일일 요약 (1회)
        if (!ws.dailySummaryDone) {
          ws.dailySummaryDone = true;
          writeDailySummary(ctx, config);

          // 후보 풀 초기화
          const pool = getCandidatePool(ctx.accountId);
          pool.clear();
        }
      }
    }

    ws.marketCheckTimer = setTimeout(check, 30_000);
  };

  // 즉시 1회 실행
  check();
}

function writeDailySummary(ctx: AccountContext, config: DantaV1Config): void {
  try {
    const todayStr = getKSTDateString();
    const collection = config.shadowMode ? 'dantaShadowLogs' : 'dantaTradeLogs';
    const logs = ctx.store.getLogs<{ type: string; profitAmount?: number; netPnlPct?: number; exitReason?: string }>(
      collection, todayStr,
    );

    const exits = logs.filter(l => l.type === 'EXIT');
    const wins = exits.filter(l => (l.profitAmount ?? 0) > 0);
    const losses = exits.filter(l => (l.profitAmount ?? 0) <= 0);

    logDailySummary({
      totalTrades: exits.length,
      wins: wins.length,
      losses: losses.length,
      totalPnl: exits.reduce((sum, l) => sum + (l.profitAmount ?? 0), 0),
      netPnl: exits.reduce((sum, l) => sum + (l.profitAmount ?? 0), 0),
      shadowMode: config.shadowMode,
    }, ctx);

    // 메트릭 리포트 출력 + 로그 저장
    const report = generateReport(ctx.accountId);
    console.log(report);

    const snapshot = getSnapshot(ctx.accountId);
    ctx.store.appendLog('dantaScanLogs', todayStr, {
      type: 'METRICS_SNAPSHOT',
      ...snapshot,
      shadowMode: config.shadowMode,
      timestamp: new Date().toISOString(),
    });

    // 텔레그램 일일 요약 발송
    sendDantaDailySummaryTelegram(todayStr, exits, config.shadowMode).catch(err => {
      console.error(`${TAG} Telegram send failed:`, err);
    });

    // 다음날을 위해 리셋
    resetDaily(ctx.accountId);
  } catch (err) {
    logError('dailySummary', err, ctx);
  }
}

// ========================================
// 텔레그램 일일 요약
// ========================================

async function sendDantaDailySummaryTelegram(
  dateStr: string,
  exits: Array<{ profitAmount?: number; netPnlPct?: number; exitReason?: string }>,
  shadowMode: boolean,
): Promise<void> {
  const chatId = await getUserTelegramChatId();
  if (!chatId) return;

  const totalTrades = exits.length;
  if (totalTrades === 0) {
    const msg = `<b>📊 단타${shadowMode ? '(shadow)' : ''} ${dateStr}</b>\n거래 없음`;
    await sendTelegramMessage(chatId, msg);
    return;
  }

  const wins = exits.filter(l => (l.profitAmount ?? 0) > 0).length;
  const losses = totalTrades - wins;
  const winRate = (wins / totalTrades * 100).toFixed(1);
  const totalPnl = exits.reduce((sum, l) => sum + (l.profitAmount ?? 0), 0);
  const avgPnlPct = exits.reduce((sum, l) => sum + (l.netPnlPct ?? 0), 0) / totalTrades;

  // exit reason 분포
  const reasons: Record<string, number> = {};
  for (const e of exits) {
    const r = e.exitReason ?? 'unknown';
    reasons[r] = (reasons[r] ?? 0) + 1;
  }
  const reasonLabels: Record<string, string> = {
    target: '익절', stop_loss: '손절', time_stop: '시간청산', market_close: '장마감',
  };
  const reasonStr = Object.entries(reasons)
    .map(([r, cnt]) => `${reasonLabels[r] || r} ${cnt}건`)
    .join(' / ');

  const sign = totalPnl >= 0 ? '+' : '';
  const emoji = totalPnl >= 0 ? '📈' : '📉';

  const msg = [
    `<b>${emoji} 단타${shadowMode ? '(shadow)' : ''} ${dateStr}</b>`,
    '',
    `승률: <b>${winRate}%</b> (${wins}W/${losses}L, 총 ${totalTrades}건)`,
    `수익: <b>${sign}${totalPnl.toLocaleString()}원</b>`,
    `평균: ${sign}${avgPnlPct.toFixed(2)}%/건 (비용 차감)`,
    `청산: ${reasonStr}`,
  ].join('\n');

  await sendTelegramMessage(chatId, msg);
}

// ========================================
// Public API
// ========================================

/**
 * 단타 v1 워커 시작.
 * 서버 시작 시 1회 호출. 이후 장 시간에 따라 자동으로 루프를 켜고 끔.
 */
export function startDantaWorker(ctx: AccountContext): void {
  const accountId = ctx.accountId;

  if (workers.has(accountId)) {
    console.log(`${TAG} Worker already running for ${accountId}`);
    return;
  }

  const ws: WorkerState = {
    accountId,
    running: true,
    candidateTimer: null,
    entryTimer: null,
    positionTimer: null,
    marketCheckTimer: null,
    loopsActive: false,
    dailySummaryDone: false,
  };

  workers.set(accountId, ws);

  console.log(`${TAG} Worker started for ${accountId}/${ctx.nickname}`);
  startMarketCheck(ws, ctx);
}

/**
 * 단타 v1 워커 정지.
 */
export function stopDantaWorker(accountId: string): void {
  const ws = workers.get(accountId);
  if (!ws) return;

  ws.running = false;
  stopLoops(ws);
  if (ws.marketCheckTimer) { clearTimeout(ws.marketCheckTimer); ws.marketCheckTimer = null; }
  workers.delete(accountId);

  console.log(`${TAG} Worker stopped for ${accountId}`);
}

/**
 * 워커 상태 조회 (모니터링/UI용)
 */
export function getDantaWorkerStatus(accountId: string): {
  running: boolean;
  loopsActive: boolean;
  candidateCount: number;
} {
  const ws = workers.get(accountId);
  if (!ws) return { running: false, loopsActive: false, candidateCount: 0 };

  const pool = getCandidatePool(accountId);
  return {
    running: ws.running,
    loopsActive: ws.loopsActive,
    candidateCount: pool.size,
  };
}

/**
 * 모든 워커 정지 (graceful shutdown)
 */
export function stopAllDantaWorkers(): void {
  for (const accountId of workers.keys()) {
    stopDantaWorker(accountId);
  }
}
