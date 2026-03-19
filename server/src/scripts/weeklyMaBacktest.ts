/**
 * 주봉/일봉 10이평 골든/데드크로스 백테스트
 *
 * 전략:
 *   - 매수: 전봉 종가 <= 전봉 SMA10  &&  이번봉 종가 > 이번봉 SMA10 (골든크로스)
 *   - 매도: 전봉 종가 >= 전봉 SMA10  &&  이번봉 종가 < 이번봉 SMA10 (데드크로스)
 *   - 체결가 = 해당 봉의 종가 (단순 모델)
 *
 * 사용법:
 *   cd server
 *   tsx src/scripts/weeklyMaBacktest.ts 005930 000660       # 주봉 (기본값)
 *   tsx src/scripts/weeklyMaBacktest.ts --daily TQQQ SOXL  # 일봉
 */

import { KisApiClient, getOrRefreshToken } from '../lib/kisApi';
import { getEnabledAccounts } from '../lib/accountContext';

// 해외 종목 여부 판별 (숫자 6자리면 국내, 그 외 해외)
function isOverseas(ticker: string): boolean {
  return !/^\d{6}$/.test(ticker);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const MA_PERIOD = 10;
const YEARS_BACK = 5;

// ==================== 타입 ====================

interface WeeklyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  buyDate: string;
  buyPrice: number;
  buySMA: number;        // 매수 시점 SMA10
  buyGapPct: number;     // 매수 시점 괴리율 = (close - SMA) / SMA * 100
  sellDate: string | null;
  sellPrice: number | null;
  returnPct: number | null;
  holdingPeriod: number | null; // 보유 기간 (주봉: 주, 일봉: 일)
}

// ==================== 유틸 ====================

function calcSMA(closes: number[], endIdx: number, period: number): number | null {
  if (endIdx < period - 1) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) sum += closes[i];
  return sum / period;
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function periodBetween(dateA: string, dateB: string, daily: boolean): number {
  const parse = (s: string) => new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  ).getTime();
  const ms = parse(dateB) - parse(dateA);
  return Math.round(ms / (daily ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000));
}

// ==================== 데이터 수집 ====================

/**
 * Yahoo Finance에서 봉 데이터 조회 (해외 종목 전용 fallback)
 * 공개 API — 인증 불필요
 */
async function fetchBarsYahoo(ticker: string, daily: boolean): Promise<WeeklyBar[]> {
  const interval = daily ? '1d' : '1wk';
  const range = `${YEARS_BACK}y`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
  return fetchYahooUrl(ticker, url);
}

