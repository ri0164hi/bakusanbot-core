const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROMPT_VERSION,
  SUMMARY_TYPES,
  buildCacheKey,
  buildPrompt,
  extractArticles,
  extractArticleBody,
  isTestServerArticle,
  isWithinDays,
  selectArticle,
} = require('../utils/idvSummary');
const { getOrCreateSummary } = require('../utils/summaryService');
const { selectItemsForType, countPending } = require('../utils/classifyUpdate');
const { formatDateWithWeekday } = require('../utils/dateUtil');

function createMemoryStore() {
  const entries = new Map();
  return {
    getCacheEntry: key => entries.get(key) || null,
    saveCacheEntry: (key, value) => entries.set(key, value),
    entries,
  };
}

test('cache key separates update text, summary type, and prompt version', () => {
  const normalKey = buildCacheKey(SUMMARY_TYPES.NORMAL, 'same article');
  assert.notEqual(normalKey, buildCacheKey(SUMMARY_TYPES.ENTERTAINMENT, 'same article'));
  assert.notEqual(normalKey, buildCacheKey(SUMMARY_TYPES.NORMAL, 'edited article'));
  assert.ok(normalKey.includes(PROMPT_VERSION));
});

test('prompt gives distinct and scoped instructions for each summary type', () => {
  const normal = buildPrompt(SUMMARY_TYPES.NORMAL, 'ARTICLE');
  const entertainment = buildPrompt(SUMMARY_TYPES.ENTERTAINMENT, 'ARTICLE');
  const testServer = buildPrompt(SUMMARY_TYPES.TEST_SERVER, 'ARTICLE');

  assert.match(normal, /通常対戦.*協力狩り/s);
  assert.match(normal, /娯楽モード.*除外/s);
  assert.match(entertainment, /その他の娯楽モード/);
  assert.match(entertainment, /協力狩りはこの対象に含めず/);
  assert.match(testServer, /正式実装済みではなく/);
  assert.match(testServer, /ARTICLE/);
});

test('article discovery does not depend on the old newsItem class', () => {
  const html = `
    <a href="/jp/news/update/20261104/35356_1318751.html">2026-11-05 ゲームアップデートのお知らせ（11/5実施） 2026-11-04</a>
    <a href="https://idv.163.com/jp/news/update/20261103/test.html">2026年11月15日 テストサーバー更新内容 2026-11-03</a>
    <a href="/jp/news/notice/other.html">お知らせ</a>`;
  const articles = extractArticles(html, 'https://www.identityvgame.com/jp/newspage.html');

  assert.equal(articles.length, 2);
  assert.equal(articles[0].date, '2026-11-04');
  assert.equal(articles[0].title, 'ゲームアップデートのお知らせ（11/5実施）');
  assert.equal(articles[1].date, '2026-11-03');
  assert.equal(isTestServerArticle(articles[1]), true);
});

test('article body extraction supports old and fallback markup', () => {
  assert.equal(extractArticleBody('<div class="artText"><p>本文A</p><p>本文B</p></div>'), '本文A\n本文B');
  assert.match(extractArticleBody('<main><p>新しいレイアウトの本文です。</p></main>'), /新しいレイアウトの本文です/);
});

test('test-server article recency excludes stale and future posts', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  assert.equal(isWithinDays('2026-11-01', 7, now), true);
  assert.equal(isWithinDays('2026-10-01', 7, now), false);
  assert.equal(isWithinDays('2026-11-07', 7, now), false);
  assert.equal(isWithinDays('', 7, now), false);
});

