const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const githubApi = require('./github-api');

/**
 * 머지된 수정 1건을 루터(Rootr) DATABASE에 "자연어"로 기록한다.
 *
 * 목적: QA가 GitHub 이슈·PR·diff를 읽지 않고도 표 한 줄만 보고
 *       "어디가 / 뭐가 문제였고 / 어떻게 고쳤고 / 어떻게 확인하는지"를 알 수 있게 한다.
 *
 * 원칙: 여기서 무슨 일이 나도 머지·배포 파이프라인은 절대 막지 않는다 (전부 soft-fail).
 */

const TEMP_DIR = path.join(__dirname, '..');

/** diff·본문에서 프롬프트에 넣을 분량만 잘라낸다 */
function clip(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.substring(0, max)}\n...(이하 생략)` : text;
}

/** 변경 파일 경로로 v1/v2/공통 판별 — 화면 버전은 QA가 가장 먼저 보는 축이다 */
function guessVersion(files) {
  const paths = (files || []).map(f => (typeof f === 'string' ? f : f.filename || ''));
  const hasV2 = paths.some(p => /\/v2\/|V2\.tsx|v2\./i.test(p));
  const hasV1 = paths.some(p => /\/v1\/|\/pages\/(?!v2\/)/i.test(p));
  if (hasV2 && !hasV1) return 'v2';
  if (hasV1 && !hasV2) return 'v1';
  if (hasV2 && hasV1) return '공통';
  return '공통';
}

/**
 * Claude로 QA용 자연어 요약 생성.
 * 코드·diff는 여기서만 읽고, 표에는 사람 말만 남긴다.
 */
async function summarizeForQA({ issueNumber, issueTitle, issueBody, diff, files }) {
  const fileList = (files || [])
    .map(f => (typeof f === 'string' ? f : `${f.filename} (+${f.additions}/-${f.deletions})`))
    .join('\n');

  const prompt = `아래는 방금 배포된 웹 서비스 수정 1건의 원본 자료다.
이 내용을 **QA 담당자(비개발자)** 가 읽고 바로 확인에 들어갈 수 있도록 자연어로 정리하라.

