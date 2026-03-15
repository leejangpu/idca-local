/**
 * 로컬 파일 저장소 — Firestore 완전 대체
 *
 * 디렉토리 구조:
 *   data/
 *     config/trading.json                         ← CommonConfig
 *     config/domestic/{strategy}.json             ← 국내 전략 설정
 *     config/overseas/{strategy}.json             ← 해외 전략 설정
 *     config/telegram.json                        ← 텔레그램 매핑
 *     credentials/main.json                       ← KIS API 자격증명
 *     cache/kisToken.json                         ← 토큰 캐시
 *     state/{collection}/{ticker}.json            ← 종목별 런타임 상태
 *     state/pendingOrders/{orderId}.json          ← 대기 주문
 *     logs/{type}/{YYYYMMDD}.json                 ← 일별 로그
 *     history/balanceHistory/{YYYYMMDD}.json      ← 잔고 히스토리
 *     history/cycleHistory/{id}.json              ← 사이클 히스토리
 *     swing/                                      ← 스윙 데이터 (기존 호환)
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

// ==================== 기본 유틸 ====================

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath); // atomic write
}

function deleteJson(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // 무시
  }
}

function listJsonFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
}

// ==================== 경로 헬퍼 ====================

const DATA_ROOT = config.dataDir;

const paths = {
  // Config
  tradingConfig: () => path.join(DATA_ROOT, 'config', 'trading.json'),
  strategyConfig: (market: string, strategy: string) =>
    path.join(DATA_ROOT, 'config', market, `${strategy}.json`),
  telegramConfig: () => path.join(DATA_ROOT, 'config', 'telegram.json'),

  // Credentials & Cache
  credentials: () => path.join(DATA_ROOT, 'credentials', 'main.json'),
  tokenCache: () => path.join(DATA_ROOT, 'cache', 'kisToken.json'),

  // State (종목별)
  stateDir: (collection: string) => path.join(DATA_ROOT, 'state', collection),
  stateFile: (collection: string, ticker: string) =>
    path.join(DATA_ROOT, 'state', collection, `${ticker}.json`),

  // Pending Orders
  pendingOrdersDir: () => path.join(DATA_ROOT, 'state', 'pendingOrders'),
  pendingOrderFile: (orderId: string) =>
    path.join(DATA_ROOT, 'state', 'pendingOrders', `${orderId}.json`),

  // Logs (일별)
  logDir: (type: string) => path.join(DATA_ROOT, 'logs', type),
  logFile: (type: string, date: string) =>
    path.join(DATA_ROOT, 'logs', type, `${date}.json`),

  // History
  balanceHistoryFile: (date: string) =>
    path.join(DATA_ROOT, 'history', 'balanceHistory', `${date}.json`),
  cycleHistoryDir: () => path.join(DATA_ROOT, 'history', 'cycleHistory'),
  cycleHistoryFile: (id: string) =>
    path.join(DATA_ROOT, 'history', 'cycleHistory', `${id}.json`),

  // Swing (기존 호환)
  swingDir: () => path.join(DATA_ROOT, 'swing'),

  // 텍스트 로그
  textLogDir: () => path.join(DATA_ROOT, 'logs', 'text'),
};

// ==================== Config CRUD ====================

export function getTradingConfig<T>(): T | null {
  return readJson<T>(paths.tradingConfig());
}

export function setTradingConfig(data: unknown): void {
  writeJson(paths.tradingConfig(), {
    ...(data as Record<string, unknown>),
    updatedAt: new Date().toISOString(),
  });
}

export function getStrategyConfig<T>(market: string, strategy: string): T | null {
  return readJson<T>(paths.strategyConfig(market, strategy));
}

export function setStrategyConfig(market: string, strategy: string, data: unknown): void {
  writeJson(paths.strategyConfig(market, strategy), {
    ...(data as Record<string, unknown>),
    updatedAt: new Date().toISOString(),
  });
}

// ==================== Credentials & Token Cache ====================

export function getCredentials<T>(): T | null {
  return readJson<T>(paths.credentials());
}

export function setCredentials(data: unknown): void {
  writeJson(paths.credentials(), data);
}

export function getTokenCache<T>(): T | null {
  return readJson<T>(paths.tokenCache());
}

export function setTokenCache(data: unknown): void {
  writeJson(paths.tokenCache(), data);
}

// ==================== Telegram Config ====================

export function getTelegramConfig<T>(): T | null {
  return readJson<T>(paths.telegramConfig());
}

export function setTelegramConfig(data: unknown): void {
  writeJson(paths.telegramConfig(), data);
}

// ==================== State (종목별 상태) CRUD ====================

export function getState<T>(collection: string, ticker: string): T | null {
  return readJson<T>(paths.stateFile(collection, ticker));
}

export function setState(collection: string, ticker: string, data: unknown): void {
  writeJson(paths.stateFile(collection, ticker), {
    ...(data as Record<string, unknown>),
    updatedAt: new Date().toISOString(),
  });
}

export function updateState(collection: string, ticker: string, update: Record<string, unknown>): void {
  const existing = readJson<Record<string, unknown>>(paths.stateFile(collection, ticker)) || {};
  writeJson(paths.stateFile(collection, ticker), {
    ...existing,
    ...update,
    updatedAt: new Date().toISOString(),
  });
}

export function deleteState(collection: string, ticker: string): void {
  deleteJson(paths.stateFile(collection, ticker));
}

export function getAllStates<T>(collection: string): Map<string, T> {
  const dir = paths.stateDir(collection);
  const result = new Map<string, T>();
  const files = listJsonFiles(dir);
  for (const file of files) {
    const ticker = file.replace('.json', '');
    const data = readJson<T>(path.join(dir, file));
    if (data) result.set(ticker, data);
  }
  return result;
}

/**
 * 조건 필터링이 가능한 상태 조회 (Firestore where 대체)
 */
