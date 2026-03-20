/**
 * 종목 알리미 엔진 — 매분 실행, 가격 모니터링 + 알림 발송
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

  // 알림 중복 방지 — timestamp 기록
  alert.alertsSent[alertType] = new Date().toISOString();
}

export async function checkStockAlerts(): Promise<void> {
  const allAlerts = localStore.getAllStates<StockAlert>(COLLECTION);
  if (allAlerts.size === 0) return;

  // KIS 인증용 첫 번째 계정 사용
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

    try {
      // 1. 현재가 조회 (시장별 분기)
      let currentPrice: number;
      const m = alert.market || 'KR';
      if (m === 'US') {
        const quoteRes = await kisClient.getCurrentPrice(
          ctx.credentials.appKey, ctx.credentials.appSecret, accessToken, alert.ticker
        );
        currentPrice = Number(quoteRes.output?.last);
      } else {
        const quoteRes = await kisClient.getDomesticCurrentPrice(
          ctx.credentials.appKey, ctx.credentials.appSecret, accessToken, alert.ticker
        );
        currentPrice = Number(quoteRes.output?.stck_prpr);
      }
      if (!currentPrice || isNaN(currentPrice)) {
        console.log(`${PREFIX} ${alert.ticker} 현재가 조회 실패`);
        continue;
      }

      // 2. highSinceEntry 업데이트
      if (currentPrice > alert.highSinceEntry) {
        alert.highSinceEntry = currentPrice;
      }

      alert.lastCheckedPrice = currentPrice;
      alert.lastCheckedAt = new Date().toISOString();

      // 매수/매도 수량 계산 헬퍼
      const buyAmount = Math.round(alert.initialBuyAmount * 0.5); // 2차, 3차 각 25% (= 1차의 50%)
      const buyQty = currentPrice > 0 ? Math.floor(buyAmount / currentPrice) : 0;
      const sellHalfQty = Math.floor(alert.holdingQty / 2); // 익절 시 50%
      const sellHalfAmt = sellHalfQty * currentPrice;
      const sellAllQty = alert.holdingQty; // 전량
      const sellAllAmt = sellAllQty * currentPrice;

      // 3. 손절 체크: -8% from initialBuyPrice
      const stopLossPrice = alert.initialBuyPrice * 0.92;
      if (currentPrice <= stopLossPrice && !alert.alertsSent.stop_loss) {
        const lossAmt = alert.holdingQty > 0 ? roundPrice((alert.avgPrice - currentPrice) * alert.holdingQty, m) : 0;
        await sendAlert(alert, 'stop_loss',
          `🚨 <b>손절 도달!</b>\n` +
          `현재가: ${fmtPrice(currentPrice, m)}\n` +
          `손절가(-8%): ${fmtPrice(roundPrice(stopLossPrice, m), m)}\n\n` +
          `👉 <b>전량 매도: ${fmtKRW(sellAllQty)}주</b>\n` +
          `예상 매도금액: ${fmtPrice(roundPrice(sellAllAmt, m), m)}\n` +
          `예상 손실: -${fmtPrice(lossAmt, m)}`
        );
      }

      // 4. 매수 알림 (buyPhase === 'buy1_done')
      if (alert.buyPhase === 'buy1_done') {
        const dropFromBuy = (alert.initialBuyPrice - currentPrice) / alert.initialBuyPrice;

        // 급락 감지: -6% 도달 + buy2 미발송
        if (dropFromBuy >= 0.06 && !alert.alertsSent.buy2) {
          await sendAlert(alert, 'buy2',
            `⚡ <b>급락 감지! 2차 매수 타이밍</b>\n` +
            `현재가: ${fmtPrice(currentPrice, m)} (${pct(-dropFromBuy)})\n` +
            `1차 매수가: ${fmtPrice(alert.initialBuyPrice, m)}\n\n` +
            `👉 <b>매수: ${fmtKRW(buyQty)}주 × ${fmtPrice(currentPrice, m)}</b>\n` +
            `매수금액: ${fmtPrice(buyAmount, m)}\n` +
            `⚠️ 급락이라 2차만 (3차는 추가 하락 시)`
          );
          alert.rapidDropDetected = true;
        }
        // 일반: -3% 도달 → buy2 발송
        else if (dropFromBuy >= 0.03 && !alert.alertsSent.buy2) {
          await sendAlert(alert, 'buy2',
            `📉 <b>2차 매수 타이밍</b>\n` +
            `현재가: ${fmtPrice(currentPrice, m)} (${pct(-dropFromBuy)})\n` +
            `1차 매수가: ${fmtPrice(alert.initialBuyPrice, m)}\n\n` +
            `👉 <b>매수: ${fmtKRW(buyQty)}주 × ${fmtPrice(currentPrice, m)}</b>\n` +
            `매수금액: ${fmtPrice(buyAmount, m)}`
          );
        }
      }

      // 5. 매수 알림 (buyPhase === 'buy2_done')
      if (alert.buyPhase === 'buy2_done') {
        const dropFromBuy = (alert.initialBuyPrice - currentPrice) / alert.initialBuyPrice;
        if (dropFromBuy >= 0.06 && !alert.alertsSent.buy3) {
          await sendAlert(alert, 'buy3',
            `📉 <b>3차 매수 타이밍</b>\n` +
            `현재가: ${fmtPrice(currentPrice, m)} (${pct(-dropFromBuy)})\n` +
            `1차 매수가: ${fmtPrice(alert.initialBuyPrice, m)}\n\n` +
            `👉 <b>매수: ${fmtKRW(buyQty)}주 × ${fmtPrice(currentPrice, m)}</b>\n` +
            `매수금액: ${fmtPrice(buyAmount, m)}`
          );
        }
      }

      // 6. 익절 알림 (avgPrice 기준)
      if (alert.avgPrice > 0) {
        const gainFromAvg = (currentPrice - alert.avgPrice) / alert.avgPrice;
        const profitPerShare = currentPrice - alert.avgPrice;

        if (alert.sellPhase === 'none' && gainFromAvg >= 0.10 && !alert.alertsSent.profit1) {
          const profitAmt = roundPrice(profitPerShare * sellHalfQty, m);
          await sendAlert(alert, 'profit1',
            `📈 <b>1차 익절 타이밍 (+10%)</b>\n` +
            `현재가: ${fmtPrice(currentPrice, m)} (+${pct(gainFromAvg)})\n` +
            `평균단가: ${fmtPrice(alert.avgPrice, m)}\n\n` +
            `👉 <b>50% 매도: ${fmtKRW(sellHalfQty)}주 × ${fmtPrice(currentPrice, m)}</b>\n` +
            `예상 매도금액: ${fmtPrice(roundPrice(sellHalfAmt, m), m)}\n` +
            `예상 수익: +${fmtPrice(profitAmt, m)}`
          );
        }

        if (alert.sellPhase === 'profit1_done' && gainFromAvg >= 0.20 && !alert.alertsSent.profit2) {
          const profitAmt = roundPrice(profitPerShare * sellHalfQty, m);
          await sendAlert(alert, 'profit2',
            `📈 <b>2차 익절 타이밍 (+20%)</b>\n` +
            `현재가: ${fmtPrice(currentPrice, m)} (+${pct(gainFromAvg)})\n` +
            `평균단가: ${fmtPrice(alert.avgPrice, m)}\n\n` +
            `👉 <b>50% 매도: ${fmtKRW(sellHalfQty)}주 × ${fmtPrice(currentPrice, m)}</b>\n` +
            `예상 매도금액: ${fmtPrice(roundPrice(sellHalfAmt, m), m)}\n` +
            `예상 수익: +${fmtPrice(profitAmt, m)}`
          );
        }
      }

      // 7. 트레일링 (sellPhase === 'profit2_done' or 'trailing')
      if (alert.sellPhase === 'profit2_done' || alert.sellPhase === 'trailing') {
        const trailingStop = alert.highSinceEntry * 0.90;
        if (currentPrice <= trailingStop && !alert.alertsSent.trailing_high) {
          const profitAmt = alert.avgPrice > 0 ? roundPrice((currentPrice - alert.avgPrice) * sellAllQty, m) : 0;
          const profitLabel = profitAmt >= 0 ? `+${fmtPrice(profitAmt, m)}` : fmtPrice(profitAmt, m);
          await sendAlert(alert, 'trailing_high',
            `📉 <b>트레일링 스탑 도달 (고점 -10%)</b>\n` +
            `현재가: ${fmtPrice(currentPrice, m)}\n` +
            `진입 후 최고가: ${fmtPrice(alert.highSinceEntry, m)}\n\n` +
            `👉 <b>전량 매도: ${fmtKRW(sellAllQty)}주 × ${fmtPrice(currentPrice, m)}</b>\n` +
            `예상 매도금액: ${fmtPrice(roundPrice(sellAllAmt, m), m)}\n` +
            `예상 수익: ${profitLabel}`
          );
        }
      }

      // 8. 상태 저장
      localStore.setState(COLLECTION, id, alert);

      // API 호출 간격
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`${PREFIX} ${alert.ticker} 처리 오류:`, err);
    }
  }
}
