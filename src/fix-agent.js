const { exec } = require('child_process');
const fs = require('fs').promises;
const https = require('https');
const http = require('http');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const gitOps = require('./git-ops');
const githubApi = require('./github-api');

const TEMP_DIR = path.join(__dirname, '..');
const IMAGES_DIR = path.join(TEMP_DIR, 'issue-images');

/**
 * 텍스트에서 이미지 URL 추출 (GitHub 이슈 마크다운)
 */
function extractImageUrls(text) {
  if (!text) return [];
  const urls = [];
  // ![alt](url) 패턴
  const mdPattern = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = mdPattern.exec(text)) !== null) {
    urls.push(match[1]);
  }
  // <img src="url"> 패턴
  const imgPattern = /<img[^>]+src=["'](https?:\/\/[^\s"']+)["'][^>]*>/gi;
  while ((match = imgPattern.exec(text)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

/**
 * URL에서 이미지 다운로드 (리다이렉트 지원)
 */
function downloadImage(url, filePath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects'));
    }
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'github-claude' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location, filePath, maxRedirects - 1)
          .then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const fileStream = require('fs').createWriteStream(filePath);
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(filePath); });
      fileStream.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * 이슈 body + 댓글에서 이미지를 추출하여 다운로드
 * 반환: { imagePaths: string[], imageSection: string }
 */
async function downloadIssueImages(issueNumber, texts) {
  const allUrls = [];
  for (const text of texts) {
    allUrls.push(...extractImageUrls(text));
  }

  if (allUrls.length === 0) {
    return { imagePaths: [], imageSection: '' };
  }

  // 이미지 디렉토리 생성
  const issueImgDir = path.join(IMAGES_DIR, `issue-${issueNumber}`);
  await fs.mkdir(issueImgDir, { recursive: true });

  const imagePaths = [];
  for (let i = 0; i < allUrls.length; i++) {
    const url = allUrls[i];
    const ext = path.extname(new URL(url).pathname) || '.png';
    const filePath = path.join(issueImgDir, `image-${i + 1}${ext}`);
    try {
      await downloadImage(url, filePath);
      imagePaths.push(filePath);
      logger.info(`Image downloaded for issue #${issueNumber}`, { index: i + 1, url: url.substring(0, 100) });
    } catch (err) {
      logger.warn(`Failed to download image for issue #${issueNumber}`, { url: url.substring(0, 100), error: err.message });
    }
  }

  if (imagePaths.length === 0) {
    return { imagePaths: [], imageSection: '' };
  }

  const imageSection = `\n\n첨부 이미지 (${imagePaths.length}개):
이슈에 첨부된 스크린샷을 반드시 확인하세요. Read 도구로 아래 이미지 파일을 읽어서 현재 UI 상태를 파악한 후 수정하세요.
${imagePaths.map((p, i) => `- 이미지 ${i + 1}: ${p}`).join('\n')}`;

  logger.info(`Issue #${issueNumber} images downloaded`, { count: imagePaths.length });
  return { imagePaths, imageSection };
}

/**
 * 이슈 이미지 임시 파일 정리
 */
async function cleanupIssueImages(issueNumber) {
  const issueImgDir = path.join(IMAGES_DIR, `issue-${issueNumber}`);
  try {
    await fs.rm(issueImgDir, { recursive: true, force: true });
  } catch (_) {}
}

// 이슈별 세션 ID 저장 (메모리 + 파일 백업)
const SESSION_FILE = path.join(TEMP_DIR, 'sessions.json');
let issueSessions = {};

async function loadSessions() {
  try {
    const data = await fs.readFile(SESSION_FILE, 'utf-8');
    issueSessions = JSON.parse(data);
    logger.info('Sessions loaded', { count: Object.keys(issueSessions).length });
  } catch (_) {
    issueSessions = {};
  }
}

async function saveSessions() {
  try {
    await fs.writeFile(SESSION_FILE, JSON.stringify(issueSessions, null, 2));
  } catch (err) {
    logger.warn(`Failed to save sessions: ${err.message}`);
  }
}

// 초기 로드
loadSessions();

/**
 * Claude Code CLI 실행 (세션 지원)
 * - sessionId가 있으면 --resume으로 이전 세션 이어서 실행
 * - 실행 후 session_id를 반환
 */
