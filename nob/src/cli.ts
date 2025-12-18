#!/usr/bin/env node

import { TerminalKitUI } from './terminal/TerminalKitUI.js';
import { executeCommand } from './terminal/commandExecutor.js';
import { loadConfig } from './config/index.js';
import { NobAgent } from './ai/agent.js';
import { handleSetApiKey, handleShowConfig, handleRemoveApiKey, handleLogin, checkLogin, handleLogout } from './cli/commands.js';

// Handle CLI commands before starting the terminal
const command = process.argv[2];

// Commands that should run and exit (not start the terminal)
const runCommandAndExit = async () => {
	if (command === 'login') {
		await handleLogin();
		process.exit(0);
	} else if (command === 'logout') {
		await handleLogout();
		process.exit(0);
	} else if (command === 'set-api-key' || command === 'config') {
		await handleSetApiKey();
		process.exit(0);
	} else if (command === 'show-config' || command === 'config-show') {
		await handleShowConfig();
		process.exit(0);
	} else if (command === 'remove-api-key' || command === 'config-remove') {
		await handleRemoveApiKey();
		process.exit(0);
	}
};

// Handle commands that should run and exit (not start the terminal)
const isSpecialCommand = ['login', 'logout', 'set-api-key', 'config', 'show-config', 'config-show', 'remove-api-key', 'config-remove'].includes(command);

if (isSpecialCommand) {
	runCommandAndExit().catch((err) => {
		console.error(err);
		process.exit(1);
	});
} else if (command === 'help' || command === '--help' || command === '-h') {
	console.log(`
${'nob'} - AI-Powered Agentic Terminal

Usage:
  nob                    Start the terminal
  nob login              Login to nob (required before first use)
  nob logout             Logout from nob
  nob set-api-key        Configure your Cloudflare Workers AI API key
  nob show-config        Show current configuration
  nob remove-api-key     Remove your API key (use shared backend)
  nob help               Show this help message

Commands:
  nob on                 Enable AI mode
  nob off                Switch to manual mode with autosuggestion
  nob exit               Exit nob

Bring Your Own API Key (BYOK):
  By default, nob uses a shared backend with rate limits (100 requests/day).
  To use your own API key for unlimited usage:
  
  1. Get your credentials from https://dash.cloudflare.com:
     - Account ID: Workers & Pages → Overview (right sidebar)
     - API Token: My Profile → API Tokens → Create Token
  
  2. Configure your API key:
     nob set-api-key
  
  Or set environment variables:
     export NOB_CLOUDFLARE_ACCOUNT_ID=your_account_id
     export NOB_CLOUDFLARE_API_TOKEN=your_api_token

Examples:
  nob set-api-key        # Configure your own API key (unlimited usage)
  nob                    # Start the terminal
`);
	process.exit(0);
} else if (command && !['on', 'off', 'exit'].includes(command)) {
	console.log(`Unknown command: ${command}\nRun 'nob help' for usage information.`);
	process.exit(1);
}

