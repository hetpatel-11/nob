import { userInfo } from 'os';
import { NobConfig } from '../types/index.js';
import { loadUserConfig } from './configFile.js';

// Backend API endpoint that proxies to Workers AI
// Credentials stay secure on your server, not in the npm package
const DEFAULT_API_ENDPOINT = 'https://nob-proxy.hetkp8044.workers.dev';

export async function loadConfig(): Promise<NobConfig> {
	// Priority order: Environment variables > Config file > Backend API
	
	// Check environment variables first (highest priority)
	const envAccountId = process.env.NOB_CLOUDFLARE_ACCOUNT_ID;
	const envApiToken = process.env.NOB_CLOUDFLARE_API_TOKEN;
	
	// Check config file (second priority)
	const userConfig = await loadUserConfig();
	
	// Use env vars if available, otherwise use config file
	const customAccountId = envAccountId || userConfig.cloudflareAccountId;
	const customApiToken = envApiToken || userConfig.cloudflareApiToken;
	
	// If user provides their own credentials, use those instead of backend
	const useCustomCredentials = customAccountId && customApiToken;

	return {
		// Use backend API endpoint if user doesn't provide their own credentials
		apiEndpoint: useCustomCredentials ? undefined : DEFAULT_API_ENDPOINT,
		// Use custom credentials if provided (BYO API key), otherwise empty
		cloudflareAccountId: useCustomCredentials ? customAccountId : '',
		cloudflareApiToken: useCustomCredentials ? customApiToken : '',
		userId: userInfo().username,
		shell: process.env.SHELL || '/bin/bash',
	};
}

