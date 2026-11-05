const { buildCacheKey, hashContent, PROMPT_VERSION } = require('./idvSummary');
const cacheStore = require('./cache');

const inFlight = new Map();

async function getOrCreateSummary({ type, content, metadata = {}, generate, store = cacheStore }) {
  const cacheKey = buildCacheKey(type, content);
  const cached = store.getCacheEntry(cacheKey);
  if (cached?.summary) return { entry: cached, cached: true, cacheKey };

  if (inFlight.has(cacheKey)) {
    return { entry: await inFlight.get(cacheKey), cached: true, cacheKey };
  }

  const generation = (async () => {
    const summary = await generate();
    if (typeof summary !== 'string' || !summary.trim()) {
      throw new Error('空の要約はキャッシュに保存できません。');
    }

    const entry = {
      ...metadata,
      summary: summary.trim(),
      type,
      promptVersion: PROMPT_VERSION,
      contentHash: hashContent(content),
      timestamp: Date.now(),
    };
    store.saveCacheEntry(cacheKey, entry);
    return entry;
  })();

  inFlight.set(cacheKey, generation);
  try {
    return { entry: await generation, cached: false, cacheKey };
  } finally {
    if (inFlight.get(cacheKey) === generation) inFlight.delete(cacheKey);
  }
}

module.exports = { getOrCreateSummary };

