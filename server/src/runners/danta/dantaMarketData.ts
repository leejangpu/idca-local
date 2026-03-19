/**
 * 단타 v1 — 시세 데이터 프로바이더
 *
 * 두 가지 구현:
 * 1. RestMarketDataProvider — 기존 REST polling (fallback)
 * 2. WebSocketMarketDataProvider — KIS WebSocket 실시간 체결가
 *
 * 엔진은 MarketDataProvider 인터페이스만 사용하므로
 * 런타임에 provider를 교체할 수 있다.
 *
 * KIS WebSocket 스펙:
 * - 실시간 체결가(통합): TR_ID=H0UNCNT0, ws://ops.koreainvestment.com:21000
 * - approval_key: /oauth2/Approval API로 발급
 * - 체결가 데이터에 현재가/매도1호가/매수1호가/매수잔량1 모두 포함
 */

import WebSocket from 'ws';
import { type AccountContext } from '../../lib/accountContext';
import { getOrRefreshToken } from '../../lib/kisApi';

const TAG = '[DantaV1:MarketData]';

// ========================================
// 공통 인터페이스
// ========================================

/** 종목별 최신 시세 스냅샷 */
export interface TickData {
  ticker: string;
  currentPrice: number;     // 체결가 (STCK_PRPR)
  askPrice: number;         // 매도1호가 (ASKP1)
  bidPrice: number;         // 매수1호가 (BIDP1)
  bidQty1: number;          // 매수잔량1 (BIDP_RSQN1)
  askQty1: number;          // 매도잔량1 (ASKP_RSQN1)
  volume: number;           // 누적거래량 (ACML_VOL)
  tradeAmt: number;         // 누적거래대금 (ACML_TR_PBMN)
  timestamp: number;        // 수신 시각 (Date.now())
}

export type TickCallback = (tick: TickData) => void;

export interface MarketDataProvider {
  /** 종목 구독 (실시간 시세 수신 시작) */
  subscribe(ticker: string): void;
  /** 종목 구독 해제 */
  unsubscribe(ticker: string): void;
  /** 현재 구독 중인 종목 목록 */
  getSubscriptions(): string[];
  /** 종목의 최신 시세 (캐시된 값, null이면 아직 수신 없음) */
  getLatestTick(ticker: string): TickData | null;
  /** 새 체결 데이터 수신 콜백 등록 */
  onTick(callback: TickCallback): void;
  /** 프로바이더 시작 (연결 등) */
  start(): Promise<void>;
  /** 프로바이더 정지 (연결 해제 등) */
  stop(): Promise<void>;
  /** 프로바이더 유형 */
  readonly type: 'rest' | 'websocket';
  /** REST fallback 활성 여부 (WebSocket provider에서만 의미 있음) */
  isFallbackActive(): boolean;
  /** REST fallback 지속 시간 (ms). fallback 아니면 0 */
  getFallbackDurationMs(): number;
  /** WS 복구 직후 warm-up 중인지 (정상 tick 수신 확인 구간) */
  isWarmingUp(): boolean;
}

// ========================================
// 1. REST Polling Provider (fallback)
// ========================================

export class RestMarketDataProvider implements MarketDataProvider {
  readonly type = 'rest' as const;
  private subscriptions = new Set<string>();
  private cache = new Map<string, TickData>();
  private callbacks: TickCallback[] = [];
  private ctx: AccountContext;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;

  constructor(ctx: AccountContext, pollIntervalMs = 500) {
    this.ctx = ctx;
    this.pollIntervalMs = pollIntervalMs;
  }

  subscribe(ticker: string): void {
    this.subscriptions.add(ticker);
  }

  unsubscribe(ticker: string): void {
    this.subscriptions.delete(ticker);
    this.cache.delete(ticker);
  }

  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  getLatestTick(ticker: string): TickData | null {
    return this.cache.get(ticker) ?? null;
  }

  onTick(callback: TickCallback): void {
    this.callbacks.push(callback);
  }

  async start(): Promise<void> {
    console.log(`${TAG} [REST] Provider started (poll=${this.pollIntervalMs}ms)`);
    this.pollTimer = setInterval(() => this.pollAll(), this.pollIntervalMs);
  }

