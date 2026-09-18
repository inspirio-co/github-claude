const { exec } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
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
 * 파일 내용 해시. 사라진 파일은 빈 문자열.
 */
async function hashBackendFile(file) {
  return sh(`git hash-object -- "${file.replace(/"/g, '\\"')}"`, { timeout: 30000 }).catch(() => '');
}

/**
 * fix 실행 "전" 백엔드 워크스페이스의 dirty 스냅샷을 파일→내용해시 맵으로 뜬다.
 *
 * 경로 목록만으로 스냅샷을 뜨면, 이미 dirty였던 파일을 봇이 추가로 고쳤을 때 그 변경이
 * "봇이 안 건드린 파일"로 분류돼 커밋·빌드·배포가 통째로 스킵된다(#699 실제 사고:
 * projects.service.ts 가 다른 작업 때문에 미커밋 상태였고, 봇이 같은 파일의 stepStatus를
 * 고쳤으나 `Backend: no changes` 로 판정돼 pm2 재시작까지 전부 누락 → 소스만 고쳐진 채
 * 라이브는 옛 코드가 그대로 돌았다). 해시로 비교하면 같은 파일이어도 내용이 바뀌면 잡힌다.
 */
async function getBackendDirtySnapshot() {
  const files = await getBackendChangedFiles();
  const snapshot = {};
  for (const f of files) snapshot[f] = await hashBackendFile(f);
  return snapshot;
}

/**
 * 마이그레이션 누락 검사: prisma/migrations 를 전부 적용한 결과와 schema.prisma 를 비교한다.
 * 차이가 있으면 = 스키마만 고치고 마이그레이션을 안 만든 것 → 배포하면 코드가 없는 컬럼을
 * SELECT 해서 해당 모델의 모든 요청이 Prisma P2022 → 500 이 된다.
 *
 * @returns {Promise<{ok:boolean, sql?:string, error?:string}>}
 */
function checkMigrationDrift() {
  const cmd = 'npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script --exit-code';
  return new Promise((resolve) => {
    exec(cmd, { cwd: config.backend.workspaceDir, maxBuffer: 10 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
      const out = (stdout || '').trim();
      if (!error) return resolve({ ok: true });          // exit 0 = 차이 없음
      if (error.code === 2) return resolve({ ok: false, sql: out });  // exit 2 = 누락된 변경분
      // exit 1 = 검사 자체 실패(스키마 파싱 오류, shadow DB 미설정 등) — 배포를 막고 사람이 본다
      resolve({ ok: false, error: (stderr || error.message || '').trim() || out });
    });
  });
}

/**
 * 드리프트 SQL이 "자동 생성해도 안전한" 가산적 변경만으로 이뤄졌는지 판정한다.
 *
 * 안전 = 기존 컬럼·데이터를 잃지 않고, 기존 행 때문에 마이그레이션 자체가 실패할 일도 없는 것.
 * 컬럼 삭제·타입 변경·NOT NULL 승격·UNIQUE 인덱스는 데이터 사정에 따라 결과가 갈리므로
 * 사람이 판단해야 한다 → 종전대로 배포를 막는다.
 *
 * @returns {{safe:boolean, unsafe:string[]}}
 */
function classifyMigrationSql(sql) {
  const statements = (sql || '')
    .split('\n')
    .map(l => l.replace(/--.*$/, '').trim())   // 주석 제거
    .filter(Boolean)
    .join(' ')
    .split(';')
    .map(st => st.trim())
    .filter(Boolean);

  if (statements.length === 0) return { safe: false, unsafe: [] };

  const unsafe = [];
  for (const st of statements) {
    const s = st.replace(/\s+/g, ' ').toUpperCase();
    const additive =
      /^CREATE TABLE /.test(s) ||
      /^CREATE INDEX /.test(s) ||                 // UNIQUE 인덱스는 매칭되지 않음 → 차단
      /^CREATE TYPE /.test(s) ||
      /^ALTER TYPE .+ ADD VALUE/.test(s) ||
      /^ALTER TABLE .+ ADD CONSTRAINT .+ FOREIGN KEY/.test(s) ||
      // 컬럼 추가는 nullable이거나 DEFAULT가 있어야 기존 행이 살아남는다
      (/^ALTER TABLE .+ ADD COLUMN /.test(s) && (!/ NOT NULL/.test(s) || / DEFAULT /.test(s)));
    if (!additive) unsafe.push(st);
  }
  return { safe: unsafe.length === 0, unsafe };
}

/**
 * prisma 마이그레이션 디렉터리명에 쓰는 UTC 타임스탬프(YYYYMMDDHHmmss).
 * 기존 마이그레이션보다 항상 뒤에 정렬돼야 migrate deploy가 순서대로 적용한다.
 */
function migrationTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * migrate diff가 뽑아준 SQL을 그대로 새 마이그레이션 파일로 떨군다.
 *
 * fix 에이전트의 허용 툴은 Edit/Write/Glob/Grep/Read뿐이라 `prisma migrate dev`를 직접 돌릴 수
 * 없다. 즉 schema.prisma를 고치는 백엔드 수정은 구조적으로 항상 마이그레이션이 빈 채로 끝난다
 * (#787 실제 사고: 백엔드 PR이 드리프트로 영구 차단 → 프론트만 머지 → 리뷰가 계속
 * REQUEST_CHANGES → 이슈가 needs-review로 방치). 여기서 파일을 만들어 그 구멍을 메운다.
 *
 * @returns {Promise<{name:string, relPath:string}>}
 */
async function writeAutoMigration(sql, issueNumber) {
  const name = `${migrationTimestamp()}_auto_issue_${issueNumber}`;
  const relDir = path.join('prisma', 'migrations', name);
  const absDir = path.join(config.backend.workspaceDir, relDir);
  await fs.mkdir(absDir, { recursive: true });
  const header =
    `-- 자동 생성: 프론트 이슈 #${issueNumber} 처리 중 발생한 schema.prisma 변경분\n` +
    `-- (prisma migrate diff --from-migrations --to-schema 결과, 가산적 변경만 자동화)\n`;
  await fs.writeFile(path.join(absDir, 'migration.sql'), header + sql.trim() + '\n', 'utf8');
  return { name, relPath: path.join(relDir, 'migration.sql') };
}

/**
 * 파일 → porcelain 상태코드(XY) 맵. 신규 추가(??/A)와 수정·삭제(M/D/R)를 구분하는 데 쓴다.
 */
async function getBackendFileStatuses() {
  const dir = config.backend.workspaceDir;
  return new Promise((resolve) => {
    exec('git status --porcelain', { cwd: dir, maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const map = {};
      for (const line of stdout.split('\n').filter(Boolean)) {
        const status = line.slice(0, 2);
        const file = line.slice(3);
        const arrowIdx = file.indexOf(' -> ');
        map[arrowIdx >= 0 ? file.slice(arrowIdx + 4) : file] = status;
      }
      resolve(map);
    });
  });
}

/**
 * 마이그레이션 경로는 "신규 추가"만 허용한다.
 * 봇이 만든 새 마이그레이션은 반드시 커밋돼야 하지만([[prisma-migration-drift]]),
 * 이미 적용된 과거 마이그레이션의 수정·삭제는 DB와 히스토리를 깨뜨리므로 막는다.
 */
function isNewlyAddedMigration(file, status) {
  if (!file.includes('prisma/migrations/')) return false;
  if (file.endsWith('migration_lock.toml')) return false;
  return status === '??' || status.startsWith('A');
}

/**
 * 프론트 이슈 처리 중 fix 에이전트가 백엔드 파일을 수정했는지 확인하고,
 * 수정이 있으면 백엔드 레포에 브랜치·커밋·PR 생성 → 빌드 → (성공 시) 머지+배포까지 수행한다.
 *
 * @param {{number:number,title:string}} issueData - 원본(프론트) 이슈
 * @param {Object<string,string>|string[]} preDirty - fix 실행 전 dirty였던 백엔드 파일.
 *   getBackendDirtySnapshot()이 준 {파일:해시} 맵을 넘긴다. 내용이 그대로인 파일만 제외하고,
 *   해시가 바뀐 파일은 봇이 고친 것으로 보고 포함한다. (구버전 호환: 배열이면 경로 기준 제외)
 * @returns {Promise<null | {prNumber:number, deployed:boolean, buildFailed?:boolean, driftBlocked?:boolean, files:string[]}>}
 */
