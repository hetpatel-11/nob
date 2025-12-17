import inquirer from 'inquirer';
import { saveUserConfig, loadUserConfig, getConfigFilePath } from '../config/configFile.js';
import chalk from 'chalk';

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

