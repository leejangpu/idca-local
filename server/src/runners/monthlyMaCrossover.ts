/**
 * 월봉 10이평 돌파 스크리닝 러너
 *
 * 매달 마지막 영업일 장 마감 후 (KST 16:00) 실행:
 *   1. KIS API로 시총 상위 ~100종목 수집 (가격대별 분할 호출)
 *   2. 각 종목의 월봉 데이터 조회 (최근 15개월)
 *   3. 지난달 종가 > 10개월 SMA && 전전달 종가 <= 10개월 SMA → 돌파!
 *   4. 텔레그램으로 결과 리포트 전송
 */

import { KisApiClient, getOrRefreshToken } from '../lib/kisApi';
import { sendTelegramMessage, getUserTelegramChatId } from '../lib/telegram';
import { getKRMarketHolidayName } from '../lib/marketUtils';
import { AccountContext } from '../lib/accountContext';
import { config } from '../config';

const TAG = '[MonthlyMA]';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface StockInfo {
  ticker: string;
  name: string;
  price: number;
}

interface MonthlyBar {
  date: string;
  close: number;
}

interface CrossoverResult {
  stock: StockInfo;
  prevClose: number;
  prevSMA10: number;
  lastClose: number;
  lastSMA10: number;
  monthDate: string;
  gapPct: string;
}

interface NearResult {
  stock: StockInfo;
  lastClose: number;
  lastSMA10: number;
  gapPct: string;
}

// ==================== 헬퍼 ====================

function calcSMA(closes: number[], endIdx: number, period: number): number | null {
  if (endIdx < period - 1) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    sum += closes[i];
  }
  return sum / period;
}

function isCommonStock(ticker: string, name: string): boolean {
  const lastDigit = ticker.charAt(5);
  if (['5', '7', '8', '9'].includes(lastDigit)) return false;
  if (name.includes('스팩') || name.includes('ETN')) return false;
  return true;
}

function formatNum(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}

/** 오늘이 이번 달 마지막 영업일인지 확인 */
export function isLastBusinessDayOfMonth(now: Date): boolean {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kst = new Date(now.getTime() + KST_OFFSET_MS);

  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth();
  const today = kst.getUTCDate();

  // 이번 달 마지막 날
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  // today ~ lastDay 중 남은 영업일이 있는지 확인
  for (let d = today + 1; d <= lastDay; d++) {
    const check = new Date(Date.UTC(year, month, d));
    const dow = check.getUTCDay();
    if (dow === 0 || dow === 6) continue; // 주말
    if (getKRMarketHolidayName(check)) continue; // 공휴일
    return false; // 남은 영업일이 있으면 마지막이 아님
  }
  return true;
}

// ==================== 시총 수집 ====================

async function collectMarketCapStocks(
  kisClient: KisApiClient,
  appKey: string, appSecret: string, token: string
): Promise<StockInfo[]> {
  const allStocks: StockInfo[] = [];

  // KOSPI — 가격대별 분할 호출 (30건 제한 우회)
  const priceRanges: Array<[string, string]> = [
    ['200000', ''],
    ['100000', '199999'],
    ['50000', '99999'],
    ['20000', '49999'],
    ['5000', '19999'],
  ];

  for (const [pMin, pMax] of priceRanges) {
    try {
      const resp = await kisClient.getDomesticMarketCapRanking(
        appKey, appSecret, token, { priceMin: pMin, priceMax: pMax }
      );
      if (resp.output) {
        for (const item of resp.output) {
          allStocks.push({
            ticker: item.mksc_shrn_iscd,
            name: item.hts_kor_isnm,
            price: parseInt(item.stck_prpr),
          });
        }
      }
    } catch (err) {
      console.error(`${TAG} 시총순위 조회 실패 (${pMin}~${pMax}):`, err);
    }
    await sleep(500);
  }

  // 중복 제거 + 우선주/스팩 필터
  const seen = new Set<string>();
  return allStocks.filter(s => {
    if (seen.has(s.ticker)) return false;
    seen.add(s.ticker);
    return isCommonStock(s.ticker, s.name);
  });
}

// ==================== 월봉 조회 + SMA 분석 ====================