export function getStatesWhere<T extends Record<string, unknown>>(
  collection: string,
  predicate: (data: T) => boolean
): Map<string, T> {
  const all = getAllStates<T>(collection);
  const result = new Map<string, T>();
  for (const [ticker, data] of all) {
    if (predicate(data)) result.set(ticker, data);
  }
  return result;
}

// ==================== Pending Orders ====================

export function getPendingOrder<T>(orderId: string): T | null {
  return readJson<T>(paths.pendingOrderFile(orderId));
}

export function setPendingOrder(orderId: string, data: unknown): void {
  writeJson(paths.pendingOrderFile(orderId), {
    ...(data as Record<string, unknown>),
    updatedAt: new Date().toISOString(),
  });
}

export function deletePendingOrder(orderId: string): void {
  deleteJson(paths.pendingOrderFile(orderId));
}

export function getAllPendingOrders<T>(): Map<string, T> {
  const dir = paths.pendingOrdersDir();
  const result = new Map<string, T>();
  const files = listJsonFiles(dir);
  for (const file of files) {
    const id = file.replace('.json', '');
    const data = readJson<T>(path.join(dir, file));
    if (data) result.set(id, data);
  }
  return result;
}

// ==================== Logs (일별 JSON) ====================

/**
 * 로그 추가 (배열에 append)
 */
export function appendLog<T>(type: string, date: string, entry: T): void {
  const filePath = paths.logFile(type, date);
  const existing = readJson<T[]>(filePath) ?? [];
  existing.push(entry);
  writeJson(filePath, existing);
}

export function getLogs<T>(type: string, date: string): T[] {
  return readJson<T[]>(paths.logFile(type, date)) ?? [];
}

export function getRecentLogs<T>(type: string, days: number = 7): Array<{ date: string; entries: T[] }> {
  const dir = paths.logDir(type);
  const files = listJsonFiles(dir).sort().slice(-days);
  return files.map(file => ({
    date: file.replace('.json', ''),
    entries: readJson<T[]>(path.join(dir, file)) ?? [],
  }));
}

// ==================== Balance History ====================

export function getBalanceHistory<T>(date: string): T | null {
  return readJson<T>(paths.balanceHistoryFile(date));
}

export function setBalanceHistory(date: string, data: unknown): void {
  writeJson(paths.balanceHistoryFile(date), {
    ...(data as Record<string, unknown>),
    recordedAt: new Date().toISOString(),
  });
}

// ==================== Cycle History ====================

