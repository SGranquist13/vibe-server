import { Template } from 'e2b'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read files at build time and embed them
const packageJson = readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
const indexTs = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8')

export const template = Template()
  .fromImage('e2bdev/base')
  // Check if Node.js is installed, if not install it
  .runCmd('command -v node >/dev/null 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs)')
  // Verify Node.js installation
  .runCmd('node --version && npm --version')
  // Create app directory in user's home (we have permissions there)
  .runCmd('mkdir -p /home/user/app')
  // Create package.json by writing file contents directly
  .runCmd(`cat > /home/user/app/package.json << 'EOFPKG'
${packageJson}
EOFPKG`)
  // Create index.ts by writing file contents directly
  .runCmd(`cat > /home/user/app/index.ts << 'EOFTSC'
${indexTs}
EOFTSC`)
  // Install all dependencies (including devDependencies for tsx/typescript)
  .runCmd('cd /home/user/app && npm install --no-audit --no-fund')
  // Install Claude Code CLI globally (may need sudo, but try without first)
  // Note: In production, you might want to install a specific version or use vibe-cli
  .runCmd('npm install -g @anthropic-ai/claude-code --no-audit --no-fund || sudo npm install -g @anthropic-ai/claude-code --no-audit --no-fund')