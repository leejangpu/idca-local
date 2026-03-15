# 무한매수법 3.0 자동매매 시스템 개발 계획

## 프로젝트 개요

- **목표**: TQQQ, SOXL 두 종목에 대해 무한매수법 V3.0 규칙에 따라 자동 매매
- **언어**: Python 3.11+
- **실행 환경**: 로컬 Mac (launchd로 자동 실행)
- **알림**: 텔레그램 봇

---

## 실행 스케줄

| 시간 (KST) | 작업 | 설명 |
|------------|------|------|
| **18:00** | 주문 제출 | 프리마켓 시작 후 LOC 주문 |
| **06:30** | 체결 확인 | 장 마감 후 체결 결과 조회 |

### 텔레그램 알림

#### 1. 주문 제출 알림 (18:00)
```
📊 [TQQQ] 주문 제출 완료

📈 매수 주문
- LOC $45.50 x 22주 ($1,001)
- LOC $44.00 x 22주 ($968)

📉 매도 주문
- LOC $47.25 x 50주 (1/4 쿼터매도)
- LIMIT $51.75 x 150주 (목표 15%)

⏰ 체결 예정: 내일 06:00
```

#### 2. 체결 결과 알림 (06:30)
```
✅ [TQQQ] 체결 완료

📈 매수 체결
- $45.50 x 22주 = $1,001

📉 매도 체결
- 없음

📊 현재 상태
- 보유수량: 222주
- 평단가: $46.82
- 현재가: $45.50
- 평가손익: -$293 (-2.82%)
- T값: 8.5

💰 실현손익
- 이번 달: +$523 (+2.1%)
- 누적: +$1,847 (+3.7%)
```

#### 3. 에러/경고 알림 (즉시)
```
🚨 [오류] 주문 실패

종목: TQQQ
사유: 잔고 부족
필요금액: $1,000
보유금액: $523
시간: 2024-01-16 18:05:23

수동 확인 필요
```

```
⚠️ [경고] 잔고 부족

종목: SOXL
상태: 매수 주문 스킵
사유: 잔여자금 $200 < 1회매수금 $500
시간: 2024-01-16 18:05:25

다음 입금 필요
```

#### 4. 연간 리포트 (매년 1월 1일)
```
📊 2025년 연간 리포트

📈 TQQQ
- 시작 원금: $10,000
- 현재 평가: $12,350
- 실현 손익: +$1,847 (+18.5%)
- 사이클 완료: 12회

📈 SOXL
- 시작 원금: $10,000
- 현재 평가: $11,200
- 실현 손익: +$2,156 (+21.6%)
- 사이클 완료: 8회

💰 총 수익: +$4,003 (+20.0%)
```

---

## 개발 단계

### Phase 1: 기반 구조 (API 클라이언트)

#### 1.1 프로젝트 구조 설정
```
infinite-dca/
├── src/
│   ├── __init__.py
│   ├── config.py              # 환경변수 로드, 설정값
│   ├── kis_api/               # 한투 API 클라이언트
│   │   ├── __init__.py
│   │   ├── auth.py            # 토큰 발급/관리
│   │   ├── order.py           # 주문 (매수/매도/정정/취소)
│   │   ├── account.py         # 잔고, 미체결, 체결내역
│   │   ├── quote.py           # 시세 조회
│   │   └── market.py          # 휴장일 조회
│   ├── strategy/              # 무한매수법 전략
│   │   ├── __init__.py
│   │   ├── calculator.py      # T값, 별%, 주문가격 계산
│   │   └── v3.py              # V3.0 매매 로직
│   ├── models/                # 데이터 모델
│   │   ├── __init__.py
│   │   ├── cycle.py           # 사이클 상태
│   │   └── order.py           # 주문 객체
│   ├── notification/          # 알림
│   │   ├── __init__.py
│   │   └── telegram.py        # 텔레그램 봇
│   ├── storage/               # 상태 저장
│   │   ├── __init__.py
│   │   └── json_store.py      # JSON 파일 기반 저장
│   └── scheduler/             # 스케줄러
│       ├── __init__.py
│       └── jobs.py            # 정기 작업 정의
├── data/
│   ├── cycles/                # 사이클 상태 (TQQQ.json, SOXL.json)
│   ├── history/               # 거래 히스토리 (체결 내역)
│   └── reports/               # 수익률 기록 (월별/연별)
├── logs/                      # 로그 파일
├── tests/                     # 테스트 코드
├── main.py                    # 진입점 (스케줄러 실행)
├── requirements.txt
├── .env
└── .gitignore
```

#### 1.2 KIS API 클라이언트 구현
- [ ] `auth.py`: 토큰 발급, 캐싱 (24시간 유효), 자동 갱신
- [ ] `order.py`: 매수/매도 주문, 정정/취소
- [ ] `account.py`: 잔고 조회, 미체결 조회, 체결 내역
- [ ] `quote.py`: 현재가 조회
- [ ] `market.py`: 휴장일 조회 (CTOS5011R)

---