export function addCycleHistory(data: Record<string, unknown>): string {
  const dir = paths.cycleHistoryDir();
  ensureDir(dir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ticker = (data.ticker as string) || 'unknown';
  const id = `${timestamp}_${ticker}`;
  writeJson(paths.cycleHistoryFile(id), {
    ...data,
    completedAt: new Date().toISOString(),
  });
  return id;
}

export function getAllCycleHistory<T>(): T[] {
  const dir = paths.cycleHistoryDir();
  const files = listJsonFiles(dir).sort();
  const results: T[] = [];
  for (const file of files) {
    const data = readJson<T>(path.join(dir, file));
    if (data) results.push(data);
  }
  return results;
}

// ==================== 텍스트 로그 (일별 파일) ====================

const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export function appendTextLog(prefix: string, message: string): void {
  const dir = paths.textLogDir();
  ensureDir(dir);

  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(dir, `${prefix}_${today}.log`);

  // 크기 제한 체크 + 로테이션
  try {
    const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    if (stat && stat.size > MAX_LOG_FILE_SIZE) {
      const oldFile = logFile.replace('.log', '.old.log');
      if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
      fs.renameSync(logFile, oldFile);
    }
  } catch {
    // 무시
  }

  const timestamp = new Date().toISOString();
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, 'utf-8');
}

export function cleanOldLogs(retainDays = 7): void {
  const dir = paths.textLogDir();
  if (!fs.existsSync(dir)) return;

  const now = Date.now();
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > retainDays * 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // 무시
    }
  }
}

// ==================== 초기화 ====================

function ensureAccountDirs(accountRoot: string): void {
  ensureDir(accountRoot);
  ensureDir(path.join(accountRoot, 'config'));
  ensureDir(path.join(accountRoot, 'config', 'domestic'));
  ensureDir(path.join(accountRoot, 'config', 'overseas'));
  ensureDir(path.join(accountRoot, 'credentials'));
  ensureDir(path.join(accountRoot, 'cache'));
  ensureDir(path.join(accountRoot, 'state'));
  ensureDir(path.join(accountRoot, 'logs'));
  ensureDir(path.join(accountRoot, 'history'));
}

export function initLocalStore(): void {
  ensureDir(DATA_ROOT);
  ensureDir(path.join(DATA_ROOT, 'config'));
  ensureDir(path.join(DATA_ROOT, 'config', 'domestic'));
  ensureDir(path.join(DATA_ROOT, 'config', 'overseas'));
  ensureDir(path.join(DATA_ROOT, 'credentials'));
  ensureDir(path.join(DATA_ROOT, 'cache'));
  ensureDir(path.join(DATA_ROOT, 'state'));
  ensureDir(path.join(DATA_ROOT, 'logs'));
  ensureDir(path.join(DATA_ROOT, 'history'));
  ensureDir(path.join(DATA_ROOT, 'swing'));

  // 계정별 디렉토리 초기화
  const registry = readJson<AccountRegistry>(accountRegistryPath());
  if (registry && registry.accounts) {
    ensureDir(path.join(DATA_ROOT, 'accounts'));
    for (const account of registry.accounts) {
      ensureAccountDirs(path.join(DATA_ROOT, 'accounts', account.id));
    }
  }

  console.log(`[LocalStore] 초기화 완료: ${DATA_ROOT}`);
}

// ==================== Account Registry ====================

export interface AccountRegistryEntry {
  id: string;
  nickname: string;
  accountNo: string;
  createdAt: string;
  order: number;
}

export interface AccountRegistry {
  accounts: AccountRegistryEntry[];
  defaultAccountId: string;
}

const accountRegistryPath = () => path.join(DATA_ROOT, 'accounts.json');

export function getAccountRegistry(): AccountRegistry {
  return readJson<AccountRegistry>(accountRegistryPath()) ?? { accounts: [], defaultAccountId: '' };
}

export function setAccountRegistry(data: AccountRegistry): void {
  writeJson(accountRegistryPath(), data);
}

// ==================== Account-Scoped Store ====================

