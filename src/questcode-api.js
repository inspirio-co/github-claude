const https = require('https');
const config = require('./config');
const logger = require('./logger');

function makeRequest(pathStr, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, config.questcode.apiUrl);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${config.questcode.apiToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'github-claude',
      },
    };

    logger.debug(`QuestCode API: ${method} ${url.pathname}`);

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
          logger.error(`QuestCode API error`, { status: res.statusCode, path: url.pathname, body: body.substring(0, 500) });
          reject(new Error(`QuestCode API error ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', (err) => {
      logger.error(`QuestCode API network error: ${err.message}`);
      reject(err);
    });

    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function startQAJob(params) {
  const payload = {
    url: params.url || config.questcode.siteUrl,
    testCase: params.testCase,
    spec: params.spec || '',
    ragUrl: params.ragUrl || null,
    credentialId: params.credentialId || config.questcode.credentialId,
  };

  logger.info('Starting QuestCode QA Job', { url: payload.url, testCaseLength: payload.testCase.length });

  const result = await makeRequest('/api/qa', 'POST', payload);
  if (result.id && !result.jobId) {
    result.jobId = result.id;
  }

  logger.info(`QuestCode QA Job started`, { jobId: result.jobId });
  return result;
}

async function cancelQAJob(jobId) {
  logger.info(`Cancelling QuestCode QA Job ${jobId}`);
  return makeRequest(`/api/qa/jobs/${jobId}/cancel`, 'POST');
}

async function getQAReports() {
  return makeRequest('/api/qa/reports', 'GET');
}

/**
 * QuestCode 리포트에서 실패/미완성 항목 확인
 */
function hasFailures(result) {
  if (!result) return false;

  if (result.passed === false) return true;
  if (result.success === false) return true;
  if (result.status === 'failed') return true;

  const report = (result.report || '').toLowerCase();
  const failurePatterns = [
    /fail/i, /error/i, /❌/, /불합격/, /실패/,
    /미완성/, /incomplete/i, /broken/i, /not working/i,
    /bug/i, /issue found/i, /문제 발견/, /오류/,
  ];

  for (const pattern of failurePatterns) {
    if (pattern.test(report)) return true;
  }

  if (typeof result.score === 'number' && result.score < 80) return true;

  return false;
}

/**
 * Issue에 대한 QA 테스트 케이스 생성 및 Job 시작
 */
async function startQAForIssue(issueData) {
  const { number, title, body } = issueData;

  const testCase = `
이슈 #${number}: ${title}

테스트 목표:
${body || '(내용 없음)'}

검증 사항:
1. 사이트가 정상적으로 로드되는지 확인
2. 이슈에서 언급된 기능이 정상 작동하는지 확인
3. 로그인 후 주요 기능 접근 가능 여부 확인
4. 콘솔 에러가 없는지 확인
`.trim();

  logger.info(`Starting QA job for issue #${number}`);

  try {
    const result = await startQAJob({
      url: config.questcode.siteUrl,
      testCase,
      spec: `이슈 #${number}에 대한 자동화된 QA 테스트`,
    });

    logger.info(`QuestCode Job started for issue #${number}`, { jobId: result.jobId });
    return { success: true, jobId: result.jobId, pending: true };
  } catch (error) {
    logger.error(`QuestCode Job start failed for issue #${number}`, { error: error.message });
    return { success: false, error: error.message, pending: false };
  }
}

module.exports = { startQAJob, cancelQAJob, getQAReports, hasFailures, startQAForIssue };
