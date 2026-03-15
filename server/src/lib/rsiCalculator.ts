/**
 * RSI/EMA 계산 및 분봉 집계 유틸리티
 */

export interface MinuteBar {
  time: string;   // HHMMSS
  date?: string;  // YYYYMMDD
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number; // 체결 거래량 (optional — 기존 코드 영향 없음)
}

/**
 * Wilder's RSI 계산
 * @param closes 종가 배열 (시간순 정렬, 오래된 것부터)
 * @param period RSI 기간 (기본 14)
 * @returns RSI 값 (0~100) 또는 데이터 부족 시 null
 */
export function calculateRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // 초기 평균 (SMA)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

/**
 * 1분봉 → N분봉 집계 (국내주식용)
 * @param bars 1분봉 배열 (시간순 정렬, 오래된 것부터)
 * @param intervalMinutes 집계 간격 (5, 15 등)
 * @returns 집계된 N분봉 배열
 */
export function aggregateMinuteBars(
  bars: MinuteBar[],
  intervalMinutes: number,
): MinuteBar[] {
  if (bars.length === 0) return [];

  const result: MinuteBar[] = [];
  let bucket: MinuteBar[] = [];

  const getBucketKey = (bar: MinuteBar): string => {
    const hh = parseInt(bar.time.substring(0, 2));
    const mm = parseInt(bar.time.substring(2, 4));
    const totalMinutes = hh * 60 + mm;
    const bucketStart = Math.floor(totalMinutes / intervalMinutes) * intervalMinutes;
    const date = bar.date || '';
    return `${date}_${bucketStart}`;
  };

  let currentKey = getBucketKey(bars[0]);

  for (const bar of bars) {
    const key = getBucketKey(bar);
    if (key !== currentKey) {
      if (bucket.length > 0) {
        const hasVolume = bucket.some(b => b.volume !== undefined);
        result.push({
          time: bucket[0].time,
          date: bucket[0].date,
          open: bucket[0].open,
          high: Math.max(...bucket.map(b => b.high)),
          low: Math.min(...bucket.map(b => b.low)),
          close: bucket[bucket.length - 1].close,
          ...(hasVolume && { volume: bucket.reduce((sum, b) => sum + (b.volume || 0), 0) }),
        });
      }
      bucket = [];
      currentKey = key;
    }
    bucket.push(bar);
  }

  // 마지막 버킷
  if (bucket.length > 0) {
    const hasVolume = bucket.some(b => b.volume !== undefined);
    result.push({
      time: bucket[0].time,
      date: bucket[0].date,
      open: bucket[0].open,
      high: Math.max(...bucket.map(b => b.high)),
      low: Math.min(...bucket.map(b => b.low)),
      close: bucket[bucket.length - 1].close,
      ...(hasVolume && { volume: bucket.reduce((sum, b) => sum + (b.volume || 0), 0) }),
    });
  }

  return result;
}

// ==================== EMA 함수 ====================

/**
 * EMA(지수이동평균) 계산 — 과거 데이터 배열로 초기 seed 생성
 * @param closes 종가 배열 (시간순, 오래된 것부터)
 * @param period EMA 기간 (9, 20 등)
 * @returns EMA 값 또는 데이터 부족 시 null
 */
export function calculateEMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * 기존 EMA에 새 close를 반영하여 갱신 — 매 틱 갱신용
 * @param prevEma 이전 EMA 값
 * @param newClose 새 종가
 * @param period EMA 기간
 * @returns 갱신된 EMA 값
 */
export function updateEMA(prevEma: number, newClose: number, period: number): number {
  const k = 2 / (period + 1);
  return newClose * k + prevEma * (1 - k);
}

// ==================== RSI 증분 갱신 ====================

/**
 * RSI 증분 갱신용 내부 상태
 * avgGain/avgLoss를 저장하여 매 틱 O(1) 갱신 가능
 */
export interface RSIState {
  avgGain: number;
  avgLoss: number;
  prevClose: number;
  period: number;
}

/**
 * 과거 데이터로 RSIState 초기화 (Wilder's smoothing)
 * @param closes 종가 배열 (시간순, 오래된 것부터, 최소 period+1개)
 * @param period RSI 기간 (기본 14)
 * @returns RSIState 또는 데이터 부족 시 null
 */
export function calculateRSIState(closes: number[], period = 14): RSIState | null {
  if (closes.length < period + 1) return null;

  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // 초기 SMA
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing (나머지 데이터 적용)
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  return {
    avgGain,
    avgLoss,
    prevClose: closes[closes.length - 1],
    period,
  };
}

/**
 * RSIState에서 RSI 값 계산
 */
export function getRSIFromState(state: RSIState): number {
  if (state.avgLoss === 0) return 100;
  const rs = state.avgGain / state.avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

/**
 * 새 close로 RSIState를 증분 갱신 + RSI 값 반환
 * @param state 이전 RSIState
 * @param newClose 새 종가
 * @returns 갱신된 RSIState + RSI 값
 */
export function updateRSIState(
  state: RSIState,
  newClose: number,
): { rsiState: RSIState; rsi: number } {
  const change = newClose - state.prevClose;
  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? Math.abs(change) : 0;
  const { period } = state;

  const avgGain = (state.avgGain * (period - 1) + gain) / period;
  const avgLoss = (state.avgLoss * (period - 1) + loss) / period;

  const rsiState: RSIState = { avgGain, avgLoss, prevClose: newClose, period };
  return { rsiState, rsi: getRSIFromState(rsiState) };
}
