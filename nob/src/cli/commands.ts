import inquirer from 'inquirer';
import { saveUserConfig, loadUserConfig, getConfigFilePath } from '../config/configFile.js';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createServer } from 'http';
import { URL } from 'url';

const execAsync = promisify(exec);
const BASE_API_ENDPOINT = 'https://nob-proxy.hetkp8044.workers.dev';

export async function handleSetApiKey(): Promise<void> {
	console.log(chalk.blue('\n🔑 Configure Your Cloudflare Workers AI API Key\n'));
	console.log(chalk.gray('This will allow you to use your own API key and bypass rate limits.\n'));
	console.log(chalk.gray('Get your credentials from: https://dash.cloudflare.com\n'));
	console.log(chalk.gray('  • Account ID: Workers & Pages → Overview (right sidebar)\n'));
	console.log(chalk.gray('  • API Token: My Profile → API Tokens → Create Token\n'));

	const answers = await inquirer.prompt([
		{
			type: 'input',
			name: 'accountId',
			message: 'Cloudflare Account ID:',
			validate: (input: string) => {
				if (!input.trim()) {
					return 'Account ID is required';
				}
				return true;
			},
		},
		{
			type: 'password',
			name: 'apiToken',
			message: 'Cloudflare API Token:',
			mask: '*',
			validate: (input: string) => {
				if (!input.trim()) {
					return 'API Token is required';
				}
				return true;
			},
		},
	]);

	try {
		await saveUserConfig({
			cloudflareAccountId: answers.accountId.trim(),
			cloudflareApiToken: answers.apiToken.trim(),
		});

		console.log(chalk.green('\n✅ API key configured successfully!'));
		console.log(chalk.gray(`   Config saved to: ${getConfigFilePath()}\n`));
		console.log(chalk.blue('   You can now use nob with your own API key (unlimited usage).\n'));
	} catch (error) {
		console.error(chalk.red('\n❌ Failed to save API key:'), error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

export async function handleShowConfig(): Promise<void> {
	const config = await loadUserConfig();
	
	console.log(chalk.blue('\n📋 Current Configuration\n'));
	
	if (config.cloudflareAccountId && config.cloudflareApiToken) {
		console.log(chalk.green('✅ Cloudflare Workers AI: Configured'));
		console.log(chalk.gray(`   Account ID: ${config.cloudflareAccountId.substring(0, 8)}...`));
		console.log(chalk.gray(`   API Token: ${'*'.repeat(20)}...`));
	} else {
		console.log(chalk.yellow('⚠️  Cloudflare Workers AI: Not configured'));
		console.log(chalk.gray('   Using free tier (use your own key if rate limited)'));
	}
	
	console.log(chalk.gray(`\n   Config file: ${getConfigFilePath()}\n`));
}

export async function handleRemoveApiKey(): Promise<void> {
	const config = await loadUserConfig();
	
	if (!config.cloudflareAccountId && !config.cloudflareApiToken) {
		console.log(chalk.yellow('\n⚠️  No API key configured to remove.\n'));
		return;
	}

	const { confirm } = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'confirm',
			message: 'Are you sure you want to remove your API key?',
			default: false,
		},
	]);

	if (confirm) {
		await saveUserConfig({
			...config,
			cloudflareAccountId: undefined,
			cloudflareApiToken: undefined,
		});
		console.log(chalk.green('\n✅ API key removed. You will now use the shared backend.\n'));
	} else {
		console.log(chalk.gray('\n   Cancelled.\n'));
	}
}

