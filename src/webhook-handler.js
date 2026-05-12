const config = require('./config');
const logger = require('./logger');
const githubApi = require('./github-api');
const fixAgent = require('./fix-agent');
const reviewAgent = require('./review-agent');
const questcodeApi = require('./questcode-api');
const jobStore = require('./job-store');

// 동시 처리 방지를 위한 락
const processingIssues = new Set();
const processingPRs = new Set();

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
      // Flow A: PR 방식
      await processFlowA(issueData);
    } else if (config.features.questcode) {
      // Flow B: QuestCode 방식
      await processFlowB(issueData);
    } else {
      // 단순 수정 (PR/QuestCode 모두 비활성화)
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
 * Flow B: QuestCode 방식
 */
async function processFlowB(issueData) {
  const { number } = issueData;
  const { owner, repo } = config;

  logger.info(`Flow B (QuestCode) started for issue #${number}`);

  const fixResult = await fixAgent.processWithQuestCode(issueData);
  if (!fixResult.success) {
    logger.error(`Flow B: fix failed for issue #${number}`);
    return;
  }

  // QuestCode QA 시작
  const qaResult = await questcodeApi.startQAForIssue(issueData);

  if (qaResult.success && qaResult.pending) {
    logger.info(`Flow B: QuestCode Job ${qaResult.jobId} started for issue #${number}`);
    await githubApi.commentOnIssue(owner, repo, number,
      `🧪 QuestCode QA 테스트를 시작했습니다.\n\nJob ID: ${qaResult.jobId}\n\n결과는 완료되면 자동으로 업데이트됩니다.`
    );

    jobStore.set(qaResult.jobId, {
      issueNumber: number,
      owner,
      repo,
      issueData,
      retryCount: 0,
      startedAt: new Date().toISOString(),
    });
  } else {
    logger.error(`Flow B: QuestCode Job start failed for issue #${number}`, { error: qaResult.error });
    await githubApi.commentOnIssue(owner, repo, number,
      `❌ QuestCode 테스트 시작 실패:\n\n\`\`\`\n${qaResult.error}\n\`\`\``
    );
  }
}

/**
 * 단순 수정 (PR/QuestCode 비활성화 시)
 */
async function processSimpleFix(issueData) {
  const { number } = issueData;
  const { owner, repo } = config;

  logger.info(`Simple fix (no PR, no QuestCode) for issue #${number}`);

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

    logger.info(`>>> Review agent triggered: PR #${prNumber} (action: ${action})`);

    // retryCount 추출 (synchronize 이벤트 시)
    let retryCount = 0;
    if (action === 'synchronize') {
      // 기존 코멘트에서 재시도 횟수 파악
      // 간단하게: 이전 리뷰 결과에서 retry 카운트 추적
      // webhook-handler에서 직접 관리하지 않고, review-agent가 PR 코멘트를 분석
      retryCount = 0; // review-agent 내부에서 관리
    }

    try {
      const result = await reviewAgent.reviewPR(prNumber, retryCount);
      logger.info(`Review agent result for PR #${prNumber}`, result);
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

/**
 * QuestCode Webhook 이벤트 처리
 */
async function handleQuestCodeEvent(payload) {
  const { jobId, status, result } = payload;

  logger.info(`QuestCode webhook received: Job ${jobId}, Status: ${status}`);

  const jobInfo = jobStore.get(jobId);
  if (!jobInfo) {
    logger.warn(`Unknown QuestCode job ${jobId}, no matching issue found`);
    return { handled: false, reason: 'unknown-job' };
  }

  const { issueNumber, owner, repo, issueData, retryCount } = jobInfo;

  try {
    if (status === 'completed' || status === 'failed') {
      const report = result?.report || result?.error || 'No report available';
      const reportSummary = report.substring(0, 1000) + (report.length > 1000 ? '...' : '');
      const needsRefix = status === 'failed' || questcodeApi.hasFailures(result);

      if (needsRefix && retryCount < config.claude.maxRetries) {
        // 재수정 필요
        const nextRetry = retryCount + 1;
        logger.info(`QuestCode Job ${jobId} has failures for issue #${issueNumber}. Starting re-fix (${nextRetry}/${config.claude.maxRetries})`);

        await githubApi.commentOnIssue(owner, repo, issueNumber,
          `🔄 QuestCode QA 테스트에서 문제가 발견되었습니다. 자동 재수정을 시작합니다. (${nextRetry}/${config.claude.maxRetries}차 시도)\n\n**QA 리포트:**\n\`\`\`\n${reportSummary}\n\`\`\``
        );

        jobStore.remove(jobId);

        // Claude 재수정
        const refixOutput = await fixAgent.refixFromQuestCode(issueData, report, nextRetry);

        await githubApi.commentOnIssue(owner, repo, issueNumber,
          `🤖 Claude 재수정 완료 (${nextRetry}차). QuestCode 재테스트를 시작합니다.\n\n**수정 내용:**\n\`\`\`\n${refixOutput.substring(0, 500)}${refixOutput.length > 500 ? '...' : ''}\n\`\`\``
        );

        // QuestCode 재테스트
        const qaResult = await questcodeApi.startQAForIssue(issueData);
        if (qaResult.success && qaResult.pending) {
          logger.info(`QuestCode re-test Job ${qaResult.jobId} started for issue #${issueNumber} (retry ${nextRetry})`);
          await githubApi.commentOnIssue(owner, repo, issueNumber,
            `🧪 QuestCode 재테스트 시작 (${nextRetry}차)\n\nJob ID: ${qaResult.jobId}`
          );

          jobStore.set(qaResult.jobId, {
            issueNumber,
            owner,
            repo,
            issueData,
            retryCount: nextRetry,
            startedAt: new Date().toISOString(),
          });
        } else {
          logger.error(`QuestCode re-test start failed for issue #${issueNumber}`);
          await githubApi.commentOnIssue(owner, repo, issueNumber,
            `❌ QuestCode 재테스트 시작 실패:\n\n\`\`\`\n${qaResult.error}\n\`\`\``
          );
        }

      } else if (needsRefix && retryCount >= config.claude.maxRetries) {
        // 최대 재시도 초과
        logger.warn(`QuestCode Job ${jobId} still failing after ${config.claude.maxRetries} retries for issue #${issueNumber}`);
        await githubApi.updateIssueLabels(owner, repo, issueNumber, [config.labels.needsReview]);
        await githubApi.commentOnIssue(owner, repo, issueNumber,
          `⚠️ ${config.claude.maxRetries}회 재시도 후에도 QA 테스트를 통과하지 못했습니다. 수동 검토가 필요합니다.\n\n**최종 QA 리포트:**\n\`\`\`\n${reportSummary}\n\`\`\``
        );
        jobStore.remove(jobId);

      } else {
        // QA 통과
        const summary = report.substring(0, 500) + (report.length > 500 ? '...' : '');
        const retryInfo = retryCount > 0 ? ` (${retryCount}회 재수정 후 통과)` : '';

        logger.info(`QuestCode Job ${jobId} passed for issue #${issueNumber}${retryInfo}`);
        await githubApi.updateIssueLabels(owner, repo, issueNumber, [config.labels.done]);
        await githubApi.commentOnIssue(owner, repo, issueNumber,
          `✅ QuestCode QA 테스트 통과!${retryInfo}\n\n**테스트 결과:**\n\`\`\`\n${summary}\n\`\`\``
        );
        await githubApi.closeIssue(owner, repo, issueNumber);
        logger.info(`Issue #${issueNumber} closed after QA pass`);
        jobStore.remove(jobId);
      }

    } else if (status === 'cancelled') {
      logger.info(`QuestCode Job ${jobId} was cancelled`);
      await githubApi.commentOnIssue(owner, repo, issueNumber,
        '⚠️ QuestCode QA 테스트가 취소되었습니다.'
      );
      jobStore.remove(jobId);
    }

  } catch (error) {
    logger.error(`Error processing QuestCode webhook for job ${jobId}`, { error: error.message, stack: error.stack });
  }

  return { handled: true };
}

module.exports = { handleGitHubEvent, handleQuestCodeEvent };
