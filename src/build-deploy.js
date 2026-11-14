const { exec } = require('child_process');
const config = require('./config');
const logger = require('./logger');

function runCommand(cmd, label) {
  return new Promise((resolve, reject) => {
    if (!cmd) {
      logger.info(`${label}: no command configured, skipping`);
      resolve('');
      return;
    }

    logger.info(`${label}: executing "${cmd}" in ${config.workspaceDir}`);

    exec(cmd, {
      cwd: config.workspaceDir,
      maxBuffer: 10 * 1024 * 1024,
      // 서버 부하가 높을 땐 vite build 단독으로도 5분을 넘긴다 (2026-09-30 #1416~#1422 전부 5분 00초 컷)
      timeout: config.buildTimeout,
    }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = error.killed || error.signal === 'SIGTERM';
        logger.error(`${label} failed`, { error: error.message, timedOut, stderr: stderr?.substring(0, 500) });
        const err = timedOut
          ? new Error(`${label} failed: 타임아웃 (${Math.round(config.buildTimeout / 60000)}분 초과로 강제 종료됨 — 코드 오류 아님, 서버 부하 확인)`)
          : new Error(`${label} failed: ${stderr || error.message}`);
        err.timedOut = timedOut;
        reject(err);
      } else {
        logger.info(`${label} completed successfully`, { outputLength: (stdout || '').length });
        resolve(stdout || '');
      }
    });
  });
}

async function runBuild() {
  if (!config.buildCommand) {
    logger.info('Build: no command configured');
    return '';
  }
  logger.info('Build started');
  const result = await runCommand(config.buildCommand, 'Build');
  logger.info('Build completed');
  return result;
}

async function runDeploy() {
  if (!config.deployCommand) {
    logger.info('Deploy: no command configured');
    return '';
  }
  logger.info('Deploy started');
  const result = await runCommand(config.deployCommand, 'Deploy');
  logger.info('Deploy completed');
  return result;
}

async function runBuildAndDeploy() {
  logger.info('Build & Deploy pipeline started');
  const buildResult = await runBuild();
  const deployResult = await runDeploy();
  logger.info('Build & Deploy pipeline completed');
  return { buildResult, deployResult };
}

module.exports = { runBuild, runDeploy, runBuildAndDeploy };
