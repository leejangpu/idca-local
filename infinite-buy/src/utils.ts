/**
 * 유틸리티 — 휴장일, 날짜, 포맷
 */

// ==================== 미국 시장 휴장일 ====================

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const firstDay = new Date(year, month, 1);
  const firstWeekday = firstDay.getDay();
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (n - 1) * 7;
  return new Date(year, month, day);
}

function getLastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDay = new Date(year, month + 1, 0);
  const diff = (lastDay.getDay() - weekday + 7) % 7;
  return new Date(year, month, lastDay.getDate() - diff);
}

function getGoodFriday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(year, month, day);
  easter.setDate(easter.getDate() - 2);
  return easter;
}

function getUSMarketHolidays(year: number): Date[] {
  const holidays: Date[] = [];

  const newYear = new Date(year, 0, 1);
  if (newYear.getDay() === 0) newYear.setDate(2);
  if (newYear.getDay() === 6) newYear.setDate(newYear.getDate() - 1);
  holidays.push(newYear);

  holidays.push(getNthWeekdayOfMonth(year, 0, 1, 3));  // MLK Day
  holidays.push(getNthWeekdayOfMonth(year, 1, 1, 3));  // Presidents Day
  holidays.push(getGoodFriday(year));

  const memorialDay = getLastWeekdayOfMonth(year, 4, 1);
  holidays.push(memorialDay);

  const juneteenth = new Date(year, 5, 19);
  if (juneteenth.getDay() === 0) juneteenth.setDate(20);
  if (juneteenth.getDay() === 6) juneteenth.setDate(18);
  holidays.push(juneteenth);

  const independenceDay = new Date(year, 6, 4);
  if (independenceDay.getDay() === 0) independenceDay.setDate(5);
  if (independenceDay.getDay() === 6) independenceDay.setDate(3);
  holidays.push(independenceDay);

  holidays.push(getNthWeekdayOfMonth(year, 8, 1, 1));  // Labor Day
  holidays.push(getNthWeekdayOfMonth(year, 10, 4, 4)); // Thanksgiving

  const christmas = new Date(year, 11, 25);
  if (christmas.getDay() === 0) christmas.setDate(26);
  if (christmas.getDay() === 6) christmas.setDate(24);
  holidays.push(christmas);

  return holidays;
}

// ==================== 날짜 유틸 ====================

/** 현재 ET 시간 기준 Date 반환 */
export function getETNow(): Date {
  const now = new Date();
  const year = now.getUTCFullYear();
  const marchSecondSunday = new Date(year, 2, 8 + (7 - new Date(year, 2, 1).getDay()) % 7);
  const novFirstSunday = new Date(year, 10, 1 + (7 - new Date(year, 10, 1).getDay()) % 7);
  const isDST = now >= marchSecondSunday && now < novFirstSunday;
  const offset = isDST ? -4 : -5;
  return new Date(now.getTime() + offset * 60 * 60 * 1000);
}

/** ET 기준 오늘 날짜 YYYYMMDD */
export function getETDateString(): string {
  const et = getETNow();
  const y = et.getUTCFullYear();
  const m = String(et.getUTCMonth() + 1).padStart(2, '0');
  const d = String(et.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** ET 기준 오늘 날짜 YYYY-MM-DD */
export function getETDateISO(): string {
  const s = getETDateString();
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 미국 휴장일 체크 (주말 포함) */
export function isUSMarketClosed(): boolean {
  const et = getETNow();
  const day = et.getUTCDay();
  // 주말
  if (day === 0 || day === 6) return true;
  // 공휴일
  const year = et.getUTCFullYear();
  const holidays = getUSMarketHolidays(year);
  const dateStr = getETDateString();
  for (const h of holidays) {
    const hStr = `${h.getFullYear()}${String(h.getMonth() + 1).padStart(2, '0')}${String(h.getDate()).padStart(2, '0')}`;
    if (dateStr === hStr) return true;
  }
  return false;
}

/** ISO 현재 시각 */
export function nowISO(): string {
  return new Date().toISOString();
}

/** USD 포맷 */
export function fmtUSD(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