async function analyzeMonthlyMA(
  kisClient: KisApiClient,
  appKey: string, appSecret: string, token: string,
  stocks: StockInfo[]
): Promise<{
  crossovers: CrossoverResult[];
  nearCrossovers: NearResult[];
  aboveCount: number;
  belowCount: number;
  errorCount: number;
}> {
  const crossovers: CrossoverResult[] = [];
  const nearCrossovers: NearResult[] = [];
  let aboveCount = 0;
  let belowCount = 0;
  let errorCount = 0;

  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentMonth = `${kstNow.getUTCFullYear()}${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}`;

  // 15개월 전~오늘
  const endDate = formatDate(kstNow);
  const startD = new Date(kstNow);
  startD.setUTCMonth(startD.getUTCMonth() - 15);
  const startDate = formatDate(startD);

  for (const stock of stocks) {
    await sleep(400);
    try {
      const resp = await kisClient.getDomesticDailyBars(
        appKey, appSecret, token,
        stock.ticker, startDate, endDate, 'M'
      );

      if (!resp.output2 || resp.output2.length < 12) continue;

      // 월봉 파싱 + 정렬 (오래된 순)
      const bars: MonthlyBar[] = resp.output2
        .map(item => ({ date: item.stck_bsop_date, close: parseInt(item.stck_clpr) }))
        .filter(b => b.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));

      // 이번달 봉 제거 (미완성)
      let completed = bars;
      if (completed.length > 0 && completed[completed.length - 1].date.startsWith(currentMonth)) {
        completed = completed.slice(0, -1);
      }
      if (completed.length < 11) continue;

      const closes = completed.map(b => b.close);
      const lastIdx = closes.length - 1;
      const prevIdx = lastIdx - 1;

      const lastSMA10 = calcSMA(closes, lastIdx, 10);
      const prevSMA10 = calcSMA(closes, prevIdx, 10);
      if (!lastSMA10 || !prevSMA10) continue;

      const lastClose = closes[lastIdx];
      const prevClose = closes[prevIdx];

      const isCrossover = lastClose > lastSMA10 && prevClose <= prevSMA10;
      const isAbove = lastClose > lastSMA10;

      if (isCrossover) {
        const gapPct = ((lastClose - lastSMA10) / lastSMA10 * 100).toFixed(1);
        crossovers.push({
          stock, prevClose, prevSMA10, lastClose, lastSMA10,
          monthDate: completed[lastIdx].date, gapPct,
        });
      } else if (isAbove) {
        aboveCount++;
      } else {
        belowCount++;
        // 돌파 임박 (이평 아래 -5% 이내)
        const gapPct = ((lastClose - lastSMA10) / lastSMA10 * 100).toFixed(1);
        if (parseFloat(gapPct) >= -5) {
          nearCrossovers.push({ stock, lastClose, lastSMA10, gapPct });
        }
      }
    } catch {
      errorCount++;
    }
  }

  nearCrossovers.sort((a, b) => parseFloat(b.gapPct) - parseFloat(a.gapPct));
  return { crossovers, nearCrossovers, aboveCount, belowCount, errorCount };
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// ==================== 텔레그램 리포트 ====================

function buildReport(
  totalStocks: number,
  crossovers: CrossoverResult[],
  nearCrossovers: NearResult[],
  aboveCount: number,
  belowCount: number,
): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;

  let msg = `📊 <b>월봉 10이평 돌파 스크리닝</b>\n`;
  msg += `${dateStr} | 시총 상위 ${totalStocks}종목\n\n`;

  if (crossovers.length > 0) {
    msg += `⭐ <b>돌파 종목 (${crossovers.length}개)</b>\n`;
    for (const c of crossovers) {
      msg += `\n<b>${c.stock.name}</b> (${c.stock.ticker})\n`;
      msg += `  전전달: ${formatNum(c.prevClose)} ≤ 10MA ${formatNum(c.prevSMA10)}\n`;
      msg += `  지난달: ${formatNum(c.lastClose)} &gt; 10MA ${formatNum(c.lastSMA10)} (+${c.gapPct}%)\n`;
    }
  } else {
    msg += `⭐ 돌파 종목 없음\n`;
  }

  if (nearCrossovers.length > 0) {
    msg += `\n▲ <b>돌파 임박 (이평 -5% 이내, ${nearCrossovers.length}개)</b>\n`;
    for (const n of nearCrossovers) {
      msg += `  ${n.stock.name} (${n.stock.ticker}) — ${formatNum(n.lastClose)} / 10MA ${formatNum(n.lastSMA10)} (${n.gapPct}%)\n`;
    }
  }

  msg += `\n📈 이평 위 유지: ${aboveCount}개`;
  msg += `\n📉 이평 아래: ${belowCount}개`;

  return msg;
}

// ==================== 메인 러너 ====================

export async function runMonthlyMaCrossover(ctx?: AccountContext): Promise<void> {
  const now = new Date();

  // 마지막 영업일 체크
  if (!isLastBusinessDayOfMonth(now)) {
    console.log(`${TAG} 마지막 영업일 아님 — 스킵`);
    return;
  }

  console.log(`${TAG} 월봉 10이평 돌파 스크리닝 시작`);

  try {
    const kisClient = ctx?.kisClient ?? new KisApiClient(config.kis.paperTrading);
    const credentials = ctx
      ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret }
      : { appKey: config.kis.appKey, appSecret: config.kis.appSecret };
    const accessToken = await getOrRefreshToken(
      '', ctx?.accountId ?? config.accountId, credentials, kisClient
    );

    // 1. 시총 상위 종목 수집
    console.log(`${TAG} 시총 상위 종목 수집 중...`);
    const stocks = await collectMarketCapStocks(
      kisClient, credentials.appKey, credentials.appSecret, accessToken
    );
    console.log(`${TAG} ${stocks.length}종목 수집 완료`);

    // 2. 월봉 분석
    console.log(`${TAG} 월봉 10이평 분석 중...`);
    const result = await analyzeMonthlyMA(
      kisClient, credentials.appKey, credentials.appSecret, accessToken, stocks
    );

    console.log(`${TAG} 완료 — 돌파: ${result.crossovers.length}, 임박: ${result.nearCrossovers.length}, 위: ${result.aboveCount}, 아래: ${result.belowCount}, 에러: ${result.errorCount}`);

    // 3. 텔레그램 전송
    const chatId = await getUserTelegramChatId();
    if (chatId) {
      const report = buildReport(
        stocks.length,
        result.crossovers,
        result.nearCrossovers,
        result.aboveCount,
        result.belowCount,
      );
      await sendTelegramMessage(chatId, report, 'HTML');
      console.log(`${TAG} 텔레그램 전송 완료`);
    } else {
      console.warn(`${TAG} 텔레그램 chatId 없음 — 전송 스킵`);
    }
  } catch (err) {
    console.error(`${TAG} 에러:`, err);

    // 에러 알림도 텔레그램으로
    const chatId = await getUserTelegramChatId();
    if (chatId) {
      await sendTelegramMessage(chatId, `⚠️ 월봉 10이평 스크리닝 실패\n${(err as Error).message}`, 'HTML');
    }
  }
}