### Phase 2: 무한매수법 전략 구현

#### 2.1 계산 모듈 (`calculator.py`)
- [ ] T값 계산: `T = ceil(누적매수금 / 1회매수금 * 100) / 100`
- [ ] 별% 계산
  - TQQQ: `15 - 1.5 × T`
  - SOXL: `20 - 2.0 × T`
- [ ] 주문 가격 계산: `평단가 × (1 + 별%/100)`
- [ ] 모드 판별: 전반전/후반전/쿼터모드

#### 2.2 V3.0 전략 (`v3.py`)
- [ ] 매수 주문 생성
  - 전반전 (T < 10): 2개 LOC 주문 (별%, 0%)
  - 후반전 (T >= 10): 1개 LOC 주문 (별%)
- [ ] 매도 주문 생성
  - T <= 19: 1/4 별%LOC + 3/4 목표가 LIMIT
  - 19 < T < 20: 쿼터모드 (MOC 대체 → 현재가 -5% LOC)
- [ ] 사이클 종료/재시작 처리
- [ ] 반복리(Half Compounding) 적용

#### 2.3 복리 재투자 전략
```
┌─────────────────────────────────────────────────────────┐
│                    최초 시작                             │
│  예수금 → 50% TQQQ + 50% SOXL                           │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              사이클 진행 중...                            │
└─────────────────────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │ TQQQ만     │ │ SOXL만     │ │ 둘 다      │
   │ 사이클 종료 │ │ 사이클 종료 │ │ 사이클 종료 │
   └────────────┘ └────────────┘ └────────────┘
          │              │              │
          ▼              ▼              ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │ TQQQ 원금  │ │ SOXL 원금  │ │ 전체 예수금 │
   │ = 예수금   │ │ = 예수금   │ │ 5:5 재분배  │
   │ - SOXL분   │ │ - TQQQ분   │ │            │
   └────────────┘ └────────────┘ └────────────┘
```

**로직 상세:**
1. **최초 시작**: 전체 예수금의 50%씩 각 종목에 배분
2. **한 종목만 사이클 종료**:
   - 예수금 조회
   - 다른 종목의 필요 자금 계산 (1회매수금 × 남은 분할 수)
   - 나머지 전액을 종료된 종목의 새 원금으로 설정
3. **두 종목 동시 사이클 종료**:
   - 전체 예수금을 5:5로 재분배

---

### Phase 3: 상태 관리

#### 3.1 사이클 상태 모델 (`cycle.py`)
```python
@dataclass
class CycleState:
    ticker: str                    # TQQQ or SOXL
    split_count: int = 20          # 분할 수

    # 자금
    principal: float               # 원금
    buy_per_round: float           # 1회매수금
    remaining_cash: float          # 잔여자금

    # 보유
    total_quantity: int            # 누적수량
    avg_price: float               # 평단가
    total_invested: float          # 누적매수금

    # V3.0 전용
    max_profit_ever: float = 0     # 과거 수익 최대치
    reserved_profit: float = 0     # 보관 수익금

    # 쿼터모드
    quarter_mode_active: bool = False
    quarter_buy_count: int = 0

    # 히스토리
    cycle_count: int = 1
    order_history: list = field(default_factory=list)
```

#### 3.2 상태 저장/로드 (`json_store.py`)
- [ ] JSON 파일로 상태 저장 (`data/cycles/TQQQ.json`)
- [ ] 시작 시 상태 로드, 종료 시 저장
- [ ] 백업 기능 (일자별)

---

### Phase 4: 메인 실행 로직

#### 4.1 주문 제출 작업 (18:00 KST)
```python
async def submit_orders():
    # 1. 휴장일 체크
    if not is_us_market_open(today):
        send_telegram("🏖️ 오늘 미국 휴장일")
        return

    # 2. 토큰 발급/확인
    # 3. 각 종목별 처리
    for ticker in ['TQQQ', 'SOXL']:
        # 3.1 상태 로드
        # 3.2 기존 미체결 주문 취소
        # 3.3 T값, 별% 계산
        # 3.4 매도 주문 생성 및 제출
        # 3.5 매수 주문 생성 및 제출
        # 3.6 상태 저장
        # 3.7 주문 제출 알림 전송
```

#### 4.2 체결 확인 작업 (06:30 KST)
```python
async def check_executions():
    # 1. 토큰 발급/확인
    # 2. 각 종목별 처리
    for ticker in ['TQQQ', 'SOXL']:
        # 2.1 체결 내역 조회
        # 2.2 상태 업데이트 (평단가, 수량, 실현손익)
        # 2.3 월별 실현손익 기록
        # 2.4 상태 저장
        # 2.5 체결 결과 알림 전송
```

#### 4.3 스케줄러 설정 (APScheduler)
```python
scheduler = AsyncIOScheduler(timezone="Asia/Seoul")

# 주문 제출: 매일 18:00 (월~금)
scheduler.add_job(submit_orders, 'cron', hour=18, minute=0, day_of_week='mon-fri')

# 체결 확인: 매일 06:30 (화~토) - 전날 장 마감 결과
scheduler.add_job(check_executions, 'cron', hour=6, minute=30, day_of_week='tue-sat')
```

