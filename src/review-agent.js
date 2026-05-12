const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const githubApi = require('./github-api');
const gitOps = require('./git-ops');
const fixAgent = require('./fix-agent');
const buildDeploy = require('./build-deploy');

const TEMP_DIR = path.join(__dirname, '..');

/**
 * Claude Code로 PR diff 리뷰
 */
async function runReview(prNumber, diff, issueTitle, issueBody) {
  logger.info(`=== Review agent started for PR #${prNumber} ===`);

  const prompt = `
PR #${prNumber} 코드 리뷰:

관련 이슈: ${issueTitle || '(알 수 없음)'}
이슈 내용: ${issueBody || '(알 수 없음)'}

아래 PR의 diff를 리뷰해주세요:

\`\`\`diff
${diff.substring(0, 50000)}
\`\`\`

리뷰 기준:
1. 목적 부합: 이슈의 요구사항을 정확히 해결하는가
2. 코드 품질: 불필요한 변경, 하드코딩, 잠재적 버그가 없는가
3. 부작용: 기존 기능에 영향을 미치는 변경이 없는가

반드시 아래 형식으로 결론을 내려주세요:

VERDICT: APPROVE 또는 REQUEST_CHANGES
REASON: (한 줄 이유)
DETAILS: (상세 리뷰 내용)
`.trim();

  const promptFile = path.join(TEMP_DIR, `prompt-review-${prNumber}-${Date.now()}.txt`);
  const outputFile = path.join(TEMP_DIR, `claude-output-review-${prNumber}-${Date.now()}.txt`);

  await fs.writeFile(promptFile, prompt);
  logger.info(`Review prompt written for PR #${prNumber}`, { promptLength: prompt.length });

  return new Promise((resolve, reject) => {
    const cmd = `cd "${config.workspaceDir}" && cat "${promptFile}" | claude -p --allowedTools "${config.claude.reviewTools}" > "${outputFile}" 2>&1`;

    exec(cmd, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: config.claude.timeout,
    }, async (error, stdout, stderr) => {
      let output = '';
      try {
        output = await fs.readFile(outputFile, 'utf-8');
      } catch (_) {
        output = stderr || '';
      }

      await fs.unlink(promptFile).catch(() => {});
      await fs.unlink(outputFile).catch(() => {});

      if (error) {
        logger.error(`Review agent failed for PR #${prNumber}`, { error: error.message });
        reject(new Error(`Review error: ${error.message}`));
      } else {
        logger.info(`Review agent completed for PR #${prNumber}`, { outputLength: output.length });
        resolve(output);
      }
    });
  });
}

/**
 * 리뷰 결과에서 VERDICT 파싱
 */
