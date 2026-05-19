const config = require('./config');
const logger = require('./logger');
const githubApi = require('./github-api');

/**
 * 이슈 본문에서 ## TC 섹션 파싱
 */
function parseTestCases(issueBody) {
  if (!issueBody) return [];

  const tcMatch = issueBody.match(/## TC\s*\n([\s\S]*?)(?=\n## |\n<!-- |$)/);
  if (!tcMatch) return [];

  const tcSection = tcMatch[1].trim();
  if (!tcSection) return [];

  const lines = tcSection.split('\n')
    .map(l => l.trim())
    .filter(l => /^\d+\./.test(l))
    .map(l => l.replace(/^\d+\.\s*/, ''));

  return lines;
}

/**
 * 이슈 본문에서 qa-retry 히든 태그 파싱
 */
function parseRetryCount(issueBody) {
  if (!issueBody) return { retryCount: 0, originalIssue: null };

  const match = issueBody.match(/<!-- qa-retry:(\d+)\s+from:#(\d+)\s*-->/);
  if (!match) return { retryCount: 0, originalIssue: null };

  return {
    retryCount: parseInt(match[1], 10),
    originalIssue: parseInt(match[2], 10),
  };
}

/**
 * QuestCode API: QA Job 생성
 */
async function startQAJob(url, testCase, options = {}) {
  const { apiToken, baseUrl, credentialId } = config.qa;

  const body = JSON.stringify({
    url,
    testCase,
    credentialId: options.credentialId || credentialId,
  });

  const parsedUrl = new URL('/api/qa', baseUrl);

  const response = await fetch(parsedUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`QuestCode API error (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * QuestCode API: 리포트 조회
 */
async function getReports() {
  const { apiToken, baseUrl } = config.qa;
  const parsedUrl = new URL('/api/qa/reports', baseUrl);

  const response = await fetch(parsedUrl.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`QuestCode reports API error (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * QA Job 결과 폴링
 */
async function pollJobResult(jobId, timeout) {
  const pollTimeout = timeout || config.qa.pollTimeout;
  const pollInterval = config.qa.pollInterval;
  const startTime = Date.now();

  while (Date.now() - startTime < pollTimeout) {
    const { apiToken, baseUrl } = config.qa;
    const parsedUrl = new URL(`/api/qa/jobs/${jobId}`, baseUrl);

    const response = await fetch(parsedUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`QuestCode job poll error (${response.status}): ${text}`);
    }

    const result = await response.json();

    if (result.status === 'completed' || result.status === 'failed') {
      return result;
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error(`QA job ${jobId} timed out after ${pollTimeout}ms`);
}

/**
 * QA 리포트를 마크다운 요약으로 포맷팅
 */
function formatReportSummary(result, report) {
  const lines = [];

  lines.push(`**상태**: ${result.passed ? '✅ 통과' : '❌ 실패'}`);

  if (report) {
    if (report.summary) lines.push(`**요약**: ${report.summary}`);
    if (report.duration) lines.push(`**소요시간**: ${report.duration}`);
    if (report.totalSteps != null) {
      lines.push(`**스텝**: ${report.passedSteps || 0}/${report.totalSteps} 통과`);
    }
    if (report.screenshotUrl) lines.push(`**스크린샷**: ${report.screenshotUrl}`);
    if (report.videoUrl) lines.push(`**영상**: ${report.videoUrl}`);

    // 개별 스텝 결과
    if (Array.isArray(report.steps) && report.steps.length > 0) {
      lines.push('');
      lines.push('| # | 스텝 | 결과 |');
      lines.push('|---|------|------|');
      for (const step of report.steps) {
        const icon = step.passed ? '✅' : '❌';
        const desc = (step.description || step.name || '').substring(0, 80);
        lines.push(`| ${step.index || '-'} | ${desc} | ${icon} ${step.error || ''} |`);
      }
    }

    // 에러 로그
    if (report.errorLog) {
      lines.push('');
      lines.push('<details><summary>에러 로그</summary>');
      lines.push('');
      lines.push('```');
      lines.push(report.errorLog.substring(0, 2000));
      lines.push('```');
      lines.push('</details>');
    }
  } else {
    // report 객체가 없으면 result에서 추출
    if (result.error) lines.push(`**오류**: ${result.error}`);
    if (result.message) lines.push(`**메시지**: ${result.message}`);
    if (result.details) lines.push(`**상세**: ${result.details}`);
  }

  return lines.join('\n');
}

/**
 * QA 실패 시 신규 이슈 생성
 */
async function createQAFailureIssue(originalIssueNumber, testCase, failureDetails, retryCount, report) {
  const { owner, repo } = config;
  const maxRetries = config.qa.maxRetries;
  const nextRetry = retryCount + 1;

  const failureSummary = failureDetails.substring(0, 80);
  const title = `[QA 실패] #${originalIssueNumber} - ${failureSummary}`;

  const labels = nextRetry < maxRetries
    ? [config.labels.trigger]
    : [config.labels.needsReview];

  // 리포트 상세 섹션 구성
  let reportSection = '';
  if (report) {
    const parts = [];
    if (report.summary) parts.push(`**요약**: ${report.summary}`);
    if (report.duration) parts.push(`**소요시간**: ${report.duration}`);
    if (report.totalSteps != null) {
      parts.push(`**스텝**: ${report.passedSteps || 0}/${report.totalSteps} 통과`);
    }
    if (report.screenshotUrl) parts.push(`**스크린샷**: ${report.screenshotUrl}`);
    if (report.videoUrl) parts.push(`**영상**: ${report.videoUrl}`);
    if (Array.isArray(report.steps) && report.steps.length > 0) {
      parts.push('');
      parts.push('| # | 스텝 | 결과 |');
      parts.push('|---|------|------|');
      for (const step of report.steps) {
        const icon = step.passed ? '✅' : '❌';
        const desc = (step.description || step.name || '').substring(0, 80);
        parts.push(`| ${step.index || '-'} | ${desc} | ${icon} ${step.error || ''} |`);
      }
    }
    if (parts.length > 0) {
      reportSection = `\n### QA 리포트\n${parts.join('\n')}\n`;
    }
  }

  const body = `## QA 실패 보고

원본 이슈: #${originalIssueNumber}
재시도 횟수: ${nextRetry}/${maxRetries}

### 실패 상세
\`\`\`
${failureDetails.substring(0, 3000)}
\`\`\`
${reportSection}
## TC
${testCase.map((tc, i) => `${i + 1}. ${tc}`).join('\n')}

<!-- qa-retry:${nextRetry} from:#${originalIssueNumber} -->
`;

  const opts = {
    hostname: 'api.github.com',
    port: 443,
    path: `/repos/${owner}/${repo}/issues`,
    method: 'POST',
    headers: {
      'User-Agent': 'github-claude',
      'Authorization': `Bearer ${config.githubToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  };

  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const issue = JSON.parse(responseBody);
          logger.info(`QA failure issue created: #${issue.number}`, { labels });

          // 라벨 부착
          githubApi.updateIssueLabels(owner, repo, issue.number, labels)
            .then(() => resolve(issue))
            .catch(err => {
              logger.warn(`Failed to set labels on QA failure issue #${issue.number}: ${err.message}`);
              resolve(issue);
            });
        } else {
          reject(new Error(`Failed to create QA failure issue: HTTP ${res.statusCode} ${responseBody}`));
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ title, body, labels }));
    req.end();
  });
}

/**
 * 메인 함수: PR 머지 후 QA 실행
 */
async function runQAAfterMerge(issueNumber, issueBody) {
  const testCases = parseTestCases(issueBody);

  if (testCases.length === 0) {
    logger.info(`Issue #${issueNumber}: No TC section found, skipping QA`);
    return { skipped: true, reason: 'no-tc' };
  }

  const { targetUrl } = config.qa;
  if (!targetUrl) {
    logger.warn(`QA_TARGET_URL not configured, skipping QA for issue #${issueNumber}`);
    return { skipped: true, reason: 'no-target-url' };
  }

  const { retryCount } = parseRetryCount(issueBody);

  logger.info(`Starting QA for issue #${issueNumber} (${testCases.length} test cases, retry: ${retryCount})`);

  const tcText = testCases.map((tc, i) => `${i + 1}. ${tc}`).join('\n');

  try {
    // QA Job 생성
    const job = await startQAJob(targetUrl, tcText);
    logger.info(`QA job created for issue #${issueNumber}`, { jobId: job.id || job.jobId });

    const jobId = job.id || job.jobId;

    // 결과 폴링
    const result = await pollJobResult(jobId);

    // 리포트 조회 (폴링 결과에 리포트가 없으면 별도 API로 조회)
    let report = result.report || null;
    if (!report && (result.reportId || jobId)) {
      try {
        const reports = await getReports();
        report = reports.find(r => r.jobId === jobId || r.id === result.reportId) || null;
      } catch (reportErr) {
        logger.warn(`Failed to fetch QA report for issue #${issueNumber}: ${reportErr.message}`);
      }
    }

    const reportSummary = formatReportSummary(result, report);

    if (result.status === 'completed' && result.passed) {
      logger.info(`QA passed for issue #${issueNumber}`);
      return { passed: true, result, report, reportSummary };
    }

    // QA 실패
    const failureDetails = result.error || result.message || result.details
      || (report && report.summary) || JSON.stringify(result);
    logger.info(`QA failed for issue #${issueNumber}`, { failureDetails: failureDetails.substring(0, 200) });

    // 실패 이슈 생성
    const failureIssue = await createQAFailureIssue(issueNumber, testCases, failureDetails, retryCount, report);

    return { passed: false, result, report, reportSummary, failureIssue };
  } catch (error) {
    logger.error(`QA execution error for issue #${issueNumber}`, { error: error.message });
    return { passed: false, error: error.message };
  }
}

module.exports = {
  parseTestCases,
  parseRetryCount,
  formatReportSummary,
  startQAJob,
  getReports,
  pollJobResult,
  createQAFailureIssue,
  runQAAfterMerge,
};
