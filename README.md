# github-claude

A generic GitHub Issue automation webhook server powered by Claude Code CLI. Automatically fixes issues, creates PRs, reviews code, and deploys — configurable for any project via `.env`.

## Prerequisites

- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- GitHub Personal Access Token with `repo` scope

## Installation

```bash
git clone https://github.com/inspirio-co/github-claude.git
cd github-claude
npm install
cp .env.example .env
# Edit .env for your project
```

## Configuration

All settings are controlled via `.env`. See `.env.example` for all options.

### Required

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub Personal Access Token (repo scope) |
| `GITHUB_OWNER` | GitHub owner or organization |
| `GITHUB_REPO` | Target repository name |
| `GITHUB_BASE_BRANCH` | Base branch (`main` or `master`) |
| `WORKSPACE_DIR` | Local clone path of the repository |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_PR` | `true` | Create PR for each fix |
| `ENABLE_REVIEW` | `true` | Auto-review PRs with Claude |
| `ENABLE_BUILD` | `true` | Run build after merge |
| `ENABLE_QUESTCODE` | `false` | Use QuestCode QA instead of PR review |

### Labels

| Variable | Default | Description |
|----------|---------|-------------|
| `LABEL_TRIGGER` | `auto-fix` | Label that triggers automation |
| `LABEL_IN_PROGRESS` | `status/in-progress` | Applied while processing |
| `LABEL_DONE` | `status/done` | Applied on completion |
| `LABEL_NEEDS_REVIEW` | `status/needs-review` | Applied when max retries exceeded |

### Claude Code

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_ALLOWED_TOOLS` | `Edit,Write,Glob,Grep,Read` | Tools for fix agent |
| `CLAUDE_REVIEW_TOOLS` | `Glob,Grep,Read` | Tools for review agent (read-only) |
| `CLAUDE_TIMEOUT` | `600000` | CLI timeout in ms |
| `CLAUDE_MAX_RETRIES` | `3` | Max re-fix attempts on review rejection |
| `BRANCH_PREFIX` | `auto-fix` | Branch name prefix |

## How It Works

### Flow A: PR + Auto-Review (default)

```
Issue labeled "auto-fix"
  → Claude Code fixes the code
  → Creates branch auto-fix/issue-N, commits, pushes
  → Opens Pull Request
  → GitHub sends pull_request.opened event
  → Claude Code reviews the PR diff
    → APPROVE: merge → pull → build/deploy → close issue
    → REQUEST_CHANGES: Claude re-fixes → push → re-review (up to N retries)
```

### Flow B: QuestCode QA (optional)

```
Issue labeled "auto-fix"
  → Claude Code fixes the code
  → Starts QuestCode QA job
  → QuestCode sends result via webhook
    → PASS: close issue
    → FAIL: Claude re-fixes → re-test (up to N retries)
```

## Running

```bash
# Direct
node src/server.js

# PM2
pm2 start src/server.js --name github-claude --cwd /path/to/github-claude

# PM2 with name
pm2 start src/server.js --name mrv-webhook --cwd /path/to/github-claude
```

## GitHub Webhook Setup

### 1. Create labels

```bash
source .env && ./create-labels.sh
```

### 2. Add webhook in GitHub

Go to **Repository → Settings → Webhooks → Add webhook**:

- **Payload URL**: `http://your-server:3031/webhook/github`
- **Content type**: `application/json`
- **Secret**: same as `GITHUB_WEBHOOK_SECRET` in `.env`
- **Events**: select **Issues** and **Pull requests**

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook/github` | GitHub webhook receiver |
| `POST` | `/webhook/questcode` | QuestCode webhook receiver |
| `GET` | `/health` | Health check (config, active jobs) |
| `GET` | `/status` | Detailed status (config, labels, jobs) |
| `GET` | `/logs?tail=100` | Recent log lines |

## Project Structure

```
github-claude/
├── src/
│   ├── server.js           # Express app, endpoint routing
│   ├── config.js            # .env → config object
│   ├── logger.js            # Console + file logging
│   ├── webhook-handler.js   # GitHub event dispatch
│   ├── fix-agent.js         # Issue → Claude Code fix → PR or QuestCode
│   ├── review-agent.js      # PR diff → Claude Code review → APPROVE/REQUEST_CHANGES
│   ├── git-ops.js           # Branch, commit, push, pull
│   ├── github-api.js        # GitHub REST API (labels, comments, PR, merge, diff)
│   ├── build-deploy.js      # Build & deploy execution
│   ├── questcode-api.js     # QuestCode QA integration (optional)
│   └── job-store.js         # Persistent job state (active-jobs.json)
├── package.json
├── .env.example
├── .gitignore
├── create-labels.sh
└── README.md
```

## License

Private — inspirio-co internal use.
