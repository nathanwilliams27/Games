# The Skreets of Maple Ridge (Node.js)

Multiplayer Buffalo property trading game for 2 to 6 players. No packages to install.

## Run it on your computer

1. Install Node.js 18 or newer
2. In this folder run `npm start`
3. Open http://localhost:3000

Friends on the same Wi-Fi can join at `http://YOUR-IP:3000`.

## Host it online

First put this folder in a GitHub repo (github.com > New repository > upload these files).

### Render (free, easiest)
1. Sign in at render.com with GitHub
2. New > Blueprint > pick your repo. `render.yaml` sets everything up
3. You get a link like `https://skreets-of-maple-ridge.onrender.com`. Send it to friends

Free Render servers sleep after 15 minutes with no visitors (the first visit takes about 30 seconds to wake up) and lose saved games when they restart. A paid plan with the disk in `render.yaml` turned on keeps games saved.

### Railway
1. Sign in at railway.app with GitHub
2. New Project > Deploy from GitHub repo > pick your repo
3. Settings > Networking > Generate Domain
4. To keep games saved, add a Volume mounted at `/data` and set the variable `DATA_DIR=/data`

### Fly.io, a VPS, or anything with Docker
```
docker build -t skreets .
docker run -d -p 80:3000 -v skreets-data:/data --restart unless-stopped skreets
```

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3000 | Port to listen on (hosts set this for you) |
| `DATA_DIR` | `./data` | Where games are saved |
| `MAX_GAMES` | 1000 | Most tables saved at once |
| `WRITES_PER_MIN` | 240 | Moves allowed per visitor per minute |
| `STREAMS_PER_IP` | 20 | Live connections allowed per visitor |

Health check: `GET /healthz`

## Files

- `server.js` serves the page and the shared game data, with live updates
- `public/index.html` is the game
- `public/claude-shim.js` connects the game to the server
- `render.yaml`, `Dockerfile` are hosting configs
