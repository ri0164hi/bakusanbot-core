const { SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const { loadCache, saveCache } = require('../utils/cache');
const summarizeWithGemini = require('../utils/summarizeWithGemini');
const { extractImplementationDate } = require('../utils/dateUtil');

const UPDATE_INDEX_URL = 'https://www.identityvgame.com/jp/news/update/index.html';
const LATEST_NEWS_URL = 'https://www.identityvgame.com/jp/newspage.html';

function normalizeArticleUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function extractArticles($, baseUrl) {
  const articles = [];
  const seen = new Set();

  // 旧一覧ページの構造を優先しつつ、クラス名変更時は新着ページ上の
  // 更新記事リンクを走査する。
  $('a.newsItem, a[href]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href) return;

    const link = normalizeArticleUrl(href, baseUrl);
    if (!link || seen.has(link)) return;
    if (!/\/jp\/news\/update\//i.test(new URL(link).pathname)) return;

    const rawText = a.text().replace(/\s+/g, ' ').trim();
    if (!rawText) return;

    const dateMatches = [...rawText.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g)];
    const date = dateMatches.length
      ? `${dateMatches[dateMatches.length - 1][1]}-${dateMatches[dateMatches.length - 1][2].padStart(2, '0')}-${dateMatches[dateMatches.length - 1][3].padStart(2, '0')}`
      : ((link.match(/\/(20\d{2})(\d{2})(\d{2})\//) || []).slice(1).join('-') || '');

    let title = rawText
      .replace(/^20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*/, '')
      .replace(/\s+20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?$/, '')
      .trim();

    // リンクテキストに日付しかない場合は親要素の見出しテキストも参照する。
    if (!title || !/(ゲームアップデート|アップデート|テストサーバー)/i.test(title)) {
      const parentText = a.parent().text().replace(/\s+/g, ' ').trim();
      const candidate = parentText
        .replace(/^20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*/, '')
        .replace(/\s+20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?$/, '')
        .trim();
      if (/(ゲームアップデート|アップデート|テストサーバー)/i.test(candidate)) title = candidate;
    }

    if (!title || !/(ゲームアップデート|アップデート|テストサーバー)/i.test(title)) return;
    seen.add(link);
    articles.push({ title, link, date });
  });

  return articles;
}

function isTestServerUpdate(title) {
  return title.includes("テストサーバー");
}

function isSameWeek(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const getWeek = d => {
    const onejan = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  };
  return d1.getFullYear() === d2.getFullYear() && getWeek(d1) === getWeek(d2);
}

function isWithinOneWeek(dateStr) {
  const articleDate = new Date(dateStr);
  const now = new Date();
  const diff = now - articleDate;
  return diff <= 7 * 24 * 60 * 60 * 1000;
}

async function safeSummarize(content) {
  for (let i = 0; i < 3; i++) {
    try {
      return await summarizeWithGemini(content);
    } catch (e) {
      if (e.status === 503 && i < 2) {
        console.warn(`Gemini過負荷、リトライ中... (${i+1}/3)`);
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

function splitMessage(content, maxLength = 1900) {
  const parts = [];
  let current = "";
  for (const line of content.split("\n")) {
    if ((current + "\n" + line).length > maxLength) {
      parts.push(current);
      current = line;
    } else {
      current += "\n" + line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function processArticle(interaction, art, cache, cacheKey) {
  let content = "";
  try {
    const { data: detailHtml } = await axios.get(art.link);
    const $$ = cheerio.load(detailHtml);
    content = $$('.artText p').map((i, el) => $$(el).text().trim()).get().filter(Boolean).join("\n");
    if (!content) {
      const articleBody = $$('article, main, [class*="articleBody"], [class*="newsContent"], [class*="artText"]').first();
      content = articleBody.length
        ? articleBody.text().replace(/\s+/g, ' ').trim()
        : $$('body').text().replace(/\s+/g, ' ').trim();
    }
    console.log(`[IDV] 本文抜粋(${art.title}):`, content.slice(0, 120).replace(/\s+/g, ' '));
  } catch (e) {
    console.error(`[IDV] 詳細取得失敗(${art.link}):`, e.message);
  }

  let summary = "";
  if (process.env.GOOGLE_API_KEY && content) {
    try {
      summary = await safeSummarize(content);
    } catch (e) {
      console.error("[IDV] Gemini要約失敗:", e.message);
    }
  }
  if (!summary) {
    const lines = content.split("\n").map(s => s.trim()).filter(Boolean);
    const picked = lines.filter(l => /(SSR|UR|衣装|家具|エコー|欠片|カード|解放|新規|アップデート|イベント|ガチャ|人格調整|天賦調整|キャラクター調整)/i.test(l)).slice(0, 12);
    summary = picked.length
      ? "⚠️ Gemini混雑中につき簡易要約を表示します\n" + picked.map(l => `- ${l}`).join("\n")
      : `⚠️ Gemini混雑中につき簡易要約を表示します\n- ${art.title}`;
  }

  const implementationDate = extractImplementationDate(content, art.date);
  const finalContent = `**${art.title}**\n🗓 日付: ${implementationDate}\n${summary}\n詳細: ${art.link}`;

  const chunks = splitMessage(finalContent);
  let firstMsg = null;
  for (const chunk of chunks) {
    const msg = await interaction.followUp({ content: chunk });
    if (!firstMsg) firstMsg = msg;
  }

  cache[cacheKey] = {
    title: art.title,
    summary,
    link: art.link,
    implementationDate,
    timestamp: Date.now(),
    messageId: firstMsg.id
  };
  saveCache(cache);

  return firstMsg;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('第五人格')
    .setDescription('第五人格関連の情報を取得します')
    .addSubcommand(sub =>
      sub.setName('アプデ情報')
         .setDescription('最新のアップデート情報を取得して要約します')
    ),
  async execute(interaction) {
  if (interaction.options.getSubcommand() !== 'アプデ情報') return;

  try {
    console.log("[IDV] execute呼ばれた");   // ← ここで発火確認
    console.log("getSubcommand:", interaction.options.getSubcommand()); // ← 実際の値を確認

    console.log("[IDV] コマンド開始");
    await interaction.deferReply();
    console.log("[IDV] deferReply完了");

    const cache = loadCache();

    let articles = [];
    let html = '';
    let indexError = null;
    for (const pageUrl of [LATEST_NEWS_URL, UPDATE_INDEX_URL]) {
      try {
        const response = await axios.get(pageUrl, { timeout: 15000 });
        html = response.data;
        const $ = cheerio.load(html);
        articles = extractArticles($, response.request?.res?.responseUrl || pageUrl);
        console.log(`[IDV] 一覧取得成功: ${pageUrl}, HTML長: ${html.length}, 記事件数: ${articles.length}`);
        if (articles.length) break;
      } catch (error) {
        indexError = error;
        console.error(`[IDV] 一覧取得失敗(${pageUrl}):`, error.message);
      }
    }

    if (!html && indexError) throw indexError;

      if (articles.length === 0) {
        await interaction.editReply("記事が取得できませんでした。サイト構造が変わった可能性があります。");
        return;
      }

      // 本サーバー記事は常に最新1件だけ
      const latestMain = articles.find(a => !isTestServerUpdate(a.title));
      if (latestMain) {
        const cacheKey = latestMain.link;
        if (cache[cacheKey]) {
          const c = cache[cacheKey];
          const finalContent = `**${c.title}**（まとめ済み）\n🗓 日付: ${c.implementationDate}\n${c.summary}\n詳細: ${c.link}`;
          const chunks = splitMessage(finalContent);
          await interaction.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i] });
          }
        } else {
          await processArticle(interaction, latestMain, cache, cacheKey);
        }
      }

      // テストサーバー記事は最新かつ7日以内のみ処理
      const latestTest = articles.find(a => isTestServerUpdate(a.title));
      if (latestTest) {
        const cacheKey = latestTest.link;
        if (!cache[cacheKey] && isWithinOneWeek(latestTest.date)) {
          await processArticle(interaction, latestTest, cache, cacheKey);

          const sameWeekMain = articles.find(a =>
            !isTestServerUpdate(a.title) && isSameWeek(a.date, latestTest.date)
          );

          if (sameWeekMain) {
            const mainKey = sameWeekMain.link;
            if (!cache[mainKey]) {
              await processArticle(interaction, sameWeekMain, cache, mainKey);
            } else {
              const replyTargetId = cache[mainKey].messageId;
              await interaction.followUp({
                content: "本サーバー記事は既に処理済みなので今回はテストサーバー記事のみ要約しました。",
                messageReference: replyTargetId
              });
            }
          }
        }
      }

      console.log("[IDV] 完了");

    } catch (err) {
      console.error("[IDV] コマンド全体で例外:", err);
      if (interaction.deferred) {
        await interaction.editReply("エラーが発生しました。");
      } else {
        await interaction.reply("エラーが発生しました。");
      }
    }
  },
};