export interface AccountStore {
  getTradingConfig<T>(): T | null;
  setTradingConfig(data: unknown): void;
  getStrategyConfig<T>(market: string, strategy: string): T | null;
  setStrategyConfig(market: string, strategy: string, data: unknown): void;
  getCredentials<T>(): T | null;
  setCredentials(data: unknown): void;
  getTokenCache<T>(): T | null;
  setTokenCache(data: unknown): void;
  getState<T>(collection: string, ticker: string): T | null;
  setState(collection: string, ticker: string, data: unknown): void;
  updateState(collection: string, ticker: string, update: Record<string, unknown>): void;
  deleteState(collection: string, ticker: string): void;
  getAllStates<T>(collection: string): Map<string, T>;
  getStatesWhere<T extends Record<string, unknown>>(collection: string, predicate: (data: T) => boolean): Map<string, T>;
  getPendingOrder<T>(orderId: string): T | null;
  setPendingOrder(orderId: string, data: unknown): void;
  deletePendingOrder(orderId: string): void;
  getAllPendingOrders<T>(): Map<string, T>;
  appendLog<T>(type: string, date: string, entry: T): void;
  getLogs<T>(type: string, date: string): T[];
  getRecentLogs<T>(type: string, days?: number): Array<{ date: string; entries: T[] }>;
  getBalanceHistory<T>(date: string): T | null;
  setBalanceHistory(date: string, data: unknown): void;
  addCycleHistory(data: Record<string, unknown>): string;
  getAllCycleHistory<T>(): T[];
  appendTextLog(prefix: string, message: string): void;
}

function makeAccountPaths(root: string) {
  return {
    tradingConfig: () => path.join(root, 'config', 'trading.json'),
    strategyConfig: (market: string, strategy: string) =>
      path.join(root, 'config', market, `${strategy}.json`),
    credentials: () => path.join(root, 'credentials', 'main.json'),
    tokenCache: () => path.join(root, 'cache', 'kisToken.json'),
    stateDir: (collection: string) => path.join(root, 'state', collection),
    stateFile: (collection: string, ticker: string) =>
      path.join(root, 'state', collection, `${ticker}.json`),
    pendingOrdersDir: () => path.join(root, 'state', 'pendingOrders'),
    pendingOrderFile: (orderId: string) =>
      path.join(root, 'state', 'pendingOrders', `${orderId}.json`),
    logDir: (type: string) => path.join(root, 'logs', type),
    logFile: (type: string, date: string) =>
      path.join(root, 'logs', type, `${date}.json`),
    balanceHistoryFile: (date: string) =>
      path.join(root, 'history', 'balanceHistory', `${date}.json`),
    cycleHistoryDir: () => path.join(root, 'history', 'cycleHistory'),
    cycleHistoryFile: (id: string) =>
      path.join(root, 'history', 'cycleHistory', `${id}.json`),
    textLogDir: () => path.join(root, 'logs', 'text'),
  };
}