export async function handleLogin(): Promise<void> {
	console.log(chalk.blue('\n🔐 Login to nob\n'));
	console.log(chalk.gray('Opening browser for authentication...\n'));

	try {
		// Start local server to receive OAuth callback
		const callbackPort = 8765;
		const localCallbackUrl = `http://localhost:${callbackPort}/callback`;
		
		// Open auth page (will show GitHub/Google buttons)
		const loginUrl = `${BASE_API_ENDPOINT}/auth/login?redirect_uri=${encodeURIComponent(localCallbackUrl)}`;
		
		console.log(chalk.gray(`   If browser doesn't open, visit:\n   ${loginUrl}\n`));

		// Open browser
		const openCommand = process.platform === 'darwin' ? 'open' : 
		                    process.platform === 'win32' ? 'start' : 'xdg-open';
		await execAsync(`${openCommand} "${loginUrl}"`).catch(() => {
			// Ignore errors - user can manually open
		});

		// Wait for OAuth callback
		const token = await waitForOAuthCallback(callbackPort);

		if (!token) {
			throw new Error('Authentication cancelled or failed');
		}

		// Verify token with backend
		const verifyResponse = await fetch(`${BASE_API_ENDPOINT}/auth/verify`, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${token}`,
			},
		});

		if (!verifyResponse.ok) {
			throw new Error('Token verification failed');
		}

		const userData = await verifyResponse.json() as { email?: string; expiresIn?: number };
		
		// Save login token with expiry (default 30 days)
		const expiryTime = Date.now() + (userData.expiresIn || 30 * 24 * 60 * 60 * 1000);
		
		const config = await loadUserConfig();
		await saveUserConfig({
			...config,
			loginToken: token,
			loginEmail: userData.email,
			loginExpiry: expiryTime,
		});

		console.log(chalk.green('\n✅ Login successful!'));
		if (userData.email) {
			console.log(chalk.gray(`   Logged in as: ${userData.email}\n`));
		}
		console.log(chalk.blue('   You can now use nob.\n'));
	} catch (error) {
		console.error(chalk.red('\n❌ Login failed:'), error instanceof Error ? error.message : String(error));
		console.log(chalk.gray('\n   Please try again.\n'));
		process.exit(1);
	}
}

function getCallbackPage(success: boolean, errorMessage?: string): string {
	if (success) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Login Successful - nob</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background: #000;
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
		}
		.container {
			background: #1a1a1a;
			border: 1px solid #333;
			border-radius: 8px;
			padding: 48px;
			text-align: center;
			max-width: 400px;
		}
		.icon {
			width: 64px;
			height: 64px;
			margin-bottom: 24px;
		}
		h1 {
			color: #22c55e;
			font-size: 24px;
			margin-bottom: 12px;
		}
		p {
			color: #999;
			font-size: 16px;
		}
	</style>
</head>
<body>
	<div class="container">
		<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2">
			<circle cx="12" cy="12" r="10"/>
			<path d="M8 12l2.5 2.5L16 9"/>
		</svg>
		<h1>Authentication Successful</h1>
		<p>You can close this window and return to the terminal.</p>
	</div>
</body>
</html>`;
	} else {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Login Failed - nob</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background: #000;
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
		}
		.container {
			background: #1a1a1a;
			border: 1px solid #333;
			border-radius: 8px;
			padding: 48px;
			text-align: center;
			max-width: 400px;
		}
		.icon {
			width: 64px;
			height: 64px;
			margin-bottom: 24px;
		}
		h1 {
			color: #ef4444;
			font-size: 24px;
			margin-bottom: 12px;
		}
		p {
			color: #999;
			font-size: 16px;
		}
		.error {
			color: #666;
			font-size: 14px;
			margin-top: 16px;
			padding: 12px;
			background: #0a0a0a;
			border-radius: 4px;
		}
	</style>
</head>
<body>
	<div class="container">
		<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2">
			<circle cx="12" cy="12" r="10"/>
			<path d="M15 9l-6 6M9 9l6 6"/>
		</svg>
		<h1>Authentication Failed</h1>
		<p>Please close this window and try again.</p>
		${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}
	</div>
</body>
</html>`;
	}
}

function waitForOAuthCallback(port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			if (!req.url) {
				res.writeHead(400);
				res.end('Bad Request');
				return;
			}

			const url = new URL(req.url, `http://localhost:${port}`);
			
			if (url.pathname === '/callback') {
				const token = url.searchParams.get('token');
				const error = url.searchParams.get('error');

				if (error) {
					res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end(getCallbackPage(false, error));
					server.close();
					reject(new Error(error));
					return;
				}

				if (token) {
					res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
					res.end(getCallbackPage(true));
					server.close();
					resolve(token);
					return;
				}
			}

			res.writeHead(404);
			res.end('Not Found');
		});

		server.listen(port, () => {
			// Timeout after 5 minutes
			setTimeout(() => {
				server.close();
				reject(new Error('Authentication timeout'));
			}, 5 * 60 * 1000);
		});

		server.on('error', (err) => {
			reject(err);
		});
	});
}

export async function checkLogin(): Promise<boolean> {
	const config = await loadUserConfig();
	
	// Check if login token exists and is not expired
	if (!config.loginToken) {
		return false;
	}

	// Check expiry (with 1 hour buffer to refresh before actual expiry)
	if (config.loginExpiry && Date.now() > (config.loginExpiry - 60 * 60 * 1000)) {
		return false;
	}

	return true;
}

export async function handleLogout(): Promise<void> {
	const config = await loadUserConfig();
	
	if (!config.loginToken) {
		console.log(chalk.yellow('\n⚠️  You are not logged in.\n'));
		return;
	}

	await saveUserConfig({
		...config,
		loginToken: undefined,
		loginEmail: undefined,
		loginExpiry: undefined,
	});

	console.log(chalk.green('\n✅ Logged out successfully.\n'));
}

