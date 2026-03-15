# 한국투자증권 Open API - 무한매수법 필요 API 정리

> 이 문서는 무한매수법 자동매매 시스템 구현에 필요한 API만 추출하여 정리한 것입니다.
> 대상 종목: TQQQ, SOXL (미국 주식)

## 목차

1. [인증](#인증)
   - [Hashkey](#hashkey)
   - [접근토큰발급](#접근토큰발급p)
2. [주문](#주문)
   - [해외주식 주문](#해외주식-주문)
   - [해외주식 정정취소주문](#해외주식-정정취소주문)
3. [계좌/잔고](#계좌잔고)
   - [해외주식 잔고](#해외주식-잔고)
   - [해외주식 미체결내역](#해외주식-미체결내역)
   - [해외주식 주문체결내역](#해외주식-주문체결내역)
   - [해외주식 매수가능금액조회](#해외주식-매수가능금액조회)
4. [시세](#시세)
   - [해외주식 현재체결가](#해외주식-현재체결가)
   - [해외주식 기간별시세](#해외주식-기간별시세)
5. [기타](#기타)
   - [해외결제일자조회](#해외결제일자조회) - 휴장일 확인

## 공통 정보

### Domain
- **실전**: `https://openapi.koreainvestment.com:9443`
- **모의투자**: `https://openapivts.koreainvestment.com:29443`

### 공통 Header (인증 후)
```
Content-Type: application/json; charset=utf-8
authorization: Bearer {access_token}
appkey: {앱키}
appsecret: {앱시크릿}
tr_id: {거래ID}
```

### 미국 거래소 코드
| 코드 | 거래소 |
|------|--------|
| NASD | 나스닥 |
| NYSE | 뉴욕 |
| AMEX | 아멕스 |

---

# 인증

## Hashkey

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| HTTP Method | `POST` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/uapi/hashkey` |

### 개요

해쉬키(Hashkey)는 보안을 위한 요소로 사용자가 보낸 요청 값을 중간에 탈취하여 변조하지 못하도록 하는데 사용됩니다.
해쉬키를 사용하면 POST로 보내는 요청(주로 주문/정정/취소 API 해당)의 body 값을 사전에 암호화시킬 수 있습니다.
해쉬키는 비필수값으로 사용하지 않아도 POST API 호출은 가능합니다.

### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| appkey | 앱키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |

### Request Body

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| JsonBody | 요청값 | object | Y | POST로 보낼 body값  ex) datas = {     "CANO": '00000000',     "ACNT_PRDT_CD": "01",     "OVRS_EXCG_CD":  |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| JsonBody | 요청값 | object | 요청한 JsonBody |
| HASH | 해쉬키 | string | [POST API 대상] Client가 요청하는 Request Body를 hashkey api로 생성한 Hash값 * API문서 > hashkey 참조 |

### Request Example

```json
{
	"ORD_PRCS_DVSN_CD": "02",
	"CANO": "계좌번호",
	"ACNT_PRDT_CD": "03",
	"SLL_BUY_DVSN_CD": "02",
	"SHTN_PDNO": "101S06",
	"ORD_QTY": "1",
	"UNIT_PRICE": "370",
	"NMPR_TYPE_CD": "",
	"KRX_NMPR_CNDT_CD": "",
	"CTAC_TLNO": "",
	"FUOP_ITEM_DVSN_CD": "",
	"ORD_DVSN_CD": "02"
}
```

### Response Example

```json
{
  "BODY": {
    "ORD_PRCS_DVSN_CD": "02",
    "CANO": "계좌번호",
    "ACNT_PRDT_CD": "03",
    "SLL_BUY_DVSN_CD": "02",
    "SHTN_PDNO": "101S06",
    "ORD_QTY": "1",
    "UNIT_PRICE": "370",
    "NMPR_TYPE_CD": "",
    "KRX_NMPR_CNDT_CD": "",
    "CTAC_TLNO": "",
    "FUOP_ITEM_DVSN_CD": "",
    "ORD_DVSN_CD": "02"
  },
  "HASH": "8b84068222a49302f7ef58226d90403f62e216828f8103465f900de0e7be2f0f"
}
```

---

## 접근토큰발급(P)

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| HTTP Method | `POST` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/oauth2/tokenP` |

### 개요

본인 계좌에 필요한 인증 절차로, 인증을 통해 접근 토큰을 부여받아 오픈API 활용이 가능합니다.

1. 접근토큰(access_token)의 유효기간은 24시간 이며(1일 1회발급 원칙) 
   갱신발급주기는 6시간 입니다.(6시간 이내는 기존 발급키로 응답)

2. 접근토큰발급(/oauth2/tokenP) 시 접근토큰값(access_token)과 함께 수신되는 
   접근토큰 유효기간(acess_token_token_expired)을 이용해 접근토큰을 관리하실 수 있습니다.


[참고]

'23.4.28 이후 지나치게 잦은 토큰 발급 요청건을 제어 하기 위해 신규 접근토큰발급 이후 일정시간 이내에 재호출 시에는 직전 토큰값을 리턴하게 되었습니다. 일정시간 이후 접근토큰발급 API 호출 시에는 신규 토큰값을 리턴합니다. 
접근토큰발급 API 호출 및 코드 작성하실 때 해당 사항을 참고하시길 바랍니다.

※ 참고 : 포럼 &gt; 공지사항 &gt;  [수정] [중요] 접근 토큰 발급 변경 안내

### Request Body

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| grant_type | 권한부여 Type | string | Y | client_credentials |
| appkey | 앱키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| access_token | 접근토큰 | string | OAuth 토큰이 필요한 API 경우 발급한 Access token ex) "eyJ0eXUxMiJ9.eyJz…..................................."    |
| token_type | 접근토큰유형 | string | 접근토큰유형 : "Bearer" ※ API 호출 시, 접근토큰유형 "Bearer" 입력. ex) "Bearer eyJ...." |
| expires_in | 접근토큰 유효기간 | number | 유효기간(초) ex) 7776000 |
| access_token_token_expired | 접근토큰 유효기간(일시표시) | string | 유효기간(년:월:일 시:분:초) ex) "2022-08-30 08:10:10" |

### Request Example

```json
{
  "grant_type": "client_credentials",
  "appkey": "PSg5dctL9dKPo727J13Ur405OSXXXXXXXXXX",
  "appsecret":  "yo2t8zS68zpdjGuWvFyM9VikjXE0i0CbgPEamnqPA00G0bIfrdfQb2RUD1xP7SqatQXr1cD1fGUNsb78MMXoq6o4lAYt9YTtHAjbMoFy+c72kbq5owQY1Pvp39/x6ejpJlXCj7gE3yVOB/h25Hvl+URmYeBTfrQeOqIAOYc/OIXXXXXXXXXX"
}
```

### Response Example

```json
{
	"access_token":"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJ0b2tlbiIsImF1ZCI6ImMwNzM1NTYzLTA1MjctNDNhZS05ODRiLTJiNWI1ZWZmOWYyMyIsImlzcyI6InVub2d3IiwiZXhwIjoxNjQ5NzUxMTAwLCJpYXQiOjE2NDE5NzUxMDAsImp0aSI6IkJTZlM0QUtSSnpRVGpmdHRtdXZlenVQUTlKajc3cHZGdjBZVyJ9.Oyt_C639yUjWmRhymlszgt6jDo8fvIKkkxH1mMngunV1T15SCC4I3Xe6MXxcY23DXunzBfR1uI0KXXXXXXXXXX",
	"access_token_token_expired":"2023-12-22 08:16:59",
	"token_type":"Bearer",
	"expires_in":86400
}
```

---

## 해외주식 주문

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `(미국매수) TTTT1002U  (미국매도) TTTT1006U (아시아 국가 하단 규격서 참고)` |
| 모의 TR_ID | `(미국매수) VTTT1002U  (미국매도) VTTT1001U  (아시아 국가 하단 규격서 참고)` |
| HTTP Method | `POST` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/uapi/overseas-stock/v1/trading/order` |

### 개요

해외주식 주문 API입니다.

* 모의투자의 경우, 모든 해외 종목 매매가 지원되지 않습니다. 일부 종목만 매매 가능한 점 유의 부탁드립니다.

* 해외주식 서비스 신청 후 이용 가능합니다. (아래 링크 3번 해외증권 거래신청 참고)
https://securities.koreainvestment.com/main/bond/research/_static/TF03ca010001.jsp

* 해외 거래소 운영시간 외 API 호출 시 에러가 발생하오니 운영시간을 확인해주세요. (미국주식 주간주문은 "해외주식 미국주간주문"을 이용)
* 해외 거래소 운영시간(한국시간 기준)
1) 미국 : 23:30 ~ 06:00 (썸머타임 적용 시 22:30 ~ 05:00) 
   * 프리마켓(18:00 ~ 23:30, Summer Time : 17:00 ~ 22:30), 애프터마켓(06:00 ~ 07:00, Summer Time : 05:00 ~ 07:00) 시간대에도 주문 가능
2) 일본 : (오전) 09:00 ~ 11:30, (오후) 12:30 ~ 15:00
3) 상해 : 10:30 ~ 16:00
4) 홍콩 : (오전) 10:30 ~ 13:00, (오후) 14:00 ~ 17:00

* 기존에는 내부통제 요건에 따라 상장주식수의 1%를 초과하는 주문은 접수할 수 없었으나, 2025.08.14 시행 이후부터는 접수가 가능합니다. 단, 타 매체(HTS 등)는 안내 팝업 확인 후 주문이 가능하지만, Open API는 별도의 안내 화면 없이 주문이 바로 접수되므로 유의하시기 바랍니다.


※ POST API의 경우 BODY값의 key값들을 대문자로 작성하셔야 합니다.
   (EX. "CANO" : "12345678", "ACNT_PRDT_CD": "01",...)

※ 종목코드 마스터파일 파이썬 정제코드는 한국투자증권 Github 참고 부탁드립니다.
   https://github.com/koreainvestment/open-trading-api/tree/main/stocks_info

### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| authorization | 접근토큰 | string | Y | OAuth 토큰이 필요한 API 경우 발급한 Access token 일반고객(Access token 유효기간 1일, OAuth 2.0의 Client Credentials Grant |
| appkey | 앱키  | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |
| personalseckey | 고객식별키 | string | N | [법인 필수] 제휴사 회원 관리를 위한 고객식별키 |
| tr_id | 거래ID | string | Y | [실전투자] TTTT1002U : 미국 매수 주문 TTTT1006U : 미국 매도 주문 TTTS0308U : 일본 매수 주문 TTTS0307U : 일본 매도 주문  TTTS0202 |
| tr_cont | 연속 거래 여부 | string | N | tr_cont를 이용한 다음조회 불가 API |
| custtype | 고객타입 | string | N | B : 법인 P : 개인 |
| seq_no | 일련번호 | string | N | [법인 필수] 001 |
| mac_address | 맥주소 | string | N | 법인고객 혹은 개인고객의 Mac address 값 |
| phone_number | 핸드폰번호 | string | N | [법인 필수] 제휴사APP을 사용하는 경우 사용자(회원) 핸드폰번호 ex) 01011112222 (하이픈 등 구분값 제거) |
| ip_addr | 접속 단말 공인 IP | string | N | [법인 필수] 사용자(회원)의 IP Address |
| gt_uid | Global UID | string | N | [법인 전용] 거래고유번호로 사용하므로 거래별로 UNIQUE해야 함 |

### Request Body

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| CANO | 종합계좌번호 | string | Y | 계좌번호 체계(8-2)의 앞 8자리 |
| ACNT_PRDT_CD | 계좌상품코드 | string | Y | 계좌번호 체계(8-2)의 뒤 2자리 |
| OVRS_EXCG_CD | 해외거래소코드 | string | Y | NASD : 나스닥 NYSE : 뉴욕 AMEX : 아멕스 SEHK : 홍콩 SHAA : 중국상해 SZAA : 중국심천 TKSE : 일본 HASE : 베트남 하노이 VNSE : 베트 |
| PDNO | 상품번호 | string | Y | 종목코드 |
| ORD_QTY | 주문수량 | string | Y | 주문수량 (해외거래소 별 최소 주문수량 및 주문단위 확인 필요) |
| OVRS_ORD_UNPR | 해외주문단가 | string | Y | 1주당 가격 * 시장가의 경우 1주당 가격을 공란으로 비우지 않음 "0"으로 입력 |
| CTAC_TLNO | 연락전화번호 | string | N |  |
| MGCO_APTM_ODNO | 운용사지정주문번호 | string | N |  |
| SLL_TYPE | 판매유형 | string | N | 제거 : 매수 00 : 매도 |
| ORD_SVR_DVSN_CD | 주문서버구분코드 | string | Y | "0"(Default) |
| ORD_DVSN | 주문구분 | string | Y | [Header tr_id TTTT1002U(미국 매수 주문)] 00 : 지정가 32 : LOO(장개시지정가) 34 : LOC(장마감지정가) 35 : TWAP (시간가중평균) 36  |
| START_TIME | 시작시간 | string | N | ※ TWAP, VWAP 주문유형이고 알고리즘주문시간구분코드가 00일때 사용 ※ YYMMDD 형태로 입력 ※ 시간 입력 시 정규장 종료 5분전까지 입력 가능 |
| END_TIME | 종료시간 | string | N | ※ TWAP, VWAP 주문유형이고 알고리즘주문시간구분코드가 00일때 사용 ※ YYMMDD 형태로 입력 ※ 시간 입력 시 정규장 종료 5분전까지 입력 가능 |
| ALGO_ORD_TMD_DVSN_CD | 알고리즘주문시간구분코드 | string | N | 00 : 분할주문 시간 직접입력 , 02 : 정규장 종료시까지 |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string | 0 : 성공  0 이외의 값 : 실패 |
| msg_cd | 응답코드 | string | 응답코드 |
| msg1 | 응답메세지 | string | 응답메세지 |
| output | 응답상세 | object |  |
| KRX_FWDG_ORD_ORGNO | 한국거래소전송주문조직번호 | string | 주문시 한국투자증권 시스템에서 지정된 영업점코드 |
| ODNO | 주문번호 | string | 주문시 한국투자증권 시스템에서 채번된 주문번호 |
| ORD_TMD | 주문시각 | string | 주문시각(시분초HHMMSS) |

### Request Example

```json
{
"CANO": "810XXXXX",
"ACNT_PRDT_CD": "01",
"OVRS_EXCG_CD": "NASD",
"PDNO": "AAPL",
"ORD_QTY": "1",
"OVRS_ORD_UNPR": "145.00",
"CTAC_TLNO": "",
"MGCO_APTM_ODNO": "",
"ORD_SVR_DVSN_CD": "0",
"ORD_DVSN": "00"
}
```

### Response Example

```json
{
  "rt_cd": "0",
  "msg_cd": "APBK0013",
  "msg1": "주문 전송 완료 되었습니다.",
  "output": {
    "KRX_FWDG_ORD_ORGNO": "01790",
    "ODNO": "0000004336",
    "ORD_TMD": "160524"
  }
}
```

---

## 해외주식 정정취소주문

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `(미국 정정·취소) TTTT1004U (아시아 국가 하단 규격서 참고)` |
| 모의 TR_ID | `(미국 정정·취소) VTTT1004U (아시아 국가 하단 규격서 참고)` |
| HTTP Method | `POST` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/uapi/overseas-stock/v1/trading/order-rvsecncl` |

### 개요

접수된 해외주식 주문을 정정하거나 취소하기 위한 API입니다.
(해외주식주문 시 Return 받은 ODNO를 참고하여 API를 호출하세요.)

* 해외주식 서비스 신청 후 이용 가능합니다. (아래 링크 3번 해외증권 거래신청 참고)
https://securities.koreainvestment.com/main/bond/research/_static/TF03ca010001.jsp

* 해외 거래소 운영시간 외 API 호출 시 에러가 발생하오니 운영시간을 확인해주세요.
* 해외 거래소 운영시간(한국시간 기준)
1) 미국 : 23:30 ~ 06:00 (썸머타임 적용 시 22:30 ~ 05:00) 
   * 프리마켓(18:00 ~ 23:30, Summer Time : 17:00 ~ 22:30), 애프터마켓(06:00 ~ 07:00, Summer Time : 05:00 ~ 07:00) 시간대에도 주문 가능
2) 일본 : (오전) 09:00 ~ 11:30, (오후) 12:30 ~ 15:00
3) 상해 : 10:30 ~ 16:00
4) 홍콩 : (오전) 10:30 ~ 13:00, (오후) 14:00 ~ 17:00

※ POST API의 경우 BODY값의 key값들을 대문자로 작성하셔야 합니다.
   (EX. "CANO" : "12345678", "ACNT_PRDT_CD": "01",...)


### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| authorization | 접근토큰 | string | Y | OAuth 토큰이 필요한 API 경우 발급한 Access token 일반고객(Access token 유효기간 1일, OAuth 2.0의 Client Credentials Grant |
| appkey | 앱키  | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |
| personalseckey | 고객식별키 | string | N | [법인 필수] 제휴사 회원 관리를 위한 고객식별키 |
| tr_id | 거래ID | string | Y | [실전투자] TTTT1004U : 미국 정정 취소 주문 TTTS1003U : 홍콩 정정 취소 주문 TTTS0309U : 일본 정정 취소 주문 TTTS0302U : 상해 취소 주문  |
| tr_cont | 연속 거래 여부 | string | N | tr_cont를 이용한 다음조회 불가 API |
| custtype | 고객타입 | string | N | B : 법인 P : 개인 |
| seq_no | 일련번호 | string | N | [법인 필수] 001 |
| mac_address | 맥주소 | string | N | 법인고객 혹은 개인고객의 Mac address 값 |
| phone_number | 핸드폰번호 | string | N | [법인 필수] 제휴사APP을 사용하는 경우 사용자(회원) 핸드폰번호 ex) 01011112222 (하이픈 등 구분값 제거) |
| ip_addr | 접속 단말 공인 IP | string | N | [법인 필수] 사용자(회원)의 IP Address |
| gt_uid | Global UID | string | N | [법인 전용] 거래고유번호로 사용하므로 거래별로 UNIQUE해야 함 |

### Request Body

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| CANO | 종합계좌번호 | string | Y | 계좌번호 체계(8-2)의 앞 8자리 |
| ACNT_PRDT_CD | 계좌상품코드 | string | Y | 계좌번호 체계(8-2)의 뒤 2자리 |
| OVRS_EXCG_CD | 해외거래소코드 | string | Y | NASD : 나스닥  NYSE : 뉴욕  AMEX : 아멕스 SEHK : 홍콩 SHAA : 중국상해 SZAA : 중국심천 TKSE : 일본 HASE : 베트남 하노이 VNSE :  |
| PDNO | 상품번호 | string | Y |  |
| ORGN_ODNO | 원주문번호 | string | Y | 정정 또는 취소할 원주문번호 (해외주식_주문 API ouput ODNO  or 해외주식 미체결내역 API output ODNO 참고) |
| RVSE_CNCL_DVSN_CD | 정정취소구분코드 | string | Y | 01 : 정정  02 : 취소 |
| ORD_QTY | 주문수량 | string | Y |   |
| OVRS_ORD_UNPR | 해외주문단가 | string | Y | 취소주문 시, "0" 입력 |
| MGCO_APTM_ODNO | 운용사지정주문번호 | string | N |  |
| ORD_SVR_DVSN_CD | 주문서버구분코드 | string | N | "0"(Default) |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string | 0 : 성공  0 이외의 값 : 실패 |
| msg_cd | 응답코드 | string | 응답코드 |
| msg1 | 응답메세지 | string | 응답메세지 |
| output | 응답상세 | object |  |
| KRX_FWDG_ORD_ORGNO | 한국거래소전송주문조직번호 | string | 주문시 한국투자증권 시스템에서 지정된 영업점코드 |
| ODNO | 주문번호 | string | 주문시 한국투자증권 시스템에서 채번된 주문번호 |
| ORD_TMD | 주문시각 | string | 주문시각(시분초HHMMSS) |

### Request Example

```json
{
"CANO": "810XXXXX",
"ACNT_PRDT_CD": "01",
"OVRS_EXCG_CD": "NYSE",
"PDNO": "BA",
"ORGN_ODNO": "30135009",
"RVSE_CNCL_DVSN_CD": "01",
"ORD_QTY": "1",
"OVRS_ORD_UNPR": "226.00",
"CTAC_TLNO": "",
"MGCO_APTM_ODNO": "",
"ORD_SVR_DVSN_CD": "0"
}
```

### Response Example

```json
{
  "rt_cd": "0",
  "msg_cd": "APBK0013",
  "msg1": "주문 전송 완료 되었습니다.",
  "output": {
    "KRX_FWDG_ORD_ORGNO": "01790",
    "ODNO": "0000004338",
    "ORD_TMD": "160710"
  }
}
```

---

## 해외주식 잔고

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `TTTS3012R` |
| 모의 TR_ID | `VTTS3012R` |
| HTTP Method | `GET` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/uapi/overseas-stock/v1/trading/inquire-balance` |

### 개요

해외주식 잔고를 조회하는 API 입니다.
한국투자 HTS(eFriend Plus) &gt; [7600] 해외주식 종합주문 화면의 좌측 하단 '실시간잔고' 기능을 API로 개발한 사항으로, 해당 화면을 참고하시면 기능을 이해하기 쉽습니다. 
다만 미국주간거래 가능종목에 대해서는 frcr_evlu_pfls_amt(외화평가손익금액), evlu_pfls_rt(평가손익율), ovrs_stck_evlu_amt(해외주식평가금액), now_pric2(현재가격2) 값이 HTS와는 상이하게 표출될 수 있습니다.
(주간시간 시간대에 HTS는 주간시세로 노출, API로는 야간시세로 노출)

실전계좌의 경우, 한 번의 호출에 최대 100건까지 확인 가능하며, 이후의 값은 연속조회를 통해 확인하실 수 있습니다. 

* 해외주식 서비스 신청 후 이용 가능합니다. (아래 링크 3번 해외증권 거래신청 참고)
https://securities.koreainvestment.com/main/bond/research/_static/TF03ca010001.jsp

* 미니스탁 잔고는 해당 API로 확인이 불가합니다.

### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| authorization | 접근토큰 | string | Y | OAuth 토큰이 필요한 API 경우 발급한 Access token 일반고객(Access token 유효기간 1일, OAuth 2.0의 Client Credentials Grant |
| appkey | 앱키  | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |
| personalseckey | 고객식별키 | string | N | [법인 필수] 제휴사 회원 관리를 위한 고객식별키 |
| tr_id | 거래ID | string | Y | [실전투자] TTTS3012R  [모의투자] VTTS3012R |
| tr_cont | 연속 거래 여부 | string | N | 공백 : 초기 조회 N : 다음 데이터 조회 (output header의 tr_cont가 M일 경우) |
| custtype | 고객타입 | string | N | B : 법인 P : 개인 |
| seq_no | 일련번호 | string | N | [법인 필수] 001 |
| mac_address | 맥주소 | string | N | 법인고객 혹은 개인고객의 Mac address 값 |
| phone_number | 핸드폰번호 | string | N | [법인 필수] 제휴사APP을 사용하는 경우 사용자(회원) 핸드폰번호 ex) 01011112222 (하이픈 등 구분값 제거) |
| ip_addr | 접속 단말 공인 IP | string | N | [법인 필수] 사용자(회원)의 IP Address |
| gt_uid | Global UID | string | N | [법인 전용] 거래고유번호로 사용하므로 거래별로 UNIQUE해야 함 |
| ACNT_PRDT_CD | 계좌상품코드 | string | Y | 계좌번호 체계(8-2)의 뒤 2자리 |
| OVRS_EXCG_CD | 해외거래소코드 | string | Y | [모의] NASD : 나스닥 NYSE : 뉴욕  AMEX : 아멕스  [실전] NASD : 미국전체 NAS : 나스닥 NYSE : 뉴욕  AMEX : 아멕스  [모의/실전 공통]  |
| TR_CRCY_CD | 거래통화코드 | string | Y | USD : 미국달러 HKD : 홍콩달러 CNY : 중국위안화 JPY : 일본엔화 VND : 베트남동 |
| CTX_AREA_FK200 | 연속조회검색조건200 | string | N | 공란 : 최초 조회시 이전 조회 Output CTX_AREA_FK200값 : 다음페이지 조회시(2번째부터) |
| CTX_AREA_NK200 | 연속조회키200 | string | N | 공란 : 최초 조회시 이전 조회 Output CTX_AREA_NK200값 : 다음페이지 조회시(2번째부터) |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string | 0 : 성공  0 이외의 값 : 실패 |
| msg_cd | 응답코드 | string | 응답코드 |
| msg1 | 응답메세지 | string | 응답메세지 |
| ctx_area_fk200 | 연속조회검색조건200 | string |  |
| ctx_area_nk200 | 연속조회키200 | string |  |
| output1 | 응답상세1 | array |  |
| cano | 종합계좌번호 | string | 계좌번호 체계(8-2)의 앞 8자리 |
| acnt_prdt_cd | 계좌상품코드 | string | 계좌상품코드 |
| prdt_type_cd | 상품유형코드 | string |  |
| ovrs_pdno | 해외상품번호 | string |  |
| ovrs_item_name | 해외종목명 | string |  |
| frcr_evlu_pfls_amt | 외화평가손익금액 | string | 해당 종목의 매입금액과 평가금액의 외회기준 비교 손익 |
| evlu_pfls_rt | 평가손익율 | string | 해당 종목의 평가손익을 기준으로 한 수익률 |
| pchs_avg_pric | 매입평균가격 | string | 해당 종목의 매수 평균 단가 |
| ovrs_cblc_qty | 해외잔고수량 | string |  |
| ord_psbl_qty | 주문가능수량 | string | 매도 가능한 주문 수량 |
| frcr_pchs_amt1 | 외화매입금액1 | string | 해당 종목의 외화 기준 매입금액 |
| ovrs_stck_evlu_amt | 해외주식평가금액 | string | 해당 종목의 외화 기준 평가금액 |
| now_pric2 | 현재가격2 | string | 해당 종목의 현재가 |
| tr_crcy_cd | 거래통화코드 | string | USD : 미국달러 HKD : 홍콩달러 CNY : 중국위안화 JPY : 일본엔화 VND : 베트남동 |
| ovrs_excg_cd | 해외거래소코드 | string | NASD : 나스닥 NYSE : 뉴욕 AMEX : 아멕스 SEHK : 홍콩 SHAA : 중국상해 SZAA : 중국심천 TKSE : 일본 HASE : 하노이거래소 VNSE : 호치민 |
| loan_type_cd | 대출유형코드 | string | 00 : 해당사항없음 01 : 자기융자일반형 03 : 자기융자투자형 05 : 유통융자일반형 06 : 유통융자투자형 07 : 자기대주 09 : 유통대주 10 : 현금 11 : 주식담 |
| loan_dt | 대출일자 | string | 대출 실행일자 |
| expd_dt | 만기일자 | string | 대출 만기일자 |
| output2 | 응답상세2 | object |  |
| frcr_pchs_amt1 | 외화매입금액1 | string |  |
| ovrs_rlzt_pfls_amt | 해외실현손익금액 | string |  |
| ovrs_tot_pfls | 해외총손익 | string |  |
| rlzt_erng_rt | 실현수익율 | string |  |
| tot_evlu_pfls_amt | 총평가손익금액 | string |  |
| tot_pftrt | 총수익률 | string |  |
| frcr_buy_amt_smtl1 | 외화매수금액합계1 | string |  |
| ovrs_rlzt_pfls_amt2 | 해외실현손익금액2 | string |  |
| frcr_buy_amt_smtl2 | 외화매수금액합계2 | string |  |

### Request Example

```json
{
"CANO": "810XXXXX",
"ACNT_PRDT_CD":"01",
"OVRS_EXCG_CD": "NASD",
"TR_CRCY_CD": "USD",
"CTX_AREA_FK200": "",
"CTX_AREA_NK200": ""
}
```

### Response Example

```json
{
  "ctx_area_fk200": "                                                                                                                                                                                                        ",
  "ctx_area_nk200": "                                                                                                                                                                                                        ",
  "output1": [
    {
      "cano": "810XXXXX",
      "acnt_prdt_cd": "01",
      "prdt_type_cd": "512",
      "ovrs_pdno": "TSLA",
      "ovrs_item_name": "테슬라",
      "frcr_evlu_pfls_amt": "-3547254.185235",
      "evlu_pfls_rt": "-81.75",
      "pchs_avg_pric": "5832.2148",
      "ovrs_cblc_qty": "744",
      "ord_psbl_qty": "744",
      "frcr_pchs_amt1": "4339167.78523",
      "ovrs_stck_evlu_amt": "791913.60000000",
      "now_pric2": "1064.400000",
      "tr_crcy_cd": "USD",
      "ovrs_excg_cd": "NASD",
      "loan_type_cd": "10",
      "loan_dt": "",
      "expd_dt": ""
    },
    {
      "cano": "",
      "acnt_prdt_cd": "",
      "prdt_type_cd": "",
      "ovrs_pdno": "",
      "ovrs_item_name": "",
      "frcr_evlu_pfls_amt": "0.000000",
      "evlu_pfls_rt": "0.00",
      "pchs_avg_pric": "0.0000",
      "ovrs_cblc_qty": "0",
      "ord_psbl_qty": "0",
      "frcr_pchs_amt1": "0.00000",
      "ovrs_stck_evlu_amt": "0.00000000",
      "now_pric2": "0.000000",
      "tr_crcy_cd": "",
      "ovrs_excg_cd": "",
      "loan_type_cd": "",
      "loan_dt": "",
      "expd_dt": ""
    }
  ],
  "output2": {
    "frcr_pchs_amt1": "4339167.78523",
    "ovrs_rlzt_pfls_amt": "-4836.71476",
    "ovrs_tot_pfls": "-3547254.18524",
    "rlzt_erng_rt": "-82.93101266",
    "tot_evlu_pfls_amt": "791913.60000000",
    "tot_pftrt": "-81.74964327",
    "frcr_buy_amt_smtl1": "5832.214765",
    "ovrs_rlzt_pfls_amt2": "-5780841.48713",
    "frcr_buy_amt_smtl2": "6970663.087128"
  },
  "rt_cd": "0",
  "msg_cd": "KIOK0510",
  "msg1": "조회가 완료되었습니다                                                           "
}
```

---

## 해외주식 미체결내역

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `TTTS3018R` |
| 모의 TR_ID | `모의투자 미지원` |
| HTTP Method | `GET` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `미지원` |
| URL 명 | `/uapi/overseas-stock/v1/trading/inquire-nccs` |

### 개요

접수된 해외주식 주문 중 체결되지 않은 미체결 내역을 조회하는 API입니다.
실전계좌의 경우, 한 번의 호출에 최대 40건까지 확인 가능하며, 이후의 값은 연속조회를 통해 확인하실 수 있습니다. 

※ 해외주식 미체결내역 API 모의투자에서는 사용이 불가합니다. 
   모의투자로 해외주식 미체결내역 확인시에는 해외주식 주문체결내역[v1_해외주식-007] API 조회하셔서 nccs_qty(미체결수량)으로 해외주식 미체결수량을 조회하실 수 있습니다.


* 해외주식 서비스 신청 후 이용 가능합니다. (아래 링크 3번 해외증권 거래신청 참고)
https://securities.koreainvestment.com/main/bond/research/_static/TF03ca010001.jsp

* 해외 거래소 운영시간(한국시간 기준)
1) 미국 : 23:30 ~ 06:00 (썸머타임 적용 시 22:30 ~ 05:00) 
   * 프리마켓(18:00 ~ 23:30, Summer Time : 17:00 ~ 22:30), 애프터마켓(06:00 ~ 07:00, Summer Time : 05:00 ~ 07:00)
2) 일본 : (오전) 09:00 ~ 11:30, (오후) 12:30 ~ 15:00
3) 상해 : 10:30 ~ 16:00
4) 홍콩 : (오전) 10:30 ~ 13:00, (오후) 14:00 ~ 17:00

### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| authorization | 접근토큰 | string | Y | OAuth 토큰이 필요한 API 경우 발급한 Access token 일반고객(Access token 유효기간 1일, OAuth 2.0의 Client Credentials Grant |
| appkey | 앱키  | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |
| personalseckey | 고객식별키 | string | N | [법인 필수] 제휴사 회원 관리를 위한 고객식별키 |
| tr_id | 거래ID | string | Y | [실전투자] TTTS3018R |
| tr_cont | 연속 거래 여부 | string | N | tr_cont를 이용한 다음조회 불가 API |
| custtype | 고객타입 | string | N | B : 법인 P : 개인 |
| seq_no | 일련번호 | string | N | [법인 필수] 001 |
| mac_address | 맥주소 | string | N | 법인고객 혹은 개인고객의 Mac address 값 |
| phone_number | 핸드폰번호 | string | N | [법인 필수] 제휴사APP을 사용하는 경우 사용자(회원) 핸드폰번호 ex) 01011112222 (하이픈 등 구분값 제거) |
| ip_addr | 접속 단말 공인 IP | string | N | [법인 필수] 사용자(회원)의 IP Address |
| gt_uid | Global UID | string | N | [법인 전용] 거래고유번호로 사용하므로 거래별로 UNIQUE해야 함 |
| ACNT_PRDT_CD | 계좌상품코드 | string | Y | 계좌번호 체계(8-2)의 뒤 2자리 |
| OVRS_EXCG_CD | 해외거래소코드 | string | Y | NASD : 나스닥 NYSE : 뉴욕  AMEX : 아멕스 SEHK : 홍콩 SHAA : 중국상해 SZAA : 중국심천 TKSE : 일본 HASE : 베트남 하노이 VNSE : 베 |
| SORT_SQN | 정렬순서 | string | Y | DS : 정순 그외 : 역순  [header tr_id: TTTS3018R] ""(공란) |
| CTX_AREA_FK200 | 연속조회검색조건200 | string | Y | 공란 : 최초 조회시 이전 조회 Output CTX_AREA_FK200값 : 다음페이지 조회시(2번째부터) |
| CTX_AREA_NK200 | 연속조회키200 | string | Y | 공란 : 최초 조회시 이전 조회 Output CTX_AREA_NK200값 : 다음페이지 조회시(2번째부터) |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string | 0 : 성공  0 이외의 값 : 실패 |
| msg_cd | 응답코드 | string | 응답코드 |
| msg1 | 응답메세지 | string | 응답메세지 |
| ctx_area_fk200 | 연속조회검색조건200 | string |  |
| ctx_area_nk200 | 연속조회키200 | string |  |
| output | 응답상세 | array |  |
| ord_dt | 주문일자 | string | 주문접수 일자 |
| ord_gno_brno | 주문채번지점번호 | string | 계좌 개설 시 관리점으로 선택한 영업점의 고유번호 |
| odno | 주문번호 | string | 접수한 주문의 일련번호 |
| orgn_odno | 원주문번호 | string | 정정 또는 취소 대상 주문의 일련번호 |
| pdno | 상품번호 | string | 종목코드 |
| prdt_name | 상품명 | string | 종목명 |
| sll_buy_dvsn_cd | 매도매수구분코드 | string | 01 : 매도 02 : 매수 |
| sll_buy_dvsn_cd_name | 매도매수구분코드명 | string | 매수매도구분명 |
| rvse_cncl_dvsn_cd | 정정취소구분코드 | string | 01 : 정정 02 : 취소 |
| rvse_cncl_dvsn_cd_name | 정정취소구분코드명 | string | 정정취소구분명 |
| rjct_rson | 거부사유 | string | 정상 처리되지 못하고 거부된 주문의 사유 |
| rjct_rson_name | 거부사유명 | string | 정상 처리되지 못하고 거부된 주문의 사유명 |
| ord_tmd | 주문시각 | string | 주문 접수 시간  |
| tr_mket_name | 거래시장명 | string |   |
| tr_crcy_cd | 거래통화코드 | string | USD : 미국달러 HKD : 홍콩달러 CNY : 중국위안화 JPY : 일본엔화 VND : 베트남동 |
| natn_cd | 국가코드 | string |   |
| natn_kor_name | 국가한글명 | string |   |
| ft_ord_qty | FT주문수량 | string | 주문수량 |
| ft_ccld_qty | FT체결수량 | string | 체결된 수량 |
| nccs_qty | 미체결수량 | string | 미체결수량 |
| ft_ord_unpr3 | FT주문단가3 | string | 주문가격 |
| ft_ccld_unpr3 | FT체결단가3 | string | 체결된 가격 |
| ft_ccld_amt3 | FT체결금액3 | string | 체결된 금액 |
| ovrs_excg_cd | 해외거래소코드 | string | NASD : 나스닥 NYSE : 뉴욕 AMEX : 아멕스 SEHK : 홍콩 SHAA : 중국상해 SZAA : 중국심천 TKSE : 일본 HASE : 베트남 하노이 VNSE : 베트 |
| prcs_stat_name | 처리상태명 | string | "" |
| loan_type_cd | 대출유형코드 | string | 00 해당사항없음 01 자기융자일반형 03 자기융자투자형 05 유통융자일반형 06 유통융자투자형 07 자기대주 09 유통대주 10 현금 11 주식담보대출 12 수익증권담보대출 13 |
| loan_dt | 대출일자 | string | 대출 실행일자 |
| usa_amk_exts_rqst_yn | 미국애프터마켓연장신청여부 | string | Y/N |
| splt_buy_attr_name | 분할매수속성명 | string | 정규장 종료 주문 시에는 '정규장 종료', 시간 입력 시에는 from ~ to 시간 표시됨 |

### Request Example

```json
{
"CANO": "810XXXXX",
"ACNT_PRDT_CD":"01",
"OVRS_EXCG_CD": "NYSE",
"SORT_SQN": "DS",
"CTX_AREA_FK200": "",
"CTX_AREA_NK200": ""
}
```

### Response Example

```json
{
  "ctx_area_fk200": "81055689^01^NYSE^DS^                                                                                                                                                                                    ",
  "ctx_area_nk200": "                                                                                                                                                                                                        ",
  "output": [
    {
      "ord_dt": "20220112",
      "ord_gno_brno": "01790",
      "odno": "0030138112",
      "orgn_odno": "",
      "pdno": "BA",
      "prdt_name": "보잉",
      "sll_buy_dvsn_cd": "02",
      "sll_buy_dvsn_cd_name": "매수",
      "rvse_cncl_dvsn_cd": "00",
      "rvse_cncl_dvsn_cd_name": "",
      "rjct_rson": "",
      "rjct_rson_name": "",
      "ord_tmd": "163209",
      "tr_mket_name": "뉴욕거래소",
      "tr_crcy_cd": "USD",
      "natn_cd": "840",
      "natn_kor_name": "미국",
      "ft_ord_qty": "1",
      "ft_ccld_qty": "0",
      "nccs_qty": "1",
      "ft_ord_unpr3": "200.00000000",
      "ft_ccld_unpr3": "0.00000000",
      "ft_ccld_amt3": "0.00000",
      "ovrs_excg_cd": "NYSE",
      "prcs_stat_name": "",
      "loan_type_cd": "10",
      "loan_dt": ""
    },
    {
      "ord_dt": "20220112",
      "ord_gno_brno": "01790",
      "odno": "0030138113",
      "orgn_odno": "",
      "pdno": "BA",
      "prdt_name": "보잉",
      "sll_buy_dvsn_cd": "02",
      "sll_buy_dvsn_cd_name": "매수",
      "rvse_cncl_dvsn_cd": "00",
      "rvse_cncl_dvsn_cd_name": "",
      "rjct_rson": "",
      "rjct_rson_name": "",
      "ord_tmd": "163211",
      "tr_mket_name": "뉴욕거래소",
      "tr_crcy_cd": "USD",
      "natn_cd": "840",
      "natn_kor_name": "미국",
      "ft_ord_qty": "1",
      "ft_ccld_qty": "0",
      "nccs_qty": "1",
      "ft_ord_unpr3": "200.00000000",
      "ft_ccld_unpr3": "0.00000000",
      "ft_ccld_amt3": "0.00000",
      "ovrs_excg_cd": "NYSE",
      "prcs_stat_name": "",
      "loan_type_cd": "10",
      "loan_dt": "",
      "loan_dt": ""
    }
  ],
  "rt_cd": "0",
  "msg_cd": "KIOK0510",
  "msg1": "조회가 완료되었습니다                                                           "
}
```

---

## 해외주식 주문체결내역

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `TTTS3035R` |
| 모의 TR_ID | `VTTS3035R` |
| HTTP Method | `GET` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/uapi/overseas-stock/v1/trading/inquire-ccnl` |

### 개요

일정 기간의 해외주식 주문 체결 내역을 확인하는 API입니다.
실전계좌의 경우, 한 번의 호출에 최대 20건까지 확인 가능하며, 이후의 값은 연속조회를 통해 확인하실 수 있습니다. 
모의계좌의 경우, 한 번의 호출에 최대 15건까지 확인 가능하며, 이후의 값은 연속조회를 통해 확인하실 수 있습니다. 

* 해외주식 서비스 신청 후 이용 가능합니다. (아래 링크 3번 해외증권 거래신청 참고)
https://securities.koreainvestment.com/main/bond/research/_static/TF03ca010001.jsp


* 해외 거래소 운영시간(한국시간 기준)
1) 미국 : 23:30 ~ 06:00 (썸머타임 적용 시 22:30 ~ 05:00) 
   * 프리마켓(18:00 ~ 23:30, Summer Time : 17:00 ~ 22:30), 애프터마켓(06:00 ~ 07:00, Summer Time : 05:00 ~ 07:00)
2) 일본 : (오전) 09:00 ~ 11:30, (오후) 12:30 ~ 15:00
3) 상해 : 10:30 ~ 16:00
4) 홍콩 : (오전) 10:30 ~ 13:00, (오후) 14:00 ~ 17:00

### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| authorization | 접근토큰 | string | Y | OAuth 토큰이 필요한 API 경우 발급한 Access token 일반고객(Access token 유효기간 1일, OAuth 2.0의 Client Credentials Grant |
| appkey | 앱키  | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |
| personalseckey | 고객식별키 | string | N | [법인 필수] 제휴사 회원 관리를 위한 고객식별키 |
| tr_id | 거래ID | string | Y | [실전투자] TTTS3035R  [모의투자] VTTS3035R |
| tr_cont | 연속 거래 여부 | string | N | 공백 : 초기 조회 N : 다음 데이터 조회 (output header의 tr_cont가 M일 경우) |
| custtype | 고객타입 | string | N | B : 법인 P : 개인 |
| seq_no | 일련번호 | string | N | [법인 필수] 001 |
| mac_address | 맥주소 | string | N | 법인고객 혹은 개인고객의 Mac address 값 |
| phone_number | 핸드폰번호 | string | N | [법인 필수] 제휴사APP을 사용하는 경우 사용자(회원) 핸드폰번호 ex) 01011112222 (하이픈 등 구분값 제거) |
| ip_addr | 접속 단말 공인 IP | string | N | [법인 필수] 사용자(회원)의 IP Address |
| gt_uid | Global UID | string | N | [법인 전용] 거래고유번호로 사용하므로 거래별로 UNIQUE해야 함 |
| ACNT_PRDT_CD | 계좌상품코드 | string | Y | 계좌번호 체계(8-2)의 뒤 2자리 |
| PDNO | 상품번호 | string | Y | 전종목일 경우 "%" 입력 ※ 모의투자계좌의 경우 ""(전체 조회)만 가능 |
| ORD_STRT_DT | 주문시작일자 | string | Y |  YYYYMMDD 형식 (현지시각 기준) |
| ORD_END_DT | 주문종료일자 | string | Y |  YYYYMMDD 형식 (현지시각 기준) |
| SLL_BUY_DVSN | 매도매수구분 | string | Y | 00 : 전체  01 : 매도  02 : 매수 ※ 모의투자계좌의 경우 "00"(전체 조회)만 가능 |
| CCLD_NCCS_DVSN | 체결미체결구분 | string | Y | 00 : 전체  01 : 체결  02 : 미체결 ※ 모의투자계좌의 경우 "00"(전체 조회)만 가능 |
| OVRS_EXCG_CD | 해외거래소코드 | string | Y | 전종목일 경우 "%" 입력 NASD : 미국시장 전체(나스닥, 뉴욕, 아멕스) NYSE : 뉴욕 AMEX : 아멕스 SEHK : 홍콩  SHAA : 중국상해 SZAA : 중국심천  |
| SORT_SQN | 정렬순서 | string | Y | DS : 정순 AS : 역순  ※ 모의투자계좌의 경우 정렬순서 사용불가(Default : DS(정순)) |
| ORD_DT | 주문일자 | string | Y | "" (Null 값 설정) |
| ORD_GNO_BRNO | 주문채번지점번호 | string | Y | "" (Null 값 설정) |
| ODNO | 주문번호 | string | Y | "" (Null 값 설정) ※ 주문번호로 검색 불가능합니다. 반드시 ""(Null 값 설정) 바랍니다. |
| CTX_AREA_NK200 | 연속조회키200 | string | Y | 공란 : 최초 조회시 이전 조회 Output CTX_AREA_NK200값 : 다음페이지 조회시(2번째부터) |
| CTX_AREA_FK200 | 연속조회검색조건200 | string | Y | 공란 : 최초 조회시 이전 조회 Output CTX_AREA_FK200값 : 다음페이지 조회시(2번째부터) |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string | 0 : 성공  0 이외의 값 : 실패 |
| msg_cd | 응답코드 | string | 응답코드 |
| msg1 | 응답메세지 | string | 응답메세지 |
| ctx_area_fk200 | 연속조회검색조건200 | string |  |
| ctx_area_nk200 | 연속조회키200 | string |  |
| output | 응답상세 | array |  |
| ord_dt | 주문일자 | string | 주문접수 일자 (현지시각 기준) |
| ord_gno_brno | 주문채번지점번호 | string | 계좌 개설 시 관리점으로 선택한 영업점의 고유번호 |
| odno | 주문번호 | string | 접수한 주문의 일련번호 ※ 정정취소주문 시, 해당 값 odno(주문번호) 넣어서 사용 |
| orgn_odno | 원주문번호 | string | 정정 또는 취소 대상 주문의 일련번호 |
| sll_buy_dvsn_cd | 매도매수구분코드 | string | 01 : 매도  02 : 매수 |
| sll_buy_dvsn_cd_name | 매도매수구분코드명 | string |  |
| rvse_cncl_dvsn | 정정취소구분 | string | 01 : 정정  02 : 취소  |
| rvse_cncl_dvsn_name | 정정취소구분명 | string |  |
| pdno | 상품번호 | string |  |
| prdt_name | 상품명 | string |  |
| ft_ord_qty | FT주문수량 | string | 주문수량 |
| ft_ord_unpr3 | FT주문단가3 | string | 주문가격 |
| ft_ccld_qty | FT체결수량 | string | 체결된 수량 |
| ft_ccld_unpr3 | FT체결단가3 | string | 체결된 가격 |
| ft_ccld_amt3 | FT체결금액3 | string | 체결된 금액 |
| nccs_qty | 미체결수량 | string | 미체결수량 |
| prcs_stat_name | 처리상태명 | string | 완료, 거부, 전송 |
| rjct_rson | 거부사유 | string | 정상 처리되지 못하고 거부된 주문의 사유 |
| rjct_rson_name | 거부사유명 | string |  |
| ord_tmd | 주문시각 | string | 주문 접수 시간  |
| tr_mket_name | 거래시장명 | string |   |
| tr_natn | 거래국가 | string |   |
| tr_natn_name | 거래국가명 | string |   |
| ovrs_excg_cd | 해외거래소코드 | string | NASD : 나스닥 NYSE : 뉴욕 AMEX : 아멕스 SEHK : 홍콩  SHAA : 중국상해 SZAA : 중국심천 TKSE : 일본 HASE : 베트남 하노이 VNSE : 베 |
| tr_crcy_cd | 거래통화코드 | string |   |
| dmst_ord_dt | 국내주문일자 | string |  |
| thco_ord_tmd | 당사주문시각 | string |  |
| loan_type_cd | 대출유형코드 | string | 00 : 해당사항없음 01 : 자기융자일반형 03 : 자기융자투자형 05 : 유통융자일반형 06 : 유통융자투자형 07 : 자기대주 09 : 유통대주 10 : 현금 11 : 주식담 |
| loan_dt | 대출일자 | string |  |
| mdia_dvsn_name | 매체구분명 | string | ex) OpenAPI, 모바일 |
| usa_amk_exts_rqst_yn | 미국애프터마켓연장신청여부 | string | Y/N |
| splt_buy_attr_name | 분할매수/매도속성명 | string | 정규장 종료 주문 시에는 '정규장 종료', 시간 입력 시에는 from ~ to 시간 표시 |

### Request Example

```json
{
	"CANO": "810XXXXX",
	"ACNT_PRDT_CD":"01",
	"PDNO": ""%,
	"ORD_STRT_DT": "20211027",
	"ORD_END_DT": "20211027",
	"SLL_BUY_DVSN": "00",
	"CCLD_NCCS_DVSN": "00",
	"OVRS_EXCG_CD": "%",
	"SORT_SQN": "DS",
	"ORD_DT": "",
	"ORD_GNO_BRNO":"02111",
	"ODNO": "",
	"CTX_AREA_NK200": "",
	"CTX_AREA_FK200": ""
}
```

### Response Example

```json
{
  "ctx_area_nk200": "                                                                                                                                                                                                        ",
  "ctx_area_fk200": "12345678^01^^20211027^20211027^00^00^NASD^^                                                                                                                                                             ",
  "output": {
      "ord_dt": "",
      "ord_gno_brno": "",
      "odno": "",
      "orgn_odno": "",
      "sll_buy_dvsn_cd": "",
      "sll_buy_dvsn_cd_name": "",
      "rvse_cncl_dvsn": "",
      "rvse_cncl_dvsn_name": "",
      "pdno": "",
      "prdt_name": "",
      "ft_ord_qty": "0",
      "ft_ord_unpr3": "0.00000000",
      "ft_ccld_qty": "0",
      "ft_ccld_unpr3": "0.00000000",
      "ft_ccld_amt3": "0.00000",
      "nccs_qty": "0",
      "prcs_stat_name": "",
      "rjct_rson": "",
      "rjct_rson_name": "",
      "ord_tmd": "",
      "tr_mket_name": "",
      "tr_natn": "",
      "tr_natn_name": "",
      "ovrs_excg_cd": "",
      "tr_crcy_cd": "",
      "dmst_ord_dt": "",
      "thco_ord_tmd": "",
      "loan_type_cd": "",
      "loan_dt": "",
      "mdia_dvsn_name": "OpenAPI",
      "usa_amk_exts_rqst_yn": "N",
      "splt_buy_attr_name": "00:00~04:00"    },
  "rt_cd": "0",
  "msg_cd": "KIOK0560",
  "msg1": "조회할 내용이 없습니다                                                          "
}
```

---

## 해외주식 매수가능금액조회

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `TTTS3007R` |
| 모의 TR_ID | `VTTS3007R` |
| HTTP Method | `GET` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/uapi/overseas-stock/v1/trading/inquire-psamount` |

### 개요

해외주식 매수가능금액조회 API입니다.

* 해외주식 서비스 신청 후 이용 가능합니다. (아래 링크 3번 해외증권 거래신청 참고)
https://securities.koreainvestment.com/main/bond/research/_static/TF03ca010001.jsp

### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| authorization | 접근토큰 | string | Y | OAuth 토큰이 필요한 API 경우 발급한 Access token  일반고객(Access token 유효기간 1일, OAuth 2.0의 Client Credentials Gran |
| appkey | 앱키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| personalseckey | 고객식별키 | string | N | [법인 필수] 제휴사 회원 관리를 위한 고객식별키 |
| tr_id | 거래ID | string | Y | [실전투자] TTTS3007R  [모의투자] VTTS3007R |
| tr_cont | 연속 거래 여부 | string | N | tr_cont를 이용한 다음조회 불가 API |
| custtype | 고객 타입 | string | N | B : 법인 / P : 개인 |
| seq_no | 일련번호 | string | N | 법인 : "001" / 개인: ""(Default) |
| mac_address | 맥주소 | string | N | 법인고객 혹은 개인고객의 Mac address 값 |
| phone_number | 핸드폰번호 | string | N | [법인 필수] 제휴사APP을 사용하는 경우 사용자(회원) 핸드폰번호  ex) 01011112222 (하이픈 등 구분값 제거) |
| ip_addr | 접속 단말 공인 IP | string | N | [법인 필수] 사용자(회원)의 IP Address |
| gt_uid | Global UID | string | N | [법인 전용] 거래고유번호로 사용하므로 거래별로 UNIQUE해야 함 |
| ACNT_PRDT_CD | 계좌상품코드 | string | Y | 계좌번호 체계(8-2)의 뒤 2자리 |
| OVRS_EXCG_CD | 해외거래소코드 | string | Y | NASD : 나스닥 / NYSE : 뉴욕 / AMEX : 아멕스 SEHK : 홍콩 / SHAA : 중국상해 / SZAA : 중국심천 TKSE : 일본 / HASE : 하노이거래소  |
| OVRS_ORD_UNPR | 해외주문단가 | string | Y | 해외주문단가 (23.8) 정수부분 23자리, 소수부분 8자리 |
| ITEM_CD | 종목코드 | string | Y | 종목코드 |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string |   |
| msg_cd | 응답코드 | string |   |
| msg1 | 응답메세지 | string |   |
| output | 응답상세1 | object |   |
| tr_crcy_cd | 거래통화코드 | string | 18.2 |
| ord_psbl_frcr_amt | 주문가능외화금액 | string | 18.2 |
| sll_ruse_psbl_amt | 매도재사용가능금액 | string | 가능금액 산정 시 사용 |
| ovrs_ord_psbl_amt | 해외주문가능금액 | string | - 한국투자 앱 해외주식 주문화면내 "외화" 인경우 주문가능금액  |
| max_ord_psbl_qty | 최대주문가능수량 | string | - 한국투자 앱 해외주식 주문화면내 "외화" 인경우 주문가능수량 - 매수 시 수량단위 절사해서 사용     예 : (100주단위) 545 주 -> 500 주 / (10주단위) 54 |
| echm_af_ord_psbl_amt | 환전이후주문가능금액 | string | 사용되지 않는 사항(0으로 출력) |
| echm_af_ord_psbl_qty | 환전이후주문가능수량 | string | 사용되지 않는 사항(0으로 출력) |
| ord_psbl_qty | 주문가능수량 | string | 22(20.1) |
| exrt | 환율 | string | 25(18.6) |
| frcr_ord_psbl_amt1 | 외화주문가능금액1 | string | - 한국투자 앱 해외주식 주문화면내 "통합" 인경우 주문가능금액 |
| ovrs_max_ord_psbl_qty | 해외최대주문가능수량 | string | - 한국투자 앱 해외주식 주문화면내 "통합" 인경우 주문가능수량 - 매수 시 수량단위 절사해서 사용     예 : (100주단위) 545 주 -> 500 주 / (10주단위) 54 |

### Request Example

```json
        "input": {
            "ACNT_PRDT_CD": "01",
            "CANO": "81019777",
            "ITEM_CD": "00011",
            "OVRS_EXCG_CD": "SEHK",
            "OVRS_ORD_UNPR": "133.200"
        }
```

### Response Example

```json
        "output": {
            "echm_af_ord_psbl_amt": "0.00",
            "echm_af_ord_psbl_qty": "0",
            "exrt": "165.5400000000",
            "frcr_ord_psbl_amt1": "955**.12",
            "max_ord_psbl_qty": "744**",
            "ord_psbl_frcr_amt": "999**.52",
            "ord_psbl_qty": "744**",
            "ovrs_max_ord_psbl_qty": "717**",
            "ovrs_ord_psbl_amt": "992**.35",
            "sll_ruse_psbl_amt": "0.00",
            "tr_crcy_cd": "HKD"
        }
```

---

## 해외주식 현재체결가

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `HHDFS00000300` |
| 모의 TR_ID | `HHDFS00000300` |
| HTTP Method | `GET` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/uapi/overseas-price/v1/quotations/price` |

### 개요

해외주식종목의 현재체결가를 확인하는 API 입니다.

해외주식 시세는 무료시세(지연체결가)만이 제공되며, API로는 유료시세(실시간체결가)를 받아보실 수 없습니다.

※ 지연시세 지연시간 : 미국 - 실시간무료(0분지연) / 홍콩, 베트남, 중국, 일본 - 15분지연 (중국은 실시간시세 신청 시 무료실시간시세 제공)
   미국의 경우 0분지연시세로 제공되나, 장중 당일 시가는 상이할 수 있으며, 익일 정정 표시됩니다.

※ 2024년 12월 13일(금) 오후 5시부터 HTS(efriend Plus) [7781] 시세신청(실시간) 화면에서 유료 서비스 신청 후 접근토큰 발급하면 최대 2시간 이후 실시간 유료 시세 수신 가능

※ 미국주식 시세의 경우 주간거래시간을 제외한 정규장, 애프터마켓, 프리마켓 시간대에 동일한 API(TR)로 시세 조회가 되는 점 유의 부탁드립니다.

해당 API로 미국주간거래(10:00~16:00) 시세 조회도 가능합니다. 
※ 미국주간거래 시세 조회 시, EXCD(거래소코드)를 다음과 같이 입력 → 나스닥: BAQ, 뉴욕: BAY, 아멕스: BAA

※ 종목코드 마스터파일 파이썬 정제코드는 한국투자증권 Github 참고 부탁드립니다.
   https://github.com/koreainvestment/open-trading-api/tree/main/stocks_info

[미국주식시세 이용시 유의사항]
■ 무료 실시간 시세 서비스가 기본 제공되며, 유료 실시간 시세 서비스는 HTS ‘[7781] 시세신청 (실시간)’과 MTS(모바일) ‘고객서비스 &gt; 거래 서비스신청 &gt; 해외주식 &gt; 해외 실시간시세 신청’ 에서 신청 가능합니다. 
※ 무료(매수/매도 각 1호가) : 나스닥 마켓센터에서 거래되는 호가 및 호가 잔량 정보
※ 유료(매수/매도 각 1호가) : 미국 전체 거래소들의 통합 주문체결 및 최우선 호가
■ 무료 실시간 시세 서비스는 유료 실시간 시세 서비스 대비 평균 50% 수준에 해당하는 정보이므로 
현재가/호가/순간체결량/차트 등에서 일시적·부분적 차이가 있을 수 있습니다. 
■ 무료∙유료 모두 미국에 상장된 종목(뉴욕, 나스닥, 아멕스 등)의 시세를 제공하며, 동일한 시스템을 사용하여 주문∙체결됩니다. 
단, 무료∙유료의 기반 데이터 차이로 호가 및 체결 데이터는 차이가 발생할 수 있고, 이로 인해 발생하는 손실에 대해서 당사가 책임지지 않습니다.
■ 무료 실시간 시세 서비스의 시가, 저가, 고가, 종가는 유료 실시간 시세 서비스와 다를 수 있으며, 
종목별 과거 데이터(거래량, 시가, 종가, 고가, 차트 데이터 등)는 장 종료 후(오후 12시경) 유료 실시간 시세 서비스 데이터와 동일하게 업데이트됩니다.
■ 유료 실시간 시세 서비스는 신청 시 1~12개월까지 기간 선택 후 해당 요금을 일괄 납부하며, 
해지 시 해지한 달의 말일까지 시세 제공 후 남은 기간 해당 금액이 환급되니 유의하시기 바랍니다.
(출처: 한국투자증권 외화증권 거래설명서 - https://www.truefriend.com/main/customer/guide/Guide.jsp?&cmd=TF04ag010002&currentPage=1&num=64)

### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| authorization | 접근토큰 | string | Y | OAuth 토큰이 필요한 API 경우 발급한 Access token 일반고객(Access token 유효기간 1일, OAuth 2.0의 Client Credentials Grant |
| appkey | 앱키  | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |
| personalseckey | 고객식별키 | string | N | [법인 필수] 제휴사 회원 관리를 위한 고객식별키 |
| tr_id | 거래ID | string | Y | [실전투자/모의투자] HHDFS00000300 |
| tr_cont | 연속 거래 여부 | string | N | tr_cont를 이용한 다음조회 불가 API |
| custtype | 고객타입 | string | N | B : 법인 P : 개인 |
| seq_no | 일련번호 | string | N | [법인 필수] 001 |
| mac_address | 맥주소 | string | N | 법인고객 혹은 개인고객의 Mac address 값 |
| phone_number | 핸드폰번호 | string | N | [법인 필수] 제휴사APP을 사용하는 경우 사용자(회원) 핸드폰번호 ex) 01011112222 (하이픈 등 구분값 제거) |
| ip_addr | 접속 단말 공인 IP | string | N | [법인 필수] 사용자(회원)의 IP Address |
| gt_uid | Global UID | string | N | [법인 전용] 거래고유번호로 사용하므로 거래별로 UNIQUE해야 함 |
| EXCD | 거래소코드 | string | Y | HKS : 홍콩 NYS : 뉴욕 NAS : 나스닥 AMS : 아멕스 TSE : 도쿄 SHS : 상해 SZS : 심천 SHI : 상해지수 SZI : 심천지수 HSX : 호치민 HNX |
| SYMB | 종목코드 | string | Y |  |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string | 0 : 성공  0 이외의 값 : 실패 |
| msg_cd | 응답코드 | string | 응답코드 |
| msg1 | 응답메세지 | string | 응답메세지 |
| output | 응답상세 | object |  |
| rsym | 실시간조회종목코드 | string | D+시장구분(3자리)+종목코드 예) DNASAAPL : D+NAS(나스닥)+AAPL(애플) [시장구분] NYS : 뉴욕, NAS : 나스닥, AMS : 아멕스 , TSE : 도쿄, |
| zdiv | 소수점자리수 | string |  |
| base | 전일종가 | string | 전일의 종가 |
| pvol | 전일거래량 | string | 전일의 거래량 |
| last | 현재가 | string | 당일 조회시점의 현재 가격 |
| sign | 대비기호 | string | 1 : 상한 2 : 상승 3 : 보합 4 : 하한 5 : 하락 |
| diff | 대비 | string | 전일 종가와 당일 현재가의 차이 (당일 현재가-전일 종가) |
| rate | 등락율 | string | 전일 대비 / 당일 현재가 * 100 |
| tvol | 거래량 | string | 당일 조회시점까지 전체 거래량 |
| tamt | 거래대금 | string | 당일 조회시점까지 전체 거래금액 |
| ordy | 매수가능여부 | string | 매수주문 가능 종목 여부 |

