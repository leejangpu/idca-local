/**
 * 한국투자증권 Open API 클라이언트
 * 로컬 서버용 (Firebase 의존성 제거)
 */

const REAL_BASE_URL = 'https://openapi.koreainvestment.com:9443';

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  access_token_token_expired: string;
}

// KIS API 해외주식 잔고조회 응답
// 실제 응답에서는 output1이 보유 종목 배열, output2는 요약 정보
interface BalanceResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: Array<{
    ovrs_pdno: string;            // 종목코드
    ovrs_item_name: string;       // 종목명
    frcr_evlu_pfls_amt: string;   // 외화 평가 손익 금액
    evlu_pfls_rt: string;         // 평가 손익률
    pchs_avg_pric: string;        // 매입 평균 가격
    ovrs_cblc_qty: string;        // 보유 수량
    ovrs_stck_evlu_amt: string;   // 평가 금액
    now_pric2: string;            // 현재가
    frcr_pchs_amt1: string;       // 외화 매입 금액
    ovrs_excg_cd: string;         // 해외거래소코드
  }>;
  output2?: Array<{
    ovrs_tot_pfls: string;        // 해외 총 손익
    frcr_pchs_amt1: string;       // 외화 매입 금액
    tot_evlu_pfls_amt: string;    // 총 평가 손익 금액
    tot_asst_amt: string;         // 총 자산 금액
  }>;
}

interface QuoteResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    rsym: string;                 // 종목코드
    zdiv: string;                 // 소수점 자리수
    base: string;                 // 기준가
    pvol: string;                 // 전일 거래량
    last: string;                 // 현재가
    sign: string;                 // 등락 부호
    diff: string;                 // 전일 대비
    rate: string;                 // 등락률
    tvol: string;                 // 거래량
    tamt: string;                 // 거래대금
    ordy: string;                 // 매수 가능 여부
  };
}

interface OrderResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    KRX_FWDG_ORD_ORGNO: string;   // 주문 기관 번호
    ODNO: string;                  // 주문 번호
    ORD_TMD: string;               // 주문 시간
  };
}

interface BuyableAmountResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    tr_crcy_cd: string;            // 거래통화코드
    ord_psbl_frcr_amt: string;     // 주문가능외화금액
    ovrs_ord_psbl_amt: string;     // 해외주문가능금액
    max_ord_psbl_qty: string;      // 최대주문가능수량
    ovrs_max_ord_psbl_qty: string; // 해외최대주문가능수량
    frcr_ord_psbl_amt1: string;    // 외화주문가능금액1 (통합)
    exrt: string;                   // 환율
  };
}

// 투자계좌자산현황조회 응답
export interface AccountAssetStatusResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: Array<{
    prdt_name: string;           // 상품명
    evlu_amt: string;            // 평가금액
  }>;
  output2?: {
    dncl_amt: string;            // 예수금액 (원화 예수금)
    tot_evlu_amt: string;        // 총평가금액
    frcr_evlu_tota: string;      // 외화평가총액
    evlu_amt_smtl: string;       // 평가금액합계
    pchs_amt_smtl: string;       // 매입금액합계
    evlu_pfls_smtl: string;      // 평가손익합계
  };
}

// 주문체결내역 응답
export interface OrderHistoryResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  ctx_area_fk200: string;
  ctx_area_nk200: string;
  output?: Array<{
    ord_dt: string;                // 주문일자 (현지시각 YYYYMMDD)
    ord_gno_brno: string;          // 주문채번지점번호
    odno: string;                  // 주문번호
    orgn_odno: string;             // 원주문번호 (정정/취소 대상)
    sll_buy_dvsn_cd: string;       // 매도매수구분코드 (01:매도, 02:매수)
    sll_buy_dvsn_cd_name: string;  // 매도매수구분코드명
    rvse_cncl_dvsn: string;        // 정정취소구분 (01:정정, 02:취소)
    rvse_cncl_dvsn_name: string;   // 정정취소구분명
    pdno: string;                  // 상품번호 (종목코드)
    prdt_name: string;             // 상품명
    ft_ord_qty: string;            // 주문수량
    ft_ord_unpr3: string;          // 주문가격
    ft_ccld_qty: string;           // 체결수량
    ft_ccld_unpr3: string;         // 체결가격
    ft_ccld_amt3: string;          // 체결금액
    nccs_qty: string;              // 미체결수량
    prcs_stat_name: string;        // 처리상태명 (완료, 거부, 전송)
    rjct_rson: string;             // 거부사유
    rjct_rson_name: string;        // 거부사유명
    ord_tmd: string;               // 주문시각 (HHMMSS)
    tr_mket_name: string;          // 거래시장명
    tr_natn: string;               // 거래국가
    tr_natn_name: string;          // 거래국가명
    ovrs_excg_cd: string;          // 해외거래소코드
    tr_crcy_cd: string;            // 거래통화코드
    dmst_ord_dt: string;           // 국내주문일자
    thco_ord_tmd: string;          // 당사주문시각
    loan_type_cd: string;          // 대출유형코드
    loan_dt: string;               // 대출일자
    mdia_dvsn_name: string;        // 매체구분명
    usa_amk_exts_rqst_yn: string;  // 미국애프터마켓연장신청여부
  }>;
}

// 미체결내역 응답
export interface PendingOrdersResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  ctx_area_fk200: string;
  ctx_area_nk200: string;
  output?: Array<{
    ord_dt: string;                // 주문일자
    ord_gno_brno: string;          // 주문채번지점번호
    odno: string;                  // 주문번호
    orgn_odno: string;             // 원주문번호
    pdno: string;                  // 상품번호 (종목코드)
    prdt_name: string;             // 상품명
    sll_buy_dvsn_cd: string;       // 매도매수구분코드
    sll_buy_dvsn_cd_name: string;  // 매도매수구분코드명
    rvse_cncl_dvsn_cd: string;     // 정정취소구분코드
    rvse_cncl_dvsn_cd_name: string; // 정정취소구분코드명
    rjct_rson: string;             // 거부사유
    rjct_rson_name: string;        // 거부사유명
    ord_tmd: string;               // 주문시각
    tr_mket_name: string;          // 거래시장명
    tr_crcy_cd: string;            // 거래통화코드
    natn_cd: string;               // 국가코드
    natn_kor_name: string;         // 국가한글명
    ft_ord_qty: string;            // 주문수량
    ft_ccld_qty: string;           // 체결수량
    nccs_qty: string;              // 미체결수량
    ft_ord_unpr3: string;          // 주문가격
    ft_ccld_unpr3: string;         // 체결가격
    ft_ccld_amt3: string;          // 체결금액
    ovrs_excg_cd: string;          // 해외거래소코드
    prcs_stat_name: string;        // 처리상태명
    loan_type_cd: string;          // 대출유형코드
    loan_dt: string;               // 대출일자
    usa_amk_exts_rqst_yn: string;  // 미국애프터마켓연장신청여부
  }>;
}

// 예약주문 접수 응답
export interface ReservationOrderResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    ODNO: string;                  // 예약주문번호
    ORD_TMD: string;               // 주문시간
    KRX_FWDG_ORD_ORGNO: string;   // 주문기관번호
  };
}

// 예약주문 목록 응답
export interface ReservationOrderListResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  ctx_area_fk200: string;
  ctx_area_nk200: string;
  output?: Array<{
    odno: string;                  // 예약주문번호
    ord_dt: string;                // 주문일자
    pdno: string;                  // 종목코드
    prdt_name: string;             // 종목명
    sll_buy_dvsn_cd: string;       // 매도매수구분 (01:매도, 02:매수)
    sll_buy_dvsn_cd_name: string;  // 매도매수구분명
    ft_ord_qty: string;            // 주문수량
    ft_ord_unpr3: string;          // 주문가격
    ft_ccld_qty: string;           // 체결수량
    nccs_qty: string;              // 미체결수량
    revs_rson_cd: string;          // 예약사유코드
    revs_rson_cd_name: string;     // 예약사유명
    prcs_stat_cd: string;          // 처리상태코드
    prcs_stat_name: string;        // 처리상태명
    ovrs_excg_cd: string;          // 해외거래소코드
    tr_crcy_cd: string;            // 거래통화코드
  }>;
}

// 예약주문 취소 응답
export interface ReservationCancelResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    ODNO: string;                  // 예약주문번호
    ORD_TMD: string;               // 주문시간
  };
}

// ==================== 국내주식 응답 타입 ====================

