require('dotenv').config();

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
  backend: {
    enabled: process.env.BACKEND_FIX_ENABLED !== 'false',
    repo: process.env.BACKEND_REPO || 'mrv-backend',
    workspaceDir: process.env.BACKEND_WORKSPACE_DIR || '/home/ubuntu/mrv/mrv-backend',
    baseBranch: process.env.BACKEND_BASE_BRANCH || 'main',
    // 빌드 성공 시에만 배포(pm2 restart). 빌드 실패면 PR만 열어두고 배포하지 않음.
    buildCommand: process.env.BACKEND_BUILD_COMMAND ||
      'cd /home/ubuntu/mrv/mrv-backend && npm install && npx prisma generate && npm run build',
    deployCommand: process.env.BACKEND_DEPLOY_COMMAND || 'pm2 restart mrv-backend',
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