### Request Example

```json
{
"AUTH": "",
"EXCD": "NAS",
"SYMB": "TSLA"
}
```

### Response Example

```json
{
  "output": {
    "rsym": "DNASTSLA",
    "zdiv": "4",
    "base": "1091.2600",
    "pvol": "26691673",
    "last": "1091.2600",
    "sign": "0",
    "diff": "0.0000",
    "rate": " 0.00",
    "tvol": "0",
    "tamt": "0",
    "ordy": "매도불가"
  },
  "rt_cd": "0",
  "msg_cd": "MCA00000",
  "msg1": "정상처리 되었습니다."
}
```

---

## 해외주식 기간별시세

### 기본 정보

| 항목 | 값 |
|------|----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `HHDFS76240000` |
| 모의 TR_ID | `HHDFS76240000` |
| HTTP Method | `GET` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| 모의 Domain | `https://openapivts.koreainvestment.com:29443` |
| URL 명 | `/uapi/overseas-price/v1/quotations/dailyprice` |

### 개요

해외주식의 기간별시세를 확인하는 API 입니다.
실전계좌/모의계좌의 경우, 한 번의 호출에 최대 100건까지 확인 가능합니다.

해외주식 시세는 무료시세(지연체결가)만이 제공되며, API로는 유료시세(실시간체결가)를 받아보실 수 없습니다.