async function fetchYahooUrl(ticker: string, url: string): Promise<WeeklyBar[]> {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Yahoo Finance 요청 실패: ${resp.status} (${ticker})`);
  const json = await resp.json() as any;

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance 응답 구조 이상 (${ticker})`);

  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const adjClose: number[] = result.indicators?.adjclose?.[0]?.adjclose ?? q.close ?? [];

  const bars: WeeklyBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = Number(adjClose[i] ?? q.close?.[i]);
    if (!c || isNaN(c)) continue;
    const d = new Date(timestamps[i] * 1000);
    const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    bars.push({
      date,
      open:   Number(q.open?.[i])   || c,
      high:   Number(q.high?.[i])   || c,
      low:    Number(q.low?.[i])    || c,
      close:  c,
      volume: Number(q.volume?.[i]) || 0,
    });
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchWeeklyBarsYahoo(ticker: string): Promise<WeeklyBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1wk&range=${YEARS_BACK}y`;
  return fetchYahooUrl(ticker, url);
}

/**
 * 주봉 데이터 페이지네이션 조회 (국내)
 * KIS API는 최대 100봉/호출이므로 endDate를 앞당겨가며 반복 조회
 */
async function fetchWeeklyBarsKIS(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  token: string,
  ticker: string,
): Promise<WeeklyBar[]> {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const start = new Date(kstNow);
  start.setUTCFullYear(start.getUTCFullYear() - YEARS_BACK);
  const globalStartDate = formatDate(start);

  const allBars: WeeklyBar[] = [];
  let currentEnd = formatDate(kstNow);

  for (let page = 0; page < 6; page++) {
    if (currentEnd <= globalStartDate) break;

    await sleep(400);
    const resp = await kisClient.getDomesticDailyBars(
      appKey, appSecret, token,
      ticker, globalStartDate, currentEnd, 'W'
    );
    const raw = resp.output2 ?? [];
    if (raw.length === 0) break;

    const parsed: WeeklyBar[] = raw
      .filter(b => b.stck_clpr && Number(b.stck_clpr) > 0)
      .map(b => ({
        date: b.stck_bsop_date,
        open: Number(b.stck_oprc),
        high: Number(b.stck_hgpr),
        low: Number(b.stck_lwpr),
        close: Number(b.stck_clpr),
        volume: Number(b.acml_vol),
      }));

    allBars.push(...parsed);
    if (raw.length < 100) break;

    const oldest = parsed.reduce((a, b) => (a.date < b.date ? a : b));
    const o = oldest.date;
    const prev = new Date(Date.UTC(
      parseInt(o.slice(0, 4)),
      parseInt(o.slice(4, 6)) - 1,
      parseInt(o.slice(6, 8)) - 1,
    ));
    currentEnd = formatDate(prev);
  }

  const seen = new Set<string>();
  return allBars
    .filter(b => { if (seen.has(b.date)) return false; seen.add(b.date); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 국내 일봉 페이지네이션 조회 (KIS, periodCode='D')
 */
async function fetchDailyBarsKIS(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  token: string,
  ticker: string,
): Promise<WeeklyBar[]> {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);

  const start = new Date(kstNow);
  start.setUTCFullYear(start.getUTCFullYear() - YEARS_BACK);
  const globalStartDate = formatDate(start);

  const allBars: WeeklyBar[] = [];
  let currentEnd = formatDate(kstNow);

  for (let page = 0; page < 20; page++) { // 일봉은 페이지 더 많이 필요
    if (currentEnd <= globalStartDate) break;

    await sleep(400);
    const resp = await kisClient.getDomesticDailyBars(
      appKey, appSecret, token,
      ticker, globalStartDate, currentEnd, 'D'
    );
    const raw = resp.output2 ?? [];
    if (raw.length === 0) break;

    const parsed: WeeklyBar[] = raw
      .filter(b => b.stck_clpr && Number(b.stck_clpr) > 0)
      .map(b => ({
        date: b.stck_bsop_date,
        open: Number(b.stck_oprc),
        high: Number(b.stck_hgpr),
        low: Number(b.stck_lwpr),
        close: Number(b.stck_clpr),
        volume: Number(b.acml_vol),
      }));

    allBars.push(...parsed);
    if (raw.length < 100) break;

    const oldest = parsed.reduce((a, b) => (a.date < b.date ? a : b));
    const o = oldest.date;
    const prev = new Date(Date.UTC(
      parseInt(o.slice(0, 4)),
      parseInt(o.slice(4, 6)) - 1,
      parseInt(o.slice(6, 8)) - 1,
    ));
    currentEnd = formatDate(prev);
  }

  const seen = new Set<string>();
  return allBars
    .filter(b => { if (seen.has(b.date)) return false; seen.add(b.date); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchBars(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  token: string,
  ticker: string,
  daily: boolean,
): Promise<WeeklyBar[]> {
  if (isOverseas(ticker)) {
    return fetchBarsYahoo(ticker, daily);
  }
  return daily
    ? fetchDailyBarsKIS(kisClient, appKey, appSecret, token, ticker)
    : fetchWeeklyBarsKIS(kisClient, appKey, appSecret, token, ticker);
}

export async function fetchWeeklyBars(
  kisClient: KisApiClient,
  appKey: string,
  appSecret: string,
  token: string,
  ticker: string,
): Promise<WeeklyBar[]> {
  return fetchBars(kisClient, appKey, appSecret, token, ticker, false);
}

// ==================== 백테스트 ====================

function backtest(bars: WeeklyBar[], daily: boolean): {
  trades: Trade[];
  stats: {
    totalTrades: number;
    winRate: number;
    avgReturn: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    avgHoldingPeriod: number;
    cumulativeReturn: number;
    mdd: number;
  };
} {
  const closes = bars.map(b => b.close);
  const trades: Trade[] = [];
  let inPosition = false;
  let buyBar: WeeklyBar | null = null;

  for (let i = MA_PERIOD; i < bars.length; i++) {
    const currSMA = calcSMA(closes, i, MA_PERIOD)!;
    const prevSMA = calcSMA(closes, i - 1, MA_PERIOD)!;
    const curr = closes[i];
    const prev = closes[i - 1];

    if (!inPosition) {
      // 골든크로스: 전봉이 SMA 아래 또는 같음 → 현봉이 SMA 위로 돌파
      if (prev <= prevSMA && curr > currSMA) {
        inPosition = true;
        buyBar = { ...bars[i], _sma: currSMA } as WeeklyBar & { _sma: number };
      }
    } else {
      // 데드크로스: 전봉이 SMA 위 또는 같음 → 현봉이 SMA 아래로 하락 돌파
      if (prev >= prevSMA && curr < currSMA && buyBar) {
        const buySMA = (buyBar as WeeklyBar & { _sma: number })._sma;
        trades.push({
          buyDate: buyBar.date,
          buyPrice: buyBar.close,
          buySMA,
          buyGapPct: (buyBar.close - buySMA) / buySMA * 100,
          sellDate: bars[i].date,
          sellPrice: curr,
          returnPct: (curr - buyBar.close) / buyBar.close * 100,
          holdingPeriod: periodBetween(buyBar.date, bars[i].date, daily),
        });
        inPosition = false;
        buyBar = null;
      }
    }
  }

  // 미청산 포지션
  if (inPosition && buyBar) {
    const buySMA = (buyBar as WeeklyBar & { _sma: number })._sma ?? 0;
    trades.push({
      buyDate: buyBar.date,
      buyPrice: buyBar.close,
      buySMA,
      buyGapPct: buySMA > 0 ? (buyBar.close - buySMA) / buySMA * 100 : 0,
      sellDate: null,
      sellPrice: null,
      returnPct: null,
      holdingPeriod: null,
    });
  }

  const completed = trades.filter(t => t.returnPct !== null) as (Trade & { returnPct: number })[];
  const wins = completed.filter(t => t.returnPct > 0);
  const losses = completed.filter(t => t.returnPct <= 0);

  const winRate = completed.length > 0 ? wins.length / completed.length * 100 : 0;
  const avgReturn = completed.length > 0
    ? completed.reduce((s, t) => s + t.returnPct, 0) / completed.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.returnPct, 0) / losses.length : 0;
  const grossProfit = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const avgHoldingPeriod = completed.length > 0
    ? completed.reduce((s, t) => s + (t.holdingPeriod ?? 0), 0) / completed.length : 0;

  // 복리 누적 수익률 + MDD
  let equity = 1.0;
  let peak = 1.0;
  let mdd = 0;
  for (const t of completed) {
    equity *= (1 + t.returnPct / 100);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > mdd) mdd = dd;
  }
  const cumulativeReturn = (equity - 1) * 100;

  return {
    trades,
    stats: {
      totalTrades: completed.length,
      winRate,
      avgReturn,
      avgWin,
      avgLoss,
      profitFactor,
      avgHoldingPeriod,
      cumulativeReturn,
      mdd,
    },
  };
}

// ==================== 출력 ====================

function printResults(ticker: string, bars: WeeklyBar[], { trades, stats }: ReturnType<typeof backtest>, daily: boolean) {
  const unit = daily ? '일' : '주';
  const completed = trades.filter(t => t.returnPct !== null);
  const openTrade = trades.find(t => t.returnPct === null);

  const sep = '─'.repeat(60);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  [${ticker}]  ${daily ? '일봉' : '주봉'} ${MA_PERIOD}이평 골든/데드크로스 백테스트`);
  console.log(`  기간: ${bars[0]?.date} ~ ${bars[bars.length - 1]?.date}  (${bars.length}${unit}봉)`);
  console.log('═'.repeat(60));

  if (completed.length === 0) {
    console.log('  완료된 거래 없음');
  } else {
    console.log(`  완료 거래       : ${stats.totalTrades}회`);
    console.log(`  승률            : ${stats.winRate.toFixed(1)}%`);
    console.log(`  평균 수익률     : ${stats.avgReturn >= 0 ? '+' : ''}${stats.avgReturn.toFixed(2)}%`);
    console.log(`  평균 이익       : +${stats.avgWin.toFixed(2)}%`);
    console.log(`  평균 손실       : ${stats.avgLoss.toFixed(2)}%`);
    console.log(`  손익비          : ${isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}`);
    console.log(`  평균 보유 기간  : ${stats.avgHoldingPeriod.toFixed(1)}${unit}`);
    console.log(sep);
    console.log(`  복리 누적 수익  : ${stats.cumulativeReturn >= 0 ? '+' : ''}${stats.cumulativeReturn.toFixed(2)}%`);
    console.log(`  최대 낙폭 (MDD) : -${stats.mdd.toFixed(2)}%`);
  }

  if (openTrade) {
    const currentBar = bars[bars.length - 1];
    const unrealizedPct = (currentBar.close - openTrade.buyPrice) / openTrade.buyPrice * 100;
    console.log(sep);
    console.log(`  현재 보유 중    : ${openTrade.buyDate} 매수 @ ${openTrade.buyPrice.toLocaleString()}`);
    console.log(`  미실현 손익     : ${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}% (현재가 ${currentBar.close.toLocaleString()})`);
  }

  if (completed.length > 0) {
    console.log(`\n  거래 내역`);
    console.log(`  ${'매수일'.padEnd(10)} ${'매수가'.padStart(8)}  ${'매도일'.padEnd(10)} ${'매도가'.padStart(8)}  ${'수익률'.padStart(8)}  ${'보유'}`);
    console.log(`  ${sep}`);
    for (const t of completed) {
      const ret = t.returnPct!;
      const sign = ret >= 0 ? '+' : '';
      const retStr = `${sign}${ret.toFixed(2)}%`;
      const gapStr = `(${t.buyGapPct >= 0 ? '+' : ''}${t.buyGapPct.toFixed(1)}%)`;
      console.log(
        `  ${t.buyDate.padEnd(10)} ${t.buyPrice.toLocaleString().padStart(8)} ${gapStr.padEnd(8)}  ` +
        `${t.sellDate!.padEnd(10)} ${t.sellPrice!.toLocaleString().padStart(8)}  ` +
        `${retStr.padStart(8)}  ${t.holdingPeriod}${unit}`
      );
    }
  }

  // 괴리율 구간별 분석
  printGapAnalysis(trades);
}

