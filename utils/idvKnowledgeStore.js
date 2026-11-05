const fs = require('fs');
const path = require('path');

const filePath = process.env.IDV_KNOWLEDGE_PATH || path.join(__dirname, '../idv-knowledge.json');
let mongoose;
let connectionPromise;
let KnowledgeModel;

function getModel() {
  if (!KnowledgeModel) {
    const schema = new mongoose.Schema({
      _id: { type: String, required: true },
      version: { type: String, default: 'v1' },
      claims: { type: [mongoose.Schema.Types.Mixed], default: [] },
      reviews: { type: [mongoose.Schema.Types.Mixed], default: [] },
      updatedAt: { type: Date, default: Date.now },
    }, { versionKey: false, collection: 'idv_knowledge' });
    KnowledgeModel = mongoose.models.IdvKnowledge || mongoose.model('IdvKnowledge', schema);
  }
  return KnowledgeModel;
}

async function connect() {
  if (!process.env.MONGODB_URI) return false;
  if (!mongoose) mongoose = require('mongoose');
  if (mongoose.connection.readyState === 1) return true;
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
      .then(() => true)
      .catch(error => {
        console.error('[IDV] MongoDB接続失敗。JSON保存へ切り替えます:', error.message);
        connectionPromise = null;
        return false;
      });
  }
  return connectionPromise;
}

function readFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { version: parsed.version || 'v1', claims: parsed.claims || [], reviews: parsed.reviews || [] };
  } catch {
    return { version: 'v1', claims: [], reviews: [] };
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

async function getKnowledge() {
  if (await connect()) {
    try {
      const record = await getModel().findById('idv').lean();
      if (record) return { version: record.version || 'v1', claims: record.claims || [], reviews: record.reviews || [] };
      return { version: 'v1', claims: [], reviews: [] };
    } catch (error) {
      console.error('[IDV] MongoDB読み込み失敗。JSON保存へ切り替えます:', error.message);
    }
  }
  return readFile();
}

async function saveKnowledge(data) {
  if (await connect()) {
    try {
      await getModel().findByIdAndUpdate('idv', {
        $set: { version: data.version || 'v1', claims: data.claims || [], reviews: data.reviews || [], updatedAt: new Date() },
      }, { upsert: true, new: true, setDefaultsOnInsert: true });
      return 'mongodb';
    } catch (error) {
      console.error('[IDV] MongoDB保存失敗。JSON保存へ切り替えます:', error.message);
    }
  }
  writeFile(data);
  return 'json';
}

module.exports = { getKnowledge, saveKnowledge };
