/**
 * 상태 조회 API — 대시보드 UI용
 * localStore에서 매매 상태 데이터 읽기 (읽기 전용)
 */

import { Router } from 'express';
import * as localStore from '../lib/localStore';

export const statusRoutes = Router();

// VR 상태
statusRoutes.get('/vr', (_req, res) => {
  const states = localStore.getAllStates<Record<string, unknown>>('vrState');
  const result: Record<string, unknown> = {};
  for (const [ticker, state] of states) {
    result[ticker] = state;
  }
  res.json(result);
});

// 무한매수법 사이클 상태
statusRoutes.get('/cycles', (_req, res) => {
  const states = localStore.getAllStates<Record<string, unknown>>('cycles');
  const result: Record<string, unknown> = {};
  for (const [ticker, state] of states) {
    result[ticker] = state;
  }
  res.json(result);
});

// 실사오팔v2 상태
statusRoutes.get('/realtimeDdsobV2', (_req, res) => {
  const states = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
  const result: Record<string, unknown> = {};
  for (const [ticker, state] of states) {
    result[ticker] = state;
  }
  res.json(result);
});

// 모멘텀 스캘핑 상태
statusRoutes.get('/momentumScalp', (_req, res) => {
  const states = localStore.getAllStates<Record<string, unknown>>('momentumScalpState');
  const result: Record<string, unknown> = {};
  for (const [ticker, state] of states) {
    result[ticker] = state;
  }
  res.json(result);
});

// 스윙 상태
statusRoutes.get('/swing', (_req, res) => {
  const states = localStore.getAllStates<Record<string, unknown>>('swingState');
  const result: Record<string, unknown> = {};
  for (const [ticker, state] of states) {
    result[ticker] = state;
  }
  res.json(result);
});

// 전체 요약 (대시보드용)
statusRoutes.get('/summary', (_req, res) => {
  const trading = localStore.getTradingConfig<Record<string, unknown>>();
  const vrStates = localStore.getAllStates<Record<string, unknown>>('vrState');
  const cycles = localStore.getAllStates<Record<string, unknown>>('cycles');
  const rdStates = localStore.getAllStates<Record<string, unknown>>('realtimeDdsobV2State');
  const scalpStates = localStore.getAllStates<Record<string, unknown>>('momentumScalpState');
  const swingStates = localStore.getAllStates<Record<string, unknown>>('swingState');

  res.json({
    trading: trading ?? {},
    counts: {
      vr: vrStates.size,
      cycles: cycles.size,
      realtimeDdsobV2: rdStates.size,
      momentumScalp: scalpStates.size,
      swing: swingStates.size,
    },
  });
});

// 잔고 히스토리 (최근 N일)
statusRoutes.get('/balance-history', (req, res) => {
  const days = parseInt(req.query.days as string) || 30;
  const dir = require('path').join(require('../config').config.dataDir, 'history', 'balanceHistory');
  const fs = require('fs');
  if (!fs.existsSync(dir)) { res.json([]); return; }
  const files = fs.readdirSync(dir)
    .filter((f: string) => f.endsWith('.json'))
    .sort()
    .slice(-days);
  const result = files.map((f: string) => {
    try {
      return JSON.parse(fs.readFileSync(require('path').join(dir, f), 'utf-8'));
    } catch { return null; }
  }).filter(Boolean);
  res.json(result);
});