[이슈 #${issueNumber}] ${issueTitle}

--- 이슈 본문 ---
${clip(issueBody, 4000) || '(본문 없음)'}

--- 변경 파일 ---
${clip(fileList, 2000) || '(목록 없음)'}

--- 변경 내용(diff) ---
${clip(diff, 30000) || '(diff 없음)'}

아래 JSON **한 개만** 출력하라. 코드블록·설명·서론 없이 JSON만.
{
  "summary": "무엇이 어떻게 달라졌는지 한 문장. 40자 내외. 예: '신규 프로젝트 저장 후 대시보드로 바로 넘어가도록 수정'",
  "screen": "QA가 찾아갈 수 있는 화면·메뉴 이름. 예: '프로젝트 기본정보(신규 생성)'",
  "problem": "고치기 전에 사용자가 겪던 증상. 2~3문장, 사용자 눈에 보이는 현상으로만 서술",
  "fix": "무엇을 바꿔서 해결했는지. 2~3문장. 함수명·변수명 대신 동작으로 설명",
  "howToCheck": "QA 확인 절차. '1) ... 2) ... 3) 기대결과: ...' 형태의 번호 목록 한 덩어리",
  "impact": "같이 영향받을 수 있는 다른 화면·기능, 또는 회귀 확인이 필요한 부분. 없으면 '해당 수정 화면 외 영향 없음'"
}

규칙:
- 개발 용어(컴포넌트·state·useEffect·props·API 엔드포인트명)를 쓰지 말 것. 화면과 동작으로만 쓸 것.
- diff에서 실제로 확인되는 사실만 쓸 것. 추측·과장 금지.
- 모든 값은 한국어 평문. 줄바꿈은 howToCheck에서만 사용.`;

  const ts = Date.now();
  const promptFile = path.join(TEMP_DIR, `prompt-changelog-${issueNumber}-${ts}.txt`);
  const outputFile = path.join(TEMP_DIR, `claude-output-changelog-${issueNumber}-${ts}.txt`);
  await fs.writeFile(promptFile, prompt);

  const raw = await new Promise((resolve, reject) => {
    const cmd = `cd "${config.workspaceDir}" && cat "${promptFile}" | claude -p --output-format json `
      + `--disallowedTools "Bash,Task,Agent,Edit,Write" > "${outputFile}" 2>&1`;
    exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: config.changelog.timeout }, async (error) => {
      let out = '';
      try { out = await fs.readFile(outputFile, 'utf-8'); } catch (_) {}
      await fs.unlink(promptFile).catch(() => {});
      await fs.unlink(outputFile).catch(() => {});
      if (error) return reject(new Error(`요약 생성 실패: ${error.message}`));
      resolve(out);
    });
  });

  let text = raw;
  try { text = JSON.parse(raw).result || raw; } catch (_) { /* JSON 래핑이 아니면 원문 사용 */ }

  // 앞뒤 설명이 붙어도 본문 JSON만 건져낸다
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('요약 JSON을 찾지 못함');
  return JSON.parse(text.substring(start, end + 1));
}

/** 루터 DATABASE에 행 1개 추가 */
async function appendRow(values) {
  const { baseUrl, dbId, apiKey } = config.changelog;
  const res = await fetch(`${baseUrl}/databases/${dbId}/rows/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ rows: [values] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Rootr ${res.status}: ${body.substring(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * 수정 1건 기록. 실패해도 예외를 던지지 않는다.
 *
 * @param {object} p
 * @param {number} p.issueNumber   이슈 번호
 * @param {string} p.issueTitle    이슈 제목
 * @param {string} p.issueBody     이슈 본문
 * @param {number} [p.prNumber]    프론트 PR 번호 (백엔드 전용 수정이면 생략)
 * @param {string} [p.repo]        PR이 있는 레포 (기본: 프론트 레포)
 * @param {boolean} [p.deployed]   라이브 반영 여부
 * @param {string} [p.note]        표에 덧붙일 비고 (예: 백엔드 전용 수정)
 */
async function record(p) {
  if (!config.changelog.enabled) return { skipped: true, reason: 'disabled' };
  if (!config.changelog.apiKey || !config.changelog.dbId) {
    logger.warn('Changelog skipped: ROOTR_API_KEY 또는 ROOTR_CHANGELOG_DB_ID 미설정');
    return { skipped: true, reason: 'not-configured' };
  }

  const { issueNumber, issueTitle, issueBody, prNumber, deployed, note } = p;
  const repo = p.repo || config.repo;

  try {
    let diff = '';
    let files = [];
    if (prNumber) {
      try { diff = await githubApi.getPullRequestDiff(config.owner, repo, prNumber); } catch (_) {}
      try { files = await githubApi.getPullRequestFiles(config.owner, repo, prNumber); } catch (_) {}
    }

    const s = await summarizeForQA({ issueNumber, issueTitle, issueBody, diff, files });

    const fileNames = (files || [])
      .map(f => (typeof f === 'string' ? f : f.filename))
      .filter(Boolean);

    const issueUrl = `https://github.com/${config.owner}/${config.repo}/issues/${issueNumber}`;
    const prUrl = prNumber ? `https://github.com/${config.owner}/${repo}/pull/${prNumber}` : '';

    const values = {
      '수정 내용 (한 줄 요약)': s.summary || issueTitle,
      '상태': '확인 대기',
      '어디가 바뀌었나 (화면)': s.screen || '',
      '어떤 문제가 있었나': s.problem || '',
      '어떻게 고쳤나': s.fix || '',
      'QA 확인 방법': s.howToCheck || '',
      '영향 범위 / 주의사항': [s.impact, note].filter(Boolean).join('\n'),
      '버전': guessVersion(files),
      '반영 일시': { start: new Date().toISOString().slice(0, 16) },
      '라이브 반영': deployed !== false,
      '이슈': issueUrl,
      '변경 파일': fileNames.join('\n'),
    };
    if (prUrl) values['PR'] = prUrl;

    await appendRow(values);
    logger.info(`Changelog recorded to Rootr for issue #${issueNumber}`);
    return { recorded: true };
  } catch (err) {
    // 기록 실패가 머지·배포를 막아선 안 된다
    logger.error(`Changelog record failed for issue #${p.issueNumber}: ${err.message}`);
    return { recorded: false, error: err.message };
  }
}

module.exports = { record, summarizeForQA, guessVersion };
