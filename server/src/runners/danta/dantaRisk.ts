/**
 * 단타 v2 — 리스크 관리
 *
 * 슬롯/쿨다운/재진입 횟수/일일 제한 등을 관리.
 * 포지션 진입 전 모든 리스크 체크를 통과해야 한다.
 */

import { type AccountContext } from '../../lib/accountContext';
import { isTickerOccupied } from '../../lib/activeTickerRegistry';
import {
  type DantaV2Config,
  type DantaV2State,
  type TickerCooldown,
  type TickerEntryCount,
  type ExitReason,
  DANTA_STATE_COLLECTION,
} from './dantaTypes';

// ========================================
// In-Memory 상태 (서버 재시작 시 초기화)
// ========================================

// 종목별 쿨다운 (손절 후 5분)
const cooldowns = new Map<string, TickerCooldown>();

// 종목별 당일 연속 진입 횟수
const entryCountMap = new Map<string, TickerEntryCount>();

// 일일 카운터 리셋 날짜
let lastResetDate = '';

// ========================================
// 쿨다운 관리
// ========================================

export function setCooldown(ticker: string, reason: ExitReason, durationMs: number): void {
  cooldowns.set(ticker, {
    ticker,
    reason,
    expiresAt: Date.now() + durationMs,
  });
}

export function isOnCooldown(ticker: string): boolean {
  const cd = cooldowns.get(ticker);
  if (!cd) return false;
  if (Date.now() >= cd.expiresAt) {
    cooldowns.delete(ticker);
    return false;
  }
  return true;
}

export function getCooldownRemainingSec(ticker: string): number {
  const cd = cooldowns.get(ticker);
  if (!cd) return 0;
  const remain = cd.expiresAt - Date.now();
  return remain > 0 ? Math.ceil(remain / 1000) : 0;
}

// ========================================
// 재진입 횟수 관리
// ========================================

function ensureDailyReset(todayStr: string): void {
  if (lastResetDate !== todayStr) {
    entryCountMap.clear();
    cooldowns.clear();
    lastResetDate = todayStr;
  }
}

export function recordEntry(ticker: string, todayStr: string): void {
  ensureDailyReset(todayStr);
  const existing = entryCountMap.get(ticker);
  if (existing) {
    existing.count++;
    existing.lastEntryAt = Date.now();
  } else {
    entryCountMap.set(ticker, { ticker, count: 1, lastEntryAt: Date.now() });
  }
}

export function getEntryCount(ticker: string, todayStr: string): number {
  ensureDailyReset(todayStr);
  return entryCountMap.get(ticker)?.count ?? 0;
}

// ========================================
// 종합 리스크 체크
// ========================================

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
}

export function canOpenPosition(
  ticker: string,
  todayStr: string,
  config: DantaV2Config,
  ctx: AccountContext,
): RiskCheckResult {
  // 1) 동시 보유 슬롯 체크
  const states = ctx.store.getAllStates<DantaV2State>(DANTA_STATE_COLLECTION);
  const activeCount = Array.from(states.values()).filter(
    s => s.status === 'active' || s.status === 'pending_buy',
  ).length;
  if (activeCount >= config.maxSlots) {
    return { allowed: false, reason: `슬롯 부족: ${activeCount}/${config.maxSlots}` };
  }

  // 2) 이미 보유 중인 종목
  if (states.has(ticker)) {
    return { allowed: false, reason: `이미 보유/대기 중: ${ticker}` };
  }

  // 3) 쿨다운 체크 (0이면 비활성)
  if (config.cooldownAfterStopLossSec > 0 && isOnCooldown(ticker)) {
    const remain = getCooldownRemainingSec(ticker);
    return { allowed: false, reason: `쿨다운 중: ${ticker} (${remain}초 남음)` };
  }

  // 4) 연속 진입 횟수 체크 (0이면 무제한)
  if (config.maxConsecutiveEntriesPerSymbol > 0) {
    ensureDailyReset(todayStr);
    const count = getEntryCount(ticker, todayStr);
    if (count >= config.maxConsecutiveEntriesPerSymbol) {
      return { allowed: false, reason: `연속 진입 제한: ${ticker} ${count}/${config.maxConsecutiveEntriesPerSymbol}회` };
    }
  }

  // 5) 타 전략 종목 점유 체크
  if (isTickerOccupied(ticker, 'dantaV2')) {
    return { allowed: false, reason: `타 전략 점유: ${ticker}` };
  }

  return { allowed: true, reason: 'OK' };
}

// ========================================
// 청산 후 처리
// ========================================

export function onPositionClosed(
  ticker: string,
  exitReason: ExitReason,
  todayStr: string,
  config: DantaV2Config,
): void {
  // 손절 시 쿨다운 적용
  if (exitReason === 'stop_loss') {
    setCooldown(ticker, exitReason, config.cooldownAfterStopLossSec * 1000);
  }
}

// ========================================
// 디버그/모니터링
// ========================================

export function getStatus(): {
  cooldowns: Array<{ ticker: string; reason: string; remainSec: number }>;
  entryCounts: Array<{ ticker: string; count: number }>;
} {
  const now = Date.now();
  return {
    cooldowns: Array.from(cooldowns.values())
      .filter(cd => cd.expiresAt > now)
      .map(cd => ({ ticker: cd.ticker, reason: cd.reason, remainSec: Math.ceil((cd.expiresAt - now) / 1000) })),
    entryCounts: Array.from(entryCountMap.values())
      .map(ec => ({ ticker: ec.ticker, count: ec.count })),
  };
}