---

### Phase 5: 안전장치 및 모니터링

#### 5.1 안전장치 및 예외처리
- [ ] 주문 전 잔고/자금 검증
  - 잔여자금 < 1회매수금 → 경고 알림 + 매수 스킵
  - 보유수량 부족 → 에러 알림 + 매도 스킵
- [ ] API 에러 시 재시도 (최대 3회)
- [ ] 비정상 상태 감지 및 알림
- [ ] 네트워크 오류 처리
- [ ] 토큰 만료 자동 갱신

#### 5.2 로깅
- [ ] 모든 API 호출 로깅
- [ ] 주문 내역 로깅
- [ ] 에러 로깅

#### 5.3 텔레그램 알림
- [ ] 주문 제출 알림 (18:00)
- [ ] 체결 결과 알림 (06:30) - 현재 상태, 월별 실현손익 포함
- [ ] 에러 알림 (즉시) - 잔고 부족, API 오류 등
- [ ] 경고 알림 (즉시) - 매수 스킵 등
- [ ] 휴장일 알림
- [ ] 연간 리포트 (1월 1일)

---

## 개발 우선순위

| 순서 | 작업 | 산출물 |
|------|------|--------|
| 1 | 프로젝트 구조 + config | 폴더 구조, requirements.txt, config.py |
| 2 | KIS API 인증 | auth.py |
| 3 | KIS API 시세 | quote.py |
| 4 | KIS API 계좌 | account.py |
| 5 | KIS API 주문 | order.py |
| 6 | KIS API 휴장일 | market.py |
| 7 | 텔레그램 알림 | telegram.py |
| 8 | 계산 모듈 | calculator.py |
| 9 | 상태 모델 | cycle.py, json_store.py |
| 10 | V3.0 전략 | v3.py |
| 11 | 스케줄러 + 메인 | scheduler/jobs.py, main.py |
| 12 | 테스트 | 모의투자 테스트 |

---

## 주요 API 매핑

| 기능 | API | TR_ID (실전/모의) |
|------|-----|-------------------|
| 토큰 발급 | POST /oauth2/tokenP | - |
| 매수 주문 | POST /uapi/overseas-stock/v1/trading/order | TTTT1002U / VTTT1002U |
| 매도 주문 | POST /uapi/overseas-stock/v1/trading/order | TTTT1006U / VTTT1001U |
| 주문 취소 | POST /uapi/overseas-stock/v1/trading/order-rvsecncl | TTTT1004U / VTTT1004U |
| 잔고 조회 | GET /uapi/overseas-stock/v1/trading/inquire-balance | TTTS3012R / VTTS3012R |
| 현재가 | GET /uapi/overseas-stock/v1/quotations/price | HHDFS00000300 |
| 휴장일 | GET /uapi/overseas-stock/v1/quotations/countries-holiday | CTOS5011R (실전만) |

---

## 주문 타입 매핑

| 무한매수법 | 한투 API ORD_DVSN |
|-----------|------------------|
| 지정가 (LIMIT) | 00 |
| LOC (장마감지정가) | 34 |
| MOC (장마감시장가) | **현재가 -5% LOC로 대체** |

> **MOC 대체**: 한투 API에 MOC 미지원. 현재가 -5% LOC 주문으로 거의 확실하게 체결되도록 처리.

---

## Mac 로컬 실행 설정

### 사전 준비
1. Mac 시스템 환경설정 → 에너지 → "디스플레이가 꺼져도 자동 잠자기 방지" 설정
2. Python 3.11+ 설치 확인

### launchd 설정 (자동 실행)

`~/Library/LaunchAgents/com.infinite-dca.plist` 파일 생성:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.infinite-dca</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/python3</string>
        <string>/Users/user/Documents/infinite-dca/main.py</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/user/Documents/infinite-dca/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/user/Documents/infinite-dca/logs/stderr.log</string>
    <key>WorkingDirectory</key>
    <string>/Users/user/Documents/infinite-dca</string>
</dict>
</plist>
```

### 서비스 등록/실행
```bash
# 등록
launchctl load ~/Library/LaunchAgents/com.infinite-dca.plist

# 시작
launchctl start com.infinite-dca

# 중지
launchctl stop com.infinite-dca

# 해제
launchctl unload ~/Library/LaunchAgents/com.infinite-dca.plist
```

---

## 텔레그램 봇 설정

### 봇 정보
- **봇 이름**: @infinite_dca_bot
- **토큰**: 환경변수에 저장됨

### chat_id 확인 방법
1. 텔레그램에서 @infinite_dca_bot 검색 후 `/start` 전송
2. 브라우저에서 접속:
   ```
   https://api.telegram.org/bot{토큰}/getUpdates
   ```
3. 응답에서 `"chat":{"id":123456789}` 확인
4. `.env`에 `TELEGRAM_CHAT_ID=123456789` 추가
