const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const gitOps = require('./git-ops');
const githubApi = require('./github-api');

const TEMP_DIR = path.join(__dirname, '..');

/**
 * Claude Code CLI 실행
 */
async function runClaude(prompt, tools, label) {
  const promptFile = path.join(TEMP_DIR, `prompt-${label}-${Date.now()}.txt`);
  const outputFile = path.join(TEMP_DIR, `claude-output-${label}-${Date.now()}.txt`);

  await fs.writeFile(promptFile, prompt);
  logger.info(`Claude Code started (${label})`, { promptLength: prompt.length, tools });

  return new Promise((resolve, reject) => {
    const cmd = `cd "${config.workspaceDir}" && cat "${promptFile}" | claude -p --allowedTools "${tools}" > "${outputFile}" 2>&1`;

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

      // 임시 파일 정리
      await fs.unlink(promptFile).catch(() => {});
      await fs.unlink(outputFile).catch(() => {});

      if (error) {
        logger.error(`Claude Code failed (${label})`, { error: error.message, outputSnippet: output.substring(0, 300) });
        reject(new Error(`Claude Code error: ${error.message}\nOutput: ${output.substring(0, 500)}`));
      } else {
        logger.info(`Claude Code completed (${label})`, { outputLength: output.length });
        resolve(output);
      }
    });
  });
}

/**
 * Issue를 기반으로 Claude Code 수정 실행
 */
async function fixIssue(issueData) {
  const { number, title, body, labels } = issueData;

  logger.info(`=== Fix agent started for issue #${number}: ${title} ===`);

  const prompt = `
GitHub Issue #${number} 자동 처리:

제목: ${title}
내용:
${body || '(내용 없음)'}

라벨: ${(labels || []).map(l => l.name).join(', ')}

다음 순서로 작업해주세요:
1. 이슈 내용을 분석하여 문제 파악
2. 관련 파일들을 찾아서 읽기
3. 코드 수정 (버그 수정 또는 기능 구현)
4. 변경사항 테스트 (빌드 확인)
5. 작업 완료 시 요약 제공

작업 중 발견한 문제나 불확실한 부분은 명확히 보고해주세요.
`.trim();

  const output = await runClaude(prompt, config.claude.allowedTools, `fix-${number}`);
  logger.info(`Fix agent output for issue #${number}`, { outputSnippet: output.substring(0, 300) });
  return output;
}

/**
 * 리뷰 피드백을 기반으로 Claude Code 재수정 실행
 */
async function refixFromReview(issueData, reviewFeedback, retryCount) {
  const { number, title, body } = issueData;

  logger.info(`=== Re-fix agent started for issue #${number} (retry ${retryCount}/${config.claude.maxRetries}) ===`);

  const prompt = `
GitHub Issue #${number} 재수정 요청 (${retryCount}차 재시도):

원래 이슈 제목: ${title}
원래 이슈 내용:
${body || '(내용 없음)'}

---

코드 리뷰에서 아래 문제가 발견되었습니다. 이 문제들을 해결해주세요:

${reviewFeedback}

---

다음 순서로 작업해주세요:
1. 리뷰에서 지적된 문제를 분석
2. 관련 파일을 찾아서 읽기
3. 문제를 수정
4. 빌드 확인
5. 수정 내용 요약 제공

반드시 리뷰에서 지적된 문제를 모두 해결해주세요.
`.trim();

  const output = await runClaude(prompt, config.claude.allowedTools, `refix-${number}-${retryCount}`);
  logger.info(`Re-fix agent output for issue #${number}`, { outputSnippet: output.substring(0, 300) });
  return output;
}

/**
 * Issue 수정 후 브랜치 생성, PR 생성
 */
async function processWithPR(issueData) {
  const { number, title } = issueData;
  const { owner, repo } = config;
  const branchName = `${config.branchPrefix}/issue-${number}`;

  try {
    // 1. 라벨 업데이트 & 코멘트
    await githubApi.updateIssueLabels(owner, repo, number, [config.labels.inProgress]);
    await githubApi.commentOnIssue(owner, repo, number, '🤖 Claude가 이슈 처리를 시작합니다...');

    // 2. 브랜치 생성
    logger.info(`Creating branch ${branchName} for issue #${number}`);
    await gitOps.checkoutNew(branchName, config.baseBranch);

    // 3. Claude Code로 수정
    const claudeOutput = await fixIssue(issueData);

    // 4. 변경사항 커밋 & 푸시
    const hasChanges = await gitOps.hasChanges();
    if (!hasChanges) {
      logger.warn(`No changes detected for issue #${number}`);
      await githubApi.commentOnIssue(owner, repo, number,
        '⚠️ Claude가 코드를 분석했으나 변경사항이 없습니다.\n\n' +
        `**분석 결과:**\n\`\`\`\n${claudeOutput.substring(0, 1000)}\n\`\`\``
      );
      await gitOps.checkout(config.baseBranch);
      return { success: false, reason: 'no-changes' };
    }

    await gitOps.commit(`fix: #${number} ${title}`);
    await gitOps.push(branchName, true);
    logger.info(`Branch ${branchName} pushed for issue #${number}`);

    // 5. PR 생성
    const pr = await githubApi.createPullRequest(owner, repo, {
      title: `fix: #${number} ${title}`,
      body: `Closes #${number}\n\n자동 수정 by Claude Code\n\n**변경 요약:**\n${claudeOutput.substring(0, 2000)}`,
      head: branchName,
      base: config.baseBranch,
    });

    logger.info(`PR #${pr.number} created for issue #${number}`);
    await githubApi.commentOnIssue(owner, repo, number,
      `🔧 코드 수정이 완료되었습니다. PR #${pr.number} 이 생성되었습니다.\n\n` +
      `**변경 요약:**\n\`\`\`\n${claudeOutput.substring(0, 500)}${claudeOutput.length > 500 ? '...' : ''}\n\`\`\``
    );

    return { success: true, prNumber: pr.number, branchName };

  } catch (error) {
    logger.error(`Fix agent failed for issue #${number}`, { error: error.message, stack: error.stack });
    await githubApi.commentOnIssue(owner, repo, number,
      `❌ 자동 수정 중 오류 발생:\n\n\`\`\`\n${error.message}\n\`\`\``
    ).catch(e => logger.error(`Failed to comment on error: ${e.message}`));

    // 원래 브랜치로 복귀
    await gitOps.checkout(config.baseBranch).catch(() => {});
    return { success: false, error: error.message };
  }
}

module.exports = {
  fixIssue,
  refixFromReview,
  processWithPR,
};
