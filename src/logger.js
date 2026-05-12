const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

const LOG_DIR = path.join(__dirname, '..');
const LOG_FILE = path.join(LOG_DIR, 'webhook.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

function timestamp() {
  return new Date().toISOString();
}

async function rotateIfNeeded() {
  try {
    const stat = await fsPromises.stat(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const rotated = LOG_FILE + '.' + Date.now();
      await fsPromises.rename(LOG_FILE, rotated);
    }
  } catch (_) {
    // 파일이 없으면 무시
  }
}

async function writeLog(level, message, meta) {
  const ts = timestamp();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  const line = `[${ts}] [${level}] ${message}${metaStr}\n`;

  // 콘솔 출력
  if (level === 'ERROR') {
    console.error(line.trim());
  } else {
    console.log(line.trim());
  }

  // 파일 출력
  try {
    await rotateIfNeeded();
    await fsPromises.appendFile(LOG_FILE, line);
  } catch (err) {
    console.error(`[${ts}] [ERROR] Failed to write log file: ${err.message}`);
  }
}

const logger = {
  info(message, meta) {
    return writeLog('INFO', message, meta);
  },
  warn(message, meta) {
    return writeLog('WARN', message, meta);
  },
  error(message, meta) {
    return writeLog('ERROR', message, meta);
  },
  debug(message, meta) {
    if (process.env.DEBUG === 'true') {
      return writeLog('DEBUG', message, meta);
    }
  },
};

module.exports = logger;