※ 지연시세 지연시간 : 미국 - 실시간무료(0분지연) / 홍콩, 베트남, 중국, 일본 - 15분지연 (중국은 실시간시세 신청 시 무료실시간시세 제공)
   미국의 경우 0분지연시세로 제공되나, 장중 당일 시가는 상이할 수 있으며, 익일 정정 표시됩니다.

※ 2024년 12월 13일(금) 오후 5시부터 HTS(efriend Plus) [7781] 시세신청(실시간) 화면에서 유료 서비스 신청 후 접근토큰 발급하면 최대 2시간 이후 실시간 유료 시세 수신 가능

※ 당사 미국주식 주간거래는 별도 일봉을 제공하지 않고 당일 시세만 제공하고 있습니다.

[미국주식시세 이용시 유의사항]
■ 무료 실시간 시세 서비스가 기본 제공되며, 유료 실시간 시세 서비스는 HTS ‘[7781] 시세신청 (실시간)’과 MTS(모바일) ‘고객서비스 &gt; 거래 서비스신청 &gt; 해외주식 &gt; 해외 실시간시세 신청’ 에서 신청 가능합니다. 
※ 무료(매수/매도 각 1호가) : 나스닥 마켓센터에서 거래되는 호가 및 호가 잔량 정보
※ 유료(매수/매도 각 1호가) : 미국 전체 거래소들의 통합 주문체결 및 최우선 호가
■ 무료 실시간 시세 서비스는 유료 실시간 시세 서비스 대비 평균 50% 수준에 해당하는 정보이므로 
현재가/호가/순간체결량/차트 등에서 일시적·부분적 차이가 있을 수 있습니다. 
■ 무료∙유료 모두 미국에 상장된 종목(뉴욕, 나스닥, 아멕스 등)의 시세를 제공하며, 동일한 시스템을 사용하여 주문∙체결됩니다. 
단, 무료∙유료의 기반 데이터 차이로 호가 및 체결 데이터는 차이가 발생할 수 있고, 이로 인해 발생하는 손실에 대해서 당사가 책임지지 않습니다.
■ 무료 실시간 시세 서비스의 시가, 저가, 고가, 종가는 유료 실시간 시세 서비스와 다를 수 있으며, 
종목별 과거 데이터(거래량, 시가, 종가, 고가, 차트 데이터 등)는 장 종료 후(오후 12시경) 유료 실시간 시세 서비스 데이터와 동일하게 업데이트됩니다.
■ 유료 실시간 시세 서비스는 신청 시 1~12개월까지 기간 선택 후 해당 요금을 일괄 납부하며, 
해지 시 해지한 달의 말일까지 시세 제공 후 남은 기간 해당 금액이 환급되니 유의하시기 바랍니다.
(출처: 한국투자증권 외화증권 거래설명서 - https://www.truefriend.com/main/customer/guide/Guide.jsp?&cmd=TF04ag010002&currentPage=1&num=64)

### Request Header

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| authorization | 접근토큰 | string | Y | OAuth 토큰이 필요한 API 경우 발급한 Access token 일반고객(Access token 유효기간 1일, OAuth 2.0의 Client Credentials Grant |
| appkey | 앱키  | string | Y | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | string | Y | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |
| personalseckey | 고객식별키 | string | N | [법인 필수] 제휴사 회원 관리를 위한 고객식별키 |
| tr_id | 거래ID | string | Y | [실전투자/모의투자] HHDFS76240000 |
| tr_cont | 연속 거래 여부 | string | N | tr_cont를 이용한 다음조회 불가 API |
| custtype | 고객타입 | string | N | B : 법인 P : 개인 |
| seq_no | 일련번호 | string | N | [법인 필수] 001 |
| mac_address | 맥주소 | string | N | 법인고객 혹은 개인고객의 Mac address 값 |
| phone_number | 핸드폰번호 | string | N | [법인 필수] 제휴사APP을 사용하는 경우 사용자(회원) 핸드폰번호 ex) 01011112222 (하이픈 등 구분값 제거) |
| ip_addr | 접속 단말 공인 IP | string | N | [법인 필수] 사용자(회원)의 IP Address |
| gt_uid | Global UID | string | N | [법인 전용] 거래고유번호로 사용하므로 거래별로 UNIQUE해야 함 |
| EXCD | 거래소코드 | string | Y | HKS : 홍콩 NYS : 뉴욕 NAS : 나스닥 AMS : 아멕스 TSE : 도쿄 SHS : 상해 SZS : 심천 SHI : 상해지수 SZI : 심천지수 HSX : 호치민 HNX |
| SYMB | 종목코드 | string | Y | 종목코드 (ex. TSLA) |
| GUBN | 일/주/월구분 | string | Y | 0 : 일 1 : 주 2 : 월 |
| BYMD | 조회기준일자 | string | Y | 조회기준일자(YYYYMMDD) ※ 공란 설정 시, 기준일 오늘 날짜로 설정 |
| MODP | 수정주가반영여부 | string | Y | 0 : 미반영 1 : 반영 |
| KEYB | NEXT KEY BUFF | string | N | 응답시 다음값이 있으면 값이 셋팅되어 있으므로 다음 조회시 응답값 그대로 셋팅 |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string | 0 : 성공  0 이외의 값 : 실패 |
| msg_cd | 응답코드 | string | 응답코드 |
| msg1 | 응답메세지 | string | 응답메세지 |
| output1 | 응답상세1 | object |  |
| rsym | 실시간조회종목코드 | string | D+시장구분(3자리)+종목코드 예) DNASAAPL : D+NAS(나스닥)+AAPL(애플) [시장구분] NYS : 뉴욕, NAS : 나스닥, AMS : 아멕스 , TSE : 도쿄, |
| zdiv | 소수점자리수 | string |  |
| nrec | 전일종가 | string |  |
| output2 | 응답상세2 | object array |  |
| xymd | 일자(YYYYMMDD) | string |   |
| clos | 종가 | string | 해당 일자의 종가 |
| sign | 대비기호 | string | 1 : 상한 2 : 상승 3 : 보합 4 : 하한 5 : 하락 |
| diff | 대비 | string | 해당 일자의 종가와 해당 전일 종가의 차이 (해당일 종가-해당 전일 종가) |
| rate | 등락율 | string | 해당 전일 대비 / 해당일 종가 * 100 |
| open | 시가 | string | 해당일 최초 거래가격 |
| high | 고가 | string | 해당일 가장 높은 거래가격 |
| low | 저가 | string | 해당일 가장 낮은 거래가격 |
| tvol | 거래량 | string | 해당일 거래량 |
| tamt | 거래대금 | string | 해당일 거래대금 |
| pbid | 매수호가 | string | 마지막 체결이 발생한 시점의 매수호가 * 해당 일자 거래량 0인 경우 값이 수신되지 않음 |
| vbid | 매수호가잔량 | string | * 해당 일자 거래량 0인 경우 값이 수신되지 않음 |
| pask | 매도호가 | string | 마지막 체결이 발생한 시점의 매도호가 * 해당 일자 거래량 0인 경우 값이 수신되지 않음 |
| vask | 매도호가잔량 | string | * 해당 일자 거래량 0인 경우 값이 수신되지 않음 |

