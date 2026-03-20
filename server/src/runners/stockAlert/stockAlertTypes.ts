/**
 * 종목 알리미 — 타입 정의
 */

export type AlertRegistrationType = 'holding' | 'watchlist';
export type BuyPhase = 'buy1_done' | 'buy2_done' | 'buy3_done';
export type SellPhase = 'none' | 'profit1_done' | 'profit2_done' | 'trailing';
export type AlertType = 'buy2' | 'buy3' | 'rapid_drop' | 'stop_loss' | 'profit1' | 'profit2' | 'trailing_ma20' | 'trailing_high';
export type StockMarket = 'KR' | 'US';

export interface StockAlert {
  id: string;                          // ticker를 ID로 사용
  ticker: string;
  stockName: string;                   // KIS 조회
  market: StockMarket;                 // KR: 국내, US: 미국
  type: AlertRegistrationType;

  // 매수 정보
  initialBuyPrice: number;             // 1차 매수가
  initialBuyAmount: number;            // 1차 매수금액 (50%)
  totalAmount: number;                 // 총 투자원금 (= initialBuyAmount * 2)

  // 사용자 입력 상태
  avgPrice: number;                    // 평균단가 (수동 입력)
  holdingQty: number;                  // 보유수량 (수동 입력)
  buyPhase: BuyPhase;
  sellPhase: SellPhase;

  // 실시간 추적
  highSinceEntry: number;              // 진입 후 최고가
  lastCheckedPrice: number;
  lastCheckedAt: string;
  ma20: number | null;                 // 20일선 (장마감 후 업데이트)

  // 알림 중복 방지
  alertsSent: Record<AlertType, string | null>;  // ISO timestamp or null

  // 급락 예외
  rapidDropDetected: boolean;

  // 메타
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export const COLLECTION = 'stockAlerts';
