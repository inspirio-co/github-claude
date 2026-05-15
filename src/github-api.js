const https = require('https');
const config = require('./config');
const logger = require('./logger');

function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    logger.debug(`GitHub API request: ${options.method} ${options.path}`);

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body || '{}'));
          } catch (_) {
            resolve({ raw: body });
          }
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${body}`);
          logger.error(`GitHub API error: ${options.method} ${options.path}`, { status: res.statusCode, body: body.substring(0, 500) });
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      logger.error(`GitHub API network error: ${err.message}`);
      reject(err);
    });
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function headers(extraHeaders = {}) {
  return {
    'User-Agent': 'github-claude',
    'Authorization': `Bearer ${config.githubToken}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
}

function apiOptions(method, pathStr, extraHeaders) {
  return {
    hostname: 'api.github.com',
    port: 443,
    path: pathStr,
    method,
    headers: headers(extraHeaders),
  };
}

// ─── Issue 관련 ───

async function updateIssueLabels(owner, repo, issueNumber, labels) {
  logger.info(`Updating labels on issue #${issueNumber}`, { labels });
  const opts = apiOptions('PUT', `/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
  return makeRequest(opts, { labels });
}

async function addLabel(owner, repo, issueNumber, label) {
  logger.info(`Adding label "${label}" to issue #${issueNumber}`);
  const opts = apiOptions('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
  return makeRequest(opts, { labels: [label] });
}

async function removeLabel(owner, repo, issueNumber, label) {
  logger.info(`Removing label "${label}" from issue #${issueNumber}`);
  const opts = apiOptions('DELETE', `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
  return makeRequest(opts).catch(err => {
    // 라벨이 없어도 에러 무시
    logger.warn(`Remove label "${label}" failed (may not exist): ${err.message}`);
  });
}

async function commentOnIssue(owner, repo, issueNumber, comment) {
  logger.info(`Commenting on issue #${issueNumber}`, { length: comment.length });
  const opts = apiOptions('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`);
  return makeRequest(opts, { body: comment });
}

async function closeIssue(owner, repo, issueNumber) {
  logger.info(`Closing issue #${issueNumber}`);
  const opts = apiOptions('PATCH', `/repos/${owner}/${repo}/issues/${issueNumber}`);
  return makeRequest(opts, { state: 'closed', state_reason: 'completed' });
}

async function getIssue(owner, repo, issueNumber) {
  logger.debug(`Fetching issue #${issueNumber}`);
  const opts = apiOptions('GET', `/repos/${owner}/${repo}/issues/${issueNumber}`);
  return makeRequest(opts);
}

async function getIssueComments(owner, repo, issueNumber) {
  logger.debug(`Fetching comments for issue #${issueNumber}`);
  const opts = apiOptions('GET', `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
  return makeRequest(opts);
}

// ─── PR 관련 ───

async function createPullRequest(owner, repo, { title, body, head, base }) {
  logger.info(`Creating PR: ${head} → ${base}`, { title });
  const opts = apiOptions('POST', `/repos/${owner}/${repo}/pulls`);
  return makeRequest(opts, { title, body, head, base });
}

async function mergePullRequest(owner, repo, prNumber, { mergeMethod = 'squash' } = {}) {
  logger.info(`Merging PR #${prNumber}`, { mergeMethod });
  const opts = apiOptions('PUT', `/repos/${owner}/${repo}/pulls/${prNumber}/merge`);
  return makeRequest(opts, { merge_method: mergeMethod });
}

async function getPullRequest(owner, repo, prNumber) {
  logger.debug(`Fetching PR #${prNumber}`);
  const opts = apiOptions('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`);
  return makeRequest(opts);
}

async function getPullRequestDiff(owner, repo, prNumber) {
  logger.debug(`Fetching diff for PR #${prNumber}`);
  const opts = apiOptions('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`, {
    'Accept': 'application/vnd.github.v3.diff',
  });
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          logger.error(`Failed to fetch PR diff #${prNumber}`, { status: res.statusCode });
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getPullRequestFiles(owner, repo, prNumber) {
  logger.debug(`Fetching files for PR #${prNumber}`);
  const opts = apiOptions('GET', `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
  return makeRequest(opts);
}

async function createPullRequestReview(owner, repo, prNumber, { event, body }) {
  logger.info(`Submitting review on PR #${prNumber}`, { event });
  const opts = apiOptions('POST', `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
  return makeRequest(opts, { event, body });
}

async function listPullRequestsForBranch(owner, repo, head) {
  logger.debug(`Listing PRs for branch ${head}`);
  const opts = apiOptions('GET', `/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=open`);
  return makeRequest(opts);
}

// ─── Branch 관련 ───

async function deleteBranch(owner, repo, branch) {
  logger.info(`Deleting remote branch: ${branch}`);
  const opts = apiOptions('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
  return makeRequest(opts).catch(err => {
    logger.warn(`Delete branch "${branch}" failed: ${err.message}`);
  });
}

async function listIssues(owner, repo, { state = 'open', labels = '', per_page = 30 } = {}) {
  logger.debug(`Listing issues`, { state, labels });
  const params = `state=${state}&labels=${encodeURIComponent(labels)}&per_page=${per_page}`;
  const opts = apiOptions('GET', `/repos/${owner}/${repo}/issues?${params}`);
  return makeRequest(opts);
}

module.exports = {
  updateIssueLabels,
  addLabel,
  removeLabel,
  commentOnIssue,
  closeIssue,
  getIssue,
  getIssueComments,
  listIssues,
  createPullRequest,
  mergePullRequest,
  getPullRequest,
  getPullRequestDiff,
  getPullRequestFiles,
  createPullRequestReview,
  listPullRequestsForBranch,
  deleteBranch,
};
