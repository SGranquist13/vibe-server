/**
 * Service to fetch integration release notes from various sources
 */

interface IntegrationRelease {
    integration: string;
    version: string;
    message: string;
    type: 'update' | 'issue' | 'deprecation' | 'feature';
    releaseUrl?: string;
    publishedAt?: Date;
}

interface IntegrationConfig {
    name: string;
    type: 'github' | 'npm';
    source: string; // GitHub repo (owner/repo) or npm package name
    displayName: string;
}

const INTEGRATIONS: IntegrationConfig[] = [
    {
        name: 'claude-code',
        type: 'npm',
        source: '@anthropic-ai/claude-code',
        displayName: 'Claude Code'
    },
    {
        name: 'codex',
        type: 'github',
        source: 'cursor-ai/codex-cli',
        displayName: 'Codex'
    },
    {
        name: 'cursor',
        type: 'github',
        source: 'getcursor/cursor',
        displayName: 'Cursor'
    },
    {
        name: 'gemini',
        type: 'github',
        source: 'google-gemini/gemini-cli',
        displayName: 'Gemini CLI'
    },
    {
        name: 'mcp-sdk',
        type: 'npm',
        source: '@modelcontextprotocol/sdk',
        displayName: 'MCP SDK'
    }
];

/**
 * Fetch latest release from GitHub
 */
async function fetchGitHubRelease(repo: string): Promise<IntegrationRelease | null> {
    try {
        const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'Vibe-Server'
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                return null; // No releases found
            }
            throw new Error(`GitHub API error: ${response.status}`);
        }

        const data = await response.json();
        const version = data.tag_name?.replace(/^v/, '') || data.name;
        const message = data.body || `New release: ${version}`;
        const publishedAt = data.published_at ? new Date(data.published_at) : undefined;

        return {
            integration: repo.split('/')[1],
            version,
            message: (message || `New release: ${version}`).substring(0, 2000), // Allow longer messages for changelogs
            type: 'update',
            releaseUrl: data.html_url,
            publishedAt
        };
    } catch (error) {
        console.error(`[IntegrationReleaseNotes] Error fetching GitHub release for ${repo}:`, error);
        return null;
    }
}

/**
 * Fetch latest version from npm
 */
async function fetchNpmRelease(packageName: string): Promise<IntegrationRelease | null> {
    try {
        const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Vibe-Server'
            }
        });

        if (!response.ok) {
            throw new Error(`npm API error: ${response.status}`);
        }

        const data = await response.json();
        const version = data.version;
        const message = data.description || `New version available: ${version}`;

        return {
            integration: packageName.replace('@', '').replace('/', '-'),
            version,
            message: message.substring(0, 500),
            type: 'update',
            releaseUrl: `https://www.npmjs.com/package/${packageName}`,
            publishedAt: data.time ? new Date(data.time[version]) : undefined
        };
    } catch (error) {
        console.error(`[IntegrationReleaseNotes] Error fetching npm release for ${packageName}:`, error);
        return null;
    }
}

/**
 * Fetch release notes for all configured integrations
 */
export async function fetchAllIntegrationReleases(): Promise<IntegrationRelease[]> {
    const releases: IntegrationRelease[] = [];

    for (const integration of INTEGRATIONS) {
        let release: IntegrationRelease | null = null;

        if (integration.type === 'github') {
            release = await fetchGitHubRelease(integration.source);
        } else if (integration.type === 'npm') {
            release = await fetchNpmRelease(integration.source);
        }

        if (release) {
            // Use display name instead of technical name
            release.integration = integration.displayName;
            releases.push(release);
        }

        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    return releases;
}

/**
 * Get integration config by name
 */
export function getIntegrationConfig(name: string): IntegrationConfig | undefined {
    return INTEGRATIONS.find(integration => integration.name === name || integration.displayName === name);
}

