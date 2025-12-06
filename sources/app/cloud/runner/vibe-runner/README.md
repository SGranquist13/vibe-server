# Vibe Cloud Runner E2B Template

This E2B template runs the Vibe cloud runner inside an E2B sandbox. The cloud runner connects to vibe-server and executes Claude Code/Codex sessions on demand.

## Overview

The cloud runner:
- Connects to vibe-server via Socket.IO
- Registers itself as an available endpoint
- Handles session lifecycle (start, stop, message forwarding)
- Spawns and manages Claude Code/Codex agent processes
- Forwards messages between the server and agents

## Building the Template

### Development Build
```bash
npm run e2b:build:dev
```

This creates a template with alias `vibe-runner-dev`.

### Production Build
```bash
npm run e2b:build:prod
```

This creates a template with alias `vibe-runner`.

## Environment Variables

The cloud runner expects these environment variables when the sandbox starts:

- `VIBE_SERVER_URL` - URL of the vibe-server (e.g., `http://localhost:3005`)
- `VIBE_AUTH_TOKEN` - Authentication token for this endpoint
- `VIBE_ENDPOINT_ID` - Unique identifier for this endpoint (auto-generated if not set)
- `MAX_CONCURRENT_SESSIONS` - Maximum number of concurrent sessions (default: 1)

## Template Structure

- `template.ts` - E2B template definition
- `index.ts` - Cloud runner main code
- `package.json` - Dependencies
- `tsconfig.json` - TypeScript configuration
- `build.dev.ts` - Development build script
- `build.prod.ts` - Production build script

## How It Works

1. **Template Build**: The template installs Node.js, dependencies, and required tools
2. **Sandbox Start**: When a sandbox is spawned, it runs `tsx /app/index.ts`
3. **Connection**: The runner connects to vibe-server via Socket.IO
4. **Registration**: The runner registers itself as an available endpoint
5. **Session Handling**: When a session is requested, the runner spawns the appropriate agent process
6. **Message Forwarding**: Messages are forwarded between the server and agent processes

## Integration with vibe-server

The cloud runner integrates with vibe-server through:

- `endpoint:register` - Registers the endpoint
- `endpoint:heartbeat` - Sends periodic heartbeats
- `session:start` - Receives session start requests
- `session:started` - Notifies server when session starts
- `session:ended` - Notifies server when session ends
- `session:error` - Notifies server of errors
- `message:send` - Receives messages to forward to agents
- `message:from-claude` - Sends messages from agents to server

## Notes

- The template installs `@anthropic-ai/claude-code` globally for Claude Code support
- For Codex support, you may need to install additional dependencies
- The runner uses `tsx` to run TypeScript directly without compilation
- All agent processes run in the `/home/user` directory by default