async function main() {
	try {
		// Check if user is logged in
		const isLoggedIn = await checkLogin();
		if (!isLoggedIn) {
			console.log('\n🔐 Login required');
			console.log('Please login before using nob:\n');
			console.log('  nob login\n');
			console.log('Run "nob help" for more information.\n');
			process.exit(1);
		}

		const config = await loadConfig();
		let cwd = process.cwd();
		// Use backend API if available, otherwise fallback to direct Workers AI
		const hasAIConfig = config.apiEndpoint || (config.cloudflareAccountId && config.cloudflareApiToken);
		let mode: 'on' | 'off' = hasAIConfig ? 'on' : 'off';

		// Initialize AI agent if credentials/endpoint available
		const agent = hasAIConfig ? new NobAgent(config) : null;

		const terminal = new TerminalKitUI({
			cwd,
			mode,
			version: '1.0.0',
			onExit: () => {
				process.exit(0);
			},
			onSubmit: async (input: string) => {
				const trimmed = input.trim();

				// Execute command based on current mode (not initial mode)
				const currentMode = terminal.getMode();
				
				// In manual mode, never use AI - execute directly
				if (currentMode === 'off') {
					const result = await executeCommand(trimmed, cwd, (newCwd) => {
						cwd = newCwd;
						terminal.setCwd(newCwd);
					});

					if (result.output) {
						terminal.printOutput(result.output);
					}

					if (!result.success && result.error) {
						terminal.printError(result.error);
					}
					return;
				}

				// AI mode - only if agent is available
				if (currentMode === 'on' && agent) {
					await handleAIMode(trimmed, agent, terminal, cwd, (newCwd) => {
						cwd = newCwd;
						terminal.setCwd(newCwd);
					});
				} else {
					// Fallback: no agent available, execute directly
					const result = await executeCommand(trimmed, cwd, (newCwd) => {
						cwd = newCwd;
						terminal.setCwd(newCwd);
					});

					if (result.output) {
						terminal.printOutput(result.output);
					}

					if (!result.success && result.error) {
						terminal.printError(result.error);
					}
				}
			},
		});

		// Show welcome screen
		terminal.showWelcomeScreen();

		// Show info about API key status
		if (!config.cloudflareAccountId || !config.cloudflareApiToken) {
			terminal.printSystem('ℹ️  Free tier active. Run "nob set-api-key" to use your own API key for unlimited usage.');
		} else {
			terminal.printSystem('✅ Using your own API key (unlimited usage)');
		}

		// Start input prompt
		terminal.promptInput();

	} catch (error) {
		console.error('\n❌ Failed to start nob:', error instanceof Error ? error.message : String(error));
		if (error instanceof Error && error.stack) {
			console.error('\nStack trace:', error.stack);
		}
		process.exit(1);
	}
}

async function handleAIMode(
	input: string,
	agent: NobAgent,
	terminal: TerminalKitUI,
	cwd: string,
	onCwdChange: (newCwd: string) => void
): Promise<void> {
	let isFirstCall = true;
	let lastCommand = '';
	let lastOutput = '';
	let lastExitCode = 0;

	while (true) {
		terminal.printThinking();

		try {
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('Request timed out after 30 seconds')), 30000);
			});

			let response;
			if (isFirstCall) {
				response = await Promise.race([agent.processInput(input, cwd), timeoutPromise]);
				isFirstCall = false;
			} else {
				response = await Promise.race([
					agent.continueWithOutput(lastCommand, lastOutput, lastExitCode, cwd),
					timeoutPromise,
				]);
			}

			terminal.clearThinking();

			if (response.isConversational) {
				terminal.printAssistant(response.response || 'Hello! How can I help?');
				break;
			}

			if (response.status === 'DONE' && !response.command) {
				terminal.printSystem(`✓ ${response.thought || 'Task completed!'}`);
				break;
			}

			if (response.command) {
				// Show command for approval
				if (response.thought) {
					terminal.printThought(response.thought);
				}
				terminal.printApprovalPrompt(response.command, response.status === 'CONTINUE');

				// Wait for approval
				const approved = await terminal.waitForApproval();

				if (approved) {
					terminal.printCommand(response.command, true);

					const result = await executeCommand(response.command, cwd, onCwdChange);
					lastCommand = response.command;
					lastOutput = result.output;
					lastExitCode = result.exitCode;

					if (result.output) {
						terminal.printOutput(result.output);
					}

					if (response.status === 'DONE') {
						terminal.printSystem('✓ Task completed!');
						break;
					}
				} else {
					terminal.printCommand(response.command, false);
					terminal.printSystem('✗ Command skipped. Stopping task.');
					break;
				}
			} else {
				terminal.printAssistant('How can I help you?');
				break;
			}
		} catch (error) {
			terminal.clearThinking();
			terminal.printError(error instanceof Error ? error.message : String(error));
			break;
		}
	}
}

// Only run main() if not handling a special command
if (!['login', 'logout', 'set-api-key', 'config', 'show-config', 'config-show', 'remove-api-key', 'config-remove'].includes(command)) {
	main();
}