async function runClaude(prompt, tools, label, sessionId = null) {
  return _execClaude(prompt, tools, label, sessionId).catch(async (err) => {
    // resume 실패 시 새 세션으로 재시도
    if (sessionId) {
      logger.warn(`Resume failed for ${label}, retrying without session`, { error: err.message });
      return _execClaude(prompt, tools, label, null);
    }
    throw err;
  });
}

async function _execClaude(prompt, tools, label, sessionId) {
  const ts = Date.now();
  const promptFile = path.join(TEMP_DIR, `prompt-${label}-${ts}.txt`);
  const outputFile = path.join(TEMP_DIR, `claude-output-${label}-${ts}.txt`);

  await fs.writeFile(promptFile, prompt);

  const resumeFlag = sessionId ? ` --resume "${sessionId}"` : '';
  logger.info(`Claude Code started (${label})`, {
    promptLength: prompt.length,
    tools,
    resumeSession: sessionId || 'new',
  });

  return new Promise((resolve, reject) => {
    const disallowed = config.claude.disallowedTools ? ` --disallowedTools "${config.claude.disallowedTools}"` : '';
    const cmd = `cd "${config.workspaceDir}" && cat "${promptFile}" | claude -p --output-format json --allowedTools "${tools}"${disallowed}${resumeFlag} > "${outputFile}" 2>&1`;

    exec(cmd, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: config.claude.timeout,
    }, async (error, stdout, stderr) => {
      let rawOutput = '';
      try {
        rawOutput = await fs.readFile(outputFile, 'utf-8');
      } catch (_) {
        rawOutput = stderr || '';
      }

      // 임시 파일 정리
      await fs.unlink(promptFile).catch(() => {});
      await fs.unlink(outputFile).catch(() => {});

      // JSON 파싱하여 session_id와 result 추출
      let result = rawOutput;
      let newSessionId = null;

      try {
        const parsed = JSON.parse(rawOutput);
        result = parsed.result || rawOutput;
        newSessionId = parsed.session_id || null;
      } catch (_) {
        logger.warn(`Claude output is not JSON (${label}), using raw output`);
      }

      if (error) {
        logger.error(`Claude Code failed (${label})`, { error: error.message, outputSnippet: result.substring(0, 300) });
        reject(new Error(`Claude Code error: ${error.message}\nOutput: ${result.substring(0, 500)}`));
      } else {
        logger.info(`Claude Code completed (${label})`, { outputLength: result.length, sessionId: newSessionId });
        resolve({ output: result, sessionId: newSessionId });
      }
    });
  });
}

/**
 * Issue를 기반으로 Claude Code 수정 실행
 */
