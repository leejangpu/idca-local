/**
 * 종목 알리미 — 20일 이동평균선 체크 (매일 16:00 KST)
 */

import { StockAlert, COLLECTION } from './stockAlertTypes';
import * as localStore from '../../lib/localStore';
import { getOrRefreshToken } from '../../lib/kisApi';
import { KisApiClient } from '../../lib/kisApi';
import { sendTelegramMessage } from '../../lib/telegram';
import { config } from '../../config';
import { getEnabledAccounts } from '../../lib/accountContext';

const PREFIX = '[StockAlert:MA20]';
const kisClient = new KisApiClient();

function fmtPrice(n: number, market?: string): string {
  if (market === 'US') {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${n.toLocaleString('ko-KR')}원`;
}

export async function checkStockAlerts20MA(): Promise<void> {
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
    // 트레일링 단계만 대상
    if (alert.sellPhase !== 'profit2_done' && alert.sellPhase !== 'trailing') continue;

    try {
      const m = alert.market || 'KR';
      const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

      let ma20: number;
      let currentPrice: number;

      if (m === 'US') {
        // 해외주식 일봉 조회
        const barRes = await kisClient.getOverseasDailyBars(
          ctx.credentials.appKey, ctx.credentials.appSecret, accessToken,
          alert.ticker, endDate
        );
        const bars = barRes.output2;
        if (!bars || bars.length < 20) {
          console.log(`${PREFIX} ${alert.ticker} 일봉 부족 (${bars?.length ?? 0})`);
          continue;
        }
        const recent20 = bars.slice(0, 20);
        ma20 = recent20.reduce((sum, b) => sum + Number(b.clos), 0) / 20;
        ma20 = Math.round(ma20 * 100) / 100;
        currentPrice = Number(bars[0].clos);
      } else {
        // 국내주식 일봉 조회
        const startD = new Date();
        startD.setDate(startD.getDate() - 45);
        const startDate = startD.toISOString().slice(0, 10).replace(/-/g, '');

        const barRes = await kisClient.getDomesticDailyBars(
          ctx.credentials.appKey, ctx.credentials.appSecret, accessToken,
          alert.ticker, startDate, endDate
        );
        const bars = barRes.output2;
        if (!bars || bars.length < 20) {
          console.log(`${PREFIX} ${alert.ticker} 일봉 부족 (${bars?.length ?? 0})`);
          continue;
        }
        const recent20 = bars.slice(0, 20);
        ma20 = recent20.reduce((sum, b) => sum + Number(b.stck_clpr), 0) / 20;
        ma20 = Math.round(ma20);
        currentPrice = Number(bars[0].stck_clpr);
      }

      alert.ma20 = ma20;

      if (currentPrice <= ma20 && !alert.alertsSent.trailing_ma20) {
        const marketLabel = m === 'US' ? '🇺🇸' : '🇰🇷';
        const chatId = config.telegram.adminChatId;
        await sendTelegramMessage(chatId,
          `🔔 <b>종목 알리미</b> ${marketLabel}\n` +
          `<b>${alert.stockName}</b> (${alert.ticker})\n\n` +
          `📉 <b>20일선 이탈!</b>\n` +
          `종가: ${fmtPrice(currentPrice, m)}\n` +
          `20일선: ${fmtPrice(ma20, m)}\n` +
          `트레일링 매도 검토`,
          'HTML'
        );
        alert.alertsSent.trailing_ma20 = new Date().toISOString();
        console.log(`${PREFIX} ${alert.ticker} MA20 이탈 알림 발송`);
      }

      localStore.setState(COLLECTION, id, alert);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`${PREFIX} ${alert.ticker} 처리 오류:`, err);
    }
  }
}
