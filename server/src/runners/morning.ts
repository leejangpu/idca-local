/**
 * 모닝 잔고 스냅샷 러너
 * 매일 KST 08:00 — KIS API로 잔고 조회 후 로컬 히스토리 기록
 *
 * 원본: idca-functions/src/functions/morning.ts
 * 변경: Firebase onSchedule → 단순 async 함수, Firestore → localStore
 */

import { config } from '../config';
import { KisApiClient, getOrRefreshToken } from '../lib/kisApi';
import * as localStore from '../lib/localStore';
import { AccountContext } from '../lib/accountContext';

export async function runMorningSnapshot(ctx?: AccountContext): Promise<void> {
  console.log('[MorningTrigger] Started');

  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstDate = new Date(now.getTime() + kstOffset);
  const dateStr = kstDate.toISOString().slice(0, 10);
  const docId = dateStr.replace(/-/g, '');

  const { accountId } = config;

  try {
    const kisClient = ctx?.kisClient ?? new KisApiClient(config.kis.paperTrading);
    const credentials = ctx
      ? { appKey: ctx.credentials.appKey, appSecret: ctx.credentials.appSecret }
      : { appKey: config.kis.appKey, appSecret: config.kis.appSecret };
    const accessToken = await getOrRefreshToken('', ctx?.accountId ?? accountId, credentials, kisClient);
    const accountNo = ctx?.credentials.accountNo ?? config.kis.accountNo;

    // 재시도 헬퍼
    const withRetry = async <T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T | null> => {
      for (let i = 1; i <= retries; i++) {
        try {
          return await fn();
        } catch (err) {
          console.warn(`[MorningTrigger] ${label} attempt ${i}/${retries} failed:`, err);
          if (i < retries) await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      return null;
    };

    // 1) 국내 잔고 조회
    let krwDeposit = 0;
    let krwStockValue = 0;
    const domesticBalance = await withRetry(
      () => kisClient.getDomesticBalance(credentials.appKey, credentials.appSecret, accessToken, accountNo),
      'getDomesticBalance'
    );
    if (domesticBalance) {
      const output2 = Array.isArray(domesticBalance.output2) ? domesticBalance.output2[0] : null;
      krwStockValue = parseFloat(output2?.evlu_amt_smtl_amt || '0');
      krwDeposit = parseFloat(output2?.dnca_tot_amt || '0');
    }

    await new Promise(resolve => setTimeout(resolve, 300));

    // 1-2) 투자계좌자산현황 조회 → KRW 예수금
    const accountAsset = await withRetry(
      () => kisClient.getAccountAssetStatus(credentials.appKey, credentials.appSecret, accessToken, accountNo),
      'getAccountAssetStatus'
    );
    if (accountAsset?.rt_cd === '0' && accountAsset.output2?.dncl_amt) {
      krwDeposit = parseFloat(accountAsset.output2.dncl_amt);
    }

    await new Promise(resolve => setTimeout(resolve, 300));

    // 2) 해외 잔고 조회
    let usdStockValue = 0;
    const overseasBalance = await withRetry(
      () => kisClient.getBalance(credentials.appKey, credentials.appSecret, accessToken, accountNo),
      'getBalance'
    );
    if (overseasBalance) {
      const holdings = Array.isArray(overseasBalance.output1) ? overseasBalance.output1 : [];
      usdStockValue = holdings.reduce(
        (sum, h) => sum + parseFloat(h.ovrs_stck_evlu_amt || '0'), 0
      );
    }

    await new Promise(resolve => setTimeout(resolve, 300));

    // 3) 매수가능금액 조회 → USD 예수금 + 환율
    let usdDeposit = 0;
    let exchangeRate = 0;
    const buyable = await withRetry(
      () => kisClient.getBuyableAmount(credentials.appKey, credentials.appSecret, accessToken, accountNo, 'AAPL', 1, 'NASD'),
      'getBuyableAmount'
    );
    if (buyable?.rt_cd === '0' && buyable.output) {
      usdDeposit = parseFloat(buyable.output.ovrs_ord_psbl_amt || '0');
      exchangeRate = parseFloat(buyable.output.exrt || '0');
    }

    // 총자산 원화환산
    const totalKRW = krwDeposit + krwStockValue +
      (usdDeposit + usdStockValue) * exchangeRate;

    // 4) 전일 실현손익 조회
    const yesterday = new Date(kstDate);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');

    let realizedPnlKrw = 0;
    let realizedPnlUsd = 0;

    // 국내 기간별손익
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const domesticPnl = await withRetry(
        () => kisClient.getDomesticDailyPnl(credentials.appKey, credentials.appSecret, accessToken, accountNo, yesterdayStr, yesterdayStr),
        'getDomesticDailyPnl'
      );
      if (domesticPnl?.rt_cd === '0' && domesticPnl.output2) {
        realizedPnlKrw = parseFloat(domesticPnl.output2.tot_rlzt_pfls || '0');
      }
    } catch (pnlErr) {
      console.warn('[MorningTrigger] Domestic PnL query failed:', pnlErr);
    }

    // 해외 기간손익 (거래소별)
    for (const exchange of ['NASD', 'AMEX', 'NYSE']) {
      try {
        await new Promise(resolve => setTimeout(resolve, 300));
        const ovsPnl = await withRetry(
          () => kisClient.getOverseasPeriodPnl(credentials.appKey, credentials.appSecret, accessToken, accountNo, exchange, yesterdayStr, yesterdayStr),
          `getOverseasPeriodPnl:${exchange}`
        );
        if (ovsPnl?.rt_cd === '0' && ovsPnl.output1) {
          for (const item of ovsPnl.output1) {
            realizedPnlUsd += parseFloat(item.ovrs_rlzt_pfls_amt || '0');
          }
        }
      } catch (pnlErr) {
        console.warn(`[MorningTrigger] Overseas PnL (${exchange}) failed:`, pnlErr);
      }
    }

    realizedPnlKrw = Math.round(realizedPnlKrw);
    realizedPnlUsd = Math.round(realizedPnlUsd * 100) / 100;

    // 로컬 스토어에 기록
    localStore.setBalanceHistory(docId, {
      date: dateStr,
      krwDeposit,
      krwStockValue,
      usdDeposit,
      usdStockValue,
      exchangeRate,
      totalKRW,
      realizedPnlKrw,
      realizedPnlUsd,
    });

    console.log(`[MorningTrigger] totalKRW=${Math.round(totalKRW).toLocaleString()}, ` +
      `krwDeposit=${krwDeposit}, krwStock=${krwStockValue}, ` +
      `usdDeposit=${usdDeposit.toFixed(2)}, usdStock=${usdStockValue.toFixed(2)}, exRate=${exchangeRate}, ` +
      `pnlKrw=${realizedPnlKrw}, pnlUsd=${realizedPnlUsd}`);
  } catch (err) {
    console.error('[MorningTrigger] Error:', err);
  }

  console.log('[MorningTrigger] Completed');
}