// 국내주식 종목정보 응답 (기간별시세 output1)
export interface DomesticStockInfoResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: {
    hts_kor_isnm: string;      // HTS 한글 종목명
    stck_prpr: string;         // 주식 현재가
    prdy_vrss: string;         // 전일 대비
    prdy_vrss_sign: string;    // 전일 대비 부호
    prdy_ctrt: string;         // 전일 대비율
    stck_shrn_iscd: string;    // 주식 단축 종목코드
    acml_vol: string;          // 누적 거래량
    stck_mxpr: string;         // 상한가
    stck_llam: string;         // 하한가
  };
}

// 국내주식 현재가 응답
export interface DomesticQuoteResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    stck_prpr: string;       // 현재가
    prdy_vrss: string;       // 전일대비
    prdy_vrss_sign: string;  // 전일대비부호
    prdy_ctrt: string;       // 전일대비율
    stck_oprc: string;       // 시가
    stck_hgpr: string;       // 최고가
    stck_lwpr: string;       // 최저가
    stck_mxpr: string;       // 상한가
    stck_llam: string;       // 하한가
    stck_sdpr: string;       // 기준가
    aspr_unit: string;       // 호가단위
    acml_vol: string;        // 누적거래량
    acml_tr_pbmn: string;    // 누적거래대금
  };
}

// 국내주식 호가 응답
export interface DomesticAskingPriceResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: {
    askp1: string;          // 매도호가1 (최우선)
    bidp1: string;          // 매수호가1 (최우선)
    askp_rsqn1: string;     // 매도잔량1
    bidp_rsqn1: string;     // 매수잔량1
    [key: string]: string;
  };
  output2?: {
    stck_prpr: string;      // 현재가
    stck_sdpr: string;      // 기준가 (상한가 계산용)
    [key: string]: string;
  };
}

// 국내주식 잔고 응답
export interface DomesticBalanceResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  ctx_area_fk100: string;
  ctx_area_nk100: string;
  output1?: Array<{
    pdno: string;             // 종목코드
    prdt_name: string;        // 종목명
    trad_dvsn_name: string;   // 매매구분명
    hldg_qty: string;         // 보유수량
    ord_psbl_qty: string;     // 주문가능수량
    pchs_avg_pric: string;    // 매입평균가
    pchs_amt: string;         // 매입금액
    prpr: string;             // 현재가
    evlu_amt: string;         // 평가금액
    evlu_pfls_amt: string;    // 평가손익
    evlu_pfls_rt: string;     // 평가손익율
    fltt_rt: string;          // 등락율
  }>;
  output2?: Array<{
    dnca_tot_amt: string;     // 예수금총금액
    nxdy_excc_amt: string;    // 익일정산금액
    prvs_rcdl_excc_amt: string; // 가수도정산금액 (D+2 예수금)
    tot_evlu_amt: string;     // 총평가금액
    pchs_amt_smtl_amt: string; // 매입금액합계
    evlu_amt_smtl_amt: string; // 평가금액합계
    evlu_pfls_smtl_amt: string; // 평가손익합계
  }>;
}

// 국내주식 매수가능 응답
export interface DomesticBuyableAmountResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    ord_psbl_cash: string;     // 주문가능현금
    nrcvb_buy_amt: string;     // 미수없는매수금액
    nrcvb_buy_qty: string;     // 미수없는매수수량
    max_buy_amt: string;       // 최대매수금액
    max_buy_qty: string;       // 최대매수수량
  };
}

// 국내주식 체결내역 응답
export interface DomesticOrderHistoryResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  ctx_area_fk100: string;
  ctx_area_nk100: string;
  output1?: Array<{
    ord_dt: string;            // 주문일자
    ord_gno_brno: string;      // 주문채번지점번호
    odno: string;              // 주문번호
    orgn_odno: string;         // 원주문번호
    ord_dvsn_name: string;     // 주문구분명
    sll_buy_dvsn_cd: string;   // 매도매수구분코드 (01:매도, 02:매수)
    sll_buy_dvsn_cd_name: string;
    pdno: string;              // 종목코드
    prdt_name: string;         // 종목명
    ord_qty: string;           // 주문수량
    ord_unpr: string;          // 주문단가
    ord_tmd: string;           // 주문시각
    tot_ccld_qty: string;      // 총체결수량
    avg_prvs: string;          // 평균가
    cncl_yn: string;           // 취소여부
    tot_ccld_amt: string;      // 총체결금액
    rmn_qty: string;           // 잔여수량
    rjct_qty: string;          // 거부수량
    ord_dvsn_cd: string;       // 주문구분코드
    excg_id_dvsn_cd: string;   // 거래소ID구분코드
  }>;
}

