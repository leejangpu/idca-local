# IDCA Local — 서버 셋업 가이드

## 1. 서버 PC에 클론

```bash
git clone <repo-url> ~/idca-local
cd ~/idca-local
```

## 2. 의존성 설치

```bash
npm install
```

## 3. 환경변수 설정

```bash
cp .env.example .env
vi .env   # KIS 키, 텔레그램 토큰 등 입력
```

## 4. Firestore 데이터 마이그레이션 (최초 1회)

```bash
# Firebase 인증
gcloud auth application-default login

# firebase-admin 임시 설치
npm install firebase-admin --no-save

# 마이그레이션 실행
USER_ID=<firebase_user_id> ACCOUNT_ID=<firebase_account_id> npx tsx scripts/migrate-firestore.ts

# firebase-admin 제거
npm remove firebase-admin
```

## 5. 빌드

```bash
npm run build
```

## 6. PM2로 실행

```bash
# PM2 전역 설치 (최초 1회)
npm install -g pm2

# 시작
pm2 start ecosystem.config.js

# 상태 확인
pm2 status

# 로그 확인
pm2 logs idca-server

# 재시작
pm2 restart idca-server
```

## 7. Mac 부팅 시 자동 시작

```bash
pm2 startup
# 출력된 sudo 명령어 실행
pm2 save
```

## 8. Mac 절전 비활성화

시스템 설정 > 에너지 절약 > 디스플레이가 꺼져도 자동 잠자기 방지 체크

## 접속

- 설정 UI: http://localhost:3001
- 텔레그램 봇: /status, /trading on|off, /stop

## 구조

```
idca-local/
├── server/
│   ├── src/           # TypeScript 소스
│   ├── dist/          # 빌드 결과 (tsc)
│   ├── data/          # 로컬 JSON 데이터
│   └── public/        # 설정 UI (정적 HTML)
├── scripts/           # 마이그레이션 등 일회성 스크립트
├── .env               # 환경변수 (git 미포함)
└── ecosystem.config.js # PM2 설정
```
