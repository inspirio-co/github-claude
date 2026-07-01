require('dotenv').config();
const path = require('path');
const fs = require('fs');

// 백엔드 설정은 머신·프로젝트별 값을 .env(BACKEND_*)로 주입한다. 소스엔 프로젝트명을 박지 않는다.
const _beDir = process.env.BACKEND_WORKSPACE_DIR || '';
// repo 이름 미지정 시 워크스페이스 경로의 basename에서 유도
const _beRepo = process.env.BACKEND_REPO || (_beDir ? path.basename(_beDir) : '');
// enabled: 명시적 env가 있으면 그 값을 따르고, 없으면 백엔드 워크스페이스가 git 레포로 존재할 때만 자동 활성화
const _beEnabled = process.env.BACKEND_FIX_ENABLED != null
  ? process.env.BACKEND_FIX_ENABLED !== 'false'
  : (!!_beDir && (() => { try { return fs.existsSync(path.join(_beDir, '.git')); } catch (_) { return false; } })());

const config = {
  // Server
  port: parseInt(process.env.WEBHOOK_PORT || '3031', 10),
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',

  // GitHub
  githubToken: process.env.GITHUB_TOKEN || '',
  owner: process.env.GITHUB_OWNER || '',
  repo: process.env.GITHUB_REPO || '',
  baseBranch: process.env.GITHUB_BASE_BRANCH || 'main',

  // Workspace
  workspaceDir: process.env.WORKSPACE_DIR || process.cwd(),

  // Backend (프론트 이슈의 근본원인이 백엔드일 때 fix 에이전트가 함께 수정·배포)
  // 별도 이슈/웹훅이 아니라, 프론트 이슈 처리 중 백엔드 레포까지 인라인으로 고친다.
  // 머신별 실제 값(경로·빌드·배포 커맨드)은 .env의 BACKEND_* 로 주입한다.
  backend: {
    enabled: _beEnabled,
    repo: _beRepo,
    workspaceDir: _beDir,
    baseBranch: process.env.BACKEND_BASE_BRANCH || (process.env.GITHUB_BASE_BRANCH || 'main'),
    // 기본 빌드: 해당 백엔드 워크스페이스에서 install+build (prisma 등 프로젝트별 커맨드는 .env로 오버라이드)
    buildCommand: process.env.BACKEND_BUILD_COMMAND || `cd ${_beDir} && npm install && npm run build`,
    // 배포 커맨드는 프로세스 매니저·서비스명이 머신별로 다르므로 기본은 비움(미설정 시 빌드·머지까지만 하고 배포 스킵).
    deployCommand: process.env.BACKEND_DEPLOY_COMMAND || '',
  },

  // Labels
  labels: {
    trigger: process.env.LABEL_TRIGGER || 'auto-fix',
    inProgress: process.env.LABEL_IN_PROGRESS || 'status/in-progress',
    done: process.env.LABEL_DONE || 'status/done',
    needsReview: process.env.LABEL_NEEDS_REVIEW || 'status/needs-review',
  },

  // Claude Code
  claude: {
    allowedTools: process.env.CLAUDE_ALLOWED_TOOLS || 'Edit,Write,Glob,Grep,Read',
    reviewTools: process.env.CLAUDE_REVIEW_TOOLS || 'Glob,Grep,Read',
    disallowedTools: process.env.CLAUDE_DISALLOWED_TOOLS || 'Bash,Task',
    timeout: parseInt(process.env.CLAUDE_TIMEOUT || '600000', 10),
    maxRetries: parseInt(process.env.CLAUDE_MAX_RETRIES || '3', 10),
  },
  branchPrefix: process.env.BRANCH_PREFIX || 'auto-fix',

  // Feature Flags
  features: {
    pr: process.env.ENABLE_PR !== 'false',
    review: process.env.ENABLE_REVIEW !== 'false',
    build: process.env.ENABLE_BUILD !== 'false',
    qa: process.env.ENABLE_QA !== 'false',
  },

  // Build & Deploy
  buildCommand: process.env.BUILD_COMMAND || '',
  deployCommand: process.env.DEPLOY_COMMAND || '',

  // QA (QuestCode)
  qa: {
    apiToken: process.env.QUESTCODE_API_TOKEN || '',
    baseUrl: process.env.QUESTCODE_BASE_URL || '',
    targetUrl: process.env.QA_TARGET_URL || '',
    credentialId: process.env.QA_CREDENTIAL_ID || '',
    pollTimeout: parseInt(process.env.QA_POLL_TIMEOUT || '300000', 10),
    pollInterval: parseInt(process.env.QA_POLL_INTERVAL || '15000', 10),
    maxRetries: parseInt(process.env.QA_MAX_RETRIES || '2', 10),
  },
};

module.exports = config;