### Request Example

```json
{
"AUTH": "",
"EXCD": "NAS",
"SYMB": "TSLA",
"GUBN": "0",
"BYMD": "",
"MODP": "0"
}
```

### Response Example

```json
{
  "output1": {
    "rsym": "DNASTSLA",
    "zdiv": "4",
    "nrec": "100"
  },
  "output2": [
    {
      "xymd": "20220406",
      "clos": "1045.7600",
      "sign": "5",
      "diff": "45.5000",
      "rate": "-4.17",
      "open": "1073.4700",
      "high": "1079.0000",
      "low": "1027.7000",
      "tvol": "29782845",
      "tamt": "31190274312",
      "pbid": "1042.8900",
      "vbid": "7",
      "pask": "1043.2200",
      "vask": "1"
    },
    {
      "xymd": "20220405",
      "clos": "1091.2600",
      "sign": "5",
      "diff": "54.1900",
      "rate": "-4.73",
      "open": "1136.3000",
      "high": "1152.8700",
      "low": "1087.3000",
      "tvol": "26691673",
      "tamt": "29742125077",
      "pbid": "1090.0000",
      "vbid": "100",
      "pask": "1090.5000",
      "vask": "100"
    },
    {
      "xymd": "20220404",
      "clos": "1145.4500",
      "sign": "2",
      "diff": "60.8600",
      "rate": "+5.61",
      "open": "1089.3800",
      "high": "1149.9100",
      "low": "1072.5300",
      "tvol": "27392567",
      "tamt": "30743176589",
      "pbid": "1143.3000",
      "vbid": "300",
      "pask": "1143.6000",
      "vask": "100"
    },
    {
      "xymd": "20220401",
      "clos": "1084.5900",
      "sign": "2",
      "diff": "6.9900",
      "rate": "+0.65",
      "open": "1081.1500",
      "high": "1094.7500",
      "low": "1066.6400",
      "tvol": "18087741",
      "tamt": "19558845872",
      "pbid": "1090.0100",
      "vbid": "100",
      "pask": "1090.7500",
      "vask": "100"
    },
    {
      "xymd": "20220331",
      "clos": "1077.6000",
      "sign": "5",
      "diff": "16.3900",
      "rate": "-1.50",
      "open": "1094.5700",
      "high": "1103.1399",
      "low": "1076.6410",
      "tvol": "16330919",
      "tamt": "17799070958",
      "pbid": "1079.2900",
      "vbid": "100",
      "pask": "1079.8000",
      "vask": "400"
    },
    {
      "xymd": "20220330",
      "clos": "1093.9900",
      "sign": "5",
      "diff": "5.5800",
      "rate": "-0.51",
      "open": "1091.1700",
      "high": "1113.9500",
      "low": "1084.0000",
      "tvol": "19955002",
      "tamt": "21921529520",
      "pbid": "1095.0100",
      "vbid": "1000",
      "pask": "1095.4900",
      "vask": "100"
    },
    {
      "xymd": "20220329",
      "clos": "1099.5700",
      "sign": "2",
      "diff": "7.7300",
      "rate": "+0.71",
      "open": "1107.9900",
      "high": "1114.7700",
      "low": "1073.1100",
      "tvol": "24538273",
      "tamt": "26908896769",
      "pbid": "1096.0000",
      "vbid": "700",
      "pask": "1096.8800",
      "vask": "700"
    },
    {
      "xymd": "20220328",
      "clos": "1091.8400",
      "sign": "2",
      "diff": "81.2000",
      "rate": "+8.03",
      "open": "1065.1000",
      "high": "1097.8799",
      "low": "1053.6000",
      "tvol": "34168693",
      "tamt": "36935543398",
      "pbid": "1094.3000",
      "vbid": "500",
      "pask": "1094.7500",
      "vask": "100"
    },
    {
      "xymd": "20220325",
      "clos": "1010.6400",
      "sign": "5",
      "diff": "3.2800",
      "rate": "-0.32",
      "open": "1008.0000",
      "high": "1021.7999",
      "low": "997.3201",
      "tvol": "20677182",
      "tamt": "20833543456",
      "pbid": "1010.6000",
      "vbid": "300",
      "pask": "1011.5000",
      "vask": "200"
    },
    {
      "xymd": "20220324",
      "clos": "1013.9200",
      "sign": "2",
      "diff": "14.8100",
      "rate": "+1.48",
      "open": "1009.7300",
      "high": "1024.4900",
      "low": "988.8000",
      "tvol": "22973626",
      "tamt": "23177427182",
      "pbid": "1011.8500",
      "vbid": "100",
      "pask": "1012.0000",
      "vask": "1800"
    },
    {
      "xymd": "20220323",
      "clos": "999.1100",
      "sign": "2",
      "diff": "5.1300",
      "rate": "+0.52",
      "open": "979.9400",
      "high": "1040.7000",
      "low": "976.4000",
      "tvol": "40225383",
      "tamt": "40613152436",
      "pbid": "994.4100",
      "vbid": "300",
      "pask": "995.0000",
      "vask": "100"
    },
    {
      "xymd": "20220322",
      "clos": "993.9800",
      "sign": "2",
      "diff": "72.8200",
      "rate": "+7.91",
      "open": "930.0000",
      "high": "997.8600",
      "low": "921.7500",
      "tvol": "35289519",
      "tamt": "33994169075",
      "pbid": "986.5000",
      "vbid": "300",
      "pask": "987.0000",
      "vask": "200"
    },
    {
      "xymd": "20220321",
      "clos": "921.1600",
      "sign": "2",
      "diff": "15.7700",
      "rate": "+1.74",
      "open": "914.9800",
      "high": "942.8500",
      "low": "907.0900",
      "tvol": "27327216",
      "tamt": "25211905771",
      "pbid": "922.7000",
      "vbid": "400",
      "pask": "923.2000",
      "vask": "500"
    },
    {
      "xymd": "20220318",
      "clos": "905.3900",
      "sign": "2",
      "diff": "33.7900",
      "rate": "+3.88",
      "open": "874.4900",
      "high": "907.8500",
      "low": "867.3900",
      "tvol": "33471397",
      "tamt": "30178912165",
      "pbid": "904.5000",
      "vbid": "300",
      "pask": "905.2500",
      "vask": "300"
    },
    {
      "xymd": "20220317",
      "clos": "871.6000",
      "sign": "2",
      "diff": "31.3700",
      "rate": "+3.73",
      "open": "830.9900",
      "high": "875.0000",
      "low": "825.7178",
      "tvol": "22194324",
      "tamt": "19011422979",
      "pbid": "867.2100",
      "vbid": "100",
      "pask": "868.0400",
      "vask": "100"
    },
    {
      "xymd": "20220316",
      "clos": "840.2300",
      "sign": "2",
      "diff": "38.3400",
      "rate": "+4.78",
      "open": "809.0000",
      "high": "842.0000",
      "low": "802.2601",
      "tvol": "28009607",
      "tamt": "23198872371",
      "pbid": "841.9500",
      "vbid": "100",
      "pask": "842.5000",
      "vask": "300"
    },
    {
      "xymd": "20220315",
      "clos": "801.8900",
      "sign": "2",
      "diff": "35.5200",
      "rate": "+4.63",
      "open": "775.2700",
      "high": "805.5700",
      "low": "756.5700",
      "tvol": "22280381",
      "tamt": "17560285765",
      "pbid": "801.0000",
      "vbid": "200",
      "pask": "801.8000",
      "vask": "500"
    },
    {
      "xymd": "20220314",
      "clos": "766.3700",
      "sign": "5",
      "diff": "28.9800",
      "rate": "-3.64",
      "open": "780.6100",
      "high": "800.7000",
      "low": "756.0400",
      "tvol": "23717421",
      "tamt": "18350554191",
      "pbid": "762.5100",
      "vbid": "100",
      "pask": "763.6900",
      "vask": "100"
    },
    {
      "xymd": "20220311",
      "clos": "795.3500",
      "sign": "5",
      "diff": "42.9500",
      "rate": "-5.12",
      "open": "840.1970",
      "high": "843.8020",
      "low": "793.7700",
      "tvol": "22345722",
      "tamt": "18076185507",
      "pbid": "794.6000",
      "vbid": "100",
      "pask": "794.9900",
      "vask": "200"
    },
    {
      "xymd": "20220310",
      "clos": "838.3000",
      "sign": "5",
      "diff": "20.6700",
      "rate": "-2.41",
      "open": "851.4500",
      "high": "854.4500",
      "low": "810.3601",
      "tvol": "19549548",
      "tamt": "16229710911",
      "pbid": "836.2000",
      "vbid": "800",
      "pask": "836.5000",
      "vask": "200"
    },
    {
      "xymd": "20220309",
      "clos": "858.9700",
      "sign": "2",
      "diff": "34.5700",
      "rate": "+4.19",
      "open": "839.4800",
      "high": "860.5600",
      "low": "832.0100",
      "tvol": "19727993",
      "tamt": "16782318027",
      "pbid": "860.1000",
      "vbid": "200",
      "pask": "860.5000",
      "vask": "100"
    },
    {
      "xymd": "20220308",
      "clos": "824.4000",
      "sign": "2",
      "diff": "19.8200",
      "rate": "+2.46",
      "open": "795.5300",
      "high": "849.9900",
      "low": "782.1700",
      "tvol": "26799702",
      "tamt": "22014058629",
      "pbid": "819.5900",
      "vbid": "100",
      "pask": "820.8500",
      "vask": "100"
    },
    {
      "xymd": "20220307",
      "clos": "804.5800",
      "sign": "5",
      "diff": "33.7100",
      "rate": "-4.02",
      "open": "856.3000",
      "high": "866.1400",
      "low": "804.5700",
      "tvol": "24164724",
      "tamt": "20086515519",
      "pbid": "798.7500",
      "vbid": "500",
      "pask": "799.5700",
      "vask": "500"
    },
    {
      "xymd": "20220304",
      "clos": "838.2900",
      "sign": "5",
      "diff": "1.0000",
      "rate": "-0.12",
      "open": "849.1000",
      "high": "855.6500",
      "low": "825.1609",
      "tvol": "22393287",
      "tamt": "18802769433",
      "pbid": "837.5000",
      "vbid": "200",
      "pask": "837.8600",
      "vask": "200"
    },
    {
      "xymd": "20220303",
      "clos": "839.2900",
      "sign": "5",
      "diff": "40.6000",
      "rate": "-4.61",
      "open": "878.7700",
      "high": "886.4390",
      "low": "832.6001",
      "tvol": "20541169",
      "tamt": "17565872720",
      "pbid": "843.6500",
      "vbid": "100",
      "pask": "844.1500",
      "vask": "100"
    },
    {
      "xymd": "20220302",
      "clos": "879.8900",
      "sign": "2",
      "diff": "15.5200",
      "rate": "+1.80",
      "open": "872.1300",
      "high": "886.4800",
      "low": "844.2721",
      "tvol": "24881146",
      "tamt": "21649806528",
      "pbid": "871.0500",
      "vbid": "100",
      "pask": "871.9900",
      "vask": "300"
    },
    {
      "xymd": "20220301",
      "clos": "864.3700",
      "sign": "5",
      "diff": "6.0600",
      "rate": "-0.70",
      "open": "869.6800",
      "high": "889.8800",
      "low": "853.7800",
      "tvol": "24922287",
      "tamt": "21622906438",
      "pbid": "861.5700",
      "vbid": "100",
      "pask": "862.3700",
      "vask": "2500"
    },
    {
      "xymd": "20220228",
      "clos": "870.4300",
      "sign": "2",
      "diff": "60.5600",
      "rate": "+7.48",
      "open": "815.0100",
      "high": "876.8600",
      "low": "814.7075",
      "tvol": "33002289",
      "tamt": "28246358471",
      "pbid": "870.0800",
      "vbid": "500",
      "pask": "870.4800",
      "vask": "100"
    },
    {
      "xymd": "20220225",
      "clos": "809.8700",
      "sign": "2",
      "diff": "9.1000",
      "rate": "+1.14",
      "open": "809.2300",
      "high": "819.5000",
      "low": "782.4005",
      "tvol": "25355921",
      "tamt": "20339391276",
      "pbid": "809.9500",
      "vbid": "200",
      "pask": "810.0000",
      "vask": "500"
    },
    {
      "xymd": "20220224",
      "clos": "800.7700",
      "sign": "2",
      "diff": "36.7300",
      "rate": "+4.81",
      "open": "700.3900",
      "high": "802.4800",
      "low": "700.0000",
      "tvol": "45107425",
      "tamt": "34166549623",
      "pbid": "798.4500",
      "vbid": "100",
      "pask": "799.0000",
      "vask": "100"
    },
    {
      "xymd": "20220223",
      "clos": "764.0400",
      "sign": "5",
      "diff": "57.4900",
      "rate": "-7.00",
      "open": "830.4300",
      "high": "835.2997",
      "low": "760.5600",
      "tvol": "31752336",
      "tamt": "25094325267",
      "pbid": "757.3000",
      "vbid": "100",
      "pask": "757.8000",
      "vask": "200"
    },
    {
      "xymd": "20220222",
      "clos": "821.5300",
      "sign": "5",
      "diff": "35.4500",
      "rate": "-4.14",
      "open": "834.1300",
      "high": "856.7338",
      "low": "801.1001",
      "tvol": "27762734",
      "tamt": "23190823879",
      "pbid": "823.0000",
      "vbid": "100",
      "pask": "824.0800",
      "vask": "100"
    },
    {
      "xymd": "20220218",
      "clos": "856.9800",
      "sign": "5",
      "diff": "19.3700",
      "rate": "-2.21",
      "open": "886.0000",
      "high": "886.8700",
      "low": "837.6100",
      "tvol": "22833947",
      "tamt": "19556715049",
      "pbid": "854.8300",
      "vbid": "100",
      "pask": "854.9300",
      "vask": "100"
    },
    {
      "xymd": "20220217",
      "clos": "876.3500",
      "sign": "5",
      "diff": "47.0400",
      "rate": "-5.09",
      "open": "913.2600",
      "high": "918.4999",
      "low": "874.1000",
      "tvol": "18392806",
      "tamt": "16381253397",
      "pbid": "874.0500",
      "vbid": "100",
      "pask": "874.9000",
      "vask": "100"
    },
    {
      "xymd": "20220216",
      "clos": "923.3900",
      "sign": "2",
      "diff": "0.9600",
      "rate": "+0.10",
      "open": "914.0500",
      "high": "926.4299",
      "low": "901.2100",
      "tvol": "17098132",
      "tamt": "15630459694",
      "pbid": "919.6000",
      "vbid": "100",
      "pask": "919.9900",
      "vask": "100"
    },
    {
      "xymd": "20220215",
      "clos": "922.4300",
      "sign": "2",
      "diff": "46.6700",
      "rate": "+5.33",
      "open": "900.0000",
      "high": "923.0000",
      "low": "893.3774",
      "tvol": "19216514",
      "tamt": "17583891909",
      "pbid": "919.9000",
      "vbid": "100",
      "pask": "920.2000",
      "vask": "100"
    },
    {
      "xymd": "20220214",
      "clos": "875.7600",
      "sign": "2",
      "diff": "15.7600",
      "rate": "+1.83",
      "open": "861.5700",
      "high": "898.8799",
      "low": "853.1500",
      "tvol": "22585472",
      "tamt": "19771806435",
      "pbid": "874.2200",
      "vbid": "100",
      "pask": "874.9000",
      "vask": "100"
    },
    {
      "xymd": "20220211",
      "clos": "860.0000",
      "sign": "5",
      "diff": "44.5500",
      "rate": "-4.93",
      "open": "909.6300",
      "high": "915.9600",
      "low": "850.7000",
      "tvol": "26548623",
      "tamt": "23354363403",
      "pbid": "860.3100",
      "vbid": "200",
      "pask": "860.7900",
      "vask": "100"
    },
    {
      "xymd": "20220210",
      "clos": "904.5500",
      "sign": "5",
      "diff": "27.4500",
      "rate": "-2.95",
      "open": "908.3700",
      "high": "943.8100",
      "low": "896.7000",
      "tvol": "22042277",
      "tamt": "20302484250",
      "pbid": "903.1400",
      "vbid": "100",
      "pask": "903.9800",
      "vask": "100"
    },
    {
      "xymd": "20220209",
      "clos": "932.0000",
      "sign": "2",
      "diff": "10.0000",
      "rate": "+1.08",
      "open": "935.0000",
      "high": "946.2699",
      "low": "920.0000",
      "tvol": "17419848",
      "tamt": "16264353533",
      "pbid": "932.6100",
      "vbid": "200",
      "pask": "933.0000",
      "vask": "300"
    },
    {
      "xymd": "20220208",
      "clos": "922.0000",
      "sign": "2",
      "diff": "14.6600",
      "rate": "+1.62",
      "open": "905.5300",
      "high": "926.2899",
      "low": "894.8000",
      "tvol": "16909671",
      "tamt": "15469715617",
      "pbid": "921.7500",
      "vbid": "100",
      "pask": "922.2500",
      "vask": "100"
    },
    {
      "xymd": "20220207",
      "clos": "907.3400",
      "sign": "5",
      "diff": "15.9800",
      "rate": "-1.73",
      "open": "923.7900",
      "high": "947.7700",
      "low": "902.7089",
      "tvol": "20331488",
      "tamt": "18757045232",
      "pbid": "908.7000",
      "vbid": "100",
      "pask": "909.0000",
      "vask": "300"
    },
    {
      "xymd": "20220204",
      "clos": "923.3200",
      "sign": "2",
      "diff": "32.1800",
      "rate": "+3.61",
      "open": "897.2200",
      "high": "936.5000",
      "low": "881.1700",
      "tvol": "24541822",
      "tamt": "22445587121",
      "pbid": "921.5000",
      "vbid": "1200",
      "pask": "922.0000",
      "vask": "100"
    },
    {
      "xymd": "20220203",
      "clos": "891.1400",
      "sign": "5",
      "diff": "14.5200",
      "rate": "-1.60",
      "open": "882.0000",
      "high": "937.0000",
      "low": "880.5200",
      "tvol": "26285186",
      "tamt": "23895432177",
      "pbid": "906.5000",
      "vbid": "100",
      "pask": "907.3900",
      "vask": "100"
    },
    {
      "xymd": "20220202",
      "clos": "905.6600",
      "sign": "5",
      "diff": "25.5900",
      "rate": "-2.75",
      "open": "928.1800",
      "high": "931.5000",
      "low": "889.4100",
      "tvol": "22264345",
      "tamt": "20251309655",
      "pbid": "887.5000",
      "vbid": "100",
      "pask": "888.0000",
      "vask": "300"
    },
    {
      "xymd": "20220201",
      "clos": "931.2500",
      "sign": "5",
      "diff": "5.4700",
      "rate": "-0.58",
      "open": "935.2100",
      "high": "943.7000",
      "low": "905.0000",
      "tvol": "24379446",
      "tamt": "22603049750",
      "pbid": "934.4000",
      "vbid": "300",
      "pask": "934.9900",
      "vask": "100"
    },
    {
      "xymd": "20220131",
      "clos": "936.7200",
      "sign": "2",
      "diff": "90.3700",
      "rate": "+10.68",
      "open": "872.7100",
      "high": "937.9900",
      "low": "862.0500",
      "tvol": "34812032",
      "tamt": "31796186854",
      "pbid": "934.5000",
      "vbid": "1000",
      "pask": "934.9700",
      "vask": "100"
    },
    {
      "xymd": "20220128",
      "clos": "846.3500",
      "sign": "2",
      "diff": "17.2500",
      "rate": "+2.08",
      "open": "831.5600",
      "high": "857.5000",
      "low": "792.0100",
      "tvol": "44929650",
      "tamt": "37312553843",
      "pbid": "847.6600",
      "vbid": "100",
      "pask": "848.4000",
      "vask": "100"
    },
    {
      "xymd": "20220127",
      "clos": "829.1000",
      "sign": "5",
      "diff": "108.3100",
      "rate": "-11.55",
      "open": "933.3600",
      "high": "935.3900",
      "low": "829.0000",
      "tvol": "49036523",
      "tamt": "42522912142",
      "pbid": "837.6200",
      "vbid": "200",
      "pask": "838.5000",
      "vask": "100"
    },
    {
      "xymd": "20220126",
      "clos": "937.4100",
      "sign": "2",
      "diff": "19.0100",
      "rate": "+2.07",
      "open": "952.4300",
      "high": "987.6900",
      "low": "906.0000",
      "tvol": "34955761",
      "tamt": "33134684349",
      "pbid": "932.5500",
      "vbid": "100",
      "pask": "933.5000",
      "vask": "100"
    },
    {
      "xymd": "20220125",
      "clos": "918.4000",
      "sign": "5",
      "diff": "11.6000",
      "rate": "-1.25",
      "open": "914.2000",
      "high": "951.2600",
      "low": "903.2100",
      "tvol": "28865302",
      "tamt": "26613334628",
      "pbid": "903.0000",
      "vbid": "400",
      "pask": "903.5500",
      "vask": "100"
    },
    {
      "xymd": "20220124",
      "clos": "930.0000",
      "sign": "5",
      "diff": "13.9000",
      "rate": "-1.47",
      "open": "904.7600",
      "high": "933.5131",
      "low": "851.4700",
      "tvol": "50791714",
      "tamt": "45100773316",
      "pbid": "926.2500",
      "vbid": "500",
      "pask": "926.6500",
      "vask": "100"
    },
    {
      "xymd": "20220121",
      "clos": "943.9000",
      "sign": "5",
      "diff": "52.3700",
      "rate": "-5.26",
      "open": "996.3400",
      "high": "1004.5500",
      "low": "940.5000",
      "tvol": "34472009",
      "tamt": "33231719767",
      "pbid": "939.8000",
      "vbid": "100",
      "pask": "940.0000",
      "vask": "500"
    },
    {
      "xymd": "20220120",
      "clos": "996.2700",
      "sign": "2",
      "diff": "0.6200",
      "rate": "+0.06",
      "open": "1009.7300",
      "high": "1041.6600",
      "low": "994.0000",
      "tvol": "23496248",
      "tamt": "23944890598",
      "pbid": "989.9900",
      "vbid": "200",
      "pask": "991.5000",
      "vask": "100"
    },
    {
      "xymd": "20220119",
      "clos": "995.6500",
      "sign": "5",
      "diff": "34.8600",
      "rate": "-3.38",
      "open": "1041.7050",
      "high": "1054.6699",
      "low": "995.0000",
      "tvol": "25147496",
      "tamt": "25534130239",
      "pbid": "993.5100",
      "vbid": "200",
      "pask": "994.0000",
      "vask": "700"
    },
    {
      "xymd": "20220118",
      "clos": "1030.5100",
      "sign": "5",
      "diff": "19.1000",
      "rate": "-1.82",
      "open": "1026.6050",
      "high": "1070.7899",
      "low": "1016.0600",
      "tvol": "22329803",
      "tamt": "23272387126",
      "pbid": "1031.0000",
      "vbid": "100",
      "pask": "1031.9500",
      "vask": "500"
    },
    {
      "xymd": "20220114",
      "clos": "1049.6100",
      "sign": "2",
      "diff": "18.0500",
      "rate": "+1.75",
      "open": "1019.8800",
      "high": "1052.0000",
      "low": "1013.3788",
      "tvol": "24308137",
      "tamt": "25162720831",
      "pbid": "1049.9200",
      "vbid": "100",
      "pask": "1050.0900",
      "vask": "200"
    },
    {
      "xymd": "20220113",
      "clos": "1031.5600",
      "sign": "5",
      "diff": "74.6600",
      "rate": "-6.75",
      "open": "1109.0650",
      "high": "1115.6000",
      "low": "1026.5391",
      "tvol": "32403264",
      "tamt": "34906936185",
      "pbid": "1034.1000",
      "vbid": "200",
      "pask": "1034.8400",
      "vask": "300"
    },
    {
      "xymd": "20220112",
      "clos": "1106.2200",
      "sign": "2",
      "diff": "41.8200",
      "rate": "+3.93",
      "open": "1078.8500",
      "high": "1114.8400",
      "low": "1072.5901",
      "tvol": "27913005",
      "tamt": "30590414517",
      "pbid": "1107.1300",
      "vbid": "100",
      "pask": "1107.7300",
      "vask": "200"
    },
    {
      "xymd": "20220111",
      "clos": "1064.4000",
      "sign": "2",
      "diff": "6.2800",
      "rate": "+0.59",
      "open": "1053.6700",
      "high": "1075.8500",
      "low": "1038.8200",
      "tvol": "22021070",
      "tamt": "23353565457",
      "pbid": "1060.5900",
      "vbid": "100",
      "pask": "1061.2800",
      "vask": "100"
    },
    {
      "xymd": "20220110",
      "clos": "1058.1200",
      "sign": "2",
      "diff": "31.1600",
      "rate": "+3.03",
      "open": "1000.0000",
      "high": "1059.1000",
      "low": "980.0000",
      "tvol": "30604959",
      "tamt": "31132010979",
      "pbid": "1061.1500",
      "vbid": "100",
      "pask": "1061.9300",
      "vask": "100"
    },
    {
      "xymd": "20220107",
      "clos": "1026.9600",
      "sign": "5",
      "diff": "37.7400",
      "rate": "-3.54",
      "open": "1080.3700",
      "high": "1080.9299",
      "low": "1010.0000",
      "tvol": "28054916",
      "tamt": "29158872307",
      "pbid": "1025.0000",
      "vbid": "300",
      "pask": "1025.2500",
      "vask": "300"
    },
    {
      "xymd": "20220106",
      "clos": "1064.7000",
      "sign": "5",
      "diff": "23.4200",
      "rate": "-2.15",
      "open": "1077.0000",
      "high": "1088.0000",
      "low": "1020.5000",
      "tvol": "30112158",
      "tamt": "31965624488",
      "pbid": "1066.7900",
      "vbid": "100",
      "pask": "1067.0000",
      "vask": "100"
    },
    {
      "xymd": "20220105",
      "clos": "1088.1200",
      "sign": "5",
      "diff": "61.4700",
      "rate": "-5.35",
      "open": "1146.6500",
      "high": "1170.3400",
      "low": "1081.0101",
      "tvol": "26706599",
      "tamt": "30187690088",
      "pbid": "1079.0000",
      "vbid": "200",
      "pask": "1079.9500",
      "vask": "200"
    },
    {
      "xymd": "20220104",
      "clos": "1149.5900",
      "sign": "5",
      "diff": "50.1900",
      "rate": "-4.18",
      "open": "1189.5500",
      "high": "1208.0000",
      "low": "1123.0500",
      "tvol": "33416086",
      "tamt": "38836082001",
      "pbid": "1147.5000",
      "vbid": "500",
      "pask": "1147.8900",
      "vask": "200"
    },
    {
      "xymd": "20220103",
      "clos": "1199.7800",
      "sign": "2",
      "diff": "143.0000",
      "rate": "+13.53",
      "open": "1147.7500",
      "high": "1201.0700",
      "low": "1136.0400",
      "tvol": "34895349",
      "tamt": "40850633547",
      "pbid": "1205.0200",
      "vbid": "100",
      "pask": "1205.4200",
      "vask": "200"
    },
    {
      "xymd": "20211231",
      "clos": "1056.7800",
      "sign": "5",
      "diff": "13.5600",
      "rate": "-1.27",
      "open": "1073.4444",
      "high": "1081.9999",
      "low": "1054.5900",
      "tvol": "13577875",
      "tamt": "14495135610",
      "pbid": "1060.0000",
      "vbid": "900",
      "pask": "1060.0500",
      "vask": "400"
    },
    {
      "xymd": "20211230",
      "clos": "1070.3400",
      "sign": "5",
      "diff": "15.8500",
      "rate": "-1.46",
      "open": "1061.3300",
      "high": "1095.5500",
      "low": "1053.1500",
      "tvol": "15680313",
      "tamt": "16895880951",
      "pbid": "1065.5100",
      "vbid": "100",
      "pask": "1066.0000",
      "vask": "100"
    },
    {
      "xymd": "20211229",
      "clos": "1086.1900",
      "sign": "5",
      "diff": "2.2800",
      "rate": "-0.21",
      "open": "1098.6400",
      "high": "1104.0000",
      "low": "1064.1400",
      "tvol": "18718015",
      "tamt": "20304732279",
      "pbid": "1082.6500",
      "vbid": "100",
      "pask": "1083.2500",
      "vask": "400"
    },
    {
      "xymd": "20211228",
      "clos": "1088.4700",
      "sign": "5",
      "diff": "5.4700",
      "rate": "-0.50",
      "open": "1109.4900",
      "high": "1118.9999",
      "low": "1078.4200",
      "tvol": "20107969",
      "tamt": "21985026462",
      "pbid": "1088.5000",
      "vbid": "200",
      "pask": "1089.2000",
      "vask": "200"
    },
    {
      "xymd": "20211227",
      "clos": "1093.9400",
      "sign": "2",
      "diff": "26.9400",
      "rate": "+2.52",
      "open": "1073.6700",
      "high": "1117.0000",
      "low": "1070.7152",
      "tvol": "23715273",
      "tamt": "26093712075",
      "pbid": "1095.0000",
      "vbid": "400",
      "pask": "1095.5000",
      "vask": "200"
    },
    {
      "xymd": "20211223",
      "clos": "1067.0000",
      "sign": "2",
      "diff": "58.1300",
      "rate": "+5.76",
      "open": "1006.8000",
      "high": "1072.9767",
      "low": "997.5600",
      "tvol": "30904429",
      "tamt": "32322659050",
      "pbid": "1065.1100",
      "vbid": "200",
      "pask": "1065.3800",
      "vask": "100"
    },
    {
      "xymd": "20211222",
      "clos": "1008.8700",
      "sign": "2",
      "diff": "70.3400",
      "rate": "+7.49",
      "open": "965.6600",
      "high": "1015.6599",
      "low": "957.0500",
      "tvol": "31211362",
      "tamt": "31022952137",
      "pbid": "1011.5500",
      "vbid": "400",
      "pask": "1011.8500",
      "vask": "100"
    },
    {
      "xymd": "20211221",
      "clos": "938.5300",
      "sign": "2",
      "diff": "38.5900",
      "rate": "+4.29",
      "open": "916.8700",
      "high": "939.5000",
      "low": "886.1200",
      "tvol": "23839305",
      "tamt": "21840827169",
      "pbid": "934.5600",
      "vbid": "100",
      "pask": "935.5000",
      "vask": "100"
    },
    {
      "xymd": "20211220",
      "clos": "899.9400",
      "sign": "5",
      "diff": "32.6300",
      "rate": "-3.50",
      "open": "910.7000",
      "high": "921.6884",
      "low": "893.3900",
      "tvol": "18826671",
      "tamt": "17012127943",
      "pbid": "901.5000",
      "vbid": "200",
      "pask": "902.4400",
      "vask": "100"
    },
    {
      "xymd": "20211217",
      "clos": "932.5700",
      "sign": "2",
      "diff": "5.6500",
      "rate": "+0.61",
      "open": "914.7700",
      "high": "960.6599",
      "low": "909.0401",
      "tvol": "33626754",
      "tamt": "31525298596",
      "pbid": "934.6000",
      "vbid": "100",
      "pask": "935.1200",
      "vask": "300"
    },
    {
      "xymd": "20211216",
      "clos": "926.9200",
      "sign": "5",
      "diff": "49.0700",
      "rate": "-5.03",
      "open": "994.5000",
      "high": "994.9800",
      "low": "921.8500",
      "tvol": "27590483",
      "tamt": "26096160964",
      "pbid": "926.1000",
      "vbid": "100",
      "pask": "926.5000",
      "vask": "1100"
    },
    {
      "xymd": "20211215",
      "clos": "975.9900",
      "sign": "2",
      "diff": "17.4800",
      "rate": "+1.82",
      "open": "953.2100",
      "high": "978.7499",
      "low": "928.2501",
      "tvol": "25056410",
      "tamt": "23881193367",
      "pbid": "975.9000",
      "vbid": "200",
      "pask": "976.2500",
      "vask": "100"
    },
    {
      "xymd": "20211214",
      "clos": "958.5100",
      "sign": "5",
      "diff": "7.9000",
      "rate": "-0.82",
      "open": "945.0000",
      "high": "966.4100",
      "low": "930.0000",
      "tvol": "23602090",
      "tamt": "22364807150",
      "pbid": "957.1000",
      "vbid": "100",
      "pask": "957.6500",
      "vask": "100"
    },
    {
      "xymd": "20211213",
      "clos": "966.4100",
      "sign": "5",
      "diff": "50.6200",
      "rate": "-4.98",
      "open": "1001.0900",
      "high": "1005.0000",
      "low": "951.4200",
      "tvol": "26198502",
      "tamt": "25425098410",
      "pbid": "963.6100",
      "vbid": "100",
      "pask": "964.3600",
      "vask": "200"
    },
    {
      "xymd": "20211210",
      "clos": "1017.0300",
      "sign": "2",
      "diff": "13.2300",
      "rate": "+1.32",
      "open": "1008.7500",
      "high": "1020.9797",
      "low": "982.5300",
      "tvol": "19888122",
      "tamt": "19981816818",
      "pbid": "1015.0000",
      "vbid": "900",
      "pask": "1015.5700",
      "vask": "100"
    },
    {
      "xymd": "20211209",
      "clos": "1003.8000",
      "sign": "5",
      "diff": "65.1600",
      "rate": "-6.10",
      "open": "1060.6400",
      "high": "1062.4900",
      "low": "1002.3600",
      "tvol": "19812832",
      "tamt": "20343865631",
      "pbid": "1005.5000",
      "vbid": "100",
      "pask": "1006.0000",
      "vask": "300"
    },
    {
      "xymd": "20211208",
      "clos": "1068.9600",
      "sign": "2",
      "diff": "17.2100",
      "rate": "+1.64",
      "open": "1052.7100",
      "high": "1072.3800",
      "low": "1033.0001",
      "tvol": "13968790",
      "tamt": "14723658662",
      "pbid": "1067.0000",
      "vbid": "100",
      "pask": "1067.9500",
      "vask": "100"
    },
    {
      "xymd": "20211207",
      "clos": "1051.7500",
      "sign": "2",
      "diff": "42.7400",
      "rate": "+4.24",
      "open": "1044.2000",
      "high": "1057.6739",
      "low": "1026.8100",
      "tvol": "18694857",
      "tamt": "19529382052",
      "pbid": "1054.6700",
      "vbid": "200",
      "pask": "1054.9000",
      "vask": "900"
    },
    {
      "xymd": "20211206",
      "clos": "1009.0100",
      "sign": "5",
      "diff": "5.9600",
      "rate": "-0.59",
      "open": "1001.5100",
      "high": "1021.6400",
      "low": "950.5000",
      "tvol": "27221037",
      "tamt": "26964573844",
      "pbid": "1007.6500",
      "vbid": "200",
      "pask": "1008.1100",
      "vask": "100"
    },
    {
      "xymd": "20211203",
      "clos": "1014.9700",
      "sign": "5",
      "diff": "69.6300",
      "rate": "-6.42",
      "open": "1084.7900",
      "high": "1090.5753",
      "low": "1000.2100",
      "tvol": "30773995",
      "tamt": "31668617672",
      "pbid": "1010.2600",
      "vbid": "200",
      "pask": "1011.0000",
      "vask": "200"
    },
    {
      "xymd": "20211202",
      "clos": "1084.6000",
      "sign": "5",
      "diff": "10.4000",
      "rate": "-0
```

