import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config, ollamaOptions } from './config.js';
import { aiServerConfigured, aiServerModelList, aiServerError, assertPrivateUrl } from './services/llm.js';
import chatRoutes from './routes/chat.js';
import adminRoutes from './routes/admin.js';
import conversationRoutes from './routes/conversations.js';
import knowledgeRoutes from './routes/knowledge.js';

// Fail fast instead of hanging for 10s when MongoDB is down
mongoose.set('bufferCommands', false);

const app = express();
app.set('trust proxy', 1);
app.use(
  cors({
    origin: config.clientOrigin,
    exposedHeaders: ['X-Log-Id', 'X-Conversation-Id', 'X-Blocked', 'X-Sources'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Id'],
  })
);
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', async (_req, res) => {
  let ollama = false;
  let ollamaError = '';
  try {
    const r = await fetch(`${config.ollamaUrl}/api/tags`);
    ollama = r.ok;
    if (!r.ok) ollamaError = `Ollama responded ${r.status}`;
  } catch (err) {
    ollamaError = `Cannot reach Ollama at ${config.ollamaUrl} (${err.cause?.code || err.message})`;
  }
  const mongo = mongoose.connection.readyState === 1;
  let aiServer = null;
  if (aiServerConfigured()) {
    const list = await aiServerModelList();
    aiServer = { name: config.aiServer.name, ok: list.length > 0, models: list, error: list.length ? '' : aiServerError() };
  }
  res.json({
    ok: true,
    mongo,
    mongoError: mongo ? '' : `Cannot reach MongoDB at ${config.mongoUri}`,
    aiServer,
    ollama,
    ollamaError,
  });
});

app.use('/api/chat', chatRoutes);
app.use('/api/admin/knowledge', knowledgeRoutes); // must come before /api/admin
app.use('/api/admin', adminRoutes);
app.use('/api/conversations', conversationRoutes);

// In production, serve the built React app (client/dist) from the same server
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// Any uncaught error (Express 5 also catches rejected async handlers)
app.use((err, _req, res, _next) => {
  console.error(err);
  const dbDown = mongoose.connection.readyState !== 1;
  res.status(dbDown ? 503 : 500).json({
    message: dbDown ? 'Database is not connected. Check that MongoDB is running and MONGO_URI is correct.' : err.message || 'Server error',
  });
});

// Start the HTTP server even if MongoDB is down, and keep retrying the DB
app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
  console.log(`Ollama URL: ${config.ollamaUrl}`);
  console.log(`Model settings: default=${config.defaultModel} num_ctx=${config.numCtx} num_predict=${config.numPredict} keep_alive=${config.keepAlive}`);
  if (aiServerConfigured()) {
    assertPrivateUrl(config.aiServer.url)
      .then(() => aiServerModelList({ fresh: true }))
      .then((list) =>
        console.log(
          list.length
            ? `${config.aiServer.name} (${config.aiServer.url}): ${list.join(', ')}`
            : `${config.aiServer.name} not reachable yet: ${aiServerError()}`
        )
      )
      .catch((err) => console.error(`${config.aiServer.name} disabled: ${err.message}`));
  }
  // Preloading only applies to Ollama models
  if (config.warmup && !config.aiServer.models.includes(config.defaultModel)) warmUpModel();
});

// Load the default model into RAM right away (and keep it there) so the first user
// doesn't wait for it to load. Retries until Ollama and the model are available.
async function warmUpModel(attempt = 1) {
  try {
    const r = await fetch(`${config.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // An empty prompt just loads the model
      body: JSON.stringify({ model: config.defaultModel, prompt: '', keep_alive: config.keepAlive, options: ollamaOptions() }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    await r.text();
    console.log(`Model ${config.defaultModel} loaded and kept in memory (${config.keepAlive})`);
  } catch (err) {
    if (attempt === 1 || attempt % 10 === 0) {
      console.warn(`Model warm-up failed (${err.cause?.code || err.message}); retrying every 30s...`);
    }
    setTimeout(() => warmUpModel(attempt + 1), 30000);
  }
}

async function connectMongo() {
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
    console.log('MongoDB connected');
  } catch (err) {
    console.error(`MongoDB connection failed (${err.message}). Retrying in 5s...`);
    setTimeout(connectMongo, 5000);
  }
}
connectMongo();
