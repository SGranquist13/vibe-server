import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'
import * as dotenv from 'dotenv'
import { resolve } from 'path'

// Load .env files from server directory
// From vibe-runner: go up 5 levels to get to server/
const serverDir = resolve(process.cwd(), '../../../../../')
dotenv.config({ path: resolve(serverDir, '.env') })
dotenv.config({ path: resolve(serverDir, '.env.dev') })
dotenv.config({ path: resolve(process.cwd(), '.env') })

async function main() {
  // Check if API key is set
  const apiKey = process.env.E2B_API_KEY
  if (!apiKey) {
    console.error('❌ E2B_API_KEY environment variable is not set!')
    console.error('Please set it in your .env file or as an environment variable.')
    console.error('Get your API key from: https://e2b.dev/docs/api-key')
    process.exit(1)
  }

  console.log('🔑 E2B API key found, building template...')
  
  try {
    await Template.build(template, {
      alias: 'vibe-runner',
      onBuildLogs: defaultBuildLogger(),
    });

    console.log('✅ Template built successfully!')
  } catch (error: any) {
    // FileUploadError might occur but build may still succeed
    // Check E2B dashboard to verify build status
    if (error.name === 'FileUploadError') {
      console.warn('⚠️  FileUploadError occurred during file copy.')
      console.warn('This may be non-fatal - check the E2B dashboard for build status.')
      console.warn('Template ID should be visible in the dashboard.')
      // Don't exit with error code - let user check dashboard
      process.exit(0)
    } else {
      console.error('❌ Build failed:', error.message)
      throw error
    }
  }
}

main().catch(console.error);