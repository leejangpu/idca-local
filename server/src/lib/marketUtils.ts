/**
 * 마켓 유틸리티 모듈
 *
 * 국내(domestic)와 해외(overseas) 주식 시장 구분 및 관련 유틸리티.
 * 실사오팔 듀얼 마켓 지원의 핵심 모듈.
 */

export type MarketType = 'domestic' | 'overseas';

// ==================== 마켓 감지 ====================

/**
 * 티커 코드로 마켓 타입 판별
 * - 6자리 숫자 → 국내 (예: 005930, 069500)
 * - 그 외 → 해외 (예: SOXL, TQQQ, AAPL)
 */
export function getMarketType(ticker: string): MarketType {
  return /^\d{6}$/.test(ticker) ? 'domestic' : 'overseas';
}

export function isDomesticTicker(ticker: string): boolean {
  return getMarketType(ticker) === 'domestic';
}

export function isOverseasTicker(ticker: string): boolean {
  return getMarketType(ticker) === 'overseas';
}

// ==================== 가격 포맷 ====================

/**
 * 가격 표시 포맷
 * - 국내: "12,345원" (KRW)
 * - 해외: "$45.20"
 */
export function formatPrice(price: number, market: MarketType): string {
  if (market === 'domestic') {
    return `${Math.round(price).toLocaleString('ko-KR')}원`;
  }
  return `$${price.toFixed(2)}`;
}

/**
 * 금액 표시 포맷 (formatPrice와 동일하지만 의미적 구분)
 */
export function formatCurrency(amount: number, market: MarketType): string {
  return formatPrice(amount, market);
}

/**
 * 가격 반올림
 * - 국내: 정수 (KRW)
 * - 해외: 소수점 2자리 (USD)
 */
export function roundPrice(price: number, market: MarketType): number {
  if (market === 'domestic') {
    return Math.round(price);
  }
  return Math.round(price * 100) / 100;
}

// ==================== 호가단위 (국내주식) ====================

/**
 * 국내주식 호가단위 계산 (가격대별)
 * 현재가 API 응답의 aspr_unit 필드가 있으면 그것을 사용하고,
 * 없을 경우 이 함수로 폴백.
 */
