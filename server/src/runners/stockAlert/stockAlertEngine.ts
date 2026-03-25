/**
 * 종목 알리미 엔진 — 장 마감 후 1일 1회, 종가 기준 판단
 * KR: 16:00 KST / US: 07:00 KST
 */

import { StockAlert, AlertType, COLLECTION } from './stockAlertTypes';
import * as localStore from '../../lib/localStore';
import { getOrRefreshToken } from '../../lib/kisApi';
import { KisApiClient } from '../../lib/kisApi';
import { sendTelegramMessage } from '../../lib/telegram';
import { config } from '../../config';
import { getEnabledAccounts } from '../../lib/accountContext';

const PREFIX = '[StockAlert]';
const kisClient = new KisApiClient();

function fmtKRW(n: number): string {
  return n.toLocaleString('ko-KR');
}

function fmtUSD(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPrice(n: number, market?: string): string {
  return market === 'US' ? `$${fmtUSD(n)}` : `${fmtKRW(n)}원`;
}

function roundPrice(price: number, market?: string): number {
  return market === 'US' ? Math.round(price * 100) / 100 : Math.round(price);
}

function pct(ratio: number): string {
  return (ratio * 100).toFixed(1) + '%';
}

async function sendAlert(alert: StockAlert, alertType: AlertType, message: string): Promise<void> {
  const chatId = config.telegram.adminChatId;
  const marketLabel = alert.market === 'US' ? '🇺🇸' : '🇰🇷';
  const text = `🔔 <b>종목 알리미</b> ${marketLabel}\n` +
    `<b>${alert.stockName}</b> (${alert.ticker})\n\n` +
    message;

  console.log(`${PREFIX} 알림 발송: ${alert.ticker} [${alertType}]`);
  await sendTelegramMessage(chatId, text, 'HTML');

  alert.alertsSent[alertType] = new Date().toISOString();
}

/** 일봉 종가 가져오기 (최근 N개) */
async function fetchDailyCloses(
  alert: StockAlert,
  accessToken: string,
  ctx: ReturnType<typeof getEnabledAccounts>[0],
  count: number = 25
): Promise<{ close: number; high: number; low: number; date: string }[] | null> {
  const m = alert.market || 'KR';
  const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  try {
    if (m === 'US') {
      const barRes = await kisClient.getOverseasDailyBars(
        ctx.credentials.appKey, ctx.credentials.appSecret, accessToken,
        alert.ticker, endDate
      );
      const bars = barRes.output2;
      if (!bars || bars.length < count) return null;
      return bars.slice(0, count).map(b => ({
        close: Number(b.clos),
        high: Number(b.high),
        low: Number(b.low),
        date: b.xymd,
      }));
    } else {
      const startD = new Date();
      startD.setDate(startD.getDate() - 60);
      const startDate = startD.toISOString().slice(0, 10).replace(/-/g, '');

      const barRes = await kisClient.getDomesticDailyBars(
        ctx.credentials.appKey, ctx.credentials.appSecret, accessToken,
        alert.ticker, startDate, endDate
      );
      const bars = barRes.output2;
      if (!bars || bars.length < count) return null;
      return bars.slice(0, count).map(b => ({
        close: Number(b.stck_clpr),
        high: Number(b.stck_hgpr),
        low: Number(b.stck_lwpr),
        date: b.stck_bsop_date,
      }));
    }
  } catch (err) {
    console.error(`${PREFIX} ${alert.ticker} 일봉 조회 실패:`, err);
    return null;
  }
}

/**
 * 장 마감 후 종가 기준 전체 체크
 * @param market 'KR' | 'US' — cron에서 시장별 호출
 */
export async function checkStockAlertsByClose(market: 'KR' | 'US'): Promise<void> {
  const allAlerts = localStore.getAllStates<StockAlert>(COLLECTION);
  if (allAlerts.size === 0) return;

  const accounts = getEnabledAccounts();
  if (accounts.length === 0) {
    console.log(`${PREFIX} 활성 계정 없음, 스킵`);
    return;
  }

  const ctx = accounts[0];
  let accessToken: string;
  try {
    accessToken = await getOrRefreshToken(
      'default', ctx.accountId, ctx.credentials, ctx.kisClient, false, ctx.store
    );
  } catch (err) {
    console.error(`${PREFIX} 토큰 발급 실패:`, err);
    return;
  }

  for (const [id, alert] of allAlerts) {
    if (!alert.active) continue;
    if ((alert.market || 'KR') !== market) continue;

    try {
      const m = alert.market || 'KR';

      // 일봉 조회 (최근 25개 — MA20 계산 + 여유)
      const bars = await fetchDailyCloses(alert, accessToken, ctx, 25);
      if (!bars || bars.length < 20) {
        console.log(`${PREFIX} ${alert.ticker} 일봉 부족`);
        continue;
      }

      const closePrice = bars[0].close;

      // MA20 계산
      const ma20 = bars.slice(0, 20).reduce((sum, b) => sum + b.close, 0) / 20;
      alert.ma20 = roundPrice(ma20, m);

      // 종가/최고가 업데이트
      if (closePrice > alert.highSinceEntry) {
        alert.highSinceEntry = closePrice;
      }
      alert.lastCheckedPrice = closePrice;
      alert.lastCheckedAt = new Date().toISOString();

      // 관심종목은 가격 추적만 (눌림 알림 추후 추가)
      if (alert.type === 'watchlist') {
        localStore.setState(COLLECTION, id, alert);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      // === 보유종목 트리거 체크 (종가 기준) ===

      const buyAmount = Math.round(alert.initialBuyAmount * 0.5);
      const buyQty = closePrice > 0 ? Math.floor(buyAmount / closePrice) : 0;
      const sellHalfQty = Math.floor(alert.holdingQty / 2);
      const sellHalfAmt = sellHalfQty * closePrice;
      const sellAllQty = alert.holdingQty;
      const sellAllAmt = sellAllQty * closePrice;

      // 1. 손절: -8% from initialBuyPrice
      const stopLossPrice = alert.initialBuyPrice * 0.92;
      if (closePrice <= stopLossPrice && !alert.alertsSent.stop_loss) {
        const lossAmt = alert.holdingQty > 0 ? roundPrice((alert.avgPrice - closePrice) * alert.holdingQty, m) : 0;
        await sendAlert(alert, 'stop_loss',
          `🚨 <b>손절 도달! (종가 기준)</b>\n` +
          `종가: ${fmtPrice(closePrice, m)}\n` +
          `손절가(-8%): ${fmtPrice(roundPrice(stopLossPrice, m), m)}\n\n` +
          `👉 <b>전량 매도: ${fmtKRW(sellAllQty)}주</b>\n` +
          `예상 매도금액: ${fmtPrice(roundPrice(sellAllAmt, m), m)}\n` +
          `예상 손실: -${fmtPrice(lossAmt, m)}`
        );
      }

      // 2. 매수 알림 (buy1_done → -3% buy2, -6% 급락)
      if (alert.buyPhase === 'buy1_done') {
        const dropFromBuy = (alert.initialBuyPrice - closePrice) / alert.initialBuyPrice;

        if (dropFromBuy >= 0.06 && !alert.alertsSent.buy2) {
          await sendAlert(alert, 'buy2',
            `⚡ <b>급락 감지! 2차 매수 타이밍 (종가 기준)</b>\n` +
            `종가: ${fmtPrice(closePrice, m)} (${pct(-dropFromBuy)})\n` +
            `1차 매수가: ${fmtPrice(alert.initialBuyPrice, m)}\n\n` +
            `👉 <b>매수: ${fmtKRW(buyQty)}주 × ${fmtPrice(closePrice, m)}</b>\n` +
            `매수금액: ${fmtPrice(buyAmount, m)}\n` +
            `⚠️ 급락이라 2차만 (3차는 추가 하락 시)`
          );
          alert.rapidDropDetected = true;
        } else if (dropFromBuy >= 0.03 && !alert.alertsSent.buy2) {
          await sendAlert(alert, 'buy2',
            `📉 <b>2차 매수 타이밍 (종가 기준)</b>\n` +
            `종가: ${fmtPrice(closePrice, m)} (${pct(-dropFromBuy)})\n` +
            `1차 매수가: ${fmtPrice(alert.initialBuyPrice, m)}\n\n` +
            `👉 <b>매수: ${fmtKRW(buyQty)}주 × ${fmtPrice(closePrice, m)}</b>\n` +
            `매수금액: ${fmtPrice(buyAmount, m)}`
          );
        }
      }

      // 3. 매수 알림 (buy2_done → -6% buy3)
      if (alert.buyPhase === 'buy2_done') {
        const dropFromBuy = (alert.initialBuyPrice - closePrice) / alert.initialBuyPrice;
        if (dropFromBuy >= 0.06 && !alert.alertsSent.buy3) {
          await sendAlert(alert, 'buy3',
            `📉 <b>3차 매수 타이밍 (종가 기준)</b>\n` +
            `종가: ${fmtPrice(closePrice, m)} (${pct(-dropFromBuy)})\n` +
            `1차 매수가: ${fmtPrice(alert.initialBuyPrice, m)}\n\n` +
            `👉 <b>매수: ${fmtKRW(buyQty)}주 × ${fmtPrice(closePrice, m)}</b>\n` +
            `매수금액: ${fmtPrice(buyAmount, m)}`
          );
        }
      }

      // 4. 익절 알림 (avgPrice 기준)
      if (alert.avgPrice > 0) {
        const gainFromAvg = (closePrice - alert.avgPrice) / alert.avgPrice;
        const profitPerShare = closePrice - alert.avgPrice;

        if (alert.sellPhase === 'none' && gainFromAvg >= 0.10 && !alert.alertsSent.profit1) {
          const profitAmt = roundPrice(profitPerShare * sellHalfQty, m);
          await sendAlert(alert, 'profit1',
            `📈 <b>1차 익절 타이밍 (+10%, 종가 기준)</b>\n` +
            `종가: ${fmtPrice(closePrice, m)} (+${pct(gainFromAvg)})\n` +
            `평균단가: ${fmtPrice(alert.avgPrice, m)}\n\n` +
            `👉 <b>50% 매도: ${fmtKRW(sellHalfQty)}주 × ${fmtPrice(closePrice, m)}</b>\n` +
            `예상 매도금액: ${fmtPrice(roundPrice(sellHalfAmt, m), m)}\n` +
            `예상 수익: +${fmtPrice(profitAmt, m)}`
          );
        }

        if (alert.sellPhase === 'profit1_done' && gainFromAvg >= 0.20 && !alert.alertsSent.profit2) {
          const profitAmt = roundPrice(profitPerShare * sellHalfQty, m);
          await sendAlert(alert, 'profit2',
            `📈 <b>2차 익절 타이밍 (+20%, 종가 기준)</b>\n` +
            `종가: ${fmtPrice(closePrice, m)} (+${pct(gainFromAvg)})\n` +
            `평균단가: ${fmtPrice(alert.avgPrice, m)}\n\n` +
            `👉 <b>50% 매도: ${fmtKRW(sellHalfQty)}주 × ${fmtPrice(closePrice, m)}</b>\n` +
            `예상 매도금액: ${fmtPrice(roundPrice(sellHalfAmt, m), m)}\n` +
            `예상 수익: +${fmtPrice(profitAmt, m)}`
          );
        }
      }

      // 5. 트레일링 — 고점 -10%
      if (alert.sellPhase === 'profit2_done' || alert.sellPhase === 'trailing') {
        const trailingStop = alert.highSinceEntry * 0.90;
        if (closePrice <= trailingStop && !alert.alertsSent.trailing_high) {
          const profitAmt = alert.avgPrice > 0 ? roundPrice((closePrice - alert.avgPrice) * sellAllQty, m) : 0;
          const profitLabel = profitAmt >= 0 ? `+${fmtPrice(profitAmt, m)}` : fmtPrice(profitAmt, m);
          await sendAlert(alert, 'trailing_high',
            `📉 <b>트레일링 스탑 도달 (고점 -10%, 종가 기준)</b>\n` +
            `종가: ${fmtPrice(closePrice, m)}\n` +
            `진입 후 최고가: ${fmtPrice(alert.highSinceEntry, m)}\n\n` +
            `👉 <b>전량 매도: ${fmtKRW(sellAllQty)}주 × ${fmtPrice(closePrice, m)}</b>\n` +
            `예상 매도금액: ${fmtPrice(roundPrice(sellAllAmt, m), m)}\n` +
            `예상 수익: ${profitLabel}`
          );
        }
      }

      // 6. 트레일링 — MA20 이탈
      if (alert.sellPhase === 'profit2_done' || alert.sellPhase === 'trailing') {
        if (closePrice <= alert.ma20! && !alert.alertsSent.trailing_ma20) {
          await sendAlert(alert, 'trailing_ma20',
            `📉 <b>20일선 이탈! (종가 기준)</b>\n` +
            `종가: ${fmtPrice(closePrice, m)}\n` +
            `20일선: ${fmtPrice(alert.ma20!, m)}\n` +
            `트레일링 매도 검토`
          );
        }
      }

      // 상태 저장
      localStore.setState(COLLECTION, id, alert);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`${PREFIX} ${alert.ticker} 처리 오류:`, err);
    }
  }
}
