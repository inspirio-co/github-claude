# github-claude

범용 GitHub Issue 자동 처리 webhook 서버. Claude Code CLI를 이용하여 Issue를 자동으로 수정하고, PR 생성/리뷰 또는 QuestCode QA 검증까지 자동화합니다.

## 설치

```bash
git clone https://github.com/inspirio-co/github-claude.git
cd github-claude
npm install
cp .env.example .env
# .env 파일을 프로젝트에 맞게 수정
```

## 설정

`.env` 파일에서 다음 항목을 설정합니다:

| 항목 | 설명 |
|------|------|
| `GITHUB_TOKEN` | GitHub Personal Access Token (repo 권한) |
| `GITHUB_OWNER` | GitHub 소유자/조직 |
| `GITHUB_REPO` | 대상 레포지토리 |
| `GITHUB_BASE_BRANCH` | 기본 브랜치 (main/master) |
| `WORKSPACE_DIR` | 로컬 작업 디렉토리 경로 |
| `ENABLE_PR` | PR 생성 활성화 (true/false) |
| `ENABLE_REVIEW` | 자동 리뷰 활성화 (true/false) |
| `ENABLE_QUESTCODE` | QuestCode QA 연동 (true/false) |

## 사용 방식

### Flow A: PR + Review (기본)

1. Issue에 `auto-fix` 라벨 추가
2. Claude Code가 코드 자동 수정
3. `auto-fix/issue-N` 브랜치 생성 → PR 생성
4. Claude Code가 PR diff 리뷰
5. APPROVE → 자동 머지 → 빌드/배포 → Issue 종료
6. REQUEST_CHANGES → 자동 재수정 → 재리뷰 (최대 N회)

### Flow B: QuestCode QA

1. Issue에 `auto-fix` 라벨 추가
2. Claude Code가 코드 자동 수정
3. QuestCode QA 테스트 실행
4. 통과 → Issue 종료
5. 실패 → 자동 재수정 → 재테스트 (최대 N회)

## 실행

```bash
# 직접 실행
node src/server.js

# PM2
pm2 start src/server.js --name github-claude
```

## GitHub Webhook 설정

1. 라벨 생성:
```bash
source .env && ./create-labels.sh
```

2. GitHub 레포 → Settings → Webhooks → Add webhook:
   - Payload URL: `http://your-server:3031/webhook/github`
   - Content type: `application/json`
   - Secret: `.env`의 `GITHUB_WEBHOOK_SECRET`과 동일
   - Events: Issues, Pull requests

## 엔드포인트

| 경로 | 설명 |
|------|------|
| `POST /webhook/github` | GitHub Webhook 수신 |
| `POST /webhook/questcode` | QuestCode Webhook 수신 |
| `GET /health` | 헬스 체크 |
| `GET /status` | 상태 확인 (설정, 활성 Job) |
| `GET /logs?tail=100` | 최근 로그 확인 |
