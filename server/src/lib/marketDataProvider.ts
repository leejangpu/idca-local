/**
 * 공유 시세 데이터 프로바이더
 *
 * 전략 간 WebSocket 연결을 공유하기 위한 공통 모듈.
 * 계좌별 싱글톤 + 레퍼런스 카운트 구독으로 관리.
 *
 * 두 가지 구현:
 * 1. RestMarketDataProvider — REST polling (fallback)
 * 2. WebSocketMarketDataProvider — KIS WebSocket 실시간 체결가
 *
 * KIS WebSocket 스펙:
 * - 실시간 체결가(통합): TR_ID=H0UNCNT0, ws://ops.koreainvestment.com:21000
 * - 실시간 호가(통합): TR_ID=H0UNASP0 (동일 커넥션)
 * - 실시간 체결통보: TR_ID=H0STCNI0 (동일 커넥션, AES256 암호화)
 * - approval_key: /oauth2/Approval API로 발급
 * - 최대 40종목 동시 구독
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import { type AccountContext } from './accountContext';
import { getOrRefreshToken } from './kisApi';

const TAG = '[MarketData]';

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

/** 종목별 호가 스냅샷 (H0UNASP0) */
export interface OrderbookData {
  ticker: string;
  askPrices: number[];      // 매도호가 1~10
  bidPrices: number[];      // 매수호가 1~10
  askQtys: number[];        // 매도호가 잔량 1~10
  bidQtys: number[];        // 매수호가 잔량 1~10
  totalAskQty: number;      // 총 매도호가 잔량
  totalBidQty: number;      // 총 매수호가 잔량
  timestamp: number;
}

/** 체결통보 (H0STCNI0) */
export interface ExecutionNotification {
  orderNo: string;          // 주문번호 (ODER_NO)
  ticker: string;           // 종목코드 (STCK_SHRN_ISCD)
  side: '01' | '02';       // 01=매도, 02=매수 (SELN_BYOV_CLS)
  filledQty: number;        // 체결수량 (CNTG_QTY)
  filledPrice: number;      // 체결단가 (CNTG_UNPR)
  orderQty: number;         // 주문수량 (ODER_QTY)
  orderPrice: number;       // 주문가격 (ODER_PRC)
  status: 'accepted' | 'filled' | 'rejected';  // CNTG_YN 기반
  timestamp: number;
}

export type TickCallback = (tick: TickData) => void;
export type OrderbookCallback = (ob: OrderbookData) => void;
export type ExecutionCallback = (exec: ExecutionNotification) => void;

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

  // --- 호가 (H0UNASP0) ---
  /** 호가 구독 */
  subscribeOrderbook(ticker: string): void;
  /** 호가 구독 해제 */
  unsubscribeOrderbook(ticker: string): void;
  /** 최신 호가 캐시 */
  getLatestOrderbook(ticker: string): OrderbookData | null;
  /** 호가 수신 콜백 */
  onOrderbook(callback: OrderbookCallback): void;

  // --- 체결통보 (H0STCNI0) ---
  /** 체결통보 구독 (HTS ID 기반) */
  subscribeExecution(htsId: string): void;
  /** 체결통보 구독 해제 */
  unsubscribeExecution(htsId: string): void;
  /** 체결통보 수신 콜백 */
  onExecution(callback: ExecutionCallback): void;
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

  // REST provider: 호가/체결통보는 no-op
  subscribeOrderbook(_ticker: string): void { /* no-op */ }
  unsubscribeOrderbook(_ticker: string): void { /* no-op */ }
  getLatestOrderbook(_ticker: string): OrderbookData | null { return null; }
  onOrderbook(_callback: OrderbookCallback): void { /* no-op */ }
  subscribeExecution(_htsId: string): void { /* no-op */ }
  unsubscribeExecution(_htsId: string): void { /* no-op */ }
  onExecution(_callback: ExecutionCallback): void { /* no-op */ }

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
// 2. WebSocket Provider (멀티 TR_ID)
// ========================================

