/**
 * 단타 v1 — 한국 주식 호가단위 유틸
 *
 * 한국거래소(KRX) 호가단위표에 따라 가격대별 틱 사이즈를 계산.
 * 모든 진입/익절/손절 가격은 이 함수를 통해 계산해야 한다.
 */

/**
 * 가격대별 호가단위 (2023년 기준 KRX 규정)
 *
 * 가격대              호가단위
 * 2,000 미만          1
 * 2,000~5,000         5
 * 5,000~20,000        10
 * 20,000~50,000       50
 * 50,000~200,000      100
 * 200,000~500,000     500
 * 500,000 이상        1,000
 */
export function getTickSize(price: number): number {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

/** 현재가에서 n틱 위 가격 */
export function priceUpTicks(price: number, ticks: number): number {
  let p = price;
  for (let i = 0; i < ticks; i++) {
    p += getTickSize(p);
  }
  return p;
}

/** 현재가에서 n틱 아래 가격 */
export function priceDownTicks(price: number, ticks: number): number {
  let p = price;
  for (let i = 0; i < ticks; i++) {
    const tick = getTickSize(p - 1); // 경계에서 아래 단위 기준
    p -= tick;
  }
  return Math.max(p, 0);
}

/** 두 가격 사이의 틱 수 계산 (높은 가격 - 낮은 가격 방향) */
export function ticksBetween(high: number, low: number): number {
  if (high <= low) return 0;
  let ticks = 0;
  let p = low;
  while (p < high) {
    p += getTickSize(p);
    ticks++;
    if (ticks > 100) break; // safety
  }
  return ticks;
}

/** 가격을 호가단위에 맞게 반올림 (매수: 올림, 매도: 내림) */
export function roundToTick(price: number, side: 'BUY' | 'SELL'): number {
  const tick = getTickSize(price);
  if (side === 'BUY') {
    return Math.ceil(price / tick) * tick;
  }
  return Math.floor(price / tick) * tick;
}