  isFallbackActive(): boolean {
    return false;
  }

  getFallbackDurationMs(): number {
    return 0;
  }

  isWarmingUp(): boolean {
    return false;
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.subscriptions.clear();
    this.cache.clear();
    console.log(`${TAG} [REST] Provider stopped`);
  }

  private async pollAll(): Promise<void> {
    if (this.subscriptions.size === 0) return;

    try {
      const { appKey, appSecret } = this.ctx.credentials;
      const accessToken = await getOrRefreshToken(
        '', this.ctx.accountId, { appKey, appSecret }, this.ctx.kisClient,
      );

      for (const ticker of this.subscriptions) {
        try {
          const data = await this.ctx.kisClient.getDomesticAskingPrice(
            appKey, appSecret, accessToken, ticker,
          );

          const tick: TickData = {
            ticker,
            currentPrice: parseInt(data.output2?.stck_prpr || '0', 10),
            askPrice: parseInt(data.output1?.askp1 || '0', 10),
            bidPrice: parseInt(data.output1?.bidp1 || '0', 10),
            bidQty1: parseInt(data.output1?.bidp_rsqn1 || '0', 10),
            askQty1: parseInt(data.output1?.askp_rsqn1 || '0', 10),
            volume: 0,
            tradeAmt: 0,
            timestamp: Date.now(),
          };

          if (tick.currentPrice > 0) {
            this.cache.set(ticker, tick);
            for (const cb of this.callbacks) cb(tick);
          }
        } catch {
          // 개별 종목 실패는 무시, 다음 폴링에서 재시도
        }
      }
    } catch (err) {
      console.error(`${TAG} [REST] Poll error:`, err);
    }
  }
}

// ========================================
// 2. WebSocket Provider (실시간 체결가)
// ========================================

/**
 * KIS WebSocket 실시간 체결가(H0UNCNT0) 프로바이더.
 *
 * 체결가 데이터에 현재가/매도1호가/매수1호가/잔량이 모두 포함되어
 * 호가 구독 없이 체결가만으로 충분.
 *
 * 데이터 형식: 헤더|body (파이프 구분)
 * body 내부: ^(캐럿) 구분 필드
 */
export class WebSocketMarketDataProvider implements MarketDataProvider {
  readonly type = 'websocket' as const;
  private subscriptions = new Set<string>();
  private cache = new Map<string, TickData>();
  private callbacks: TickCallback[] = [];
  private ctx: AccountContext;
  private ws: WebSocket | null = null;
  private approvalKey: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pendingSubscribes: string[] = [];

  // REST fallback: WebSocket이 안 될 때 사용
  private restFallback: RestMarketDataProvider;
  private usingFallback = false;
  private fallbackStartedAt: number | null = null;

  // warm-up: fallback 종료 후 정상 tick 수신 확인 구간
  private warmupUntil: number | null = null;
  private warmupDurationMs = 5_000;

  constructor(ctx: AccountContext) {
    this.ctx = ctx;
    this.restFallback = new RestMarketDataProvider(ctx, 500);
    this.restFallback.onTick(tick => {
      if (this.usingFallback) {
        this.cache.set(tick.ticker, tick);
        for (const cb of this.callbacks) cb(tick);
      }
    });
  }

  subscribe(ticker: string): void {
    this.subscriptions.add(ticker);
    if (this.usingFallback) {
      this.restFallback.subscribe(ticker);
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.approvalKey) {
      this.sendSubscribe(ticker);
    } else {
      this.pendingSubscribes.push(ticker);
    }
  }

  unsubscribe(ticker: string): void {
    this.subscriptions.delete(ticker);
    this.cache.delete(ticker);
    if (this.usingFallback) {
      this.restFallback.unsubscribe(ticker);
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.approvalKey) {
      this.sendUnsubscribe(ticker);
    }
  }

  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  getLatestTick(ticker: string): TickData | null {
    return this.cache.get(ticker) ?? null;
  }

  onTick(callback: TickCallback): void {
    this.callbacks.push(callback);
  }

  isFallbackActive(): boolean {
    return this.usingFallback;
  }

  getFallbackDurationMs(): number {
    if (!this.usingFallback || !this.fallbackStartedAt) return 0;
    return Date.now() - this.fallbackStartedAt;
  }

