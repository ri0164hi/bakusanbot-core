const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const { buildPrompt, SUMMARY_TYPES } = require('./idvSummary');

async function summarizeWithGemini(content, type = SUMMARY_TYPES.NORMAL) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY が設定されていません。');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: buildPrompt(type, content) }] }],
  });

  const summary = result.response.text().trim();
  if (!summary) throw new Error('Gemini APIから空の要約が返されました。');
  return summary;
}

module.exports = summarizeWithGemini;

