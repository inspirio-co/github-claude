const config = require('./config');
const logger = require('./logger');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { handleGitHubEvent, recoverPendingTasks } = require('./webhook-handler');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ─── GitHub Webhook 서명 검증 ───

function verifySignature(req) {
  if (!config.webhookSecret) {
    logger.debug('No webhook secret configured, skipping signature verification');
    return true;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    logger.warn('Missing x-hub-signature-256 header');
    return false;
  }

  const hmac = crypto.createHmac('sha256', config.webhookSecret);
  const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch (err) {
    logger.error('Signature verification failed', { error: err.message });
    return false;
  }
}

// ─── GitHub Webhook 엔드포인트 ───

app.post('/webhook/github', async (req, res) => {
  // 서명 검증
  if (config.webhookSecret && !verifySignature(req)) {
    logger.warn('Invalid webhook signature, rejecting request');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  if (!event) {
    logger.warn('Missing x-github-event header');
    return res.status(400).json({ error: 'Missing event header' });
  }

  // 즉시 응답 (202 Accepted)
  res.status(202).json({ message: 'Processing started' });

  // 백그라운드에서 처리
  try {
    await handleGitHubEvent(event, req.body);
  } catch (error) {
    logger.error(`Unhandled error in GitHub webhook handler`, { event, error: error.message, stack: error.stack });
  }
});

// ─── Health Check ───

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      owner: config.owner,
      repo: config.repo,
      baseBranch: config.baseBranch,
      features: config.features,
    },
  });
});

// ─── 상태 확인 ───

app.get('/status', (req, res) => {
  res.json({
    config: {
      owner: config.owner,
      repo: config.repo,
      baseBranch: config.baseBranch,
      workspaceDir: config.workspaceDir,
      features: config.features,
      labels: config.labels,
      branchPrefix: config.branchPrefix,
    },
  });
});

// ─── 로그 확인 ───

app.get('/logs', async (req, res) => {
  const logFile = path.join(__dirname, '..', 'webhook.log');
  try {
    const logs = await fs.readFile(logFile, 'utf-8');
    const lines = logs.split('\n');
    const tail = parseInt(req.query.tail) || 100;
    const lastLines = lines.slice(-tail).join('\n');
    res.type('text/plain').send(lastLines);
  } catch (error) {
    logger.debug(`Log file read failed: ${error.message}`);
    res.status(404).send('No logs found');
  }
});

// ─── 서버 시작 ───

app.listen(config.port, () => {
  logger.info(`github-claude webhook server started on port ${config.port}`);
  logger.info(`Config: ${config.owner}/${config.repo} (${config.baseBranch})`);
  logger.info(`Features: PR=${config.features.pr}, Review=${config.features.review}, Build=${config.features.build}`);
  logger.info(`Workspace: ${config.workspaceDir}`);
  logger.info(`Trigger label: "${config.labels.trigger}"`);
  logger.info(`Branch prefix: "${config.branchPrefix}"`);
  console.log(`\ngithub-claude webhook server started on http://localhost:${config.port}`);
  console.log(`  Health: http://localhost:${config.port}/health`);
  console.log(`  Status: http://localhost:${config.port}/status`);
  console.log(`  Logs:   http://localhost:${config.port}/logs`);

  // 서버 시작 5초 후 미처리 작업 복구
  setTimeout(() => {
    recoverPendingTasks().catch(err => {
      logger.error('Startup recovery failed', { error: err.message });
    });
  }, 5000);
});
