const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const STORE_FILE = path.join(__dirname, '..', 'active-jobs.json');

let store = new Map();

function load() {
  try {
    const data = fs.readFileSync(STORE_FILE, 'utf-8');
    const entries = JSON.parse(data);
    store = new Map(entries);
    logger.info(`Job store loaded: ${store.size} active jobs`);
  } catch (_) {
    store = new Map();
    logger.info('Job store initialized (empty)');
  }
}

function save() {
  try {
    const data = JSON.stringify([...store.entries()], null, 2);
    fs.writeFileSync(STORE_FILE, data);
    logger.debug(`Job store saved: ${store.size} jobs`);
  } catch (err) {
    logger.error(`Failed to save job store: ${err.message}`);
  }
}

function get(jobId) {
  return store.get(String(jobId));
}

function set(jobId, data) {
  store.set(String(jobId), { ...data, updatedAt: new Date().toISOString() });
  save();
  logger.info(`Job ${jobId} stored`, { issueNumber: data.issueNumber });
}

function remove(jobId) {
  const deleted = store.delete(String(jobId));
  if (deleted) {
    save();
    logger.info(`Job ${jobId} removed from store`);
  }
  return deleted;
}

function getByIssue(issueNumber) {
  for (const [jobId, data] of store) {
    if (data.issueNumber === issueNumber) {
      return { jobId, ...data };
    }
  }
  return null;
}

function all() {
  return [...store.entries()].map(([jobId, data]) => ({ jobId, ...data }));
}

function size() {
  return store.size;
}

// 초기 로드
load();

module.exports = { get, set, remove, getByIssue, all, size, load };