export function getKoreanTickSize(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/**
 * 국내주식 호가단위에 맞게 가격 반올림
 * @param price 원래 가격
 * @param tickSize 호가단위 (aspr_unit). 없으면 가격대별 자동 계산
 */
export function roundToKoreanTick(price: number, tickSize?: number): number {
  const tick = tickSize || getKoreanTickSize(price);
  return Math.round(price / tick) * tick;
}

/**
 * 국내주식 호가단위에 맞게 가격 올림 (매도 목표가용)
 * 매도 목표가는 올림해야 최소 익절 마진이 보장됨
 */
export function roundToKoreanTickCeil(price: number, tickSize?: number): number {
  const tick = tickSize || getKoreanTickSize(price);
  return Math.ceil(price / tick) * tick;
}

/**
 * 국내주식 호가단위에 맞게 가격 내림 (손절가용)
 * 손절가는 내림해야 조기 손절을 방지
 */
export function roundToKoreanTickFloor(price: number, tickSize?: number): number {
  const tick = tickSize || getKoreanTickSize(price);
  return Math.floor(price / tick) * tick;
}

// ==================== 한국장 시간 ====================

/**
 * 한국장 개장 여부 (09:00~15:30 KST)
 */
export function isKRMarketOpen(): boolean {
  const now = new Date();
  const kstOffset = 9; // UTC+9
  const kstTime = new Date(now.getTime() + kstOffset * 60 * 60 * 1000);

  const hours = kstTime.getUTCHours();
  const minutes = kstTime.getUTCMinutes();
  const day = kstTime.getUTCDay();

  // 주말 제외
  if (day === 0 || day === 6) return false;

  const totalMinutes = hours * 60 + minutes;
  const marketOpen = 9 * 60;      // 09:00
  const marketClose = 15 * 60 + 30; // 15:30

  return totalMinutes >= marketOpen && totalMinutes < marketClose;
}

/**
 * 두 시각 사이의 국내장 개장 시간(분)만 계산
 * 주말·공휴일·야간 시간을 제외하고 09:00~15:30 KST 범위만 카운트
 */
export function getKRMarketMinutesBetween(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;

  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const MARKET_OPEN = 9 * 60;       // 09:00 = 540분
  const MARKET_CLOSE = 15 * 60 + 30; // 15:30 = 930분
  const MARKET_MINUTES_PER_DAY = MARKET_CLOSE - MARKET_OPEN; // 390분

  const toKST = (ms: number) => new Date(ms + KST_OFFSET_MS);

  const isMarketDay = (kstDate: Date): boolean => {
    const day = kstDate.getUTCDay();
    if (day === 0 || day === 6) return false;
    if (getKRMarketHolidayName(kstDate)) return false;
    return true;
  };

  // KST 자정 기준 분(minute) 추출
  const getMinuteOfDay = (kstDate: Date): number =>
    kstDate.getUTCHours() * 60 + kstDate.getUTCMinutes();

  // KST 날짜 자정(UTC) 구하기
  const getDayStart = (kstDate: Date): Date =>
    new Date(Date.UTC(kstDate.getUTCFullYear(), kstDate.getUTCMonth(), kstDate.getUTCDate()));

  const fromKST = toKST(fromMs);
  const toKSTDate = toKST(toMs);

  const fromDay = getDayStart(fromKST);
  const toDay = getDayStart(toKSTDate);

  // 같은 날
  if (fromDay.getTime() === toDay.getTime()) {
    if (!isMarketDay(fromKST)) return 0;
    const startMin = Math.max(getMinuteOfDay(fromKST), MARKET_OPEN);
    const endMin = Math.min(getMinuteOfDay(toKSTDate), MARKET_CLOSE);
    return Math.max(0, endMin - startMin);
  }

  // 여러 날에 걸친 경우
  let total = 0;

  // 첫째 날: from ~ 15:30
  if (isMarketDay(fromKST)) {
    const startMin = Math.max(getMinuteOfDay(fromKST), MARKET_OPEN);
    total += Math.max(0, MARKET_CLOSE - startMin);
  }

  // 중간 날들: 온전한 장일이면 390분
  const oneDay = 24 * 60 * 60 * 1000;
  let cursor = new Date(fromDay.getTime() + oneDay);
  while (cursor.getTime() < toDay.getTime()) {
    if (isMarketDay(cursor)) {
      total += MARKET_MINUTES_PER_DAY;
    }
    cursor = new Date(cursor.getTime() + oneDay);
  }

  // 마지막 날: 09:00 ~ to
  if (isMarketDay(toKSTDate)) {
    const endMin = Math.min(getMinuteOfDay(toKSTDate), MARKET_CLOSE);
    total += Math.max(0, endMin - MARKET_OPEN);
  }

  return total;
}

// ==================== 한국 휴장일 ====================

interface KRHoliday {
  month: number; // 0-indexed
  day: number;
  name: string;
}

/**
 * 한국 양력 고정 공휴일
 */
const FIXED_HOLIDAYS: KRHoliday[] = [
  { month: 0, day: 1, name: '신정' },
  { month: 2, day: 1, name: '삼일절' },
  { month: 4, day: 5, name: '어린이날' },
  { month: 5, day: 6, name: '현충일' },
  { month: 7, day: 15, name: '광복절' },
  { month: 9, day: 3, name: '개천절' },
  { month: 9, day: 9, name: '한글날' },
  { month: 11, day: 25, name: '크리스마스' },
];

/**
 * 한국 음력 공휴일 (연도별 양력 변환 하드코딩)
 * 설날(음력 1.1), 추석(음력 8.15), 석가탄신일(음력 4.8) + 전후 1일
 */
const LUNAR_HOLIDAYS: Record<number, Array<{ month: number; day: number; name: string }>> = {
  2025: [
    { month: 0, day: 28, name: '설날 연휴' },
    { month: 0, day: 29, name: '설날' },
    { month: 0, day: 30, name: '설날 연휴' },
    { month: 4, day: 5, name: '석가탄신일/어린이날' }, // 5.5와 겹침
    { month: 9, day: 5, name: '추석 연휴' },
    { month: 9, day: 6, name: '추석' },
    { month: 9, day: 7, name: '추석 연휴' },
  ],
  2026: [
    { month: 1, day: 16, name: '설날 연휴' },
    { month: 1, day: 17, name: '설날' },
    { month: 1, day: 18, name: '설날 연휴' },
    { month: 4, day: 24, name: '석가탄신일' },
    { month: 8, day: 24, name: '추석 연휴' },
    { month: 8, day: 25, name: '추석' },
    { month: 8, day: 26, name: '추석 연휴' },
  ],
  2027: [
    { month: 1, day: 6, name: '설날 연휴' },
    { month: 1, day: 7, name: '설날' },
    { month: 1, day: 8, name: '설날 연휴' },
    { month: 4, day: 13, name: '석가탄신일' },
    { month: 9, day: 14, name: '추석 연휴' },
    { month: 9, day: 15, name: '추석' },
    { month: 9, day: 16, name: '추석 연휴' },
  ],
};

/**
 * 한국 시장 휴장일 이름 반환 (KST 기준 Date)
 * @returns 휴장일 이름 또는 null
 */
export function getKRMarketHolidayName(date: Date): string | null {
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();

  // 양력 고정 공휴일 체크
  for (const h of FIXED_HOLIDAYS) {
    if (month === h.month && day === h.day) return h.name;
  }

  // 음력 공휴일 체크
  const lunarHolidays = LUNAR_HOLIDAYS[year];
  if (lunarHolidays) {
    for (const h of lunarHolidays) {
      if (month === h.month && day === h.day) return h.name;
    }
  }

  return null;
}

/**
 * KST 기준 현재 날짜 문자열 (YYYYMMDD)
 */
export function getKSTDateString(): string {
  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kstTime.getUTCFullYear()}${String(kstTime.getUTCMonth() + 1).padStart(2, '0')}${String(kstTime.getUTCDate()).padStart(2, '0')}`;
}

/**
 * KST 기준 현재 분(minute) 계산 (0~1439)
 */
export function getKSTCurrentMinute(): number {
  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kstTime.getUTCHours() * 60 + kstTime.getUTCMinutes();
}

/**
 * ET(미국 동부시간) 기준 현재 분(minute) 계산 (0~1439)
 * DST 자동 반영: 3월 둘째 일요일 ~ 11월 첫째 일요일 = EDT(-4), 그 외 EST(-5)
 */
export function getETCurrentMinute(): number {
  const now = new Date();
  const year = now.getUTCFullYear();
  const marchSecondSunday = new Date(Date.UTC(year, 2, 8 + (7 - new Date(Date.UTC(year, 2, 1)).getUTCDay()) % 7));
  const novFirstSunday = new Date(Date.UTC(year, 10, 1 + (7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7));
  const isDST = now >= marchSecondSunday && now < novFirstSunday;
  const offset = isDST ? -4 : -5;
  const etTime = new Date(now.getTime() + offset * 60 * 60 * 1000);
  return etTime.getUTCHours() * 60 + etTime.getUTCMinutes();
}