async function fixIssue(issueData) {
  const { number, title, body, labels } = issueData;
  const { owner, repo } = config;
  const existingSessionId = issueSessions[number] || null;

  logger.info(`=== Fix agent started for issue #${number}: ${title} ===`, {
    hasExistingSession: !!existingSessionId,
  });

  // 이슈 댓글 가져오기 (봇 댓글 제외, 사람이 쓴 것만)
  let commentsSection = '';
  const allTexts = [body || '']; // 이미지 추출용 텍스트 모음
  try {
    const comments = await githubApi.getIssueComments(owner, repo, number);
    const humanComments = (Array.isArray(comments) ? comments : [])
      .filter(c => !c.body.startsWith('🤖') && !c.body.startsWith('🔍') && !c.body.startsWith('🔧') && !c.body.startsWith('❌') && !c.body.startsWith('⚠️') && !c.body.startsWith('🔄') && !c.body.startsWith('📝') && !c.body.startsWith('✅'));

    humanComments.forEach(c => allTexts.push(c.body));

    const commentText = humanComments
      .map(c => `[${c.user?.login || 'unknown'}]: ${c.body}`)
      .join('\n\n');

    if (commentText) {
      commentsSection = `\n\n추가 댓글 (최신 피드백 우선 반영):\n${commentText}`;
      logger.info(`Issue #${number} has human comments`, { count: humanComments.length });
    }
  } catch (err) {
    logger.warn(`Failed to fetch comments for issue #${number}: ${err.message}`);
  }

  // 이미지 다운로드
  const { imageSection } = await downloadIssueImages(number, allTexts);

  const safetyRules = `
⚠️ 안전 규칙 (반드시 준수):
- 작업 경로: ${config.workspaceDir} 내부 파일만 읽기/수정 가능. 이 경로 외부의 파일은 절대 접근하지 마세요.
- git reset, git clean, git checkout -- ., rm -rf 등 파괴적 명령은 절대 실행하지 마세요.
- .env, 설정 파일, package.json, package-lock.json은 수정하지 마세요.
- node_modules/ 디렉토리는 건드리지 마세요.
`;

  let prompt;
  if (existingSessionId) {
    prompt = `
이전에 이 이슈를 수정한 적이 있습니다. 이번에 다시 수정 요청이 들어왔습니다.
${safetyRules}
GitHub Issue #${number}: ${title}
${commentsSection || '(추가 댓글 없음)'}${imageSection}

이전 수정에서 부족했던 부분이 있거나, 댓글에 새로운 요구사항이 있을 수 있습니다.
댓글 내용을 우선적으로 확인하고, 이전 수정 내역을 기반으로 추가 수정을 진행해주세요.
기존에 수정한 파일들을 다시 확인하고, 필요한 부분만 수정하세요.
`.trim();
  } else {
    prompt = `
GitHub Issue #${number} 자동 처리:
${safetyRules}
제목: ${title}
내용:
${body || '(내용 없음)'}${commentsSection}${imageSection}

라벨: ${(labels || []).map(l => l.name).join(', ')}

다음 순서로 작업해주세요:
1. 이슈 내용과 댓글을 모두 분석하여 문제 파악 (댓글에 추가 요구사항이 있으면 반드시 반영)
2. 첨부 이미지가 있으면 Read 도구로 이미지를 확인하여 현재 UI 상태 파악
3. 관련 파일들을 찾아서 읽기
4. 코드 수정 (버그 수정 또는 기능 구현)
5. 변경사항 테스트 (빌드 확인)
6. 작업 완료 시 요약 제공

작업 중 발견한 문제나 불확실한 부분은 명확히 보고해주세요.
`.trim();
  }

  const { output, sessionId: newSessionId } = await runClaude(
    prompt,
    config.claude.allowedTools,
    `fix-${number}`,
    existingSessionId
  );

  // 세션 ID 저장
  if (newSessionId) {
    issueSessions[number] = newSessionId;
    await saveSessions();
    logger.info(`Session saved for issue #${number}`, { sessionId: newSessionId });
  }

  logger.info(`Fix agent output for issue #${number}`, { outputSnippet: output.substring(0, 300) });
  return output;
}

/**
 * 리뷰 피드백을 기반으로 Claude Code 재수정 실행
 */
async function refixFromReview(issueData, reviewFeedback, retryCount) {
  const { number, title, body } = issueData;
  const existingSessionId = issueSessions[number] || null;

  logger.info(`=== Re-fix agent started for issue #${number} (retry ${retryCount}/${config.claude.maxRetries}) ===`, {
    hasExistingSession: !!existingSessionId,
  });

  const prompt = `
GitHub Issue #${number} 재수정 요청 (${retryCount}차 재시도):

⚠️ 안전 규칙 (반드시 준수):
- 작업 경로: ${config.workspaceDir} 내부 파일만 읽기/수정 가능. 이 경로 외부의 파일은 절대 접근하지 마세요.
- git reset, git clean, git checkout -- ., rm -rf 등 파괴적 명령은 절대 실행하지 마세요.
- .env, 설정 파일, package.json, package-lock.json은 수정하지 마세요.
- node_modules/ 디렉토리는 건드리지 마세요.

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

  const { output, sessionId: newSessionId } = await runClaude(
    prompt,
    config.claude.allowedTools,
    `refix-${number}-${retryCount}`,
    existingSessionId
  );

  // 세션 ID 업데이트
  if (newSessionId) {
    issueSessions[number] = newSessionId;
    await saveSessions();
  }

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

    await gitOps.commit(`[#${number}] ${title}`);
    await gitOps.push(branchName, true);
    logger.info(`Branch ${branchName} pushed for issue #${number}`);

    // 5. PR 생성
    const pr = await githubApi.createPullRequest(owner, repo, {
      title: `[#${number}] ${title}`,
      body: `Related: #${number}\n\n자동 수정 by Claude Code\n\n**변경 요약:**\n${claudeOutput.substring(0, 2000)}`,
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
