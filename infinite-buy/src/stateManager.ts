/**
 * State Manager — JSON 파일 기반 상태 관리
 * infinite-buy/ 디렉토리 내 state/, logs/, history/ 관리
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { StrategyVersion, QuarterModeState } from './calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ==================== 타입 ====================

export interface Config {
  enabled: boolean;
  tickers: string[];
  strategyVersion: StrategyVersion;
  tickerConfigs: Record<string, {
    splitCount: number;
    targetProfit: number;
  }>;
  autoRestart: boolean;
  equalSplit: boolean;
}

export interface CycleState {
  ticker: string;
  status: 'active' | 'completed';
  cycleNumber: number;
  strategyVersion: StrategyVersion;
  splitCount: number;
  targetProfit: number;
  starDecreaseRate: number;
  principal: number;
  buyPerRound: number;
  totalQuantity: number;
  avgPrice: number;
  totalInvested: number;
  remainingCash: number;
  totalBuyAmount: number;
  totalSellAmount: number;
  totalRealizedProfit: number;
  quarterMode?: QuarterModeState;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface LogEntry {
  timestamp: string;
  ticker: string;
  action: 'ORDER_SUBMIT' | 'ORDER_RESULT' | 'SYNC' | 'CYCLE_START' | 'CYCLE_COMPLETE' | 'MOO_RESERVATION' | 'ERROR' | 'SKIP';
  details: Record<string, unknown>;
}

export interface CycleHistory {
  ticker: string;
  cycleNumber: number;
  strategyVersion: StrategyVersion;
  splitCount: number;
  targetProfit: number;
  starDecreaseRate: number;
  principal: number;
  buyPerRound: number;
  totalBuyAmount: number;
  totalSellAmount: number;
  totalRealizedProfit: number;
  finalProfitRate: number;
  startedAt: string;
  completedAt: string;
}

// ==================== 파일 I/O ====================

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ==================== Config ====================

export function readConfig(): Config {
  const config = readJson<Config>(path.join(ROOT, 'config.json'));
  if (!config) throw new Error('config.json not found');
  return config;
}

export function writeConfig(config: Config): void {
  writeJson(path.join(ROOT, 'config.json'), config);
}

// ==================== Cycle State ====================

export function readCycleState(ticker: string): CycleState | null {
  return readJson<CycleState>(path.join(ROOT, 'state', `${ticker}.json`));
}

export function writeCycleState(ticker: string, state: CycleState): void {
  writeJson(path.join(ROOT, 'state', `${ticker}.json`), state);
}

// ==================== Daily Log ====================

export function appendLog(date: string, entry: LogEntry): void {
  const filePath = path.join(ROOT, 'logs', `${date}.json`);
  const existing = readJson<LogEntry[]>(filePath) || [];
  existing.push(entry);
  writeJson(filePath, existing);
}

// ==================== Cycle History ====================

export function saveCycleHistory(data: CycleHistory): void {
  const fileName = `${data.ticker}-cycle-${String(data.cycleNumber).padStart(3, '0')}.json`;
  writeJson(path.join(ROOT, 'history', fileName), data);
}

export function getNextCycleNumber(ticker: string): number {
  const historyDir = path.join(ROOT, 'history');
  if (!fs.existsSync(historyDir)) return 1;
  const files = fs.readdirSync(historyDir).filter(f => f.startsWith(`${ticker}-cycle-`));
  if (files.length === 0) return 1;
  const numbers = files.map(f => {
    const match = f.match(/cycle-(\d+)/);
    return match ? parseInt(match[1]) : 0;
  });
  return Math.max(...numbers) + 1;
}
