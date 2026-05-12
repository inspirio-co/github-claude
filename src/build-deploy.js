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
      timeout: 300000, // 5분
    }, (error, stdout, stderr) => {
      if (error) {
        logger.error(`${label} failed`, { error: error.message, stderr: stderr?.substring(0, 500) });
        reject(new Error(`${label} failed: ${stderr || error.message}`));
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
