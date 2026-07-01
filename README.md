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

> **Optional:** a single issue can also fix a **secondary repo** (e.g. a backend) when the root cause
> lives there. Off by default — see [Secondary Repo (Backend Inline Fix)](#secondary-repo-backend-inline-fix).

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

### Optional — Secondary repo (backend inline fix)

Off by default. Enables fixing a **second repository** (e.g. a backend/API repo) within the same
issue when the root cause lives there. See [Secondary Repo](#secondary-repo-backend-inline-fix) below.

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND_FIX_ENABLED` | *(auto)* | `true`/`false` to force on/off. If unset, auto-enables **only** when `BACKEND_WORKSPACE_DIR` points at an existing git repo. |
| `BACKEND_REPO` | *(basename of `BACKEND_WORKSPACE_DIR`)* | Secondary repo name (same `GITHUB_OWNER`) |
| `BACKEND_WORKSPACE_DIR` | *(empty)* | Local clone path of the secondary repo. **Required** to enable the feature. |
| `BACKEND_BASE_BRANCH` | `GITHUB_BASE_BRANCH` | Base branch of the secondary repo |
| `BACKEND_BUILD_COMMAND` | `cd <dir> && npm install && npm run build` | Build command (must succeed before merge/deploy) |
| `BACKEND_DEPLOY_COMMAND` | *(empty)* | Deploy command. **If empty, changes are built & merged but NOT deployed.** |

## Secondary Repo (Backend Inline Fix)

**Optional, off by default.** In many projects, issues are filed against **one** repo (e.g. the
frontend) even though the real root cause lives in a **second** repo (e.g. the backend/API). Normally
this bot can only touch `GITHUB_REPO`, so backend-rooted issues get patched around in the frontend or
never fixed. This feature lets a single primary-repo issue **also** fix and deploy the secondary repo.

### How to enable

Point `BACKEND_WORKSPACE_DIR` at a local clone of the secondary repo (same `GITHUB_OWNER`):

```dotenv
BACKEND_FIX_ENABLED=true
BACKEND_REPO=my-backend
BACKEND_WORKSPACE_DIR=/home/ubuntu/my-backend
BACKEND_BASE_BRANCH=main
BACKEND_BUILD_COMMAND=cd /home/ubuntu/my-backend && npm install && npm run build
BACKEND_DEPLOY_COMMAND=pm2 restart my-backend   # leave empty to build+merge only, no deploy
```

If `BACKEND_WORKSPACE_DIR` is unset the feature stays **fully disabled** — behavior is identical to a
single-repo setup. No hard-coded paths or repo names; everything comes from `.env`.

### Flow

```
Issue #N (primary repo)  ──►  Fix agent runs once
                              cwd = primary repo, --add-dir = secondary repo
                              (can read/edit BOTH repos in one run)
                                        │
                    ┌───────────────────┴───────────────────┐
          primary repo changed?                   secondary repo changed?
                    │                                       │
          standard flow:                          secondary flow:
          branch → PR → REVIEW → merge → build     branch → PR → BUILD → merge → deploy
                    │                                       │
                    └───────────────────┬───────────────────┘
                          Result (incl. secondary PR/deploy) is
                          commented back on the primary issue #N
```

The fix agent decides *which* repo(s) to edit based on where the root cause actually is. One issue can
therefore produce **up to two PRs** (one per repo), each following its own repo's branch/build/deploy
path. Files under `.env`, `node_modules/`, and `prisma/migrations/` in the secondary repo are never
committed.

### ⚠️ Important differences from the primary flow (read before enabling)

This feature intentionally trades some safety for reach. Understand these before turning it on:

- **The secondary repo is NOT code-reviewed.** The primary repo's PR goes through the review agent
  (APPROVE / REQUEST_CHANGES loop); the secondary PR only has to **compile** (`BACKEND_BUILD_COMMAND`
  succeeds), then it is auto-merged. A build passing does not mean the change is correct.
- **A passing build auto-deploys to the secondary target.** If `BACKEND_DEPLOY_COMMAND` is set, it runs
  immediately after merge (e.g. restarts a production service). There is **no human gate**. Leave
  `BACKEND_DEPLOY_COMMAND` empty if you want build+merge only and a human to deploy.
- **"When does it touch the secondary repo?" is decided by the model,** not a hard rule — it edits the
  secondary repo only when it judges the root cause to be there. This is non-deterministic by nature.
- **The bot operates in the live clone.** It runs `git` / `npm install` / build inside
  `BACKEND_WORKSPACE_DIR`. Don't hand-edit that clone while the bot is active.

Recommended posture: enable it where the secondary repo is low-risk or you deploy manually
(`BACKEND_DEPLOY_COMMAND` empty). For high-risk backends, keep it off or gate deploys yourself.

## Running

```bash
# Direct
node src/server.js

# PM2 (recommended)
pm2 start src/server.js --name mrv-webhook --cwd /path/to/github-claude
pm2 save
```

## GitHub Webhook Setup

### 1. GitHub Personal Access Token

Generate a **Fine-grained Personal Access Token** (recommended) or a classic token.

**Fine-grained token permissions** (repository-scoped):

| Permission | Access | Used for |
|------------|--------|----------|
| Issues | Read & Write | Add labels, post comments, close issues |
| Pull requests | Read & Write | Create PRs, post reviews, merge |
| Contents | Read & Write | Push branches, delete merged branches |
| Metadata | Read-only | Required by default |

**Classic token**: select the `repo` scope (full control of private repositories).

Set the token as `GITHUB_TOKEN` in `.env`.

### 2. Create labels

Create the required labels in your repository:

```bash
source .env && ./create-labels.sh
```

This creates: `auto-fix`, `status/in-progress`, `status/done`, `status/needs-review`.

### 3. Add webhook

Go to **Repository → Settings → Webhooks → Add webhook**.

| Field | Value |
|-------|-------|
| **Payload URL** | `http://your-server:3031/webhook/github` |
| **Content type** | `application/json` |
| **Secret** | Same value as `GITHUB_WEBHOOK_SECRET` in `.env` (leave both empty to skip signature verification) |

**Select individual events** — only check the following:

| Event | Why |
|-------|-----|
| **Issues** | Detects when `auto-fix` label is added to trigger the fix agent |
| **Pull requests** | Detects `opened` / `synchronize` events on `auto-fix/*` branches to trigger the review agent |

> **Note:** Do **not** use "Send me everything." Only the two events above are handled; extra events are ignored but create unnecessary traffic.

### 4. Network requirements

The webhook server must be reachable from GitHub's infrastructure:

- **Public server**: Ensure port (default `3031`) is open in your firewall / security group.
- **Behind NAT / local development**: Use a tunnel such as [ngrok](https://ngrok.com), [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), or [smee.io](https://smee.io).

```bash
# Example with ngrok
ngrok http 3031
# Use the generated https URL as your Payload URL
```

### 5. Verify

After adding the webhook, GitHub sends a `ping` event. Check your server logs:

```
[INFO] Ping event received - webhook is configured correctly
```

You can also verify from the terminal:

```bash
curl http://localhost:3031/health
# {"status":"ok", ...}
```

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
├── git-ops.js           # git branch, commit, push, pull (primary repo)
├── github-api.js        # GitHub REST API (labels, comments, PR, merge, diff)
├── build-deploy.js      # Build & deploy (primary repo)
└── backend-fix.js       # Optional: secondary-repo inline fix → PR → build → merge → deploy
```