// ==================== 괴리율 구간별 분석 ====================

function printGapAnalysis(trades: Trade[]) {
  const completed = trades.filter(
    (t): t is Trade & { returnPct: number } => t.returnPct !== null
  );
  if (completed.length < 3) return;

  // 구간 정의: 상한 초과 → 해당 버킷
  const BUCKETS: Array<{ label: string; min: number; max: number }> = [
    { label: '0% ~ 1%',   min: 0,   max: 1   },
    { label: '1% ~ 2%',   min: 1,   max: 2   },
    { label: '2% ~ 3%',   min: 2,   max: 3   },
    { label: '3% ~ 5%',   min: 3,   max: 5   },
    { label: '5% ~ 8%',   min: 5,   max: 8   },
    { label: '8% ~ 12%',  min: 8,   max: 12  },
    { label: '12%+',      min: 12,  max: Infinity },
  ];

  type BucketStat = {
    count: number;
    wins: number;
    returns: number[];
  };

  const stats = new Map<string, BucketStat>(
    BUCKETS.map(b => [b.label, { count: 0, wins: 0, returns: [] }])
  );

  for (const t of completed) {
    const gap = t.buyGapPct;
    const bucket = BUCKETS.find(b => gap >= b.min && gap < b.max);
    if (!bucket) continue;
    const s = stats.get(bucket.label)!;
    s.count++;
    if (t.returnPct > 0) s.wins++;
    s.returns.push(t.returnPct);
  }

  const sep = '─'.repeat(60);
  console.log(`\n  괴리율 구간별 성과 (매수 시점: 종가 vs SMA${MA_PERIOD})`);
  console.log(`  ${'구간'.padEnd(12)} ${'건수'.padStart(4)}  ${'승률'.padStart(6)}  ${'평균수익'.padStart(8)}  ${'평균이익'.padStart(8)}  ${'평균손실'.padStart(8)}`);
  console.log(`  ${sep}`);

  for (const b of BUCKETS) {
    const s = stats.get(b.label)!;
    if (s.count === 0) continue;

    const winRate = s.wins / s.count * 100;
    const avg = s.returns.reduce((a, v) => a + v, 0) / s.count;
    const wins = s.returns.filter(r => r > 0);
    const losses = s.returns.filter(r => r <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((a, v) => a + v, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, v) => a + v, 0) / losses.length : 0;

    const avgStr = `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`;
    const winStr = wins.length > 0 ? `+${avgWin.toFixed(2)}%` : '-';
    const lossStr = losses.length > 0 ? `${avgLoss.toFixed(2)}%` : '-';

    console.log(
      `  ${b.label.padEnd(12)} ${String(s.count).padStart(4)}  ` +
      `${(winRate.toFixed(1) + '%').padStart(6)}  ` +
      `${avgStr.padStart(8)}  ${winStr.padStart(8)}  ${lossStr.padStart(8)}`
    );
  }
  console.log(`  ${sep}`);
  console.log(`  * 괴리율 = (매수 종가 - SMA${MA_PERIOD}) / SMA${MA_PERIOD} × 100`);
}