export function forAccount(accountId: string): AccountStore {
  const root = path.join(DATA_ROOT, 'accounts', accountId);
  const p = makeAccountPaths(root);

  return {
    getTradingConfig<T>(): T | null {
      return readJson<T>(p.tradingConfig());
    },
    setTradingConfig(data: unknown): void {
      writeJson(p.tradingConfig(), {
        ...(data as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      });
    },
    getStrategyConfig<T>(market: string, strategy: string): T | null {
      return readJson<T>(p.strategyConfig(market, strategy));
    },
    setStrategyConfig(market: string, strategy: string, data: unknown): void {
      writeJson(p.strategyConfig(market, strategy), {
        ...(data as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      });
    },
    getCredentials<T>(): T | null {
      return readJson<T>(p.credentials());
    },
    setCredentials(data: unknown): void {
      writeJson(p.credentials(), data);
    },
    getTokenCache<T>(): T | null {
      return readJson<T>(p.tokenCache());
    },
    setTokenCache(data: unknown): void {
      writeJson(p.tokenCache(), data);
    },
    getState<T>(collection: string, ticker: string): T | null {
      return readJson<T>(p.stateFile(collection, ticker));
    },
    setState(collection: string, ticker: string, data: unknown): void {
      writeJson(p.stateFile(collection, ticker), {
        ...(data as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      });
    },
    updateState(collection: string, ticker: string, update: Record<string, unknown>): void {
      const existing = readJson<Record<string, unknown>>(p.stateFile(collection, ticker)) || {};
      writeJson(p.stateFile(collection, ticker), {
        ...existing,
        ...update,
        updatedAt: new Date().toISOString(),
      });
    },
    deleteState(collection: string, ticker: string): void {
      deleteJson(p.stateFile(collection, ticker));
    },
    getAllStates<T>(collection: string): Map<string, T> {
      const dir = p.stateDir(collection);
      const result = new Map<string, T>();
      const files = listJsonFiles(dir);
      for (const file of files) {
        const ticker = file.replace('.json', '');
        const data = readJson<T>(path.join(dir, file));
        if (data) result.set(ticker, data);
      }
      return result;
    },
    getStatesWhere<T extends Record<string, unknown>>(
      collection: string,
      predicate: (data: T) => boolean
    ): Map<string, T> {
      const all = this.getAllStates<T>(collection);
      const result = new Map<string, T>();
      for (const [ticker, data] of all) {
        if (predicate(data)) result.set(ticker, data);
      }
      return result;
    },
    getPendingOrder<T>(orderId: string): T | null {
      return readJson<T>(p.pendingOrderFile(orderId));
    },
    setPendingOrder(orderId: string, data: unknown): void {
      writeJson(p.pendingOrderFile(orderId), {
        ...(data as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      });
    },
    deletePendingOrder(orderId: string): void {
      deleteJson(p.pendingOrderFile(orderId));
    },
    getAllPendingOrders<T>(): Map<string, T> {
      const dir = p.pendingOrdersDir();
      const result = new Map<string, T>();
      const files = listJsonFiles(dir);
      for (const file of files) {
        const id = file.replace('.json', '');
        const data = readJson<T>(path.join(dir, file));
        if (data) result.set(id, data);
      }
      return result;
    },
    appendLog<T>(type: string, date: string, entry: T): void {
      const filePath = p.logFile(type, date);
      const existing = readJson<T[]>(filePath) ?? [];
      existing.push(entry);
      writeJson(filePath, existing);
    },
    getLogs<T>(type: string, date: string): T[] {
      return readJson<T[]>(p.logFile(type, date)) ?? [];
    },
    getRecentLogs<T>(type: string, days: number = 7): Array<{ date: string; entries: T[] }> {
      const dir = p.logDir(type);
      const files = listJsonFiles(dir).sort().slice(-days);
      return files.map(file => ({
        date: file.replace('.json', ''),
        entries: readJson<T[]>(path.join(dir, file)) ?? [],
      }));
    },
    getBalanceHistory<T>(date: string): T | null {
      return readJson<T>(p.balanceHistoryFile(date));
    },
    setBalanceHistory(date: string, data: unknown): void {
      writeJson(p.balanceHistoryFile(date), {
        ...(data as Record<string, unknown>),
        recordedAt: new Date().toISOString(),
      });
    },
    addCycleHistory(data: Record<string, unknown>): string {
      const dir = p.cycleHistoryDir();
      ensureDir(dir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const ticker = (data.ticker as string) || 'unknown';
      const id = `${timestamp}_${ticker}`;
      writeJson(p.cycleHistoryFile(id), {
        ...data,
        completedAt: new Date().toISOString(),
      });
      return id;
    },
    getAllCycleHistory<T>(): T[] {
      const dir = p.cycleHistoryDir();
      const files = listJsonFiles(dir).sort();
      const results: T[] = [];
      for (const file of files) {
        const data = readJson<T>(path.join(dir, file));
        if (data) results.push(data);
      }
      return results;
    },
    appendTextLog(prefix: string, message: string): void {
      const dir = p.textLogDir();
      ensureDir(dir);
      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(dir, `${prefix}_${today}.log`);
      try {
        const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
        if (stat && stat.size > MAX_LOG_FILE_SIZE) {
          const oldFile = logFile.replace('.log', '.old.log');
          if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
          fs.renameSync(logFile, oldFile);
        }
      } catch {
        // 무시
      }
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, 'utf-8');
    },
  };
}

// ==================== 경로 내보내기 (확장용) ====================

export { paths, readJson, writeJson, deleteJson, ensureDir, listJsonFiles };
