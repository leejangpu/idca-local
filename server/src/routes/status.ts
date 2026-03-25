/**
 * 상태 조회 API — 대시보드 UI용
 * 모든 계좌의 매매 상태 데이터 집계 (읽기 전용)
 */

import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as localStore from '../lib/localStore';
import { config } from '../config';
import { getDantaWorkerStatus, getMetricsSnapshot } from '../runners/danta';

export const statusRoutes = Router();

/** 모든 계좌의 상태를 집계하는 헬퍼 (계좌 스토어 우선, 레거시 중복 제거) */
function collectFromAllAccounts<T>(collection: string): Record<string, { accountId: string; data: T }> {
  const result: Record<string, { accountId: string; data: T }> = {};

  // 1. 계좌별 경로 우선 수집 (data/accounts/{id}/state/)
  const accountTickers = new Set<string>();
  const registry = localStore.getAccountRegistry();
  for (const account of registry.accounts) {
    const store = localStore.forAccount(account.id);
    const states = store.getAllStates<T>(collection);
    for (const [ticker, data] of states) {
      result[`${account.id}:${ticker}`] = { accountId: account.id, data };
      accountTickers.add(ticker);
    }
  }

  // 2. 레거시 경로 (data/state/) — 계좌 스토어에 없는 것만
  const legacyStates = localStore.getAllStates<T>(collection);
  for (const [ticker, data] of legacyStates) {
    if (!accountTickers.has(ticker)) {
      result[ticker] = { accountId: 'default', data };
    }
  }

  return result;
}

/** 플랫 형태로 변환 (accountId 포함) */
function flatStates<T extends Record<string, unknown>>(collection: string): Array<T & { _accountId: string; _ticker: string }> {
  const collected = collectFromAllAccounts<T>(collection);
  return Object.entries(collected).map(([key, { accountId, data }]) => {
    const ticker = key.includes(':') ? key.split(':')[1] : key;
    return { ...data, _accountId: accountId, _ticker: ticker };
  });
}

// VR 상태
statusRoutes.get('/vr', (_req, res) => {
  res.json(flatStates('vrState'));
});

// 무한매수법 사이클 상태
statusRoutes.get('/cycles', (_req, res) => {
  res.json(flatStates('cycles'));
});

// 실사오팔v2 상태
statusRoutes.get('/realtimeDdsobV2', (_req, res) => {
  res.json(flatStates('realtimeDdsobV2State'));
});

// 모멘텀 스캘핑 상태
statusRoutes.get('/momentumScalp', (_req, res) => {
  res.json(flatStates('momentumScalpState'));
});

// 스윙 상태
statusRoutes.get('/swing', (_req, res) => {
  res.json(flatStates('swingState'));
});

// 단타 v1 상태
statusRoutes.get('/danta', (req, res) => {
  const accountId = req.query.accountId as string | undefined;
  const registry = localStore.getAccountRegistry();
  const results: Array<Record<string, unknown>> = [];

  for (const account of registry.accounts) {
    if (accountId && account.id !== accountId) continue;
    const store = localStore.forAccount(account.id);
    const positions = store.getAllStates<Record<string, unknown>>('dantaV2State');
    const workerStatus = getDantaWorkerStatus(account.id);
    const metrics = getMetricsSnapshot(account.id);

    results.push({
      accountId: account.id,
      nickname: account.nickname,
      worker: workerStatus,
      positions: Array.from(positions.entries()).map(([ticker, data]) => ({ ticker, ...data })),
      metrics: {
        date: metrics.date,
        entries: metrics.counters['entry.success'] ?? 0,
        exits: (metrics.counters['exit.target'] ?? 0) + (metrics.counters['exit.stop_loss'] ?? 0)
          + (metrics.counters['exit.time_stop'] ?? 0) + (metrics.counters['exit.market_close'] ?? 0),
        errors: metrics.counters['sys.error'] ?? 0,
        fallbacks: metrics.counters['sys.fallback.event'] ?? 0,
      },
    });
  }

  res.json(results);
});

// 전체 요약 (대시보드용)
statusRoutes.get('/summary', (_req, res) => {
  const trading = localStore.getTradingConfig<Record<string, unknown>>();

  res.json({
    trading: trading ?? {},
    counts: {
      vr: flatStates('vrState').length,
      cycles: flatStates('cycles').length,
      realtimeDdsobV2: flatStates('realtimeDdsobV2State').length,
      momentumScalp: flatStates('momentumScalpState').length,
      swing: flatStates('swingState').length,
      dantaV2: flatStates('dantaV2State').length,
    },
  });
});

// 잔고 히스토리 (최근 N일, 모든 계좌 집계)
statusRoutes.get('/balance-history', (req, res) => {
  const days = parseInt(req.query.days as string) || 30;
  const results: Record<string, unknown>[] = [];

  // 레거시 경로
  const legacyDir = path.join(config.dataDir, 'history', 'balanceHistory');
  if (fs.existsSync(legacyDir)) {
    const files = fs.readdirSync(legacyDir).filter(f => f.endsWith('.json')).sort().slice(-days);
    for (const f of files) {
      try {
        results.push(JSON.parse(fs.readFileSync(path.join(legacyDir, f), 'utf-8')));
      } catch { /* skip */ }
    }
  }

  // 계좌별 경로
  const registry = localStore.getAccountRegistry();
  for (const account of registry.accounts) {
    const dir = path.join(config.dataDir, 'accounts', account.id, 'history', 'balanceHistory');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().slice(-days);
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        results.push({ ...data, _accountId: account.id });
      } catch { /* skip */ }
    }
  }

  res.json(results);
});
