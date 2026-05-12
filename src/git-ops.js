const { exec } = require('child_process');
const config = require('./config');
const logger = require('./logger');

function run(cmd, cwd) {
  const workDir = cwd || config.workspaceDir;
  logger.debug(`git-ops: running "${cmd}" in ${workDir}`);

  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: workDir, maxBuffer: 10 * 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        logger.error(`git-ops command failed: ${cmd}`, { error: error.message, stderr: stderr?.substring(0, 500) });
        reject(new Error(`${cmd}: ${stderr || error.message}`));
      } else {
        const output = (stdout || '').trim();
        logger.debug(`git-ops output: ${output.substring(0, 200)}`);
        resolve(output);
      }
    });
  });
}

async function checkout(branch) {
  logger.info(`Checking out branch: ${branch}`);
  await run(`git checkout ${branch}`);
}

async function checkoutNew(branch, base) {
  logger.info(`Creating new branch: ${branch} from ${base || config.baseBranch}`);
  const baseBranch = base || config.baseBranch;
  await run(`git checkout ${baseBranch}`);
  await run(`git pull origin ${baseBranch}`);

  // 기존 브랜치가 있으면 삭제 후 재생성
  try {
    await run(`git branch -D ${branch}`);
    logger.info(`Deleted existing local branch: ${branch}`);
  } catch (_) {
    // 브랜치가 없으면 무시
  }

  await run(`git checkout -b ${branch}`);
  logger.info(`Branch ${branch} created successfully`);
}

async function stageAll() {
  logger.info('Staging all changes');
  await run('git add -A');
}

async function commit(message) {
  logger.info(`Committing: ${message.substring(0, 80)}`);
  // 변경사항이 없으면 스킵
  try {
    const status = await run('git status --porcelain');
    if (!status) {
      logger.warn('No changes to commit');
      return false;
    }
  } catch (_) {
    // git status 실패 시 그냥 진행
  }

  await run('git add -A');
  await run(`git commit -m "${message.replace(/"/g, '\\"')}"`);
  logger.info('Commit created');
  return true;
}

async function push(branch, force = false) {
  const forceFlag = force ? ' --force' : '';
  logger.info(`Pushing branch: ${branch}${force ? ' (force)' : ''}`);
  await run(`git push origin ${branch}${forceFlag}`);
  logger.info(`Branch ${branch} pushed successfully`);
}

async function pull(branch) {
  const targetBranch = branch || config.baseBranch;
  logger.info(`Pulling latest from ${targetBranch}`);
  await run(`git checkout ${targetBranch}`);
  await run(`git pull origin ${targetBranch}`);
  logger.info(`Pull completed for ${targetBranch}`);
}

async function getCurrentBranch() {
  const branch = await run('git rev-parse --abbrev-ref HEAD');
  logger.debug(`Current branch: ${branch}`);
  return branch;
}

async function hasChanges() {
  const status = await run('git status --porcelain');
  const changed = status.length > 0;
  logger.debug(`Has changes: ${changed}`);
  return changed;
}

async function resetHard(ref) {
  logger.warn(`Hard reset to ${ref || 'HEAD'}`);
  await run(`git reset --hard ${ref || 'HEAD'}`);
}

async function getLatestCommitMessage() {
  const msg = await run('git log -1 --pretty=%B');
  return msg;
}

module.exports = {
  run,
  checkout,
  checkoutNew,
  stageAll,
  commit,
  push,
  pull,
  getCurrentBranch,
  hasChanges,
  resetHard,
  getLatestCommitMessage,
};