---

# 기타

## 해외결제일자조회

### 기본 정보

| 항목 | 값 |
|------|-----|
| API 통신방식 | `REST` |
| 실전 TR_ID | `CTOS5011R` |
| 모의 TR_ID | 모의투자 미지원 |
| HTTP Method | `GET` |
| 실전 Domain | `https://openapi.koreainvestment.com:9443` |
| URL 명 | `/uapi/overseas-stock/v1/quotations/countries-holiday` |

### 개요

해외결제일자조회 API입니다. 특정 날짜의 해외 시장 영업일/휴장일 여부를 확인할 수 있습니다.
응답에 미국 시장 데이터가 포함되어 있으면 해당일은 영업일입니다.

> **MOC 대체 로직**: 이 API로 장 운영 여부 확인 후, 휴장일이면 주문 스킵.
> 영업일이면 현재가 -5% LOC 주문으로 MOC 대체.

### Request Query Parameter

| Element | 한글명 | Type | Required | Description |
|---------|--------|------|----------|-------------|
| TRAD_DT | 기준일자 | string | Y | 기준일자 (YYYYMMDD) |
| CTX_AREA_NK | 연속조회키 | string | Y | 공백 입력 |
| CTX_AREA_FK | 연속조회검색조건 | string | Y | 공백 입력 |

