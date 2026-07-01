const { exec } = require('child_process');
const config = require('./config');
const logger = require('./logger');
const githubApi = require('./github-api');

/**
 * 백엔드 워크스페이스에서 셸 명령 실행 (git / build / deploy 공용).
 * git-ops.js(프론트 전역 워크스페이스 전용)를 건드리지 않도록 독립 실행기를 둔다.
 */
function sh(cmd, { cwd = config.backend.workspaceDir, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd}: ${stderr || error.message}`));
      } else {
        resolve((stdout || '').trim());
      }
    });
  });
}

/**
 * porcelain 출력에서 변경 파일 목록 추출 (leading space 보존을 위해 raw stdout 사용)
 */
function parsePorcelain(raw) {
  return raw.split('\n')
    .filter(Boolean)
    .map(line => {
      const file = line.slice(3); // XY(2) + 공백(1) 고정
      const arrowIdx = file.indexOf(' -> ');
      return arrowIdx >= 0 ? file.slice(arrowIdx + 4) : file;
    })
    .filter(Boolean);
}

async function getBackendChangedFiles() {
  const dir = config.backend.workspaceDir;
  return new Promise((resolve) => {
    exec('git status --porcelain', { cwd: dir, maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      resolve(parsePorcelain(stdout));
    });
  });
}

/**
 * 프론트 이슈 처리 중 fix 에이전트가 백엔드 파일을 수정했는지 확인하고,
 * 수정이 있으면 백엔드 레포에 브랜치·커밋·PR 생성 → 빌드 → (성공 시) 머지+배포까지 수행한다.
 *
 * @param {{number:number,title:string}} issueData - 원본(프론트) 이슈
 * @param {string[]} preDirty - fix 실행 전 이미 dirty였던 백엔드 파일(있다면 제외)
 * @returns {Promise<null | {prNumber:number, deployed:boolean, buildFailed?:boolean, files:string[]}>}
 */
async function handleBackendChanges(issueData, preDirty = []) {
  if (!config.backend.enabled) return null;

  const { number, title } = issueData;
  const dir = config.backend.workspaceDir;
  const owner = config.owner;
  const repo = config.backend.repo;
  const base = config.backend.baseBranch;
  const branch = `${config.branchPrefix}/issue-${number}`;

  const preSet = new Set(preDirty);
  const allChanged = await getBackendChangedFiles();
  const files = allChanged.filter(f => !preSet.has(f));

  if (files.length === 0) {
    logger.info(`Backend: no changes for issue #${number}`);
    return null;
  }

  logger.info(`Backend: ${files.length} changed file(s) for issue #${number}`, { files });

  // 워크스페이스 안전장치: .env / prisma migration / node_modules 는 커밋 대상에서 제외
  const forbidden = files.filter(f =>
    f.includes('node_modules/') ||
    f === '.env' || f.endsWith('/.env') ||
    f.includes('prisma/migrations/')
  );
  const commitFiles = files.filter(f => !forbidden.includes(f));
  if (forbidden.length > 0) {
    logger.warn(`Backend: excluding forbidden files from commit`, { forbidden });
  }
  if (commitFiles.length === 0) {
    logger.warn(`Backend: only forbidden files changed, skipping (issue #${number})`);
    return null;
  }

  try {
    // 1. 현재(main) 상태에서 변경분을 담은 브랜치 생성 (checkout -b는 미커밋 변경을 그대로 가져감)
    //    기존 동일 브랜치가 있으면 삭제 후 재생성
    await sh(`git branch -D ${branch}`).catch(() => {});
    await sh(`git checkout -b ${branch}`);

    // 2. 허용된 파일만 스테이징 후 커밋
    const escaped = commitFiles.map(f => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    await sh(`git add -- ${escaped}`);
    await sh(`git commit -m "[#${number}] ${title.replace(/"/g, '\\"')} (backend)"`);
    await sh(`git push origin ${branch} --force`);
    logger.info(`Backend: branch ${branch} pushed`);

    // 3. PR 생성 (기존 PR 재사용)
    let pr;
    try {
      const existing = await githubApi.listPullRequestsForBranch(owner, repo, branch);
      if (Array.isArray(existing) && existing.length > 0) pr = existing[0];
    } catch (_) {}
    if (!pr) {
      pr = await githubApi.createPullRequest(owner, repo, {
        title: `[#${number}] ${title} (backend)`,
        body: `프론트 이슈 EQUAL-TABLE/mrv-frontend#${number} 의 근본원인이 백엔드에 있어 자동 생성된 PR입니다.\n\n**변경 파일:**\n${commitFiles.map(f => '- ' + f).join('\n')}`,
        head: branch,
        base,
      });
    }
    logger.info(`Backend: PR #${pr.number} ready for issue #${number}`);

    // 4. 빌드 (성공해야만 머지·배포)
    let buildOk = true;
    let buildErr = '';
    try {
      logger.info(`Backend: build started for PR #${pr.number}`);
      await sh(config.backend.buildCommand, { timeout: 420000 });
      logger.info(`Backend: build succeeded for PR #${pr.number}`);
    } catch (e) {
      buildOk = false;
      buildErr = e.message;
      logger.error(`Backend: build FAILED for PR #${pr.number}`, { error: e.message });
    }

    if (!buildOk) {
      // 배포하지 않고 PR 열어둔 채 보고. 워크스페이스는 main으로 되돌림.
      await restoreMain();
      await githubApi.commentOnIssue(owner, repo, number,
        `⚠️ 백엔드 근본원인을 수정해 PR EQUAL-TABLE/mrv-backend#${pr.number} 을 만들었으나 **빌드가 실패**하여 배포하지 않았습니다. 수동 검토가 필요합니다.\n\n\`\`\`\n${buildErr.substring(0, 800)}\n\`\`\``
      ).catch(() => {});
      return { prNumber: pr.number, deployed: false, buildFailed: true, files: commitFiles };
    }

    // 5. 머지 (squash) → 배포 (pm2 restart)
    await githubApi.mergePullRequest(owner, repo, pr.number, { mergeMethod: 'squash' });
    logger.info(`Backend: PR #${pr.number} merged`);

    let deployed = false;
    let deployErr = '';
    try {
      logger.info(`Backend: deploy started (${config.backend.deployCommand})`);
      await sh(config.backend.deployCommand, { timeout: 120000 });
      deployed = true;
      logger.info(`Backend: deploy succeeded for PR #${pr.number}`);
    } catch (e) {
      deployErr = e.message;
      logger.error(`Backend: deploy FAILED for PR #${pr.number}`, { error: e.message });
    }

    // 6. 워크스페이스를 최신 main으로 동기화 + 임시 브랜치 정리
    await restoreMain(branch);
    try { await githubApi.deleteBranch(owner, repo, branch); } catch (_) {}

    // 7. 프론트 이슈에 결과 보고
    if (deployed) {
      await githubApi.commentOnIssue(owner, repo, number,
        `🛠️ 근본원인이 백엔드에 있어 백엔드까지 수정했습니다. PR EQUAL-TABLE/mrv-backend#${pr.number} 머지 + 빌드 + \`pm2 restart mrv-backend\` **라이브 배포 완료**.\n\n**변경 파일:**\n${commitFiles.map(f => '- ' + f).join('\n')}`
      ).catch(() => {});
    } else {
      await githubApi.commentOnIssue(owner, repo, number,
        `🛠️ 백엔드 PR EQUAL-TABLE/mrv-backend#${pr.number} 머지 및 빌드는 성공했으나 **배포(pm2 restart) 단계에서 오류**가 발생했습니다. 수동 재시작이 필요합니다.\n\n\`\`\`\n${deployErr.substring(0, 500)}\n\`\`\``
      ).catch(() => {});
    }

    return { prNumber: pr.number, deployed, files: commitFiles };

  } catch (error) {
    logger.error(`Backend fix failed for issue #${number}`, { error: error.message, stack: error.stack });
    await restoreMain(branch).catch(() => {});
    await githubApi.commentOnIssue(owner, repo, number,
      `❌ 백엔드 자동 수정 중 오류 발생:\n\n\`\`\`\n${error.message.substring(0, 800)}\n\`\`\``
    ).catch(() => {});
    return { prNumber: null, deployed: false, error: error.message, files: commitFiles };
  }
}

/**
 * 백엔드 워크스페이스를 최신 main으로 되돌리고(임시 브랜치가 있으면 정리) 깨끗하게 만든다.
 */
async function restoreMain(branch = null) {
  const base = config.backend.baseBranch;
  try {
    await sh(`git checkout -- .`).catch(() => {});
    await sh(`git checkout ${base}`);
    await sh(`git pull origin ${base}`).catch(() => {});
    if (branch) await sh(`git branch -D ${branch}`).catch(() => {});
  } catch (e) {
    logger.warn(`Backend: restoreMain warning: ${e.message}`);
  }
}

module.exports = { handleBackendChanges, getBackendChangedFiles };
