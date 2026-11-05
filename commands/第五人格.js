const { SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const {
  SUMMARY_TYPES,
  extractArticles,
  extractArticleBody,
  selectArticle,
  sortNewestFirst,
} = require('../utils/idvSummary');
const summarizeWithGemini = require('../utils/summarizeWithGemini');
const { extractImplementationDate } = require('../utils/dateUtil');
const { getOrCreateSummary } = require('../utils/summaryService');
const { classifyUpdateItems, selectItemsForType, countPending } = require('../utils/classifyUpdate');
const { withGeminiRetry } = require('../utils/retryGemini');

const UPDATE_INDEX_URL = 'https://www.identityvgame.com/jp/news/update/index.html';
const UPDATE_INDEX_2_URL = 'https://www.identityvgame.com/jp/news/update/index_2.html';
const LATEST_NEWS_URL = 'https://www.identityvgame.com/jp/newspage.html';
const ARTICLE_LIST_URLS = [LATEST_NEWS_URL, UPDATE_INDEX_URL, UPDATE_INDEX_2_URL];

const SUMMARY_LABELS = {
  [SUMMARY_TYPES.NORMAL]: '通常対戦・協力狩り',
  [SUMMARY_TYPES.ENTERTAINMENT]: 'その他の娯楽モード',
  [SUMMARY_TYPES.TEST_SERVER]: 'テストサーバー',
};

async function fetchArticles() {
  const articlesByLink = new Map();
  const errors = [];

  for (const pageUrl of ARTICLE_LIST_URLS) {
    try {
      const response = await axios.get(pageUrl, { timeout: 15000 });
      const finalUrl = response.request?.res?.responseUrl || pageUrl;
      const pageArticles = extractArticles(response.data, finalUrl);
      for (const article of pageArticles) {
        if (!articlesByLink.has(article.link)) articlesByLink.set(article.link, article);
      }
      console.log(`[IDV] 一覧取得: ${pageUrl}, 記事件数: ${pageArticles.length}`);
    } catch (error) {
      errors.push(error);
      console.error(`[IDV] 一覧取得失敗(${pageUrl}):`, error.message);
    }
  }

  const articles = sortNewestFirst([...articlesByLink.values()]);
  if (!articles.length && errors.length === ARTICLE_LIST_URLS.length) throw errors[0];
  return articles;
}

async function fetchArticleContent(article) {
  const response = await axios.get(article.link, { timeout: 15000 });
  const content = extractArticleBody(response.data);
  if (!content || content.length < 40) {
    throw new Error(`記事本文を十分に取得できませんでした: ${article.link}`);
  }
  console.log(`[IDV] 本文取得(${article.title}):`, content.slice(0, 120).replace(/\s+/g, ' '));
  return content;
}

async function safeSummarize(content, type) {
  return withGeminiRetry(() => summarizeWithGemini(content, type), {
    onRetry: ({ attempt }) => console.warn(`[IDV] Gemini一時エラー、再試行中 (${attempt}/3)`),
  });
}

function splitMessage(content, maxLength = 1900) {
  const chunks = [];
  let current = '';
  for (const line of content.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendEntry(interaction, entry, cached) {
  const marker = cached ? '（キャッシュ）' : '';
  const message = `**${entry.title}**${marker}\n🗓 日付: ${entry.implementationDate}\n${entry.summary}\n詳細: ${entry.link}`;
  const chunks = splitMessage(message);
  await interaction.editReply(chunks[0]);
  for (let index = 1; index < chunks.length; index++) {
    await interaction.followUp({ content: chunks[index] });
  }
}

function addSummarySubcommand(builder, name) {
  return builder.addSubcommand(subcommand =>
    subcommand
      .setName(name)
      .setDescription('第五人格のアップデート内容を対象別に要約します')
      .addStringOption(option =>
        option
          .setName('対象')
          .setDescription('未指定の場合は通常対戦・協力狩りを要約します')
          .setRequired(false)
          .addChoices(
            { name: '通常対戦（協力狩りを含む）', value: SUMMARY_TYPES.NORMAL },
            { name: 'その他の娯楽モード', value: SUMMARY_TYPES.ENTERTAINMENT },
            { name: 'テストサーバー内容', value: SUMMARY_TYPES.TEST_SERVER },
          ),
      ),
  );
}

const data = new SlashCommandBuilder()
  .setName('第五人格')
  .setDescription('第五人格関連の情報を取得します');

// アップデート要約コマンドは「アプデ情報」に統一する。
addSummarySubcommand(data, 'アプデ情報');

module.exports = {
  data,
  async execute(interaction) {
    if (interaction.options.getSubcommand() !== 'アプデ情報') return;

    const type = interaction.options.getString('対象') || SUMMARY_TYPES.NORMAL;

    try {
      // Discordの初回応答期限を過ぎた場合でも、失敗をClientまで未処理で伝播させない。
      await interaction.deferReply();
      const articles = await fetchArticles();
      const article = selectArticle(articles, type);

      if (type === SUMMARY_TYPES.TEST_SERVER && !article) {
        await interaction.editReply('🧪 今回、確認できるテストサーバー関連のアップデート情報はありません。');
        return;
      }
      if (!article) {
        await interaction.editReply('アップデート記事が見つかりませんでした。公式サイトの掲載状況を確認してください。');
        return;
      }

      const content = await fetchArticleContent(article);
      const implementationDate = extractImplementationDate(content, article.date);
      const classified = await classifyUpdateItems(content, article.link);
      const selectedItems = selectItemsForType(classified, type);
      const pendingCount = countPending(classified);
      const summaryInput = selectedItems.length
        ? selectedItems.map(item => `${item.sectionPath.join(' > ') || '分類なし'}\n- ${item.text}\n根拠: ${item.evidence}`).join('\n\n')
        : `該当する変更項目はありません。`;
      const { entry, cached } = await getOrCreateSummary({
        type,
        content: `${content}\n\n[分類済み対象項目]\n${summaryInput}`,
        metadata: {
          title: article.title,
          link: article.link,
          implementationDate,
        },
        generate: () => selectedItems.length
          ? safeSummarize(summaryInput, type)
          : Promise.resolve(type === SUMMARY_TYPES.NORMAL
            ? `今週、通常対戦・協力狩りに関わる重要な変更はありません。${pendingCount ? `\n⚠️ 適用先を確認できず保留した項目: ${pendingCount}件` : ''}`
            : type === SUMMARY_TYPES.ENTERTAINMENT
              ? '今回、その他の娯楽モードに関する重要な変更はありません。'
              : '今回、確認できるテストサーバー関連の変更項目はありません。'),
      });

      console.log(`[IDV] ${SUMMARY_LABELS[type]}の要約完了 (cache=${cached})`);
      await sendEntry(interaction, entry, cached);
    } catch (error) {
      console.error('[IDV] アップデート要約失敗:', error);
      // deferReply自体が失敗した場合、interaction tokenが無効なので返信を再試行しない。
      if (interaction.deferred || interaction.replied) {
        try {
          await interaction.editReply('記事の取得または要約に失敗しました。時間をおいて再度お試しください。');
        } catch (replyError) {
          console.error('[IDV] 失敗通知も送信できませんでした:', replyError);
        }
      } else if (error.code === 10062) {
        console.warn('[IDV] Discordの応答期限切れです。ユーザーはコマンドを再実行できます。');
      }
    }
  },
};