export class KisApiClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = REAL_BASE_URL;
  }

  /**
   * 재시도 헬퍼 (소켓 끊김/네트워크 오류 대비)
   * ECONNRESET, ETIMEDOUT, ENOTFOUND, UND_ERR_SOCKET 등 자동 재시도
   */
  private async withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 3, delayMs = 500): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          console.log(`[${label}] Retry ${attempt}/${maxRetries}`);
        }
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[${label}] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      }
    }
    throw lastError || new Error(`${label} failed after ${maxRetries} attempts`);
  }

  /**
   * 접근 토큰 발급
   */
  async getAccessToken(appKey: string, appSecret: string): Promise<TokenResponse> {
    const response = await fetch(`${this.baseUrl}/oauth2/tokenP`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: appKey,
        appsecret: appSecret,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Token request failed: ${response.status} - ${errorBody}`);
    }

    return response.json();
  }

  /**
   * 해외주식 잔고 조회
   */
  async getBalance(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string
  ): Promise<BalanceResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');

    // 여러 거래소를 병렬로 조회 (NASD, AMEX, NYSE)
    // SOXL은 AMEX, TQQQ는 NASD에서 거래됨
    const exchanges = ['NASD', 'AMEX', 'NYSE'];

    const fetchBalance = async (exchange: string): Promise<BalanceResponse> => {
      const response = await fetch(
        `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-balance?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchange,
            TR_CRCY_CD: 'USD',
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'TTTS3012R',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Balance request failed for ${exchange}: ${response.status} - ${errorBody}`);
      }

      return response.json();
    };

    // 모든 거래소 순차 조회 (KIS API 속도 제한 방지)
    const results: (BalanceResponse | null)[] = [];
    for (let i = 0; i < exchanges.length; i++) {
      const ex = exchanges[i];

      // 첫 번째 요청이 아니면 300ms 대기
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      try {
        const result = await this.withRetry(() => fetchBalance(ex), `Balance:${ex}`);
        // KIS API는 보유 종목을 output1에 반환 (output2는 요약 정보)
        const output1Array = Array.isArray(result.output1) ? result.output1 : [];
        console.log(`[Balance] Exchange ${ex} response:`, JSON.stringify({
          rt_cd: result.rt_cd,
          msg_cd: result.msg_cd,
          msg1: result.msg1,
          output1_length: output1Array.length,
          output1_tickers: output1Array.map(o => o.ovrs_pdno),
        }));
        results.push(result);
      } catch (err) {
        console.error(`[Balance] Failed to fetch balance for ${ex}:`, err);
        results.push(null);
      }
    }

    // 결과 병합 - KIS API는 보유 종목을 output1에 반환
    const mergedOutput1: NonNullable<BalanceResponse['output1']> = [];

    for (const result of results) {
      if (result?.output1 && Array.isArray(result.output1)) {
        mergedOutput1.push(...result.output1);
      }
    }

    // 첫 번째 유효한 결과를 기반으로 응답 구성
    const firstValidResult = results.find(r => r !== null) || {
      rt_cd: '0',
      msg_cd: '',
      msg1: 'No results',
    };

    // output2 (계좌 요약: 총자산, 총손익 등) — 첫 번째 유효한 결과에서 가져옴
    const mergedOutput2 = results.find(r => r?.output2 && Array.isArray(r.output2) && r.output2.length > 0)?.output2 || [];

    console.log(`[Balance] Merged result: output1_length=${mergedOutput1.length}, tickers=${mergedOutput1.map(o => o.ovrs_pdno).join(',')}, output2_length=${mergedOutput2.length}`);

    return {
      ...firstValidResult,
      output1: mergedOutput1,
      output2: mergedOutput2,
    };
  }

  /**
   * 해외주식 현재가 조회
   * @param exchange 거래소 코드 (NAS: 나스닥, AMS: 아멕스/NYSE Arca, NYS: 뉴욕)
   */
  async getCurrentPrice(
    appKey: string,
    appSecret: string,
    accessToken: string,
    ticker: string,
    exchange?: string
  ): Promise<QuoteResponse> {
    // 종목별 기본 거래소 설정 (현재가 조회용)
    const exchangeCode = exchange || KisApiClient.getExchangeCodeForQuote(ticker);

    // 재시도 로직 (네트워크 오류 대비)
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 재시도 시 500ms 대기
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[Quote] Retry ${attempt}/${maxRetries} for ${ticker}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/overseas-price/v1/quotations/price?` +
            new URLSearchParams({
              AUTH: '',
              EXCD: exchangeCode,
              SYMB: ticker,
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'HHDFS00000300',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Quote request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[Quote] Attempt ${attempt}/${maxRetries} failed for ${ticker}:`, lastError.message);
      }
    }

    throw lastError || new Error(`Quote request failed for ${ticker} after ${maxRetries} attempts`);
  }

  /**
   * 종목별 거래소 코드 반환 (static)
   * 주문 API에서도 사용할 수 있도록 static으로 제공
   */
  static getExchangeCode(ticker: string): string {
    // NYSE Arca/AMEX 상장 ETF (Direxion 레버리지 ETF 등)
    const amsETFs = ['SOXL', 'SOXS', 'SPXL', 'SPXS', 'LABU', 'LABD', 'TNA', 'TZA', 'NUGT', 'DUST'];
    if (amsETFs.includes(ticker.toUpperCase())) {
      return 'AMEX';  // 주문 API는 'AMEX' 사용 (현재가는 'AMS')
    }
    // NASDAQ 상장 ETF (ProShares 레버리지 ETF 등)
    // TQQQ, SQQQ, UVXY, QLD, QID 등은 NASDAQ 상장
    // 기본값: 나스닥
    return 'NASD';
  }

  /**
   * 종목별 거래소 코드 반환 (현재가 조회용)
   * 현재가 API는 AMS, 주문 API는 AMEX를 사용
   */
  static getExchangeCodeForQuote(ticker: string): string {
    const amsETFs = ['SOXL', 'SOXS', 'SPXL', 'SPXS', 'LABU', 'LABD', 'TNA', 'TZA', 'NUGT', 'DUST'];
    if (amsETFs.includes(ticker.toUpperCase())) {
      return 'AMS';  // 현재가 API는 'AMS' 사용
    }
    return 'NAS';
  }

  /**
   * 현재가/시세 API 거래소 코드(NAS/NYS/AMS) → 주문 API 거래소 코드(NASD/NYSE/AMEX) 변환
   */
  static quoteToOrderExchangeCode(quoteExcd: string): string {
    const map: Record<string, string> = { 'NAS': 'NASD', 'NYS': 'NYSE', 'AMS': 'AMEX' };
    return map[quoteExcd] || 'NASD';
  }

  /**
   * 해외주식 주문
   */
  async submitOrder(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    params: {
      ticker: string;
      side: 'BUY' | 'SELL';
      orderType: 'LOC' | 'LIMIT' | 'MOC' | 'MOO' | 'LOO';
      price: number;
      quantity: number;
      exchange?: string;  // 주문용 거래소 코드 (NASD/NYSE/AMEX), 없으면 ticker 기반 자동 판별
    }
  ): Promise<OrderResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    // TR_ID 결정
    let trId: string;
    if (params.side === 'BUY') {
      trId = 'TTTT1002U';
    } else {
      trId = 'TTTT1006U';
    }

    // 주문 유형 코드 (KIS API ORD_DVSN)
    const orderTypeMap: Record<string, string> = {
      'MOO': '31',   // 장개시시장가 (매도만)
      'LOO': '32',   // 장개시지정가
      'MOC': '33',   // 장마감시장가 (매도만)
      'LOC': '34',   // 장마감지정가
    };
    const orderTypeCode = orderTypeMap[params.orderType] || '00';

    // 종목별 거래소 코드 설정
    const exchangeCode = params.exchange || KisApiClient.getExchangeCode(params.ticker);

    // 재시도 로직 (네트워크 오류 대비)
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 재시도 시 500ms 대기
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[Order] Retry ${attempt}/${maxRetries} for ${params.ticker} ${params.side}`);
        }

        const response = await fetch(`${this.baseUrl}/uapi/overseas-stock/v1/trading/order`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
          },
          body: JSON.stringify({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchangeCode,
            PDNO: params.ticker,
            ORD_QTY: String(params.quantity),
            OVRS_ORD_UNPR: params.orderType === 'MOO' ? '0' : String(params.price.toFixed(2)),
            SLL_TYPE: params.side === 'SELL' ? '00' : '',
            ORD_SVR_DVSN_CD: '0',
            ORD_DVSN: orderTypeCode,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Order request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[Order] Attempt ${attempt}/${maxRetries} failed for ${params.ticker}:`, lastError.message);
      }
    }

    throw lastError || new Error(`Order request failed for ${params.ticker} after ${maxRetries} attempts`);
  }

  /**
   * 해외주식 매수가능금액 조회
   */
  async getBuyableAmount(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    ticker: string,
    price: number,
    exchange: string = 'NASD'
  ): Promise<BuyableAmountResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-psamount?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchange,
            OVRS_ORD_UNPR: String(price),
            ITEM_CD: ticker,
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'TTTS3007R',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Buyable amount request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `BuyableAmount:${ticker}`);
  }

  /**
   * 해외주식 주문체결내역 조회
   * @param startDate 시작일 (YYYYMMDD)
   * @param endDate 종료일 (YYYYMMDD)
   * @param ticker 종목코드 (% 입력 시 전종목)
   * @param sllBuyDvsn 매도매수구분 (00:전체, 01:매도, 02:매수)
   * @param ccldNccsDvsn 체결미체결구분 (00:전체, 01:체결, 02:미체결)
   */
  async getOrderHistory(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    startDate: string,
    endDate: string,
    ticker: string = '%',
    sllBuyDvsn: string = '00',
    ccldNccsDvsn: string = '00'
  ): Promise<OrderHistoryResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    console.log(`[getOrderHistory] 조회 요청: startDate=${startDate}, endDate=${endDate}, ticker=${ticker}`);

    // 재시도 로직 (네트워크 오류 대비)
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 재시도 시 500ms 대기
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[getOrderHistory] Retry ${attempt}/${maxRetries} for ${ticker}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-ccnl?` +
            new URLSearchParams({
              CANO: accountPrefix,
              ACNT_PRDT_CD: accountSuffix,
              PDNO: ticker,
              ORD_STRT_DT: startDate,
              ORD_END_DT: endDate,
              SLL_BUY_DVSN: sllBuyDvsn,
              CCLD_NCCS_DVSN: ccldNccsDvsn,
              OVRS_EXCG_CD: '%',
              SORT_SQN: 'AS',  // AS: 역순(최신순), DS: 정순(오래된순)
              ORD_DT: '',
              ORD_GNO_BRNO: '',
              ODNO: '',
              CTX_AREA_NK200: '',
              CTX_AREA_FK200: '',
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'TTTS3035R',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Order history request failed: ${response.status} - ${errorBody}`);
        }

        const result: OrderHistoryResponse = await response.json();

        // 응답 로깅
        const dates = result.output ? [...new Set(result.output.map(o => o.ord_dt))].sort() : [];
        console.log(`[getOrderHistory] 응답: ${result.output?.length || 0}건, 날짜: ${dates.join(', ')}, msg: ${result.msg1}`);

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[getOrderHistory] Attempt ${attempt}/${maxRetries} failed for ${ticker}:`, lastError.message);
      }
    }

    throw lastError || new Error(`Order history request failed for ${ticker} after ${maxRetries} attempts`);
  }

  /**
   * 해외주식 미체결내역 조회
   * 실전투자만 지원 (모의투자 미지원)
   * @param exchange 거래소코드 (NASD, NYSE, AMEX 등)
   */
  async getPendingOrders(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    exchange: string = 'NASD'
  ): Promise<PendingOrdersResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');



    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-nccs?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchange,
            SORT_SQN: '',
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'TTTS3018R',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Pending orders request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `PendingOrders:${exchange}`);
  }

  /**
   * 해외주식 정정취소주문
   * - TR_ID: TTTT1004U (실전), VTTT1004U (모의)
   * - URL: /uapi/overseas-stock/v1/trading/order-rvsecncl
   * @param orderNo 원주문번호 (ORGN_ODNO)
   * @param ticker 종목코드
   * @param cancelQty 취소수량 (0 = 전량 취소)
   */
  async cancelOrder(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    params: {
      orderNo: string;
      ticker: string;
      cancelQty?: number;  // 0 = 전량 취소 (기본)
      exchange?: string;   // 주문용 거래소 코드 (NASD/NYSE/AMEX), 없으면 ticker 기반 자동 판별
    }
  ): Promise<OrderResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    const trId = 'TTTT1004U';
    const exchangeCode = params.exchange || KisApiClient.getExchangeCode(params.ticker);

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[CancelOrder] Retry ${attempt}/${maxRetries} for ${params.ticker} ODNO=${params.orderNo}`);
        }

        const response = await fetch(`${this.baseUrl}/uapi/overseas-stock/v1/trading/order-rvsecncl`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
          },
          body: JSON.stringify({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchangeCode,
            PDNO: params.ticker,
            ORGN_ODNO: params.orderNo,
            RVSE_CNCL_DVSN_CD: '02',  // 02: 취소
            ORD_QTY: String(params.cancelQty ?? 0),  // 0 = 전량 취소
            OVRS_ORD_UNPR: '0',        // 취소 시 0
            ORD_SVR_DVSN_CD: '0',
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Cancel order request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[CancelOrder] Attempt ${attempt}/${maxRetries} failed for ${params.ticker}:`, lastError.message);
      }
    }

    throw lastError || new Error(`Cancel order request failed for ${params.ticker} after ${maxRetries} attempts`);
  }

  /**
   * 해외주식 예약주문 접수
   * - TR_ID: TTTT3014U (매수), TTTT3016U (매도)
   * - 예약주문은 당일만 유효하며, 미국장 마감 후 자동 취소됨
   * - 실전투자만 지원 (모의투자 미지원)
   */
  async submitReservationOrder(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    params: {
      ticker: string;
      side: 'BUY' | 'SELL';
      price: number;
      quantity: number;
      orderType?: string;  // 'MOO' | 'LIMIT' 등 (기본: 지정가)
    }
  ): Promise<ReservationOrderResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');

    // TR_ID 결정 (미국 예약주문)
    const trId = params.side === 'BUY' ? 'TTTT3014U' : 'TTTT3016U';

    // 종목별 거래소 코드 설정
    const exchangeCode = KisApiClient.getExchangeCode(params.ticker);

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[ResvOrder] Retry ${attempt}/${maxRetries} for ${params.ticker} ${params.side}`);
        }

        // MOO(장개시시장가): 매도 예약주문만 지원 (TTTT3016U)
        const isMOO = params.orderType === 'MOO' && params.side === 'SELL';

        const response = await fetch(`${this.baseUrl}/uapi/overseas-stock/v1/trading/order-resv`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
          },
          body: JSON.stringify({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchangeCode,
            PDNO: params.ticker,
            FT_ORD_QTY: String(params.quantity),
            FT_ORD_UNPR3: isMOO ? '0' : String(params.price.toFixed(2)),
            ORD_SVR_DVSN_CD: '0',
            ORD_DVSN: isMOO ? '31' : '00',
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Reservation order request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[ResvOrder] Attempt ${attempt}/${maxRetries} failed for ${params.ticker}:`, lastError.message);
      }
    }

    throw lastError || new Error(`Reservation order request failed for ${params.ticker} after ${maxRetries} attempts`);
  }

  /**
   * 해외주식 예약주문 목록 조회
   * - TR_ID: TTTT3039R (미국)
   * - 실전투자만 지원 (모의투자 미지원)
   */
  async getReservationOrders(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    exchange: string = 'NASD'
  ): Promise<ReservationOrderListResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');



    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/overseas-stock/v1/trading/order-resv-list?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchange,
            SORT_SQN: '',
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'TTTT3039R',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Reservation order list request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, 'ReservationOrders');
  }

  /**
   * 해외주식 예약주문 취소
   * - TR_ID: TTTT3017U
   * - 실전투자만 지원 (모의투자 미지원)
   */
  async cancelReservationOrder(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    params: {
      orderNo: string;
      ticker: string;
    }
  ): Promise<ReservationCancelResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');

    // 종목별 거래소 코드 설정
    const exchangeCode = KisApiClient.getExchangeCode(params.ticker);

    return this.withRetry(async () => {
      const response = await fetch(`${this.baseUrl}/uapi/overseas-stock/v1/trading/order-resv-ccnl`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          authorization: `Bearer ${accessToken}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'TTTT3017U',
        },
        body: JSON.stringify({
          CANO: accountPrefix,
          ACNT_PRDT_CD: accountSuffix,
          OVRS_EXCG_CD: exchangeCode,
          ODNO: params.orderNo,
          ORD_SVR_DVSN_CD: '0',
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Reservation order cancel request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `ResvCancel:${params.ticker}`);
  }

  // ==================== 계좌 자산 현황 API ====================

  /**
   * 투자계좌자산현황조회
   * TR_ID: CTRP6548R (실전) / VTRP6548R (모의)
   * 계좌의 원화 예수금(dncl_amt)을 정확하게 조회할 수 있는 API
   */
  async getAccountAssetStatus(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string
  ): Promise<AccountAssetStatusResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-account-balance?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            INQR_DVSN_1: '',
            BSPR_BF_DT_APLY_YN: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'CTRP6548R',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Account asset status request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, 'AccountAssetStatus');
  }

  // ==================== 국내주식 API ====================

  /**
   * 국내주식 현재가 조회
   * TR_ID: FHKST01010100 (실전/모의 동일)
   */
  async getDomesticCurrentPrice(
    appKey: string,
    appSecret: string,
    accessToken: string,
    ticker: string
  ): Promise<DomesticQuoteResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[DomesticQuote] Retry ${attempt}/${maxRetries} for ${ticker}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?` +
            new URLSearchParams({
              FID_COND_MRKT_DIV_CODE: 'J',
              FID_INPUT_ISCD: ticker,
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'FHKST01010100',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Domestic quote request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[DomesticQuote] Attempt ${attempt}/${maxRetries} failed for ${ticker}:`, lastError.message);
      }
    }

    throw lastError || new Error(`Domestic quote request failed for ${ticker} after ${maxRetries} attempts`);
  }

  /**
   * 국내주식 호가 조회 (매수/매도 10호가)
   * TR_ID: FHKST01010200 (실전/모의 동일)
   * 스프레드 계산용: askp1(매도1), bidp1(매수1)
   */
  async getDomesticAskingPrice(
    appKey: string,
    appSecret: string,
    accessToken: string,
    ticker: string
  ): Promise<DomesticAskingPriceResponse> {
    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn?` +
          new URLSearchParams({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: ticker,
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHKST01010200',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic asking price request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `DomesticAskingPrice:${ticker}`);
  }

  /**
   * 국내주식 종목정보 조회 (종목명 + 현재가)
   * TR_ID: FHKST03010100 (국내주식기간별시세)
   */
  async getDomesticStockInfo(
    appKey: string,
    appSecret: string,
    accessToken: string,
    ticker: string
  ): Promise<DomesticStockInfoResponse> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?` +
          new URLSearchParams({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: ticker,
            FID_INPUT_DATE_1: dateStr,
            FID_INPUT_DATE_2: dateStr,
            FID_PERIOD_DIV_CODE: 'D',
            FID_ORG_ADJ_PRC: '0',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHKST03010100',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic stock info request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `DomesticStockInfo:${ticker}`);
  }

  /**
   * 국내주식 일봉 조회 (기간별 시세)
   * TR_ID: FHKST03010100
   * 날짜 범위 지정하여 일봉 OHLCV 반환, 최대 100건/호출
   */
  async getDomesticDailyBars(
    appKey: string,
    appSecret: string,
    accessToken: string,
    ticker: string,
    startDate: string, // YYYYMMDD
    endDate: string,   // YYYYMMDD
    periodCode: 'D' | 'W' | 'M' = 'D', // D:일, W:주, M:월
  ): Promise<DomesticDailyBarResponse> {
    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?` +
          new URLSearchParams({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: ticker,
            FID_INPUT_DATE_1: startDate,
            FID_INPUT_DATE_2: endDate,
            FID_PERIOD_DIV_CODE: periodCode,
            FID_ORG_ADJ_PRC: '0', // 수정주가 반영
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHKST03010100',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic daily bar request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `DomesticDailyBars:${ticker}`);
  }

  /**
   * 국내주식 잔고 조회
   * TR_ID: TTTC8434R (실전) / VTTC8434R (모의)
   */
  async getDomesticBalance(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string
  ): Promise<DomesticBalanceResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');

    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            AFHR_FLPR_YN: 'N',
            OFL_YN: '',
            INQR_DVSN: '01',       // 대출일별 (02 종목별은 2025-02 이후 제한됨)
            UNPR_DVSN: '01',
            FUND_STTL_ICLD_YN: 'N',
            FNCG_AMT_AUTO_RDPT_YN: 'N',
            PRCS_DVSN: '01',       // 전일매매미포함
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'TTTC8434R',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic balance request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, 'DomesticBalance');
  }

  /**
   * 국내주식 주문 (현금)
   * TR_ID: 매도 TTTC0011U, 매수 TTTC0012U
   * 거래소: KRX
   */
  async submitDomesticOrder(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    params: {
      ticker: string;
      side: 'BUY' | 'SELL';
      orderType: 'LIMIT' | 'MARKET';  // 00:지정가, 01:시장가
      price: number;
      quantity: number;
    }
  ): Promise<OrderResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    // TR_ID 결정
    let trId: string;
    if (params.side === 'BUY') {
      trId = 'TTTC0012U';
    } else {
      trId = 'TTTC0011U';
    }

    // 주문구분: 00=지정가, 01=시장가
    const ordDvsn = params.orderType === 'MARKET' ? '01' : '00';
    // 거래소: KRX (SOR은 NXT 미상장 종목에서 실패하므로 KRX 고정)
    const excgIdDvsnCd = 'KRX';

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[DomesticOrder] Retry ${attempt}/${maxRetries} for ${params.ticker} ${params.side}`);
        }

        const response = await fetch(`${this.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
          },
          body: JSON.stringify({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            PDNO: params.ticker,
            ORD_DVSN: ordDvsn,
            ORD_QTY: String(params.quantity),
            ORD_UNPR: params.orderType === 'MARKET' ? '0' : String(Math.round(params.price)),
            EXCG_ID_DVSN_CD: excgIdDvsnCd,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Domestic order request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[DomesticOrder] Attempt ${attempt}/${maxRetries} failed for ${params.ticker}:`, lastError.message);
      }
    }

    throw lastError || new Error(`Domestic order request failed for ${params.ticker} after ${maxRetries} attempts`);
  }

  /**
   * 국내주식 정정취소주문
   * TR_ID: TTTC0013U (실전) / VTTC0013U (모의)
   * @param orderNo 원주문번호 (ORGN_ODNO)
   * @param orgNo 주문조직번호 (KRX_FWDG_ORD_ORGNO) - 주문 응답에서 받은 값
   */
  async cancelDomesticOrder(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    params: {
      orderNo: string;
      orgNo?: string;         // KRX_FWDG_ORD_ORGNO (없으면 빈값)
      ticker: string;
    }
  ): Promise<OrderResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    const trId = 'TTTC0013U';
    const excgIdDvsnCd = 'KRX';

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[DomesticCancel] Retry ${attempt}/${maxRetries} for ${params.ticker} ODNO=${params.orderNo}`);
        }

        const response = await fetch(`${this.baseUrl}/uapi/domestic-stock/v1/trading/order-rvsecncl`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
          },
          body: JSON.stringify({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            KRX_FWDG_ORD_ORGNO: params.orgNo || '',
            ORGN_ODNO: params.orderNo,
            ORD_DVSN: '00',           // 지정가
            RVSE_CNCL_DVSN_CD: '02',  // 02: 취소
            ORD_QTY: '0',             // QTY_ALL_ORD_YN=Y이면 무시
            ORD_UNPR: '0',
            QTY_ALL_ORD_YN: 'Y',      // 전량취소
            EXCG_ID_DVSN_CD: excgIdDvsnCd,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Domestic cancel order request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[DomesticCancel] Attempt ${attempt}/${maxRetries} failed for ${params.ticker}:`, lastError.message);
      }
    }

    throw lastError || new Error(`Domestic cancel order request failed for ${params.ticker} after ${maxRetries} attempts`);
  }

  /**
   * 국내주식 일별주문체결조회 (체결/미체결 모두)
   * TR_ID: TTTC0081R (실전) / VTTC0081R (모의)
   * @param ccldDvsn 체결구분 (00:전체, 01:체결, 02:미체결)
   */
  async getDomesticOrderHistory(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    startDate: string,
    endDate: string,
    ccldDvsn: string = '00',
    sllBuyDvsnCd: string = '00',
    ticker: string = ''
  ): Promise<DomesticOrderHistoryResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');
    console.log(`[getDomesticOrderHistory] 조회: startDate=${startDate}, endDate=${endDate}, ccld=${ccldDvsn}, ticker=${ticker}`);

    // 재시도 로직 (네트워크 오류 대비)
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[getDomesticOrderHistory] Retry ${attempt}/${maxRetries} for ${ticker}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-daily-ccld?` +
            new URLSearchParams({
              CANO: accountPrefix,
              ACNT_PRDT_CD: accountSuffix,
              INQR_STRT_DT: startDate,
              INQR_END_DT: endDate,
              SLL_BUY_DVSN_CD: sllBuyDvsnCd,
              INQR_DVSN: '00',       // 역순 (최신)
              PDNO: ticker,
              CCLD_DVSN: ccldDvsn,
              ORD_GNO_BRNO: '',
              ODNO: '',
              INQR_DVSN_3: '00',     // 전체
              INQR_DVSN_1: '',
              EXCG_ID_DVSN_CD: 'ALL',
              CTX_AREA_FK100: '',
              CTX_AREA_NK100: '',
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'TTTC0081R',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Domestic order history request failed: ${response.status} - ${errorBody}`);
        }

        const result: DomesticOrderHistoryResponse = await response.json();
        console.log(`[getDomesticOrderHistory] 응답: ${result.output1?.length || 0}건, msg: ${result.msg1}`);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[getDomesticOrderHistory] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      }
    }

    throw lastError || new Error(`Domestic order history request failed after ${maxRetries} attempts`);
  }

  /**
   * 국내주식 미체결내역 조회 (getDomesticOrderHistory의 편의 메서드)
   */
  async getDomesticPendingOrders(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    todayStr: string,
    ticker: string = ''
  ): Promise<DomesticOrderHistoryResponse> {
    return this.getDomesticOrderHistory(
      appKey, appSecret, accessToken, accountNo,
      todayStr, todayStr,
      '02',    // 미체결만
      '00',    // 전체 (매수+매도)
      ticker
    );
  }

  /**
   * 국내주식 매수가능금액 조회
   * TR_ID: TTTC8908R (실전) / VTTC8908R (모의)
   */
  async getDomesticBuyableAmount(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    ticker: string,
    price: number
  ): Promise<DomesticBuyableAmountResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');

    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-psbl-order?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            PDNO: ticker,
            ORD_UNPR: String(Math.round(price)),
            ORD_DVSN: '00',            // 지정가
            CMA_EVLU_AMT_ICLD_YN: 'N',
            OVRS_ICLD_YN: 'N',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'TTTC8908R',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic buyable amount request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `DomesticBuyable:${ticker}`);
  }

  // ==================== 국내주식 순위 API ====================

  /**
   * 국내주식 거래량순위
   * TR_ID: FHPST01710000 (실전전용, 모의투자 미지원)
   * 최대 30건 반환
   * @param options.marketCode 'J'=KOSPI, 'K'=KOSDAQ (기본 'J')
   * @param options.priceMin 최소 가격 (기본 '')
   * @param options.priceMax 최대 가격 (기본 '')
   */
  async getDomesticVolumeRanking(
    appKey: string,
    appSecret: string,
    accessToken: string,
    options?: { marketCode?: string; priceMin?: string; priceMax?: string }
  ): Promise<VolumeRankingResponse> {
    const marketCode = options?.marketCode || 'J';
    const priceMin = options?.priceMin || '';
    const priceMax = options?.priceMax || '';
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[VolumeRanking] Retry ${attempt}/${maxRetries}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/domestic-stock/v1/quotations/volume-rank?` +
            new URLSearchParams({
              FID_COND_MRKT_DIV_CODE: marketCode,
              FID_COND_SCR_DIV_CODE: '20171',
              FID_INPUT_ISCD: '0000',
              FID_DIV_CLS_CODE: '1',             // 보통주만
              FID_BLNG_CLS_CODE: '0',             // 평균거래량
              FID_TRGT_CLS_CODE: '111111111',
              FID_TRGT_EXLS_CLS_CODE: '0110011101', // 관리/정리/거래정지/ETF/ETN/신용불가/SPAC 제외
              FID_INPUT_PRICE_1: priceMin,
              FID_INPUT_PRICE_2: priceMax,
              FID_VOL_CNT: '',
              FID_INPUT_DATE_1: '',
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'FHPST01710000',
              custtype: 'P',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Volume ranking request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[VolumeRanking] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      }
    }

    throw lastError || new Error('Volume ranking request failed after retries');
  }

  /**
   * 국내주식 시가총액 상위
   * TR_ID: FHPST01740000 (실전전용, 모의투자 미지원)
   * 최대 30건 반환
   */
  async getDomesticMarketCapRanking(
    appKey: string,
    appSecret: string,
    accessToken: string,
    options?: { priceMin?: string; priceMax?: string }
  ): Promise<MarketCapRankingResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[MarketCapRanking] Retry ${attempt}/${maxRetries}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/domestic-stock/v1/ranking/market-cap?` +
            new URLSearchParams({
              fid_cond_mrkt_div_code: 'J',
              fid_cond_scr_div_code: '20174',
              fid_div_cls_code: '1',              // 보통주만
              fid_input_iscd: '0000',
              fid_trgt_cls_code: '0',
              fid_trgt_exls_cls_code: '0',
              fid_input_price_1: options?.priceMin ?? '',
              fid_input_price_2: options?.priceMax ?? '',
              fid_vol_cnt: '',
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'FHPST01740000',
              custtype: 'P',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Market cap ranking request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[MarketCapRanking] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      }
    }

    throw lastError || new Error('Market cap ranking request failed after retries');
  }

  /**
   * 종목조건검색 목록조회
   * TR_ID: HHKST03900300 (실전전용, 모의투자 미지원)
   * HTS에 등록 및 서버저장한 조건 목록 반환
   */
  async getConditionSearchList(
    appKey: string,
    appSecret: string,
    accessToken: string,
    htsUserId: string
  ): Promise<ConditionSearchListResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[ConditionList] Retry ${attempt}/${maxRetries}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/domestic-stock/v1/quotations/psearch-title?` +
            new URLSearchParams({
              user_id: htsUserId,
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'HHKST03900300',
              custtype: 'P',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Condition search list request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[ConditionList] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      }
    }

    throw lastError || new Error('Condition search list request failed after retries');
  }

  /**
   * 종목조건검색조회
   * TR_ID: HHKST03900400 (실전전용, 모의투자 미지원)
   * 특정 조건에 해당하는 종목 목록 반환 (최대 100건)
   * 결과 0건이면 rt_cd:"1", msg_cd:"MCA05918" 반환 (정상 동작)
   */
  async getConditionSearchResult(
    appKey: string,
    appSecret: string,
    accessToken: string,
    htsUserId: string,
    seq: string
  ): Promise<ConditionSearchResultResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[ConditionResult] Retry ${attempt}/${maxRetries} for seq=${seq}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/domestic-stock/v1/quotations/psearch-result?` +
            new URLSearchParams({
              user_id: htsUserId,
              seq: seq,
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'HHKST03900400',
              custtype: 'P',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Condition search result request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[ConditionResult] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      }
    }

    throw lastError || new Error('Condition search result request failed after retries');
  }

  /**
   * 국내주식 당일분봉조회
   * TR_ID: FHKST03010200
   * 1분봉 반환, 최대 30건/호출
   */
  async getDomesticMinuteBars(
    appKey: string,
    appSecret: string,
    accessToken: string,
    ticker: string,
    hour: string, // HHMMSS (예: '130000')
  ): Promise<DomesticMinuteBarResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[DomesticMinuteBar] Retry ${attempt}/${maxRetries} for ${ticker}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?` +
            new URLSearchParams({
              FID_COND_MRKT_DIV_CODE: 'J',
              FID_INPUT_ISCD: ticker,
              FID_INPUT_HOUR_1: hour,
              FID_PW_DATA_INCU_YN: 'Y',
              FID_ETC_CLS_CODE: '',
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'FHKST03010200',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Domestic minute bar request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[DomesticMinuteBar] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      }
    }

    throw lastError || new Error('Domestic minute bar request failed after retries');
  }

  /**
   * 해외주식분봉조회
   * TR_ID: HHDFS76950200
   * NMIN으로 분봉 간격 지정 가능 (1, 5, 15 등), 최대 120건
   */
  async getOverseasMinuteBars(
    appKey: string,
    appSecret: string,
    accessToken: string,
    ticker: string,
    nmin: number, // 분봉 간격 (1, 5, 15 등)
    nrec = 20,    // 요청 건수 (최대 120)
    exchange?: string,
  ): Promise<OverseasMinuteBarResponse> {
    const exchangeCode = exchange || KisApiClient.getExchangeCodeForQuote(ticker);
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[OverseasMinuteBar] Retry ${attempt}/${maxRetries} for ${ticker}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice?` +
            new URLSearchParams({
              AUTH: '',
              EXCD: exchangeCode,
              SYMB: ticker,
              NMIN: String(nmin),
              PINC: '1',
              NEXT: '',
              NREC: String(nrec),
              FILL: '',
              KEYB: '',
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'HHDFS76950200',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Overseas minute bar request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[OverseasMinuteBar] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      }
    }

    throw lastError || new Error('Overseas minute bar request failed after retries');
  }

  /**
   * 해외주식 기간별 시세 (일/주/월봉)
   * TR_ID: HHDFS76200200
   * GUBN: 0=일봉, 1=주봉, 2=월봉 / 최대 100건/호출
   */
  async getOverseasDailyBars(
    appKey: string,
    appSecret: string,
    accessToken: string,
    ticker: string,
    endDate: string,    // YYYYMMDD — 이 날짜 이전 데이터 최대 100건
    periodCode: '0' | '1' | '2' = '0', // 0:일, 1:주, 2:월
    exchange?: string,  // NAS/NYS/AMS — 없으면 ticker 기반 자동 판별
  ): Promise<OverseasDailyBarResponse> {
    const excd = exchange ?? KisApiClient.getExchangeCodeForQuote(ticker);

    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/overseas-price/v1/quotations/dailyprice?` +
          new URLSearchParams({
            AUTH: '',
            EXCD: excd,
            SYMB: ticker,
            GUBN: periodCode,
            BYMD: endDate,
            MODP: '1', // 수정주가 반영
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'HHDFS76200200',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Overseas daily bar request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `OverseasDailyBars:${ticker}`);
  }

  /**
   * 국내 기간별손익일별합산조회
   * TR_ID: TTTC8708R
   * 날짜 범위의 일별 실현손익 합산 조회
   */
  async getDomesticDailyPnl(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    startDate: string, // YYYYMMDD
    endDate: string,   // YYYYMMDD
  ): Promise<DomesticDailyPnlResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');

    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-period-profit?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            INQR_STRT_DT: startDate,
            INQR_END_DT: endDate,
            PDNO: '',
            SORT_DVSN: '00',
            INQR_DVSN: '00',
            CBLC_DVSN: '00',
            CTX_AREA_FK100: '',
            CTX_AREA_NK100: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'TTTC8708R',
            custtype: 'P',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic daily PnL request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, 'DomesticDailyPnl');
  }

  /**
   * 해외주식 기간손익 (거래소별 조회)
   * TR_ID: TTTS3039R
   * 해외 기간손익은 매매일 익일부터 조회 가능
   */
  async getOverseasPeriodPnl(
    appKey: string,
    appSecret: string,
    accessToken: string,
    accountNo: string,
    exchangeCode: string, // NASD, AMEX, NYSE 등
    startDate: string,    // YYYYMMDD
    endDate: string,      // YYYYMMDD
  ): Promise<OverseasPeriodPnlResponse> {
    const [accountPrefix, accountSuffix] = accountNo.split('-');

    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-period-profit?` +
          new URLSearchParams({
            CANO: accountPrefix,
            ACNT_PRDT_CD: accountSuffix,
            OVRS_EXCG_CD: exchangeCode,
            NATN_CD: '',
            CRCY_CD: '',
            PDNO: '',
            INQR_STRT_DT: startDate,
            INQR_END_DT: endDate,
            WCRC_FRCR_DVSN_CD: '01', // 외화(USD)
            CTX_AREA_FK200: '',
            CTX_AREA_NK200: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'TTTS3039R',
            custtype: 'P',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Overseas period PnL request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `OverseasPeriodPnl:${exchangeCode}`);
  }

  /**
   * 해외주식 거래대금순위
   * TR_ID: HHDFS76320010 (실전전용, 모의투자 미지원)
   * 거래소별 호출 필요 (NYS, NAS, AMS)
   */
  async getOverseasTradingAmountRanking(
    appKey: string,
    appSecret: string,
    accessToken: string,
    exchangeCode: string,
    options?: { priceMin?: string; priceMax?: string; volRange?: string }
  ): Promise<OverseasTradingAmountRankingResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log(`[OverseasTradingAmountRanking] Retry ${attempt}/${maxRetries} for ${exchangeCode}`);
        }

        const response = await fetch(
          `${this.baseUrl}/uapi/overseas-stock/v1/ranking/trade-pbmn?` +
            new URLSearchParams({
              KEYB: '',
              AUTH: '',
              EXCD: exchangeCode,
              NDAY: '0',
              VOL_RANG: options?.volRange || '0',
              PRC1: options?.priceMin || '',
              PRC2: options?.priceMax || '',
            }),
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              authorization: `Bearer ${accessToken}`,
              appkey: appKey,
              appsecret: appSecret,
              tr_id: 'HHDFS76320010',
              custtype: 'P',
            },
          }
        );

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Overseas trading amount ranking request failed: ${response.status} - ${errorBody}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[OverseasTradingAmountRanking] Attempt ${attempt}/${maxRetries} failed for ${exchangeCode}:`, lastError.message);
      }
    }

    throw lastError || new Error('Overseas trading amount ranking request failed after retries');
  }

  // ==================== 국내업종 지수 API ====================

  /**
   * 국내업종 현재지수 조회
   * TR_ID: FHPUP02100000 (실전전용, 모의투자 미지원)
   * @param indexCode 0001(코스피), 1001(코스닥), 2001(코스피200)
   */
  async getDomesticIndexPrice(
    appKey: string,
    appSecret: string,
    accessToken: string,
    indexCode: string,
  ): Promise<DomesticIndexPriceResponse> {
    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-index-price?` +
          new URLSearchParams({
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD: indexCode,
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHPUP02100000',
            custtype: 'P',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic index price request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `DomesticIndexPrice:${indexCode}`);
  }

  /**
   * 국내업종 일자별지수 조회 (100건까지)
   * TR_ID: FHPUP02120000 (실전전용, 모의투자 미지원)
   * @param indexCode 0001(코스피), 1001(코스닥)
   * @param startDate YYYYMMDD
   */
  async getDomesticIndexDailyPrice(
    appKey: string,
    appSecret: string,
    accessToken: string,
    indexCode: string,
    startDate: string,
  ): Promise<DomesticIndexDailyPriceResponse> {
    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-index-daily-price?` +
          new URLSearchParams({
            FID_COND_MRKT_DIV_CODE: 'U',
            FID_INPUT_ISCD: indexCode,
            FID_INPUT_DATE_1: startDate,
            FID_PERIOD_DIV_CODE: 'D',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHPUP02120000',
            custtype: 'P',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic index daily price request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `DomesticIndexDailyPrice:${indexCode}`);
  }

  /**
   * 국내휴장일 조회
   * TR_ID: CTCA0903R (실전전용, 모의투자 미지원)
   * ★중요: 원장서비스 연관 — 1일 1회만 호출
   * @param baseDate YYYYMMDD
   */
  async getDomesticHolidays(
    appKey: string,
    appSecret: string,
    accessToken: string,
    baseDate: string,
  ): Promise<DomesticHolidayResponse> {
    return this.withRetry(async () => {
      const response = await fetch(
        `${this.baseUrl}/uapi/domestic-stock/v1/quotations/chk-holiday?` +
          new URLSearchParams({
            BASS_DT: baseDate,
            CTX_AREA_NK: '',
            CTX_AREA_FK: '',
          }),
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${accessToken}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'CTCA0903R',
            custtype: 'P',
          },
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Domestic holiday request failed: ${response.status} - ${errorBody}`);
      }

      return response.json();
    }, `DomesticHolidays:${baseDate}`, 2); // 2회만 재시도
  }
}

// 국내주식 당일분봉조회 응답
// 국내주식 일봉 조회 응답 (기간별 시세)
export interface DomesticDailyBarResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: {
    hts_kor_isnm: string;      // HTS 한글 종목명
    stck_prpr: string;         // 주식 현재가
    prdy_vrss: string;         // 전일 대비
    prdy_vrss_sign: string;    // 전일 대비 부호
    prdy_ctrt: string;         // 전일 대비율
    acml_vol: string;          // 누적 거래량
    stck_mxpr: string;         // 상한가
    stck_llam: string;         // 하한가
  };
  output2?: Array<{
    stck_bsop_date: string;    // 주식 영업 일자 (YYYYMMDD)
    stck_oprc: string;         // 시가
    stck_hgpr: string;         // 고가
    stck_lwpr: string;         // 저가
    stck_clpr: string;         // 종가
    acml_vol: string;          // 누적 거래량
    acml_tr_pbmn: string;      // 누적 거래대금
    prdy_vrss: string;         // 전일 대비
    prdy_vrss_sign: string;    // 전일 대비 부호
    prdy_ctrt: string;         // 전일 대비율
    flng_cls_code: string;     // 락 구분 코드
    mod_yn: string;            // 분할/병합 여부
  }>;
}

export interface DomesticMinuteBarResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: {
    stck_prpr: string;       // 현재가
    acml_vol: string;        // 누적 거래량
    hts_kor_isnm: string;    // 종목명
  };
  output2?: Array<{
    stck_bsop_date: string;  // 영업일자 (YYYYMMDD)
    stck_cntg_hour: string;  // 체결시간 (HHMMSS)
    stck_prpr: string;       // 현재가 (종가)
    stck_oprc: string;       // 시가
    stck_hgpr: string;       // 고가
    stck_lwpr: string;       // 저가
    cntg_vol: string;        // 체결 거래량
    acml_tr_pbmn: string;    // 누적 거래대금
  }>;
}

// 해외주식분봉조회 응답
export interface OverseasMinuteBarResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: {
    rsym: string;            // 종목코드
    zdiv: string;            // 소수점자리수
    nrec: string;            // 레코드갯수
  };
  output2?: Array<{
    tymd: string;            // 현지영업일자
    xymd: string;            // 현지기준일자
    xhms: string;            // 현지기준시간 (HHMMSS)
    kymd: string;            // 한국기준일자
    khms: string;            // 한국기준시간
    open: string;            // 시가
    high: string;            // 고가
    low: string;             // 저가
    last: string;            // 종가
    evol: string;            // 체결량
    eamt: string;            // 체결대금
  }>;
}

// 거래량순위 응답
export interface VolumeRankingResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: Array<{
    hts_kor_isnm: string;              // HTS 한글 종목명
    mksc_shrn_iscd: string;            // 유가증권 단축 종목코드
    data_rank: string;                 // 데이터 순위
    stck_prpr: string;                 // 주식 현재가
    prdy_vrss_sign: string;            // 전일 대비 부호
    prdy_vrss: string;                 // 전일 대비
    prdy_ctrt: string;                 // 전일 대비율
    acml_vol: string;                  // 누적 거래량
    prdy_vol: string;                  // 전일 거래량
    lstn_stcn: string;                 // 상장 주수
    avrg_vol: string;                  // 평균 거래량
    acml_tr_pbmn: string;             // 누적 거래 대금
  }>;
}

// 시가총액 상위 응답
export interface MarketCapRankingResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: Array<{
    mksc_shrn_iscd: string;            // 유가증권 단축 종목코드
    data_rank: string;                 // 데이터 순위
    hts_kor_isnm: string;             // HTS 한글 종목명
    stck_prpr: string;                 // 주식 현재가
    prdy_vrss: string;                 // 전일 대비
    prdy_vrss_sign: string;            // 전일 대비 부호
    prdy_ctrt: string;                 // 전일 대비율
    acml_vol: string;                  // 누적 거래량
    lstn_stcn: string;                 // 상장 주수
    stck_avls: string;                 // 시가 총액
    mrkt_whol_avls_rlim: string;       // 시장 전체 시가총액 비중
  }>;
}

// 종목조건검색 목록조회 응답
export interface ConditionSearchListResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output2?: Array<{
    user_id: string;
    seq: string;                // 조건키값 (0부터 시작)
    grp_nm: string;             // 그룹명
    condition_nm: string;       // 조건명
  }>;
}

// 종목조건검색조회 응답
export interface ConditionSearchResultResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output2?: Array<{
    code: string;               // 종목코드 (6자리)
    name: string;               // 종목명
    price: string;              // 현재가 ("00000138600.0000")
    chgrate: string;            // 등락률
    acml_vol: string;           // 거래량
    trade_amt: string;          // 거래대금
    stotprice: string;          // 시가총액 (억원, "31617.9088")
    daebi: string;              // 전일대비부호
    change: string;             // 전일대비
  }>;
}

// 국내 기간별손익일별합산조회 응답
export interface DomesticDailyPnlResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: Array<{
    trad_dt: string;     // 매매일자 (YYYYMMDD)
    buy_amt: string;     // 매수금액
    sll_amt: string;     // 매도금액
    rlzt_pfls: string;   // 실현손익
    fee: string;         // 수수료
    tl_tax: string;      // 제세금
    pfls_rt: string;     // 손익률
  }>;
  output2?: {
    tot_rlzt_pfls: string;   // 총실현손익
    tot_fee: string;         // 총수수료
    tot_tltx: string;        // 총제세금
  };
}

// 해외주식 기간손익 응답
export interface OverseasPeriodPnlResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: Array<{
    trad_day: string;              // 매매일
    ovrs_pdno: string;             // 해외상품번호
    ovrs_item_name: string;        // 해외종목명
    slcl_qty: string;              // 매도청산수량
    pchs_avg_pric: string;         // 매입평균가격
    frcr_pchs_amt1: string;        // 외화매입금액
    avg_sll_unpr: string;          // 평균매도단가
    frcr_sll_amt_smtl1: string;    // 외화매도금액합계
    ovrs_rlzt_pfls_amt: string;    // 해외실현손익금액
    pftrt: string;                 // 수익률
    ovrs_excg_cd: string;          // 해외거래소코드
  }>;
  output2?: {
    ovrs_rlzt_pfls_tot_amt: string;  // 해외실현손익총금액
    tot_pftrt: string;               // 총수익률
  };
}

// 해외주식 거래대금순위 응답
export interface OverseasTradingAmountRankingResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: {
    zdiv: string;              // 소수점자리수
    stat: string;              // 거래상태정보
    crec: string;              // 현재조회종목수
    trec: string;              // 전체조회종목수
    nrec: string;              // RecordCount
  };
  output2?: Array<{
    rsym: string;              // 실시간조회심볼
    excd: string;              // 거래소코드
    symb: string;              // 종목코드
    name: string;              // 종목명
    last: string;              // 현재가
    sign: string;              // 기호
    diff: string;              // 대비
    rate: string;              // 등락율
    pask: string;              // 매도호가
    pbid: string;              // 매수호가
    tvol: string;              // 거래량
    tamt: string;              // 거래대금
    a_tamt: string;            // 평균거래대금
    rank: string;              // 순위
    ename: string;             // 영문종목명
    e_ordyn: string;           // 매매가능
  }>;
}

/**
 * 토큰 캐싱 유틸리티
 * 인메모리 + 로컬 파일 캐시 (Firebase 제거)
 */
import { getTokenCache, setTokenCache } from './localStore';

const TOKEN_CACHE_HOURS = 23; // 토큰 유효기간 23시간 (실제 24시간이지만 여유 확보)

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  updatedAt: string;
  appKeyPrefix?: string; // appKey 변경 감지용 (앞 8자)
}

// 인메모리 캐시 (프로세스 내 최우선) — 계좌별 Map
const inMemoryTokenCache = new Map<string, CachedToken>();

// 진행 중인 토큰 발급 Promise — 동시 요청 dedup (같은 키에 대해 1회만 발급)
const inFlightTokenRequests = new Map<string, Promise<string>>();

/**
 * 캐시된 토큰 가져오기 또는 새로 발급
 * 3-tier: 인메모리 → 로컬 파일 → KIS API
 *
 * accountStore를 전달하면 계좌별 파일 캐시 사용, 없으면 글로벌 파일 캐시 사용
 */
export async function getOrRefreshToken(
  _userId: string,
  _accountId: string,
  credentials: { appKey: string; appSecret: string },
  kisClient: KisApiClient,
  forceRefresh = false,
  accountStore?: { getTokenCache: <T>() => T | null; setTokenCache: (data: unknown) => void }
): Promise<string> {
  try {
    const cacheKey = _accountId || 'default';
    const now = Date.now();
    const currentKeyPrefix = credentials.appKey.slice(0, 8);

    // 1. 인메모리 캐시 확인
    if (!forceRefresh) {
      const memCache = inMemoryTokenCache.get(cacheKey);
      if (memCache) {
        const keyChanged = memCache.appKeyPrefix && memCache.appKeyPrefix !== currentKeyPrefix;
        if (!keyChanged && memCache.expiresAt > now) {
          console.log(`[Token:${cacheKey}] 인메모리 캐시 사용 (만료까지 ${Math.round((memCache.expiresAt - now) / 1000 / 60)}분)`);
          return memCache.accessToken;
        }
      }
    }

    // 2. 로컬 파일 캐시 확인
    if (!forceRefresh) {
      const fileCache = accountStore
        ? accountStore.getTokenCache<CachedToken>()
        : getTokenCache<CachedToken>();
      if (fileCache) {
        const keyChanged = fileCache.appKeyPrefix && fileCache.appKeyPrefix !== currentKeyPrefix;
        if (!keyChanged && fileCache.expiresAt > now) {
          console.log(`[Token:${cacheKey}] 파일 캐시 사용 (만료까지 ${Math.round((fileCache.expiresAt - now) / 1000 / 60)}분)`);
          inMemoryTokenCache.set(cacheKey, fileCache);
          return fileCache.accessToken;
        }
      }
    }

    // 3. 새 토큰 발급 — 동일 키에 대해 진행 중인 요청이 있으면 재사용
    const existingFlight = inFlightTokenRequests.get(cacheKey);
    if (existingFlight) {
      console.log(`[Token:${cacheKey}] 진행 중인 발급 대기`);
      return existingFlight;
    }

    console.log(`[Token:${cacheKey}] 새 토큰 발급`);
    const fetchPromise = (async () => {
      const tokenResponse = await kisClient.getAccessToken(credentials.appKey, credentials.appSecret);
      const accessToken = tokenResponse.access_token;

      const cacheData: CachedToken = {
        accessToken,
        expiresAt: Date.now() + TOKEN_CACHE_HOURS * 60 * 60 * 1000,
        updatedAt: new Date().toISOString(),
        appKeyPrefix: currentKeyPrefix,
      };

      // 인메모리 + 파일 캐시 동시 저장
      inMemoryTokenCache.set(cacheKey, cacheData);
      if (accountStore) {
        accountStore.setTokenCache(cacheData);
      } else {
        setTokenCache(cacheData);
      }

      return accessToken;
    })();

    inFlightTokenRequests.set(cacheKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      inFlightTokenRequests.delete(cacheKey);
    }
  } catch (err) {
    console.error('[Token] 토큰 발급/갱신 실패:', err);
    throw err;
  }
}

/**
 * KIS API 토큰 만료 에러 감지
 */
export function isTokenExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('EGW00123') || msg.includes('만료된 token');
}

// ==================== 국내업종 지수 응답 타입 ====================

export interface DomesticIndexPriceResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: {
    bstp_nmix_prpr: string;       // 업종 지수 현재가
    bstp_nmix_prdy_vrss: string;  // 업종 지수 전일 대비
    prdy_vrss_sign: string;       // 전일 대비 부호
    bstp_nmix_prdy_ctrt: string;  // 업종 지수 전일 대비율
    acml_vol: string;             // 누적 거래량
    acml_tr_pbmn: string;         // 누적 거래 대금
    bstp_nmix_oprc: string;       // 업종 지수 시가
    bstp_nmix_hgpr: string;       // 업종 지수 최고가
    bstp_nmix_lwpr: string;       // 업종 지수 최저가
    ascn_issu_cnt: string;        // 상승 종목 수
    down_issu_cnt: string;        // 하락 종목 수
    stnr_issu_cnt: string;        // 보합 종목 수
  };
}

export interface DomesticIndexDailyPriceResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output1?: {
    bstp_nmix_prpr: string;       // 업종 지수 현재가
    bstp_nmix_prdy_vrss: string;  // 전일 대비
    bstp_nmix_prdy_ctrt: string;  // 전일 대비율
  };
  output2?: Array<{
    stck_bsop_date: string;        // 영업일자 (YYYYMMDD)
    bstp_nmix_prpr: string;        // 업종 지수 종가
    bstp_nmix_oprc: string;        // 시가
    bstp_nmix_hgpr: string;        // 고가
    bstp_nmix_lwpr: string;        // 저가
    bstp_nmix_prdy_ctrt: string;   // 전일 대비율
    acml_vol: string;              // 누적 거래량
    acml_tr_pbmn: string;          // 누적 거래 대금
    d20_dsrt: string;              // 20일 이격도
  }>;
}

export interface DomesticHolidayResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output?: Array<{
    bass_dt: string;         // 기준일자 (YYYYMMDD)
    wday_dvsn_cd: string;    // 요일구분코드
    bzdy_yn: string;         // 영업일여부 (Y/N)
    tr_day_yn: string;       // 거래일여부 (Y/N)
    opnd_yn: string;         // 개장일여부 (Y/N)
    sttl_day_yn: string;     // 결제일여부 (Y/N)
  }>;
}

// 해외주식 기간별 시세 응답 (HHDFS76200200)
export interface OverseasDailyBarResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  output2?: Array<{
    xymd: string;   // 날짜 (YYYYMMDD)
    open: string;   // 시가
    high: string;   // 고가
    low: string;    // 저가
    clos: string;   // 종가
    tvol: string;   // 거래량
    tamt: string;   // 거래대금
    pbid: string;   // 매수호가
    vbid: string;   // 매수잔량
    pask: string;   // 매도호가
    vask: string;   // 매도잔량
  }>;
}
