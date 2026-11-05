const fs = require('fs');
const path = require('path');

const cacheFile = path.join(__dirname, '../cache.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function loadCache() {
  if (!fs.existsSync(cacheFile)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const now = Date.now();
    const cache = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object' || typeof entry.summary !== 'string') continue;
      if (!Number.isFinite(entry.timestamp) || now - entry.timestamp > CACHE_TTL_MS || entry.timestamp > now) continue;
      cache[key] = entry;
    }
    return cache;
  } catch (error) {
    console.error('[IDV] キャッシュ読み込み失敗:', error.message);
    return {};
  }
}

function saveCache(cache) {
  const tempFile = `${cacheFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(cache, null, 2));
  fs.renameSync(tempFile, cacheFile);
}

function getCacheEntry(key) {
  return loadCache()[key] || null;
}

function saveCacheEntry(key, entry) {
  const cache = loadCache();
  cache[key] = entry;
  saveCache(cache);
}

module.exports = { CACHE_TTL_MS, loadCache, saveCache, getCacheEntry, saveCacheEntry };