  isWarmingUp(): boolean {
    if (!this.warmupUntil) return false;
    if (Date.now() >= this.warmupUntil) {
      this.warmupUntil = null;
      return false;
    }
    return true;
  }

  async start(): Promise<void> {
    this.running = true;

    try {
      // 1) approval_key 발급
      this.approvalKey = await this.getApprovalKey();
      console.log(`${TAG} [WS] Approval key acquired`);

      // 2) WebSocket 연결
      await this.connect();
      console.log(`${TAG} [WS] Provider started`);
    } catch (err) {
      console.error(`${TAG} [WS] Start failed, falling back to REST:`, err);
      this.switchToFallback();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.usingFallback) {
      await this.restFallback.stop();
    }
    this.subscriptions.clear();
    this.cache.clear();
    console.log(`${TAG} [WS] Provider stopped`);
  }

  // ---- WebSocket 연결 관리 ----

  private async getApprovalKey(): Promise<string> {
    const { appKey, appSecret } = this.ctx.credentials;
    const baseUrl = 'https://openapi.koreainvestment.com:9443';

    const response = await fetch(`${baseUrl}/oauth2/Approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: appKey,
        secretkey: appSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Approval key request failed: ${response.status}`);
    }

    const data = await response.json() as { approval_key: string };
    return data.approval_key;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = 'ws://ops.koreainvestment.com:21000/tryitout/H0UNCNT0';
      this.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
        this.ws?.close();
      }, 10_000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        console.log(`${TAG} [WS] Connected`);

        // 대기 중인 구독 처리
        for (const ticker of this.pendingSubscribes) {
          this.sendSubscribe(ticker);
        }
        this.pendingSubscribes = [];

        // 기존 구독 복구 (재연결 시)
        for (const ticker of this.subscriptions) {
          this.sendSubscribe(ticker);
        }

        resolve();
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        try {
          this.handleMessage(raw.toString());
        } catch (err) {
          console.error(`${TAG} [WS] Message parse error:`, err);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`${TAG} [WS] Disconnected: ${code} ${reason.toString()}`);
        if (this.running) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        console.error(`${TAG} [WS] Error:`, err.message);
        clearTimeout(timeout);
        if (!this.ws || this.ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });

      this.ws.on('ping', () => {
        this.ws?.pong();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return;
    console.log(`${TAG} [WS] Reconnecting in 3s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        this.approvalKey = await this.getApprovalKey();
        await this.connect();
        // 재연결 성공 시 REST fallback 해제 + warm-up 시작
        if (this.usingFallback) {
          console.log(`${TAG} [WS] Reconnected, switching back from REST fallback — warm-up ${this.warmupDurationMs}ms`);
          await this.restFallback.stop();
          this.usingFallback = false;
          this.fallbackStartedAt = null;
          this.warmupUntil = Date.now() + this.warmupDurationMs;
        }
      } catch (err) {
        console.error(`${TAG} [WS] Reconnect failed:`, err);
        if (this.running) {
          this.switchToFallback();
        }
      }
    }, 3_000);
  }

  private switchToFallback(): void {
    if (this.usingFallback) return;
    this.usingFallback = true;
    this.fallbackStartedAt = Date.now();
    console.log(`${TAG} [WS] Switching to REST fallback`);
    // 현재 구독을 REST fallback에 복제
    for (const ticker of this.subscriptions) {
      this.restFallback.subscribe(ticker);
    }
    this.restFallback.start();
  }

  // ---- 구독 메시지 전송 ----

  private sendSubscribe(ticker: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.approvalKey) return;

    const msg = JSON.stringify({
      header: {
        approval_key: this.approvalKey,
        custtype: 'P',
        tr_type: '1',       // 1=등록
        'content-type': 'utf-8',
      },
      body: {
        input: {
          tr_id: 'H0UNCNT0',  // 실시간 체결가(통합)
          tr_key: ticker,
        },
      },
    });

    this.ws.send(msg);
    console.log(`${TAG} [WS] Subscribed: ${ticker}`);
  }

  private sendUnsubscribe(ticker: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.approvalKey) return;

    const msg = JSON.stringify({
      header: {
        approval_key: this.approvalKey,
        custtype: 'P',
        tr_type: '2',       // 2=해제
        'content-type': 'utf-8',
      },
      body: {
        input: {
          tr_id: 'H0UNCNT0',
          tr_key: ticker,
        },
      },
    });

    this.ws.send(msg);
    console.log(`${TAG} [WS] Unsubscribed: ${ticker}`);
  }

  // ---- 수신 메시지 파싱 ----

  /**
   * KIS WebSocket 메시지 형식:
   *
   * 1) JSON 응답 (구독 확인 등): {"header":{...},"body":{...}}
   * 2) 실시간 데이터: "0|H0UNCNT0|003|005930^..." (파이프 구분, 필드는 ^ 구분)
   *
   * 실시간 데이터 구조:
   *   [0] 암호화여부 (0=평문, 1=암호화)
   *   [1] TR_ID
   *   [2] 데이터 건수
   *   [3~] 데이터 (^로 필드 구분)
   */
  private handleMessage(raw: string): void {
    // JSON 응답 (구독 확인)
    if (raw.startsWith('{')) {
      try {
        const json = JSON.parse(raw);
        const trId = json.header?.tr_id;
        const msgCd = json.header?.msg_cd;
        if (msgCd) {
          console.log(`${TAG} [WS] Response: tr_id=${trId} msg=${json.body?.msg1 || msgCd}`);
        }
      } catch {
        // 무시
      }
      return;
    }

    // 실시간 데이터
    const parts = raw.split('|');
    if (parts.length < 4) return;

    const encrypted = parts[0];
    const trId = parts[1];

    if (encrypted === '1') {
      // 암호화 데이터는 현재 미지원 (유료 시세)
      // TODO: AES 복호화 구현 필요 시 추가
      return;
    }

    if (trId !== 'H0UNCNT0') return;

    // 데이터 건수만큼 반복 (보통 1건)
    const dataCount = parseInt(parts[2], 10) || 1;
    const dataStr = parts.slice(3).join('|'); // 혹시 데이터 내 | 있을 경우 대비

    // 각 건은 ^로 구분된 필드
    // 여러 건이면 ^^ 로 구분될 수 있음 — 실제로는 보통 단일 건
    const records = dataStr.split('^^');

    for (const record of records.slice(0, dataCount)) {
      const fields = record.split('^');
      if (fields.length < 40) continue; // 최소 필드 수 체크

      // 체결가(H0UNCNT0) 필드 순서 (0-indexed):
      // 0: MKSC_SHRN_ISCD (종목코드)
      // 1: STCK_CNTG_HOUR (체결시간)
      // 2: STCK_PRPR (현재가)
      // 10: ASKP1 (매도1호가)
      // 11: BIDP1 (매수1호가)
      // 12: CNTG_VOL (체결거래량)
      // 13: ACML_VOL (누적거래량)
      // 14: ACML_TR_PBMN (누적거래대금)
      // 36: ASKP_RSQN1 (매도잔량1)
      // 37: BIDP_RSQN1 (매수잔량1)

      const ticker = fields[0];
      const tick: TickData = {
        ticker,
        currentPrice: parseInt(fields[2], 10) || 0,
        askPrice: parseInt(fields[10], 10) || 0,
        bidPrice: parseInt(fields[11], 10) || 0,
        bidQty1: parseInt(fields[37], 10) || 0,
        askQty1: parseInt(fields[36], 10) || 0,
        volume: parseInt(fields[13], 10) || 0,
        tradeAmt: parseInt(fields[14], 10) || 0,
        timestamp: Date.now(),
      };

      if (tick.currentPrice > 0 && this.subscriptions.has(ticker)) {
        this.cache.set(ticker, tick);
        for (const cb of this.callbacks) cb(tick);
      }
    }
  }
}

// ========================================
// Factory
// ========================================

export type MarketDataMode = 'websocket' | 'rest';

export function createMarketDataProvider(
  ctx: AccountContext,
  mode: MarketDataMode = 'websocket',
): MarketDataProvider {
  if (mode === 'websocket') {
    return new WebSocketMarketDataProvider(ctx);
  }
  return new RestMarketDataProvider(ctx);
}