async function handleBackendChanges(issueData, preDirty = {}) {
  if (!config.backend.enabled) return null;

  const { number, title } = issueData;
  const dir = config.backend.workspaceDir;
  const owner = config.owner;
  const repo = config.backend.repo;
  const base = config.backend.baseBranch;
  const branch = `${config.branchPrefix}/issue-${number}`;

  // 구버전 호출(배열)은 해시 정보가 없으므로 종전대로 경로 기준 제외
  const legacyPathOnly = Array.isArray(preDirty);
  const preSnapshot = legacyPathOnly
    ? Object.fromEntries(preDirty.map(f => [f, null]))
    : (preDirty || {});

  const allChanged = await getBackendChangedFiles();
  const files = [];
  const touchedPreDirty = [];
  for (const f of allChanged) {
    if (!(f in preSnapshot)) { files.push(f); continue; }
    if (legacyPathOnly) continue;
    // 사전 dirty였어도 내용이 바뀌었으면 봇이 고친 것 → 커밋·빌드·배포 대상 (#699)
    if ((await hashBackendFile(f)) !== preSnapshot[f]) {
      files.push(f);
      touchedPreDirty.push(f);
    }
  }
  if (touchedPreDirty.length > 0) {
    logger.warn(`Backend: pre-existing dirty file(s) further modified by fix — including them`, { files: touchedPreDirty });
  }

  if (files.length === 0) {
    logger.info(`Backend: no changes for issue #${number}`);
    return null;
  }

  logger.info(`Backend: ${files.length} changed file(s) for issue #${number}`, { files });

  // 워크스페이스 안전장치: .env / node_modules 는 커밋 대상에서 제외.
  // prisma/migrations 는 "신규 추가"만 허용 — 커밋에서 빼면 스키마만 배포돼 P2022 500이 난다.
  const statuses = await getBackendFileStatuses();
  const forbidden = files.filter(f =>
    f.includes('node_modules/') ||
    f === '.env' || f.endsWith('/.env') ||
    (f.includes('prisma/migrations/') && !isNewlyAddedMigration(f, statuses[f] || ''))
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
        body: `프론트 이슈 ${config.owner}/${config.repo}#${number} 의 근본원인이 백엔드에 있어 자동 생성된 PR입니다.\n\n**변경 파일:**\n${commitFiles.map(f => '- ' + f).join('\n')}`,
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
      // 보고 코멘트는 원본 '프론트' 이슈(config.repo)로 보낸다. repo(=백엔드 레포)로 보내면
      // 존재하지 않는 backend#<프론트번호> 로 404가 나고 .catch로 삼켜져 아무 데도 안 남는다.
      await githubApi.commentOnIssue(owner, config.repo, number,
        `⚠️ 백엔드 근본원인을 수정해 PR ${owner}/${repo}#${pr.number} 을 만들었으나 **빌드가 실패**하여 배포하지 않았습니다. 수동 검토가 필요합니다.\n\n\`\`\`\n${buildErr.substring(0, 800)}\n\`\`\``
      ).catch(() => {});
      return { prNumber: pr.number, deployed: false, buildFailed: true, files: commitFiles };
    }

    // 4-b. 마이그레이션 누락 검사 (빌드는 통과해도 DB 스키마가 안 따라오면 전 API가 500)
    //      누락분이 가산적 변경뿐이면 마이그레이션을 자동 생성해 PR에 얹고 파이프라인을 이어간다.
    let drift = await checkMigrationDrift();
    let autoMigration = null;
    let unsafeSql = [];
    if (!drift.ok && drift.sql) {
      const verdict = classifyMigrationSql(drift.sql);
      if (verdict.safe) {
        autoMigration = await writeAutoMigration(drift.sql, number);
        await sh(`git add -- "${autoMigration.relPath.replace(/"/g, '\\"')}"`);
        await sh(`git commit -m "[#${number}] ${autoMigration.name} 마이그레이션 자동 생성"`);
        await sh(`git push origin ${branch} --force`);
        commitFiles.push(autoMigration.relPath);
        logger.info(`Backend: auto-generated migration for PR #${pr.number}`, { name: autoMigration.name, sql: drift.sql });
        // 재검사에서 통과해야만 배포로 넘어간다 (생성한 SQL이 스키마를 온전히 못 따라잡는 경우 방지)
        drift = await checkMigrationDrift();
        if (!drift.ok) {
          logger.error(`Backend: drift persists after auto-migration for PR #${pr.number}`, { sql: drift.sql, error: drift.error });
        }
      } else {
        unsafeSql = verdict.unsafe;
        logger.warn(`Backend: drift SQL is not additive, auto-migration skipped for PR #${pr.number}`, { unsafe: verdict.unsafe });
      }
    }
    if (!drift.ok) {
      const detail = drift.sql
        ? `마이그레이션에 반영되지 않은 스키마 변경:\n\`\`\`sql\n${drift.sql.substring(0, 800)}\n\`\`\``
        : `드리프트 검사 실패:\n\`\`\`\n${(drift.error || '').substring(0, 800)}\n\`\`\``;
      const why = unsafeSql.length > 0
        ? `\n\n자동 생성은 **가산적 변경(컬럼·테이블·인덱스 추가)** 에만 적용됩니다. 아래 구문은 기존 데이터에 영향을 줄 수 있어 사람이 판단해야 합니다.\n\`\`\`sql\n${unsafeSql.join(';\n').substring(0, 500)}\n\`\`\``
        : (autoMigration ? `\n\n마이그레이션 \`${autoMigration.name}\` 을 자동 생성했으나 재검사에서 차이가 남아 중단했습니다.` : '');
      logger.error(`Backend: migration drift detected for PR #${pr.number}, deploy blocked`, { sql: drift.sql, error: drift.error });
      await restoreMain();
      await githubApi.commentOnIssue(owner, config.repo, number,
        `⚠️ 백엔드 PR ${owner}/${repo}#${pr.number} 은 빌드에 성공했으나 **\`prisma/migrations\` 에 누락된 스키마 변경**이 있어 머지·배포를 중단했습니다. 이대로 배포하면 해당 모델의 모든 요청이 Prisma P2022 → 500 이 됩니다.\n\n${detail}${why}\n\n마이그레이션을 생성(\`prisma migrate dev\`)해 PR에 추가한 뒤 다시 진행해 주세요.`
      ).catch(() => {});
      return { prNumber: pr.number, deployed: false, driftBlocked: true, files: commitFiles };
    }
    if (autoMigration) {
      logger.info(`Backend: migration drift resolved by auto-migration ${autoMigration.name} for PR #${pr.number}`);
    } else {
      logger.info(`Backend: migration drift check passed for PR #${pr.number}`);
    }

    // 5. 머지 (squash) → 배포 (deployCommand, 미설정이면 배포 스킵)
    await githubApi.mergePullRequest(owner, repo, pr.number, { mergeMethod: 'squash' });
    logger.info(`Backend: PR #${pr.number} merged`);

    const deployCmd = config.backend.deployCommand;
    let deployed = false;
    let deployErr = '';
    if (deployCmd) {
      try {
        logger.info(`Backend: deploy started (${deployCmd})`);
        await sh(deployCmd, { timeout: 120000 });
        deployed = true;
        logger.info(`Backend: deploy succeeded for PR #${pr.number}`);
      } catch (e) {
        deployErr = e.message;
        logger.error(`Backend: deploy FAILED for PR #${pr.number}`, { error: e.message });
      }
    } else {
      logger.warn('Backend: no deployCommand configured, skipping deploy (build+merge only)');
    }

    // 6. 워크스페이스를 최신 main으로 동기화 + 임시 브랜치 정리
    await restoreMain(branch);
    try { await githubApi.deleteBranch(owner, repo, branch); } catch (_) {}

    // 7. 프론트 이슈에 결과 보고 (config.repo = 프론트 레포. repo는 백엔드 레포이므로 사용 금지)
    const migNote = autoMigration
      ? `\n\n🗄️ DB 스키마 변경이 있어 마이그레이션 \`${autoMigration.name}\` 을 자동 생성해 함께 배포했습니다.`
      : '';
    const filesList = `${migNote}\n\n**변경 파일:**\n${commitFiles.map(f => '- ' + f).join('\n')}`;
    if (!deployCmd) {
      await githubApi.commentOnIssue(owner, config.repo, number,
        `🛠️ 근본원인이 백엔드에 있어 백엔드까지 수정했습니다. PR ${owner}/${repo}#${pr.number} 머지 + 빌드 성공. (배포 커맨드 미설정 → 자동 배포는 스킵, 서비스 반영은 수동 필요)${filesList}`
      ).catch(() => {});
    } else if (deployed) {
      await githubApi.commentOnIssue(owner, config.repo, number,
        `🛠️ 근본원인이 백엔드에 있어 백엔드까지 수정했습니다. PR ${owner}/${repo}#${pr.number} 머지 + 빌드 + 배포(\`${deployCmd}\`) **라이브 반영 완료**. 확인 후 이슈를 닫아주세요.${filesList}`
      ).catch(() => {});
    } else {
      await githubApi.commentOnIssue(owner, config.repo, number,
        `🛠️ 백엔드 PR ${owner}/${repo}#${pr.number} 머지 및 빌드는 성공했으나 **배포 단계에서 오류**가 발생했습니다. 수동 반영이 필요합니다.\n\n\`\`\`\n${deployErr.substring(0, 500)}\n\`\`\``
      ).catch(() => {});
    }

    return { prNumber: pr.number, deployed, files: commitFiles };

  } catch (error) {
    logger.error(`Backend fix failed for issue #${number}`, { error: error.message, stack: error.stack });
    await restoreMain(branch).catch(() => {});
    await githubApi.commentOnIssue(owner, config.repo, number,
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

module.exports = { handleBackendChanges, getBackendChangedFiles, getBackendDirtySnapshot, getBackendFileStatuses, isNewlyAddedMigration, checkMigrationDrift, classifyMigrationSql, writeAutoMigration };
