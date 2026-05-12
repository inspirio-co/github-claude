const config = require('./config');
const logger = require('./logger');
const githubApi = require('./github-api');
const fixAgent = require('./fix-agent');
const reviewAgent = require('./review-agent');
// 동시 처리 방지를 위한 락
const processingIssues = new Set();
const processingPRs = new Set();

// PR별 retryCount 추적 (메모리)
const prRetryCount = new Map();

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

  // 중복 처리 방지
  if (processingIssues.has(issueNumber)) {
    logger.warn(`Issue #${issueNumber} is already being processed, skipping`);
    return { handled: false, reason: 'already-processing' };
  }

  processingIssues.add(issueNumber);

  const issueData = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    repository: payload.repository,
  };

  logger.info(`>>> Fix agent triggered: issue #${issueNumber}`);

  try {
    if (config.features.pr) {
      await processFlowA(issueData);
    } else {
      await processSimpleFix(issueData);
    }
  } catch (error) {
    logger.error(`Unhandled error processing issue #${issueNumber}`, { error: error.message, stack: error.stack });
  } finally {
    processingIssues.delete(issueNumber);
  }

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
    // 중복 처리 방지
    if (processingPRs.has(prNumber)) {
      logger.warn(`PR #${prNumber} is already being reviewed, skipping`);
      return { handled: false, reason: 'already-processing' };
    }

    processingPRs.add(prNumber);

    // retryCount: opened=0, synchronize=이전값+1 (prRetryCount에서 추적)
    let retryCount = 0;
    if (action === 'synchronize') {
      retryCount = (prRetryCount.get(prNumber) || 0);
      logger.info(`PR #${prNumber} synchronize event, retryCount=${retryCount}`);
    }

    logger.info(`>>> Review agent triggered: PR #${prNumber} (action: ${action}, retry: ${retryCount})`);

    try {
      const result = await reviewAgent.reviewPR(prNumber, retryCount);
      logger.info(`Review agent result for PR #${prNumber}`, result);

      // retryCount 업데이트
      if (result.verdict === 'REQUEST_CHANGES' && result.retryCount != null) {
        prRetryCount.set(prNumber, result.retryCount);
      } else {
        // APPROVE, ERROR, maxRetries → 정리
        prRetryCount.delete(prNumber);
      }
    } catch (error) {
      logger.error(`Review agent error for PR #${prNumber}`, { error: error.message, stack: error.stack });
    } finally {
      processingPRs.delete(prNumber);
    }

    return { handled: true };
  }

  logger.debug(`PR event action "${action}" ignored`);
  return { handled: false };
}

module.exports = { handleGitHubEvent };
