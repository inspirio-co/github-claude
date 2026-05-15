const config = require('./config');
const logger = require('./logger');
const githubApi = require('./github-api');
const fixAgent = require('./fix-agent');
const reviewAgent = require('./review-agent');
const gitOps = require('./git-ops');

// PR별 retryCount 추적 (메모리)
const prRetryCount = new Map();

// 순차 처리 큐
const taskQueue = [];
let isProcessing = false;

function enqueueTask(taskFn, label) {
  return new Promise((resolve, reject) => {
    taskQueue.push({ fn: taskFn, label, resolve, reject });
    logger.info(`Task queued: ${label} (queue size: ${taskQueue.length})`);
    processQueue();
  });
}

async function processQueue() {
  if (isProcessing) return;
  if (taskQueue.length === 0) return;

  isProcessing = true;
  const { fn, label, resolve, reject } = taskQueue.shift();
  logger.info(`Task started: ${label} (remaining: ${taskQueue.length})`);

  try {
    // 작업 시작 전 워크스페이스 정리
    try {
      await gitOps.run('git checkout -- .');
      await gitOps.run(`git checkout ${config.baseBranch}`);
    } catch (cleanErr) {
      logger.warn(`Workspace cleanup before task: ${cleanErr.message}`);
      try {
        await gitOps.resetHard('HEAD');
        await gitOps.run(`git checkout ${config.baseBranch}`);
      } catch (_) {}
    }

    const result = await fn();
    resolve(result);
  } catch (error) {
    logger.error(`Task failed: ${label}`, { error: error.message });
    reject(error);
  } finally {
    isProcessing = false;
    logger.info(`Task completed: ${label}`);
    processQueue(); // 다음 작업 처리
  }
}

/**
 * GitHub Webhook 이벤트 디스패치
 */
async function handleGitHubEvent(event, payload) {
  const action = payload.action;
  logger.info(`Received event: ${event} / action: ${action}`);

  switch (event) {
    case 'issues':
      return handleIssueEvent(payload);
    case 'pull_request':
      return handlePullRequestEvent(payload);
    case 'ping':
      logger.info('Ping event received - webhook is configured correctly');
      return { handled: true };
    default:
      logger.debug(`Unhandled event type: ${event}`);
      return { handled: false };
  }
}

/**
 * Issue 이벤트 처리
 */
async function handleIssueEvent(payload) {
  const { action, issue, label } = payload;

  // auto-fix 라벨이 추가된 경우에만 처리
  if (action !== 'labeled') {
    logger.debug(`Issue event action "${action}" ignored (not "labeled")`);
    return { handled: false };
  }

  if (!label || label.name !== config.labels.trigger) {
    logger.debug(`Label "${label?.name}" is not trigger label "${config.labels.trigger}", ignoring`);
    return { handled: false };
  }

  const issueNumber = issue.number;

  const issueData = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    repository: payload.repository,
  };

  logger.info(`>>> Fix agent triggered: issue #${issueNumber}`);

  // 큐에 넣어 순차 처리
  enqueueTask(async () => {
    if (config.features.pr) {
      await processFlowA(issueData);
    } else {
      await processSimpleFix(issueData);
    }
  }, `fix-issue-${issueNumber}`).catch(error => {
    logger.error(`Unhandled error processing issue #${issueNumber}`, { error: error.message, stack: error.stack });
  });

  return { handled: true };
}

/**
 * Flow A: PR + Review 방식
 */
async function processFlowA(issueData) {
  const { number } = issueData;
  logger.info(`Flow A (PR) started for issue #${number}`);

  const result = await fixAgent.processWithPR(issueData);

  if (result.success) {
    logger.info(`Flow A: PR #${result.prNumber} created for issue #${number}`);
    // PR opened 이벤트가 webhook으로 들어와서 review-agent가 자동 트리거됨
  } else {
    logger.error(`Flow A failed for issue #${number}`, { reason: result.reason || result.error });
  }
}

/**
 * 단순 수정 (PR 비활성화 시)
 */
async function processSimpleFix(issueData) {
  const { number } = issueData;
  const { owner, repo } = config;

  logger.info(`Simple fix (no PR) for issue #${number}`);

  await githubApi.updateIssueLabels(owner, repo, number, [config.labels.inProgress]);
  await githubApi.commentOnIssue(owner, repo, number, '🤖 Claude가 이슈 처리를 시작합니다...');

  try {
    const output = await fixAgent.fixIssue(issueData);

    await githubApi.updateIssueLabels(owner, repo, number, [config.labels.done]);
    await githubApi.commentOnIssue(owner, repo, number,
      `✅ 코드 수정이 완료되었습니다.\n\n**결과:**\n\`\`\`\n${output.substring(0, 1000)}${output.length > 1000 ? '...' : ''}\n\`\`\``
    );
    await githubApi.closeIssue(owner, repo, number);
    logger.info(`Issue #${number} processed and closed (simple fix)`);
  } catch (error) {
    logger.error(`Simple fix failed for issue #${number}`, { error: error.message });
    await githubApi.commentOnIssue(owner, repo, number,
      `❌ 처리 중 오류 발생:\n\n\`\`\`\n${error.message}\n\`\`\``
    );
  }
}

/**
 * Pull Request 이벤트 처리
 */
