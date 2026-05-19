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