/**
 * KIS WebSocket 프로바이더 — H0UNCNT0(체결가) + H0UNASP0(호가) + H0STCNI0(체결통보).
 *
 * 동일 WS 커넥션에서 tr_id 필드로 구분하여 멀티 구독.
 * H0STCNI0는 AES256-CBC 암호화 → 구독 응답에서 iv/key를 추출하여 복호화.
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
  private pendingSubscribes: Array<{ trId: string; trKey: string }> = [];

  // REST fallback: WebSocket이 안 될 때 사용
  private restFallback: RestMarketDataProvider;
  private usingFallback = false;
  private fallbackStartedAt: number | null = null;

  // warm-up: fallback 종료 후 정상 tick 수신 확인 구간
  private warmupUntil: number | null = null;
  private warmupDurationMs = 5_000;

  // --- 호가 (H0UNASP0) ---
  private orderbookSubscriptions = new Set<string>();
  private orderbookCache = new Map<string, OrderbookData>();
  private orderbookCallbacks: OrderbookCallback[] = [];

  // --- 체결통보 (H0STCNI0) ---
  private executionSubscriptions = new Set<string>();  // HTS IDs
  private executionCallbacks: ExecutionCallback[] = [];
  private aesKey: string | null = null;
  private aesIv: string | null = null;

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
      this.sendSubscribeMsg('H0UNCNT0', ticker);
    } else {
      this.pendingSubscribes.push({ trId: 'H0UNCNT0', trKey: ticker });
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
      this.sendUnsubscribeMsg('H0UNCNT0', ticker);
    }
  }

  subscribeOrderbook(ticker: string): void {
    this.orderbookSubscriptions.add(ticker);
    if (this.usingFallback) return;
    if (this.ws?.readyState === WebSocket.OPEN && this.approvalKey) {
      this.sendSubscribeMsg('H0UNASP0', ticker);
    } else {
      this.pendingSubscribes.push({ trId: 'H0UNASP0', trKey: ticker });
    }
  }

  unsubscribeOrderbook(ticker: string): void {
    this.orderbookSubscriptions.delete(ticker);
    this.orderbookCache.delete(ticker);
    if (this.ws?.readyState === WebSocket.OPEN && this.approvalKey) {
      this.sendUnsubscribeMsg('H0UNASP0', ticker);
    }
  }

  getLatestOrderbook(ticker: string): OrderbookData | null {
    return this.orderbookCache.get(ticker) ?? null;
  }

  onOrderbook(callback: OrderbookCallback): void {
    this.orderbookCallbacks.push(callback);
  }

  subscribeExecution(htsId: string): void {
    this.executionSubscriptions.add(htsId);
    if (this.ws?.readyState === WebSocket.OPEN && this.approvalKey) {
      this.sendSubscribeMsg('H0STCNI0', htsId);
    } else {
      this.pendingSubscribes.push({ trId: 'H0STCNI0', trKey: htsId });
    }
  }

  unsubscribeExecution(htsId: string): void {
    this.executionSubscriptions.delete(htsId);
    if (this.ws?.readyState === WebSocket.OPEN && this.approvalKey) {
      this.sendUnsubscribeMsg('H0STCNI0', htsId);
    }
  }

  onExecution(callback: ExecutionCallback): void {
    this.executionCallbacks.push(callback);
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
    this.orderbookSubscriptions.clear();
    this.orderbookCache.clear();
    this.executionSubscriptions.clear();
    this.aesKey = null;
    this.aesIv = null;
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
        for (const { trId, trKey } of this.pendingSubscribes) {
          this.sendSubscribeMsg(trId, trKey);
        }
        this.pendingSubscribes = [];

        // 기존 구독 복구 (재연결 시)
        for (const ticker of this.subscriptions) {
          this.sendSubscribeMsg('H0UNCNT0', ticker);
        }
        for (const ticker of this.orderbookSubscriptions) {
          this.sendSubscribeMsg('H0UNASP0', ticker);
        }
        for (const htsId of this.executionSubscriptions) {
          this.sendSubscribeMsg('H0STCNI0', htsId);
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

  // ---- 구독 메시지 전송 (일반화) ----

  private sendSubscribeMsg(trId: string, trKey: string): void {
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
          tr_id: trId,
          tr_key: trKey,
        },
      },
    });

    this.ws.send(msg);
    console.log(`${TAG} [WS] Subscribed: ${trId}/${trKey}`);
  }

  private sendUnsubscribeMsg(trId: string, trKey: string): void {
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
          tr_id: trId,
          tr_key: trKey,
        },
      },
    });

    this.ws.send(msg);
    console.log(`${TAG} [WS] Unsubscribed: ${trId}/${trKey}`);
  }

  // ---- AES256-CBC 복호화 (H0STCNI0) ----

  private decryptAes256Cbc(encrypted: string): string {
    if (!this.aesKey || !this.aesIv) {
      throw new Error('AES key/iv not available');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      this.aesKey,
      this.aesIv,
    );
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
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
        // H0STCNI0 구독 응답에서 AES iv/key 추출
        if (trId === 'H0STCNI0' && json.body?.output) {
          const { iv, key } = json.body.output;
          if (iv && key) {
            this.aesIv = iv;
            this.aesKey = key;
            console.log(`${TAG} [WS] H0STCNI0 AES key/iv acquired`);
          }
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
    const dataStr = parts.slice(3).join('|');

    // TR_ID별 dispatch
    if (trId === 'H0UNCNT0') {
      if (encrypted === '1') return; // 암호화 미지원
      this.parseTickData(parts[2], dataStr);
    } else if (trId === 'H0UNASP0') {
      if (encrypted === '1') return;
      this.parseOrderbookData(parts[2], dataStr);
    } else if (trId === 'H0STCNI0') {
      // H0STCNI0는 항상 암호화
      if (encrypted === '1') {
        try {
          const decrypted = this.decryptAes256Cbc(dataStr);
          this.parseExecutionData(parts[2], decrypted);
        } catch (err) {
          console.error(`${TAG} [WS] H0STCNI0 decrypt error:`, err);
        }
      } else {
        // 비암호화 (모의투자 등)
        this.parseExecutionData(parts[2], dataStr);
      }
    }
  }

  private parseTickData(countStr: string, dataStr: string): void {
    const dataCount = parseInt(countStr, 10) || 1;
    const records = dataStr.split('^^');

    for (const record of records.slice(0, dataCount)) {
      const fields = record.split('^');
      if (fields.length < 40) continue;

      // 체결가(H0UNCNT0) 필드 순서 (0-indexed):
      // 0: MKSC_SHRN_ISCD (종목코드)
      // 2: STCK_PRPR (현재가)
      // 10: ASKP1 (매도1호가)
      // 11: BIDP1 (매수1호가)
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

  /**
   * H0UNASP0 필드 순서 (0-indexed, CSV 스펙 기준):
   * 0: MKSC_SHRN_ISCD (종목코드)
   * 1: BSOP_HOUR (영업시간)
   * 2: HOUR_CLS_CODE (시간구분)
   * 3~12: ASKP1~ASKP10 (매도호가 1~10)
   * 13~22: BIDP1~BIDP10 (매수호가 1~10)
   * 23~32: ASKP_RSQN1~ASKP_RSQN10 (매도잔량 1~10)
   * 33~42: BIDP_RSQN1~BIDP_RSQN10 (매수잔량 1~10)
   * 43: TOTAL_ASKP_RSQN (총매도잔량)
   * 44: TOTAL_BIDP_RSQN (총매수잔량)
   */
  private parseOrderbookData(countStr: string, dataStr: string): void {
    const dataCount = parseInt(countStr, 10) || 1;
    const records = dataStr.split('^^');

    for (const record of records.slice(0, dataCount)) {
      const f = record.split('^');
      if (f.length < 45) continue;

      const ticker = f[0];
      const askPrices: number[] = [];
      const bidPrices: number[] = [];
      const askQtys: number[] = [];
      const bidQtys: number[] = [];

      for (let i = 0; i < 10; i++) {
        askPrices.push(parseInt(f[3 + i], 10) || 0);
        bidPrices.push(parseInt(f[13 + i], 10) || 0);
        askQtys.push(parseInt(f[23 + i], 10) || 0);
        bidQtys.push(parseInt(f[33 + i], 10) || 0);
      }

      const ob: OrderbookData = {
        ticker,
        askPrices,
        bidPrices,
        askQtys,
        bidQtys,
        totalAskQty: parseInt(f[43], 10) || 0,
        totalBidQty: parseInt(f[44], 10) || 0,
        timestamp: Date.now(),
      };

      if (this.orderbookSubscriptions.has(ticker)) {
        this.orderbookCache.set(ticker, ob);
        for (const cb of this.orderbookCallbacks) cb(ob);
      }
    }
  }

  /**
   * H0STCNI0 필드 순서 (0-indexed, CSV 스펙 기준):
   * 0: CUST_ID (고객ID)
   * 1: ACNT_NO (계좌번호)
   * 2: ODER_NO (주문번호)
   * 3: OODER_NO (원주문번호)
   * 4: SELN_BYOV_CLS (매도매수구분: 01=매도, 02=매수)
   * 5: RCTF_CLS (정정구분)
   * 6: ODER_KIND (주문종류)
   * 7: ODER_COND (주문조건)
   * 8: STCK_SHRN_ISCD (종목코드)
   * 9: CNTG_QTY (체결수량)
   * 10: CNTG_UNPR (체결단가)
   * 11: STCK_CNTG_HOUR (체결시간)
   * 12: RFUS_YN (거부여부)
   * 13: CNTG_YN (체결여부: 1=접수, 2=체결)
   * 14: ACPT_YN (접수여부)
   * 15: BRNC_NO (지점번호)
   * 16: ODER_QTY (주문수량)
   * 17: ACNT_NAME (계좌명)
   * 18: CNTG_ISNM40 (체결종목명)
   * 19: ODER_PRC (주문가격)
   */
  private parseExecutionData(countStr: string, dataStr: string): void {
    const dataCount = parseInt(countStr, 10) || 1;
    const records = dataStr.split('^^');

    for (const record of records.slice(0, dataCount)) {
      const f = record.split('^');
      if (f.length < 17) continue;

      const cntgYn = f[13];
      // 체결통보만 처리 (2=체결), 접수통보(1)는 무시
      if (cntgYn !== '2') continue;

      const exec: ExecutionNotification = {
        orderNo: f[2],
        ticker: f[8],
        side: f[4] as '01' | '02',
        filledQty: parseInt(f[9], 10) || 0,
        filledPrice: parseInt(f[10], 10) || 0,
        orderQty: parseInt(f[16], 10) || 0,
        orderPrice: f.length > 19 ? (parseInt(f[19], 10) || 0) : 0,
        status: cntgYn === '2' ? 'filled' : (f[12] === '1' ? 'rejected' : 'accepted'),
        timestamp: Date.now(),
      };

      if (exec.filledQty > 0) {
        console.log(`${TAG} [WS] H0STCNI0 체결: ${exec.side === '01' ? '매도' : '매수'} ${exec.ticker} ${exec.filledQty}주 @${exec.filledPrice} (ODNO=${exec.orderNo})`);
        for (const cb of this.executionCallbacks) cb(exec);
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

// ========================================
// 계좌별 싱글톤 레지스트리
// ========================================

const providerRegistry = new Map<string, MarketDataProvider>();

/** 계좌별 프로바이더 등록 (시작은 호출자가 직접) */
export function setProvider(accountId: string, provider: MarketDataProvider): void {
  providerRegistry.set(accountId, provider);
}

/** 계좌별 프로바이더 조회 */
export function getProvider(accountId: string): MarketDataProvider | undefined {
  return providerRegistry.get(accountId);
}

/** 프로바이더 제거 (stop은 호출자가 직접) */
export function removeProvider(accountId: string): void {
  providerRegistry.delete(accountId);
}

/** 프로바이더가 없으면 생성 + 등록 (start는 호출자가 직접) */
export function getOrCreateProvider(
  accountId: string,
  ctx: AccountContext,
  mode: MarketDataMode = 'websocket',
): MarketDataProvider {
  const existing = providerRegistry.get(accountId);
  if (existing) return existing;

  const provider = createMarketDataProvider(ctx, mode);
  providerRegistry.set(accountId, provider);
  return provider;
}

// ========================================
// 레퍼런스 카운트 구독 관리
// ========================================

// accountId → ticker → Set<consumer>
const refCounts = new Map<string, Map<string, Set<string>>>();

function getRefMap(accountId: string): Map<string, Set<string>> {
  if (!refCounts.has(accountId)) {
    refCounts.set(accountId, new Map());
  }
  return refCounts.get(accountId)!;
}

/**
 * 레퍼런스 카운트 기반 구독.
 * 같은 종목을 여러 전략(consumer)이 구독해도 WS 구독은 1회만 발생.
 * @returns 실제 WS 구독이 발생했으면 true
 */
export function subscribeWithRef(accountId: string, ticker: string, consumer: string): boolean {
  const provider = providerRegistry.get(accountId);
  if (!provider) {
    console.warn(`${TAG} subscribeWithRef: no provider for ${accountId}`);
    return false;
  }

  const refs = getRefMap(accountId);
  let consumers = refs.get(ticker);
  if (!consumers) {
    consumers = new Set();
    refs.set(ticker, consumers);
  }

  const isNew = consumers.size === 0;
  consumers.add(consumer);

  if (isNew) {
    provider.subscribe(ticker);
    return true;
  }
  return false;
}

/**
 * 레퍼런스 카운트 기반 구독 해제.
 * 모든 consumer가 해제해야 실제 WS 구독이 해제됨.
 * @returns 실제 WS 구독 해제가 발생했으면 true
 */
export function unsubscribeWithRef(accountId: string, ticker: string, consumer: string): boolean {
  const refs = getRefMap(accountId);
  const consumers = refs.get(ticker);
  if (!consumers) return false;

  consumers.delete(consumer);

  if (consumers.size === 0) {
    refs.delete(ticker);
    const provider = providerRegistry.get(accountId);
    if (provider) {
      provider.unsubscribe(ticker);
      return true;
    }
  }
  return false;
}

/**
 * 특정 consumer의 모든 구독 해제.
 * 전략 종료 시 호출하면 해당 전략이 구독한 모든 종목을 정리.
 */
export function unsubscribeAllByConsumer(accountId: string, consumer: string): void {
  const refs = getRefMap(accountId);
  const provider = providerRegistry.get(accountId);

  for (const [ticker, consumers] of refs) {
    if (consumers.has(consumer)) {
      consumers.delete(consumer);
      if (consumers.size === 0) {
        refs.delete(ticker);
        provider?.unsubscribe(ticker);
      }
    }
  }
}

/** 레퍼런스 카운트 전체 초기화 (계좌 단위) */
export function clearRefs(accountId: string): void {
  refCounts.delete(accountId);
}

// ========================================
// 호가 레퍼런스 카운트 구독 관리
// ========================================

const orderbookRefCounts = new Map<string, Map<string, Set<string>>>();

function getOrderbookRefMap(accountId: string): Map<string, Set<string>> {
  if (!orderbookRefCounts.has(accountId)) {
    orderbookRefCounts.set(accountId, new Map());
  }
  return orderbookRefCounts.get(accountId)!;
}

export function subscribeOrderbookWithRef(accountId: string, ticker: string, consumer: string): boolean {
  const provider = providerRegistry.get(accountId);
  if (!provider) return false;

  const refs = getOrderbookRefMap(accountId);
  let consumers = refs.get(ticker);
  if (!consumers) {
    consumers = new Set();
    refs.set(ticker, consumers);
  }

  const isNew = consumers.size === 0;
  consumers.add(consumer);

  if (isNew) {
    provider.subscribeOrderbook(ticker);
    return true;
  }
  return false;
}

export function unsubscribeOrderbookWithRef(accountId: string, ticker: string, consumer: string): boolean {
  const refs = getOrderbookRefMap(accountId);
  const consumers = refs.get(ticker);
  if (!consumers) return false;

  consumers.delete(consumer);

  if (consumers.size === 0) {
    refs.delete(ticker);
    const provider = providerRegistry.get(accountId);
    if (provider) {
      provider.unsubscribeOrderbook(ticker);
      return true;
    }
  }
  return false;
}

export function unsubscribeAllOrderbookByConsumer(accountId: string, consumer: string): void {
  const refs = getOrderbookRefMap(accountId);
  const provider = providerRegistry.get(accountId);

  for (const [ticker, consumers] of refs) {
    if (consumers.has(consumer)) {
      consumers.delete(consumer);
      if (consumers.size === 0) {
        refs.delete(ticker);
        provider?.unsubscribeOrderbook(ticker);
      }
    }
  }
}
