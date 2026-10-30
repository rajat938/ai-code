# Ollama MERN – Local AI Assistant with Admin Dashboard

A MERN stack (MongoDB, Express, React, Node.js) app that runs prompts on a **local Ollama server**.

- **Chat page (`/`)** – users type a prompt, pick a model, and see the answer stream in live.
- **Admin dashboard (`/admin`)** – login-protected. Shows every prompt that was asked and the output the model returned, with search, filters (status, model, date), stats, charts, details view, delete, and CSV export.

```
Browser (React) ──► Express API (Node) ──► Ollama (localhost:11434)
                          │
                          └──► MongoDB (stores every prompt + output)
```

## Project structure

```
ollama-mern/
├── server/                 Express + Mongoose API
│   ├── src/index.js        App entry (also serves the built React app)
│   ├── src/config.js       Reads .env
│   ├── src/models/PromptLog.js
│   ├── src/routes/chat.js  POST /api/chat (streams from Ollama, saves log)
│   ├── src/routes/admin.js Login, stats, logs, delete, CSV export
│   └── .env.example
├── client/                 React (Vite) frontend
│   └── src/pages/          ChatPage, AdminLogin, AdminDashboard
├── deploy/
│   ├── install-ubuntu.sh   Installs Ollama, Node, MongoDB, PM2
│   └── nginx.conf          Reverse-proxy example
└── ecosystem.config.cjs    PM2 config
```

---

## Run with Docker (easiest)

Runs MongoDB, Ollama (with `llama3.2`), the API and the React app in containers.

```bash
docker compose up -d --build
docker compose logs -f ollama     # first run downloads the model (~2 GB), wait for "Ollama is ready"
```

- Chat: http://localhost:3000
- Admin: http://localhost:3000/admin (login from `server/.env`)
- API: http://localhost:5000/api/health

Inside Docker, containers reach each other by **service name**, not `localhost`:
the client forwards `/api` to `http://server:5000`, the server uses `http://ollama:11434` and `mongodb://...@mongodb:27017`.
These are set in `docker-compose.yml`, so the same `server/.env` still works when you run without Docker.

Change the model: edit `MODEL` under the `ollama` service, or run `docker exec -it ollama ollama pull mistral`.

> If you change the MongoDB username/password after the first run, reset the volume once:
> `docker compose down -v && docker compose up -d --build` (this deletes saved logs).

---

## 1. Install Ollama on the server

**Linux (Ubuntu/Debian/etc.)**

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama      # runs Ollama as a service on port 11434
ollama pull llama3.2                    # download a model (~2 GB)
ollama run llama3.2 "Hello"             # quick test
```

**Windows / macOS:** download the installer from https://ollama.com/download, then run `ollama pull llama3.2`.

Other models you can pull: `llama3.1:8b`, `mistral`, `gemma2`, `qwen2.5`, `phi3`, `deepseek-r1:7b`. Every model you pull appears automatically in the model dropdown.

> Check Ollama is running: `curl http://127.0.0.1:11434/api/tags`

## 2. Install Node.js and MongoDB

- Node.js 18 or newer (20 LTS recommended).
- MongoDB 6/7 running locally, **or** a free MongoDB Atlas cluster (just put its connection string in `MONGO_URI`).

On a fresh Ubuntu server you can do steps 1–2 in one go:

```bash
sudo bash deploy/install-ubuntu.sh
```

## 3. Configure

```bash
cp server/.env.example server/.env
```

Edit `server/.env`:

| Variable | Meaning |
|---|---|
| `PORT` | API port (default 5000) |
| `MONGO_URI` | MongoDB connection string |
| `OLLAMA_URL` | Where Ollama runs (default `http://127.0.0.1:11434`) |
| `DEFAULT_MODEL` | Model pre-selected in the UI, e.g. `llama3.2` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin dashboard login — **change these** |
| `JWT_SECRET` | Long random string (`openssl rand -hex 32`) |
| `CLIENT_ORIGIN` | Frontend URL for CORS in development |

## 4. Run in development

```bash
npm run install:all      # installs root + server + client packages
npm run dev              # starts backend (:5000) AND frontend (:5173) together
```

Open http://localhost:5173 for the chat and http://localhost:5173/admin for the dashboard.

## 5. Run in production (single port)

The Express server serves the built React app, so only one process is needed:

```bash
npm run build            # builds client/dist
npm start                # http://SERVER_IP:5000
```

Keep it running with PM2:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Optional: put Nginx in front (port 80/443) using `deploy/nginx.conf`. Keep `proxy_buffering off;` so answers stream live.

---

## API reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | – | Mongo + Ollama status |
| GET | `/api/chat/models` | – | Installed Ollama models |
| POST | `/api/chat` | – | `{ prompt, model }` → streamed text answer |
| POST | `/api/admin/login` | – | `{ username, password }` → `{ token }` |
| GET | `/api/admin/stats` | Bearer | Totals, today, errors, avg time, by model, per day |
| GET | `/api/admin/logs` | Bearer | `?q=&status=&model=&from=&to=&page=&limit=` |
| GET | `/api/admin/logs/:id` | Bearer | One log |
| DELETE | `/api/admin/logs/:id` | Bearer | Delete a log |
| GET | `/api/admin/export` | Bearer | CSV of logs (same filters) |

Each saved log contains: prompt, response, model, status (success/error), error message, response time, token counts, user IP, user agent, and timestamp.

## Troubleshooting

The chat page shows a yellow **Setup problem** banner when something is down.

| Message | Fix |
|---|---|
| *Cannot reach the backend server* | The Express server isn't running or crashed. Use `npm run dev` (starts both), or run `npm run dev:server` in its own terminal and read its output. |
| *Cannot reach Ollama at http://127.0.0.1:11434* | Start Ollama: `ollama serve` (or `sudo systemctl start ollama`). Check with `curl http://127.0.0.1:11434/api/tags`. |
| *No models found* in the dropdown | Ollama has no models yet: `ollama pull llama3.2`, then refresh the page. |
| *model "xyz" not found* | `ollama pull xyz` |
| *Database is not connected* | Start MongoDB (`sudo systemctl start mongod`, or the MongoDB service on Windows) or fix `MONGO_URI`. Use `127.0.0.1`, not `localhost`. Chat still works without the database, but prompts won't be saved. |

## Notes

- The chat endpoint is rate-limited to 20 prompts per minute per IP (change in `server/src/routes/chat.js`).
- Ollama only listens on localhost by default, which is what you want — the browser never talks to Ollama directly, only to the Express API.
- Speed depends on the server hardware; a GPU makes a big difference. Smaller models (`llama3.2:1b`, `phi3`) are faster on CPU-only machines.
- If a model is missing you'll see an error like `model "xyz" not found` — run `ollama pull xyz`.