function parseVerdict(reviewOutput) {
  const upper = reviewOutput.toUpperCase();

  if (upper.includes('VERDICT: APPROVE') || upper.includes('VERDICT:** APPROVE') || upper.includes('**VERDICT**: APPROVE')) {
    return 'APPROVE';
  }
  if (upper.includes('VERDICT: REQUEST_CHANGES') || upper.includes('VERDICT:** REQUEST_CHANGES') || upper.includes('**VERDICT**: REQUEST_CHANGES')) {
    return 'REQUEST_CHANGES';
  }

  // 폴백: APPROVE/REQUEST_CHANGES 키워드 직접 탐색
  if (upper.includes('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (upper.includes('APPROVE')) return 'APPROVE';

  logger.warn('Could not parse verdict from review output, defaulting to APPROVE');
  return 'APPROVE';
}

/**
 * PR 리뷰 전체 프로세스
 * - diff 가져오기 → Claude 리뷰 → APPROVE면 merge → REQUEST_CHANGES면 re-fix
 */
async function reviewPR(prNumber, retryCount = 0) {
  const { owner, repo } = config;

  logger.info(`Review agent processing PR #${prNumber} (attempt ${retryCount + 1})`);

  try {
    // 1. PR 정보 & diff 가져오기
    const pr = await githubApi.getPullRequest(owner, repo, prNumber);
    let diff = '';
    try {
      diff = await githubApi.getPullRequestDiff(owner, repo, prNumber);
    } catch (diffErr) {
      logger.warn(`GitHub API diff failed for PR #${prNumber}, falling back to local git diff`, { error: diffErr.message });
      // GitHub API가 406(too large) 등으로 실패하면 로컬 git diff 사용
      try {
        const baseBranch = pr.base?.ref || config.baseBranch;
        const headBranch = pr.head?.ref || '';
        await gitOps.checkout(headBranch);
        diff = await gitOps.run(`git diff ${baseBranch}...${headBranch}`);
        logger.info(`Local git diff obtained for PR #${prNumber}`, { diffLength: diff.length });
      } catch (localDiffErr) {
        logger.error(`Local git diff also failed for PR #${prNumber}`, { error: localDiffErr.message });
        throw new Error(`Cannot obtain diff: API=${diffErr.message}, local=${localDiffErr.message}`);
      }
    }

    if (!diff || diff.trim().length === 0) {
      logger.warn(`PR #${prNumber} has empty diff, auto-approving`);
      await githubApi.createPullRequestReview(owner, repo, prNumber, {
        event: 'APPROVE',
        body: '✅ 변경사항 없음 - 자동 승인',
      });
      return { verdict: 'APPROVE', reason: 'empty-diff' };
    }

    // 이슈 번호 추출 (PR body에서 #N 패턴)
    const issueMatch = pr.body?.match(/#(\d+)/);
    const issueNumber = issueMatch ? parseInt(issueMatch[1]) : null;
    let issueTitle = pr.title;
    let issueBody = '';

    if (issueNumber) {
      try {
        const issue = await githubApi.getIssue(owner, repo, issueNumber);
        issueTitle = issue.title;
        issueBody = issue.body || '';
        logger.info(`Linked issue #${issueNumber}: ${issueTitle}`);
      } catch (err) {
        logger.warn(`Could not fetch linked issue #${issueNumber}: ${err.message}`);
      }
    }

    // 2. Claude Code 리뷰 실행
    await githubApi.commentOnIssue(owner, repo, prNumber,
      `🔍 Claude가 코드 리뷰를 시작합니다...${retryCount > 0 ? ` (${retryCount}차 재리뷰)` : ''}`
    );

    const reviewOutput = await runReview(prNumber, diff, issueTitle, issueBody);
    const verdict = parseVerdict(reviewOutput);

    logger.info(`Review verdict for PR #${prNumber}: ${verdict}`);
    logger.info(`Review agent output for PR #${prNumber}:`, { outputSnippet: reviewOutput.substring(0, 500) });

    // 3. 리뷰 결과 코멘트
    await githubApi.commentOnIssue(owner, repo, prNumber,
      `📝 **코드 리뷰 결과: ${verdict}**\n\n${reviewOutput.substring(0, 3000)}${reviewOutput.length > 3000 ? '\n...(truncated)' : ''}`
    );

    // 4. APPROVE → merge → build/deploy → close issue
    if (verdict === 'APPROVE') {
      logger.info(`PR #${prNumber} approved, merging...`);

      try {
        await githubApi.mergePullRequest(owner, repo, prNumber);
        logger.info(`PR #${prNumber} merged successfully`);
      } catch (mergeErr) {
        logger.error(`Merge failed for PR #${prNumber}`, { error: mergeErr.message });
        await githubApi.commentOnIssue(owner, repo, prNumber,
          `❌ PR 머지 실패:\n\n\`\`\`\n${mergeErr.message}\n\`\`\``
        );
        return { verdict: 'APPROVE', merged: false, error: mergeErr.message };
      }

      // pull latest
      try {
        await gitOps.pull(config.baseBranch);
        logger.info(`Pulled latest ${config.baseBranch} after merge`);
      } catch (pullErr) {
        logger.error(`Pull failed after merge: ${pullErr.message}`);
      }

      // build/deploy
      if (config.features.build && config.buildCommand) {
        try {
          await buildDeploy.runBuild();
          logger.info(`Build completed after PR #${prNumber} merge`);

          if (config.deployCommand) {
            await buildDeploy.runDeploy();
            logger.info(`Deploy completed after PR #${prNumber} merge`);
          }

          await githubApi.commentOnIssue(owner, repo, prNumber,
            '✅ 빌드 및 배포가 완료되었습니다.'
          );
        } catch (buildErr) {
          logger.error(`Build/deploy failed after PR #${prNumber} merge`, { error: buildErr.message });
          await githubApi.commentOnIssue(owner, repo, prNumber,
            `⚠️ 빌드/배포 중 오류:\n\n\`\`\`\n${buildErr.message.substring(0, 500)}\n\`\`\``
          );
        }
      }

      // issue close
      if (issueNumber) {
        try {
          await githubApi.updateIssueLabels(owner, repo, issueNumber, [config.labels.done]);
          await githubApi.closeIssue(owner, repo, issueNumber);
          logger.info(`Issue #${issueNumber} closed after PR merge`);
        } catch (closeErr) {
          logger.error(`Failed to close issue #${issueNumber}: ${closeErr.message}`);
        }
      }

      // remote 브랜치 삭제
      try {
        await githubApi.deleteBranch(owner, repo, pr.head.ref);
        logger.info(`Remote branch ${pr.head.ref} deleted`);
      } catch (_) {}

      return { verdict: 'APPROVE', merged: true };
    }

    // 5. REQUEST_CHANGES → re-fix → push → synchronize 이벤트 → 재리뷰
    if (verdict === 'REQUEST_CHANGES') {
      if (retryCount >= config.claude.maxRetries) {
        logger.warn(`PR #${prNumber} exceeded max retries (${config.claude.maxRetries})`);
        if (issueNumber) {
          await githubApi.updateIssueLabels(owner, repo, issueNumber, [config.labels.needsReview]);
        }
        await githubApi.commentOnIssue(owner, repo, prNumber,
          `⚠️ ${config.claude.maxRetries}회 재시도 후에도 리뷰를 통과하지 못했습니다. 수동 검토가 필요합니다.`
        );
        return { verdict: 'REQUEST_CHANGES', maxRetriesReached: true };
      }

      // re-fix
      const nextRetry = retryCount + 1;
      logger.info(`PR #${prNumber} needs changes, starting re-fix (${nextRetry}/${config.claude.maxRetries})`);

      await githubApi.commentOnIssue(owner, repo, prNumber,
        `🔄 리뷰 피드백을 반영하여 자동 재수정을 시작합니다. (${nextRetry}/${config.claude.maxRetries}차 시도)`
      );

      // PR의 브랜치로 체크아웃
      const branchName = pr.head.ref;
      await gitOps.checkout(branchName);

      const issueData = { number: issueNumber || prNumber, title: issueTitle, body: issueBody };
      const refixOutput = await fixAgent.refixFromReview(issueData, reviewOutput, nextRetry);

      logger.info(`Re-fix completed for PR #${prNumber}`, { outputSnippet: refixOutput.substring(0, 200) });

      // 변경사항 커밋 & 푸시
      const hasChanges = await gitOps.hasChanges();
      if (hasChanges) {
        await gitOps.commit(`fix: #${issueNumber || prNumber} review feedback (retry ${nextRetry})`);
        await gitOps.push(branchName, true);
        logger.info(`Re-fix pushed to ${branchName} for PR #${prNumber}`);

        await githubApi.commentOnIssue(owner, repo, prNumber,
          `🤖 Claude 재수정 완료 (${nextRetry}차).\n\n**수정 내용:**\n\`\`\`\n${refixOutput.substring(0, 500)}${refixOutput.length > 500 ? '...' : ''}\n\`\`\``
        );
      } else {
        logger.warn(`No changes from re-fix for PR #${prNumber}`);
        await githubApi.commentOnIssue(owner, repo, prNumber,
          `⚠️ 재수정 후에도 변경사항이 없습니다. 수동 검토가 필요합니다.`
        );
        if (issueNumber) {
          await githubApi.updateIssueLabels(owner, repo, issueNumber, [config.labels.needsReview]);
        }
      }

      // synchronize 이벤트가 자동 발생 → webhook-handler에서 재리뷰 트리거
      return { verdict: 'REQUEST_CHANGES', retryCount: nextRetry };
    }

  } catch (error) {
    logger.error(`Review agent failed for PR #${prNumber}`, { error: error.message, stack: error.stack });
    await githubApi.commentOnIssue(owner, repo, prNumber,
      `❌ 리뷰 에이전트 오류:\n\n\`\`\`\n${error.message}\n\`\`\``
    ).catch(e => logger.error(`Failed to comment review error: ${e.message}`));
    return { verdict: 'ERROR', error: error.message };
  }
}

module.exports = { reviewPR, parseVerdict };