### Response Body

| Element | 한글명 | Type | Description |
|---------|--------|------|-------------|
| rt_cd | 성공 실패 여부 | string | 0: 성공 |
| output | 응답상세 | array | |
| prdt_type_cd | 상품유형코드 | string | 512: 나스닥, 513: 뉴욕, 529: 아멕스 |
| tr_natn_cd | 거래국가코드 | string | 840: 미국 |
| tr_natn_name | 거래국가명 | string | |
| tr_mket_name | 거래시장명 | string | 나스닥, 뉴욕거래소, 아멕스 |
| acpl_sttl_dt | 현지결제일자 | string | YYYYMMDD |
| dmst_sttl_dt | 국내결제일자 | string | YYYYMMDD |

### Request Example

```json
{
    "TRAD_DT": "20221227",
    "CTX_AREA_NK": "",
    "CTX_AREA_FK": ""
}
```

### Response Example

```json
{
    "output": [
        {
            "prdt_type_cd": "512",
            "tr_natn_cd": "840",
            "tr_natn_name": "미국",
            "tr_mket_cd": "01",
            "tr_mket_name": "나스닥",
            "acpl_sttl_dt": "20221229",
            "dmst_sttl_dt": "20221230"
        },
        {
            "prdt_type_cd": "513",
            "tr_natn_cd": "840",
            "tr_natn_name": "미국",
            "tr_mket_cd": "02",
            "tr_mket_name": "뉴욕거래소",
            "acpl_sttl_dt": "20221229",
            "dmst_sttl_dt": "20221230"
        }
    ],
    "rt_cd": "0",
    "msg_cd": "KIOK0460",
    "msg1": "조회 되었습니다."
}
```

### 사용법 (휴장일 확인)

```python
def is_us_market_open(date: str) -> bool:
    """미국 시장 영업일 여부 확인"""
    response = call_api("CTOS5011R", {"TRAD_DT": date})

    # 응답에서 미국(840) 시장 데이터 확인
    for market in response.get("output", []):
        if market.get("tr_natn_cd") == "840":
            return True  # 미국 시장 영업일

    return False  # 휴장일 (미국 데이터 없음)
```

---