async function handlePullRequestEvent(payload) {
  const { action, pull_request: pr } = payload;

  if (!config.features.review) {
    logger.debug('Review feature disabled, skipping PR event');
    return { handled: false };
  }

  // auto-fix 브랜치의 PR만 처리
  const branchName = pr.head?.ref || '';
  if (!branchName.startsWith(config.branchPrefix + '/')) {
    logger.debug(`PR branch "${branchName}" does not match prefix "${config.branchPrefix}/", ignoring`);
    return { handled: false };
  }

  const prNumber = pr.number;

  if (action === 'opened' || action === 'synchronize') {
    // retryCount: opened=0, synchronize=이전값+1 (prRetryCount에서 추적)
    let retryCount = 0;
    if (action === 'synchronize') {
      retryCount = (prRetryCount.get(prNumber) || 0);
      logger.info(`PR #${prNumber} synchronize event, retryCount=${retryCount}`);
    }

    logger.info(`>>> Review agent triggered: PR #${prNumber} (action: ${action}, retry: ${retryCount})`);

    // 큐에 넣어 순차 처리
    enqueueTask(async () => {
      const result = await reviewAgent.reviewPR(prNumber, retryCount);
      logger.info(`Review agent result for PR #${prNumber}`, result);

      // retryCount 업데이트
      if (result.verdict === 'REQUEST_CHANGES' && result.retryCount != null) {
        prRetryCount.set(prNumber, result.retryCount);
      } else {
        prRetryCount.delete(prNumber);
      }
    }, `review-pr-${prNumber}`).catch(error => {
      logger.error(`Review agent error for PR #${prNumber}`, { error: error.message, stack: error.stack });
    });

    return { handled: true };
  }

  logger.debug(`PR event action "${action}" ignored`);
  return { handled: false };
}

/**
 * 서버 시작 시 미처리 이슈/PR 복구
 * - auto-fix 라벨이 있지만 status/* 라벨이 없는 이슈 → fix 트리거
 * - auto-fix/* 브랜치의 열린 PR 중 리뷰되지 않은 것 → review 트리거
 */
async function recoverPendingTasks() {
  const { owner, repo } = config;

  try {
    // 1. auto-fix 라벨이 있는 열린 이슈 확인
    const issues = await githubApi.listIssues(owner, repo, {
      state: 'open',
      labels: config.labels.trigger,
    });

    // PR은 제외 (GitHub API에서 PR도 issue로 반환됨)
    const realIssues = issues.filter(i => !i.pull_request);

    for (const issue of realIssues) {
      const labelNames = issue.labels.map(l => l.name);
      const hasStatusLabel = labelNames.some(l =>
        l === config.labels.inProgress ||
        l === config.labels.done ||
        l === config.labels.needsReview
      );

      if (!hasStatusLabel) {
        logger.info(`Recovery: re-triggering issue #${issue.number} (${issue.title})`);

        const issueData = {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
        };

        enqueueTask(async () => {
          if (config.features.pr) {
            await processFlowA(issueData);
          } else {
            await processSimpleFix(issueData);
          }
        }, `fix-issue-${issue.number}`).catch(error => {
          logger.error(`Recovery: error processing issue #${issue.number}`, { error: error.message });
        });
      }
    }

    // 2. auto-fix 브랜치의 열린 PR 중 리뷰 필요한 것 확인
    if (config.features.review) {
      const prs = await githubApi.listIssues(owner, repo, { state: 'open' });
      const openPRs = prs.filter(i => i.pull_request);

      for (const prIssue of openPRs) {
        const pr = await githubApi.getPullRequest(owner, repo, prIssue.number);
        const branchName = pr.head?.ref || '';

        if (!branchName.startsWith(config.branchPrefix + '/')) continue;

        // 이미 큐에 fix 작업이 있으면 skip
        const issueMatch = pr.body?.match(/#(\d+)/);
        const linkedIssueNum = issueMatch ? parseInt(issueMatch[1]) : null;
        const linkedIssueInQueue = linkedIssueNum && realIssues.some(i => i.number === linkedIssueNum);
        if (linkedIssueInQueue) continue;

        // 연결된 이슈가 needs-review 상태이면 skip (이미 max retries 도달)
        if (linkedIssueNum) {
          try {
            const linkedIssue = await githubApi.getIssue(owner, repo, linkedIssueNum);
            const hasNeedsReview = linkedIssue.labels?.some(l => l.name === config.labels.needsReview);
            if (hasNeedsReview) {
              logger.info(`Recovery: skipping PR #${pr.number} (linked issue #${linkedIssueNum} is needs-review)`);
              continue;
            }
          } catch (_) {}
        }

        logger.info(`Recovery: re-triggering review for PR #${pr.number} (${pr.title})`);

        enqueueTask(async () => {
          const retryCount = prRetryCount.get(pr.number) || 0;
          const result = await reviewAgent.reviewPR(pr.number, retryCount);
          logger.info(`Recovery: review result for PR #${pr.number}`, result);

          if (result.verdict === 'REQUEST_CHANGES' && result.retryCount != null) {
            prRetryCount.set(pr.number, result.retryCount);
          } else {
            prRetryCount.delete(pr.number);
          }
        }, `review-pr-${pr.number}`).catch(error => {
          logger.error(`Recovery: review error for PR #${pr.number}`, { error: error.message });
        });
      }
    }

    logger.info('Recovery check completed');
  } catch (error) {
    logger.error('Recovery check failed', { error: error.message });
  }
}

module.exports = { handleGitHubEvent, recoverPendingTasks };