test('test-server mode selects only a recent test-server article and skips absent information', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const articles = [
    { title: '2026-11-05 ゲームアップデートのお知らせ', link: 'https://example.test/main', date: '2026-11-04' },
    { title: 'テストサーバー更新内容', link: 'https://example.test/old-test', date: '2026-10-01' },
    { title: 'テストサーバー更新内容', link: 'https://example.test/future-test', date: '2026-11-15' },
  ];
  assert.equal(selectArticle(articles, SUMMARY_TYPES.TEST_SERVER, now), null);
  assert.equal(selectArticle(articles, SUMMARY_TYPES.NORMAL, now).link, 'https://example.test/main');
  assert.equal(selectArticle([
    { title: 'テストサーバー更新内容', link: 'https://example.test/recent-test', date: '2026-11-03' },
  ], SUMMARY_TYPES.TEST_SERVER, now).link, 'https://example.test/recent-test');
});

test('missing or invalid publication dates do not produce NaN output', () => {
  assert.equal(formatDateWithWeekday(''), '日付不明');
  assert.equal(formatDateWithWeekday('not-a-date'), '日付不明');
});

test('cached summary avoids a second API generation for the same target and content', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const generate = async () => { calls++; return '要約'; };
  const first = await getOrCreateSummary({ type: SUMMARY_TYPES.NORMAL, content: 'article one', generate, store });
  const second = await getOrCreateSummary({ type: SUMMARY_TYPES.NORMAL, content: 'article one', generate, store });

  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.entry.summary, '要約');
});

test('different summary targets use separate cache entries', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const generate = async () => `summary-${++calls}`;

  await getOrCreateSummary({ type: SUMMARY_TYPES.NORMAL, content: 'shared article', generate, store });
  await getOrCreateSummary({ type: SUMMARY_TYPES.ENTERTAINMENT, content: 'shared article', generate, store });
  assert.equal(calls, 2);
  assert.equal(store.entries.size, 2);
});

test('simultaneous identical requests share one generation', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const generate = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return 'shared summary';
  };

  const args = { type: SUMMARY_TYPES.TEST_SERVER, content: 'same test update', generate, store };
  const [first, second] = await Promise.all([getOrCreateSummary(args), getOrCreateSummary(args)]);
  assert.equal(calls, 1);
  assert.equal(first.entry.summary, second.entry.summary);
});

test('failed or empty generations are not cached', async () => {
  const store = createMemoryStore();
  await assert.rejects(
    getOrCreateSummary({
      type: SUMMARY_TYPES.NORMAL,
      content: 'failed article',
      generate: async () => { throw new Error('API error'); },
      store,
    }),
    /API error/,
  );
  await assert.rejects(
    getOrCreateSummary({
      type: SUMMARY_TYPES.NORMAL,
      content: 'empty article',
      generate: async () => '',
      store,
    }),
    /空の要約/,
  );
  assert.equal(store.entries.size, 0);
});

test('normal match excludes entertainment and unverified items, while retaining cooperative hunt', () => {
  const items = [
    { text: 'ランク戦の調整', modes: ['normal_match'], confidence: 'high', scope: 'exclusive', evidence: '対戦で変更' },
    { text: '協力狩りの調整', modes: ['cooperative_hunt'], confidence: 'high', scope: 'exclusive', evidence: '協力狩りで変更' },
    { text: '手記の加筆の調整', modes: ['handwriting'], confidence: 'high', scope: 'exclusive', evidence: '手記の加筆で変更' },
    { text: '適用先不明', modes: ['normal_match', 'unknown'], confidence: 'low', scope: 'unclear', evidence: '不明' },
    { text: '根拠なし', modes: ['normal_match'], confidence: 'high', scope: 'exclusive', evidence: '' },
  ];
  assert.deepEqual(selectItemsForType(items, 'normal').map(item => item.text), ['ランク戦の調整', '協力狩りの調整']);
  assert.equal(countPending(items), 1);
});

test('entertainment summary selects entertainment modes separately', () => {
  const items = [
    { text: '通常対戦', modes: ['normal_match'], confidence: 'high', scope: 'exclusive', evidence: '対戦' },
    { text: 'コピーキャット', modes: ['copycat'], confidence: 'high', scope: 'exclusive', evidence: 'コピーキャットゲーム' },
  ];
  assert.deepEqual(selectItemsForType(items, 'entertainment').map(item => item.text), ['コピーキャット']);
});
