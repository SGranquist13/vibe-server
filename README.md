<div align="center">
  <h1>Vibe Server</h1>
  
  <p><strong>Zero-knowledge sync server for Vibe on the Go</strong></p>
  
  <p>
    Encrypted relay for AI coding sessions. <br/>
    Stores encrypted blobs — <strong>cannot read your data</strong>.
  </p>
</div>

---

## ✨ Features

- 🔐 **Zero-Knowledge** — Stores encrypted data but cannot decrypt it
- ⚡ **Real-time Sync** — WebSocket-based synchronization
- 📱 **Multi-device** — Seamless session management
- 🔔 **Push Notifications** — Encrypted notifications (content invisible to server)
- 🔑 **Cryptographic Auth** — No passwords, only signatures
- 🌐 **Distributed Ready** — Built to scale horizontally

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 20+** and npm/yarn
- **Docker & Docker Compose** (for PostgreSQL and Redis)
- **Git** for cloning the repository

### Initial Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/SGranquist13/vibe-server.git
   cd vibe-server
   ```

2. **Start infrastructure services:**
   ```bash
   # From the project root (where docker-compose.yml is located)
   docker-compose up -d
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env and set VIBE_MASTER_SECRET (generate with: openssl rand -hex 32)
   ```

4. **Install dependencies:**
   ```bash
   yarn install
   ```

5. **Run database migrations:**
   ```bash
   yarn migrate
   ```

6. **Start the development server:**
   ```bash
   yarn dev
   ```

Server runs at `http://localhost:3005`

---

## ⚙️ Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `VIBE_MASTER_SECRET` | Master encryption key (32-byte hex) |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3005` | Server port |
| `S3_*` | - | MinIO/S3 configuration |
| `GITHUB_*` | - | GitHub OAuth integration |
| `ELEVENLABS_API_KEY` | - | Voice synthesis |

See `.env.example` for all options.

---

## 🏗️ Architecture

```
┌─────────────┐     ┌─────────────┐
│   Mobile    │◄───►│   Server    │◄───►│     CLI     │
│     App     │     │ (this repo) │     │  (terminal) │
└─────────────┘     └─────────────┘     └─────────────┘
                          │
                    ┌─────┴─────┐
                    │           │
               PostgreSQL    Redis
                (data)      (pubsub)
```

**How it works:**

1. CLI encrypts session data client-side
2. Server stores encrypted blobs
3. Mobile app fetches & decrypts locally
4. Real-time sync via WebSocket

---

## 🛠️ Development

### Prerequisites

- **Node.js 20+** and npm/yarn
- **Docker & Docker Compose** (for local PostgreSQL and Redis)
- **Git** for cloning the repository

### Development Workflow

```bash
# Start development server
yarn dev

# Run database migrations
yarn migrate

# Run tests
yarn test

# Type check
yarn typecheck
```

### Project Structure

```
server/
├── sources/
│   ├── app/           # Application logic
│   │   ├── api/       # API routes and handlers
│   │   └── auth/      # Authentication logic
│   ├── storage/       # Database and storage utilities
│   └── modules/       # Reusable modules
├── prisma/            # Database schema and migrations
└── deploy/            # Deployment configurations
```

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `POST /api/auth/*` | Authentication |
| `POST /api/sessions/*` | Session management |
| `POST /api/machines/*` | Machine management |
| `WS /socket.io` | Real-time sync |

---

## 🐳 Docker

```bash
# Build image
docker build -t vibe-server .

# Run container
docker run -p 3005:3005 \
  -e DATABASE_URL=... \
  -e REDIS_URL=... \
  -e VIBE_MASTER_SECRET=... \
  vibe-server
```

---

## 📖 Documentation

- [**Main Project README**](../README.md) — Full project overview
- [**Quick Start Guide**](../QUICK_START.md) — Complete setup instructions
- [**Server Development Guide**](CLAUDE.md) — Detailed development docs

### Related Repositories

- [**Mobile App**](https://github.com/SGranquist13/vibe-mobile) — React Native mobile app
- [**CLI**](https://github.com/SGranquist13/vibe-cli) — Command-line wrapper
- [**Main Repository**](https://github.com/SGranquist13/votg) — Meta-repository

---

## 📄 License

MIT License
