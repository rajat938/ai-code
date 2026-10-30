import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 5000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ollama_mern',
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  defaultModel: process.env.DEFAULT_MODEL || 'qwen2.5:1.5b',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  // ---- Speed settings (important on CPU-only / low-RAM servers) ----
  // Keep the model loaded in RAM so it isn't reloaded for every prompt ("-1" = forever)
  keepAlive: process.env.OLLAMA_KEEP_ALIVE || '24h',
  // Context window in tokens. Room for policy excerpts + chat history. Smaller = less RAM.
  numCtx: num(process.env.OLLAMA_NUM_CTX, 4096),
  // Max tokens in one answer. Caps how long a reply can run.
  numPredict: num(process.env.OLLAMA_NUM_PREDICT, 512),
  // CPU threads (0 = let Ollama decide)
  numThread: num(process.env.OLLAMA_NUM_THREAD, 0),
  // How many earlier messages of the conversation are sent to the model as memory
  historyLimit: num(process.env.HISTORY_LIMIT, 6),
  // Small embedding model for meaning-based policy search ('' = keyword search only)
  embedModel: process.env.EMBED_MODEL ?? 'all-minilm',
  // ---- Optional GPU AI server on YOUR private network (vLLM, SGLang, llama.cpp, LM Studio) ----
  // Must be a private address (192.168.x.x, 10.x.x.x, 172.16-31.x.x, localhost, or a Docker service name).
  // Public internet addresses are refused by the server.
  aiServer: {
    name: process.env.LOCAL_AI_SERVER_NAME || 'GPU server',
    url: (process.env.LOCAL_AI_SERVER_URL || '').replace(/\/$/, ''), // e.g. http://192.168.1.50:8000/v1
    apiKey: process.env.LOCAL_AI_SERVER_API_KEY || '', // only if you started vLLM with --api-key
    // Comma-separated model names; empty = ask the server which models it has
    models: (process.env.LOCAL_AI_SERVER_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean),
    maxTokens: num(process.env.LOCAL_AI_SERVER_MAX_TOKENS, 1024),
    timeoutMs: num(process.env.LOCAL_AI_SERVER_TIMEOUT_SECONDS, 120) * 1000,
  },
  // Preload the default model when the server starts so the first prompt is fast
  warmup: process.env.OLLAMA_WARMUP !== 'false',
};

export function ollamaOptions() {
  const o = { num_ctx: config.numCtx, num_predict: config.numPredict };
  if (config.numThread > 0) o.num_thread = config.numThread;
  return o;
}