// ==================== 메인 ====================

async function main() {
  const args = process.argv.slice(2);
  const daily = args.includes('--daily');
  const tickers = args.filter(a => a !== '--daily');

  if (tickers.length === 0) {
    console.log('사용법: tsx src/scripts/weeklyMaBacktest.ts [--daily] [종목코드...]');
    console.log('예시:   tsx src/scripts/weeklyMaBacktest.ts 005930');
    console.log('        tsx src/scripts/weeklyMaBacktest.ts --daily TQQQ SOXL\n');
    console.log('종목코드 미입력 → 삼성전자(005930) 기본 실행\n');
    tickers.push('005930');
  }

  const accounts = getEnabledAccounts();
  if (accounts.length === 0) {
    console.error('계좌 정보 없음. data/accounts/ 디렉토리 확인 필요.');
    process.exit(1);
  }

  const ctx = accounts[0];
  const { appKey, appSecret } = ctx.credentials;
  console.log(`계좌: ${ctx.nickname} (${ctx.accountId})  |  모드: ${daily ? '일봉' : '주봉'}`);

  const token = await getOrRefreshToken(
    '', ctx.accountId, { appKey, appSecret }, ctx.kisClient, false, ctx.store
  );

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    try {
      process.stdout.write(`[${ticker}] ${daily ? '일봉' : '주봉'} 조회 중...`);
      const bars = await fetchBars(ctx.kisClient, appKey, appSecret, token, ticker, daily);
      process.stdout.write(` ${bars.length}개 수집 완료\n`);

      if (bars.length < MA_PERIOD + 2) {
        console.log(`[${ticker}] 데이터 부족 (${bars.length}봉) — 스킵`);
        continue;
      }

      const result = backtest(bars, daily);
      printResults(ticker, bars, result, daily);
    } catch (err) {
      console.error(`\n[${ticker}] 오류:`, err);
    }
    if (i < tickers.length - 1) await sleep(500);
  }

  console.log('\n백테스트 완료.');
}

main().catch(console.error);
