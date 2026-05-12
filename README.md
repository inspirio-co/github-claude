# github-claude

Automated GitHub Issue fixer powered by Claude Code CLI. When an issue is labeled `auto-fix`, Claude automatically fixes the code, creates a PR, reviews the diff, and merges — all without human intervention.

## How It Works

```
1. Issue labeled "auto-fix"
2. Claude Code fixes the code
3. Creates branch auto-fix/issue-N → commits → pushes
4. Opens Pull Request
5. Claude Code reviews the PR diff:
   - Checks if the fix matches the issue intent
   - Checks for unnecessary changes
   - Checks for side effects or bugs
6. APPROVE → auto-merge → git pull → build/deploy → close issue
7. REQUEST_CHANGES → Claude re-fixes → pushes → re-review (up to N retries)
8. Max retries exceeded → labels "needs-review" for manual inspection
```

## Prerequisites

- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- GitHub Personal Access Token with `repo` scope
- Local clone of the target repository

## Setup

```bash
git clone https://github.com/inspirio-co/github-claude.git
cd github-claude
npm install
cp .env.example .env
# Edit .env for your project
```

## Configuration (.env)

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `WEBHOOK_PORT` | Server port | `3031` |
| `GITHUB_TOKEN` | GitHub PAT (repo scope) | `ghp_xxx` |
| `GITHUB_OWNER` | Repository owner/org | `my-org` |
| `GITHUB_REPO` | Repository name | `my-app` |
| `GITHUB_BASE_BRANCH` | Base branch | `main` |
| `WORKSPACE_DIR` | Local repo clone path | `/home/ubuntu/my-app` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_WEBHOOK_SECRET` | *(empty)* | Webhook signature secret |
| `LABEL_TRIGGER` | `auto-fix` | Label that triggers automation |
| `LABEL_IN_PROGRESS` | `status/in-progress` | Applied while processing |
| `LABEL_DONE` | `status/done` | Applied on completion |
| `LABEL_NEEDS_REVIEW` | `status/needs-review` | Applied when max retries exceeded |
| `CLAUDE_ALLOWED_TOOLS` | `Edit,Write,Glob,Grep,Read` | Tools for fix agent |
| `CLAUDE_REVIEW_TOOLS` | `Glob,Grep,Read` | Tools for review agent (read-only) |
| `CLAUDE_TIMEOUT` | `600000` | Claude CLI timeout (ms) |
| `CLAUDE_MAX_RETRIES` | `3` | Max re-fix attempts |
| `BRANCH_PREFIX` | `auto-fix` | Branch name prefix |
| `ENABLE_PR` | `true` | Create PR for fixes |
| `ENABLE_REVIEW` | `true` | Auto-review PRs |
| `ENABLE_BUILD` | `true` | Run build after merge |
| `BUILD_COMMAND` | *(empty)* | Build command |
| `DEPLOY_COMMAND` | *(empty)* | Deploy command |

## Running

```bash
# Direct
node src/server.js

# PM2 (recommended)
pm2 start src/server.js --name mrv-webhook --cwd /path/to/github-claude
pm2 save
```

## GitHub Webhook Setup

### 1. Create labels

```bash
source .env && ./create-labels.sh
```

### 2. Add webhook

Repository → Settings → Webhooks → Add webhook:

- **Payload URL**: `http://your-server:3031/webhook/github`
- **Content type**: `application/json`
- **Secret**: same as `GITHUB_WEBHOOK_SECRET` in `.env`
- **Events**: Issues, Pull requests

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook/github` | GitHub webhook receiver |
| `GET` | `/health` | Health check |
| `GET` | `/status` | Config & status |
| `GET` | `/logs?tail=100` | Recent log lines |

## Project Structure

```
src/
├── server.js           # Express app, routing
├── config.js            # .env → config
├── logger.js            # Console + file logging
├── webhook-handler.js   # Event dispatch (issue labeled → fix, PR opened → review)
├── fix-agent.js         # Claude Code fix / re-fix
├── review-agent.js      # Claude Code PR review → APPROVE / REQUEST_CHANGES
├── git-ops.js           # git branch, commit, push, pull
├── github-api.js        # GitHub REST API (labels, comments, PR, merge, diff)
└── build-deploy.js      # Build & deploy
```
