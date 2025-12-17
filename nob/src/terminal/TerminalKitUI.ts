import termkit from 'terminal-kit';
import os from 'os';
import { execSync, execFileSync } from 'child_process';
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const term = termkit.terminal;

export interface TerminalConfig {
	onSubmit: (input: string) => Promise<void>;
	onExit: () => void;
	cwd: string;
	mode: 'on' | 'off';
	version: string;
}

export class TerminalKitUI {
	private config: TerminalConfig;
	private history: string[] = [];
	private historyIndex: number = -1;
	private savedInput: string = '';
	private isProcessing: boolean = false;
	private systemCommands: string[] = [];
	private shellHistory: string[] = [];
	private commandCache: Map<string, string[]> = new Map();

	// Input state - simple like zsh
	private inputBuffer: string = '';
	private cursorPos: number = 0;
	private inputActive: boolean = false;
	private lastAcceptedCompletion: string = '';
	private inputStartRow: number = 0;

	constructor(config: TerminalConfig) {
		this.config = config;
		this.loadSystemCommands();
		this.loadShellHistory();
	}

	private loadSystemCommands(): void {
		try {
			const result = execSync(
				'compgen -c 2>/dev/null || ls /usr/bin /usr/local/bin /opt/homebrew/bin 2>/dev/null',
				{
					shell: '/bin/bash',
					encoding: 'utf8',
					timeout: 5000,
				}
			);

			const commands = new Set<string>();
			result.split('\n').forEach((cmd) => {
				const trimmed = cmd.trim();
				if (trimmed && !trimmed.startsWith('.') && !trimmed.includes(' ')) {
					commands.add(trimmed);
				}
			});

			commands.add('nob on');
			commands.add('nob off');
			commands.add('nob exit');
			commands.add('clear');
			commands.add('exit');

			this.systemCommands = Array.from(commands).sort();
		} catch {
			this.systemCommands = ['nob on', 'nob off', 'nob exit', 'clear', 'exit'];
		}
	}

	private loadShellHistory(): void {
		try {
			const shell = process.env.SHELL || '/bin/bash';
			const home = process.env.HOME || '';
			let historyFile = '';

			if (shell.includes('zsh')) {
				historyFile = join(home, '.zsh_history');
			} else if (shell.includes('bash')) {
				historyFile = join(home, '.bash_history');
			} else if (shell.includes('fish')) {
				historyFile = join(home, '.local', 'share', 'fish', 'fish_history');
			}

			if (historyFile && existsSync(historyFile)) {
				const content = execFileSync('tail', ['-n', '500', historyFile], {
					encoding: 'utf8',
					timeout: 2000,
				});

				const lines = content.split('\n');
				const commands = new Set<string>();

				for (const line of lines) {
					let cmd = line;
					if (line.startsWith(':')) {
						const match = line.match(/^:\s*\d+:\d+;(.+)$/);
						if (match) cmd = match[1];
					}
					cmd = cmd.trim();
					if (cmd && !cmd.startsWith('#') && cmd.length > 2) {
						commands.add(cmd);
					}
				}

				this.shellHistory = Array.from(commands);
			}
		} catch {
			// Shell history not available
		}
	}

	private shortenPath(path: string): string {
		const home = process.env.HOME || '';
		if (path.startsWith(home)) {
			return '~' + path.slice(home.length);
		}
		return path;
	}

	public showWelcomeScreen(): void {
		const userName = os.userInfo().username || 'there';
		const capitalizedName = userName.charAt(0).toUpperCase() + userName.slice(1);
		const shortPath = this.shortenPath(this.config.cwd);

		const modeText = this.config.mode === 'on' ? 'AI Mode' : 'Manual Mode';

		// Don't clear screen - preserve previous terminal content
		term('\n\n');
		term.gray('╭──────────────────────────────────────────────────────────────────────────────╮\n');
		term.gray('│').gray(' '.repeat(78)).gray('│\n');
		const welcomeText = `Welcome back ${capitalizedName}!`;
		const welcomeLeftPad = Math.floor((78 - welcomeText.length) / 2);
		const welcomeRightPad = 78 - welcomeText.length - welcomeLeftPad;
		term.gray('│').gray(' '.repeat(welcomeLeftPad)).white.bold(welcomeText).gray(' '.repeat(welcomeRightPad)).gray('│\n');
		term.gray('│').gray(' '.repeat(78)).gray('│\n');
		// ASCII art logo - one eye, centered, exactly 78 chars
		const logo = [
			'     ╭─────╮     ',
			'    ╱       ╲    ',
			'   │    ◉    │   ',
			'    ╲       ╱    ',
			'     ╰─────╯     ',
		];
		
		for (const line of logo) {
			const leftPad = Math.floor((78 - line.length) / 2);
			const rightPad = 78 - line.length - leftPad;
			term.gray('│').gray(' '.repeat(leftPad)).magenta(line).gray(' '.repeat(rightPad)).gray('│\n');
		}
		term.gray('│').gray(' '.repeat(78)).gray('│\n');

		// Mode text - center aligned (78 chars total width)
		const modeLeftPad = Math.floor((78 - modeText.length) / 2);
		const modeRightPad = 78 - modeText.length - modeLeftPad;
		term.gray('│').gray(' '.repeat(modeLeftPad));
		if (this.config.mode === 'on') {
			term.green.bold(modeText);
		} else {
			term.yellow.bold(modeText);
		}
		term.gray(' '.repeat(modeRightPad)).gray('│\n');

		// Path - center aligned (78 chars total width)
		const pathLeftPad = Math.floor((78 - shortPath.length) / 2);
		const pathRightPad = 78 - shortPath.length - pathLeftPad;
		term.gray('│').gray(' '.repeat(pathLeftPad)).blue(shortPath).gray(' '.repeat(pathRightPad)).gray('│\n');
		term.gray('│').gray(' '.repeat(78)).gray('│\n');
		term.gray('│──────────────────────────────────────────────────────────────────────────────│\n');
		term.gray('│').gray(' '.repeat(78)).gray('│\n');
		// Shortcuts section - all lines must be exactly 78 chars between │
		const shortcuts = [
			{ cmd: 'Shortcuts', desc: '' },
			{ cmd: 'nob on    ', desc: ' Enable AI mode' },
			{ cmd: 'nob off   ', desc: ' Manual shell + autosuggestion' },
			{ cmd: 'Tab       ', desc: ' Accept suggestion (manual only)' },
			{ cmd: '↑/↓       ', desc: ' Navigate history' },
			{ cmd: 'exit      ', desc: ' Quit nob' },
		];
		
		for (const item of shortcuts) {
			const leftMargin = '  '; // 2 spaces inside the box
			const totalContent = leftMargin.length + item.cmd.length + item.desc.length;
			const padding = 78 - totalContent;
			term.gray('│').gray(leftMargin);
			if (item.desc === '') {
				term.white.bold(item.cmd);
			} else {
				term.cyan(item.cmd).gray(item.desc);
			}
			term.gray(' '.repeat(padding)).gray('│\n');
		}
		term.gray('│').gray(' '.repeat(78)).gray('│\n');
		const versionPrefix = '─── ';
		const versionSuffix = ' ───';
		const versionText = `nob v${this.config.version}`;
		const fullVersionText = versionPrefix + versionText + versionSuffix;
		const versionLeftPad = Math.floor((78 - fullVersionText.length) / 2);
		const versionRightPad = 78 - fullVersionText.length - versionLeftPad;
		term.gray('│').gray(' '.repeat(versionLeftPad)).gray(versionPrefix).magenta.bold('nob').gray(` v${this.config.version}`).gray(versionSuffix).gray(' '.repeat(versionRightPad)).gray('│\n');
		term.gray('╰──────────────────────────────────────────────────────────────────────────────╯\n');
		term('\n');
	}

	public async promptInput(): Promise<void> {
		if (this.isProcessing || this.inputActive) return;

		this.inputActive = true;
		this.inputBuffer = '';
		this.cursorPos = 0;
		this.historyIndex = -1;
		this.savedInput = '';
		this.lastAcceptedCompletion = '';

		const shortPath = this.shortenPath(this.config.cwd);
		const aiStatus = this.config.mode === 'on' ? 'AI On' : 'AI Off';
		term.green.bold(`[${aiStatus}] `).magenta.bold('❯ ').blue(shortPath)('\n');

		// Get cursor position
		const loc = await new Promise<{x: number, y: number}>((resolve) => {
			term.getCursorLocation((err: any, x: number, y: number) => {
				if (err) {
					resolve({ x: 1, y: Math.max(1, term.height - 10) });
				} else {
					resolve({ x, y });
				}
			});
		});
		
		this.inputStartRow = loc.y;

		this.renderInput();

		term.grabInput(true);
		term.hideCursor(false);
		process.stdout.write('\x1b[1 q');

		term.on('key', this.handleKey);
	}

	private handleKey = async (key: string) => {
		if (!this.inputActive) return;

		// Enter - submit
		if (key === 'ENTER') {
			term.off('key', this.handleKey);
			term.grabInput(false);
			this.inputActive = false;
			term('\n');
			await this.handleSubmit();
			return;
		}

		// Ctrl+C - clear
		if (key === 'CTRL_C') {
			this.inputBuffer = '';
			this.cursorPos = 0;
			this.renderInput();
			return;
		}

		// Backspace
		if (key === 'BACKSPACE') {
			if (this.cursorPos > 0) {
				this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos - 1) + this.inputBuffer.slice(this.cursorPos);
				this.cursorPos--;
				this.renderInput();
			}
			return;
		}

		// Delete
		if (key === 'DELETE') {
			if (this.cursorPos < this.inputBuffer.length) {
				this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos) + this.inputBuffer.slice(this.cursorPos + 1);
				this.renderInput();
			}
			return;
		}

		// Left
		if (key === 'LEFT') {
			if (this.cursorPos > 0) {
				this.cursorPos--;
				this.renderInput();
			}
			return;
		}

		// Right (+ accept suggestion at end)
		if (key === 'RIGHT') {
			if (this.cursorPos < this.inputBuffer.length) {
				this.cursorPos++;
			} else if (this.config.mode === 'off') {
				const prediction = this.getInlinePrediction(this.inputBuffer);
				if (prediction && prediction !== this.inputBuffer && prediction !== this.lastAcceptedCompletion) {
					this.inputBuffer = prediction;
					this.cursorPos = this.inputBuffer.length;
					this.lastAcceptedCompletion = prediction;
				}
			}
			this.renderInput();
			return;
		}

		// Up - history
		if (key === 'UP') {
			if (this.history.length > 0) {
				if (this.historyIndex === -1) {
					this.savedInput = this.inputBuffer;
					this.historyIndex = this.history.length - 1;
				} else if (this.historyIndex > 0) {
					this.historyIndex--;
				}
				this.inputBuffer = this.history[this.historyIndex];
				this.cursorPos = this.inputBuffer.length;
				this.renderInput();
			}
			return;
		}

		// Down - history
		if (key === 'DOWN') {
			if (this.historyIndex !== -1) {
				if (this.historyIndex < this.history.length - 1) {
					this.historyIndex++;
					this.inputBuffer = this.history[this.historyIndex];
				} else {
					this.historyIndex = -1;
					this.inputBuffer = this.savedInput;
				}
				this.cursorPos = this.inputBuffer.length;
				this.renderInput();
			}
			return;
		}

		// Tab - accept suggestion
		if (key === 'TAB') {
			if (this.config.mode === 'off') {
				const prediction = this.getInlinePrediction(this.inputBuffer);
				if (prediction && prediction !== this.inputBuffer) {
					this.inputBuffer = prediction;
					this.cursorPos = this.inputBuffer.length;
					this.lastAcceptedCompletion = prediction;
					this.renderInput();
				}
			}
			return;
		}

		// Home
		if (key === 'HOME') {
			this.cursorPos = 0;
			this.renderInput();
			return;
		}

		// End
		if (key === 'END') {
			this.cursorPos = this.inputBuffer.length;
			this.renderInput();
			return;
		}

		// Regular character
		if (key.length === 1 && key.charCodeAt(0) >= 32) {
			this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos) + key + this.inputBuffer.slice(this.cursorPos);
			this.cursorPos++;
			this.lastAcceptedCompletion = '';
			this.renderInput();
			return;
		}
	};

	// Render input and position cursor (handles wrapped lines like zsh)
	private renderInput(): void {
		const MARGIN = 2;
		const termWidth = term.width || 80;
		const textAreaWidth = termWidth - MARGIN;
		
		// Calculate how many lines the input might take (including prediction)
		const fullText = this.inputBuffer + (this.config.mode === 'off' ? (this.getInlinePrediction(this.inputBuffer)?.slice(this.inputBuffer.length) || '') : '');
		const totalChars = MARGIN + fullText.length;
		const estimatedLines = Math.max(1, Math.ceil(totalChars / termWidth));
		
		// Clear only the input lines (not the entire screen)
		for (let i = 0; i < estimatedLines; i++) {
			process.stdout.write(`\x1b[${this.inputStartRow + i};1H`);
			process.stdout.write('\x1b[K'); // Clear from cursor to end of line only
		}
		
		// Move back to start of input
		process.stdout.write(`\x1b[${this.inputStartRow};1H`);
		
		if (this.inputBuffer.length === 0) {
			process.stdout.write('  \x1b[90mType a command or question...\x1b[0m');
			process.stdout.write(`\x1b[${this.inputStartRow};${MARGIN + 1}H`);
			return;
		}
		
		// Render text with margin
		process.stdout.write('  ');
		process.stdout.write(this.inputBuffer);
		
		// Show inline prediction (manual mode)
		if (this.config.mode === 'off') {
			const prediction = this.getInlinePrediction(this.inputBuffer);
			if (prediction && prediction.length > this.inputBuffer.length) {
				process.stdout.write('\x1b[90m' + prediction.slice(this.inputBuffer.length) + '\x1b[0m');
			}
		}
		
		// Calculate cursor position accounting for line wrap
		// Characters before cursor + margin
		const charsBeforeCursor = MARGIN + this.cursorPos;
		const cursorRow = this.inputStartRow + Math.floor(charsBeforeCursor / termWidth);
		const cursorCol = (charsBeforeCursor % termWidth) + 1; // 1-based
		
		process.stdout.write(`\x1b[${cursorRow};${cursorCol}H`);
	}
	

	private getInlinePrediction(partial: string): string | null {
		if (!partial) return null;
		const completions = this.getCompletions(partial);
		return completions.length > 0 ? completions[0] : null;
	}

	private async handleSubmit(): Promise<void> {
		const trimmed = this.inputBuffer.trim();

		if (!trimmed) {
			this.promptInput();
			return;
		}

		// Add to history
		if (trimmed !== this.history[this.history.length - 1]) {
			this.history.push(trimmed);
		}

		// Handle exit
		if (trimmed === 'exit' || trimmed === 'nob exit') {
			term.gray('Goodbye! 👋\n');
			this.cleanup();
			this.config.onExit();
			return;
		}

		// Handle mode switching
		if (trimmed === 'nob on') {
			this.config.mode = 'on';
			term.green('✓ AI mode activated\n');
			this.promptInput();
			return;
		}

		if (trimmed === 'nob off') {
			this.config.mode = 'off';
			term.yellow('✓ Manual shell mode activated with autosuggestion\n');
			this.promptInput();
			return;
		}

		if (trimmed === 'nob help' || trimmed === 'nob --help' || trimmed === 'nob -h') {
			term('\n');
			term.cyan.bold('nob Commands:\n');
			term('  ').cyan('nob on').gray('      - Enable AI mode\n');
			term('  ').cyan('nob off').gray('     - Switch to manual mode with autosuggestion\n');
			term('  ').cyan('nob exit').gray('    - Exit nob\n');
			term('  ').cyan('nob help').gray('    - Show this help\n');
			term('  ').cyan('nob version').gray(' - Show version\n');
			term('  ').cyan('clear').gray('       - Clear screen\n');
			term('\n');
			term.cyan.bold('Bring Your Own API Key (BYOK):\n');
			term('  ').cyan('nob set-api-key').gray(' - Configure your own API key (unlimited usage)\n');
			term('  ').gray('  By default, uses shared backend (100 requests/day limit)\n');
			term('  ').gray('  Get credentials: https://dash.cloudflare.com\n');
			term('\n');
			term.cyan.bold('Keyboard Shortcuts (Manual Mode):\n');
			term('  ').cyan('Tab').gray('         - Accept autosuggestion (manual mode only)\n');
			term('  ').cyan('↑ / ↓').gray('       - Navigate command history\n');
			term('  ').cyan('← / →').gray('       - Move cursor left/right\n');
			term('  ').cyan('Ctrl+C').gray('      - Clear current input\n');
			term('\n');
			this.promptInput();
			return;
		}

		if (trimmed === 'nob version' || trimmed === 'nob --version' || trimmed === 'nob -v') {
			term.magenta.bold(`nob v${this.config.version}\n`);
			this.promptInput();
			return;
		}

		if (trimmed === 'clear') {
			term.clear();
			this.promptInput();
			return;
		}

		// Process command
		this.isProcessing = true;
		try {
			await this.config.onSubmit(trimmed);
		} finally {
			this.isProcessing = false;
			this.promptInput();
		}
	}

	public print(message: string): void {
		term(message + '\n');
	}

	public printOutput(output: string): void {
		term.gray(output + '\n');
	}

	public printError(error: string): void {
		term.red('✗ Error: ' + error + '\n');
	}

	public printSystem(message: string): void {
		term.gray(message + '\n');
	}

	public printCommand(command: string, approved: boolean): void {
		if (approved) {
			term.gray('$ ').yellow(command).green(' ✓\n');
		} else {
			term.gray('$ ').red(command + ' ✗\n');
		}
	}

	public printThinking(): void {
		term.gray('  Thinking...');
	}

	public clearThinking(): void {
		term.eraseLine();
		term.column(1);
	}

	public printAssistant(message: string): void {
		term.magenta.bold('◆ nob: ').white(message + '\n');
	}

	public printThought(thought: string): void {
		term.gray('💭 ' + thought + '\n');
	}

	public printApprovalPrompt(command: string, hasMoreSteps: boolean): void {
		term.gray('$ ').yellow(command + '\n');
		if (hasMoreSteps) {
			term.gray('   (more steps to follow)\n');
		}
		term('\n');
		term.green.bold('[y]').gray(' run  ').red.bold('[n]').gray(' skip\n');
	}

	public async waitForApproval(): Promise<boolean> {
		return new Promise((resolve) => {
			term.grabInput(true);

			const handler = (key: string) => {
				if (key === 'y' || key === 'Y') {
					term.grabInput(false);
					term.off('key', handler);
					resolve(true);
				} else if (key === 'n' || key === 'N' || key === 'ESCAPE') {
					term.grabInput(false);
					term.off('key', handler);
					resolve(false);
				}
			};

			term.on('key', handler);
		});
	}

	public setMode(mode: 'on' | 'off'): void {
		this.config.mode = mode;
	}

	public getMode(): 'on' | 'off' {
		return this.config.mode;
	}

	public setCwd(cwd: string): void {
		this.config.cwd = cwd;
	}

	public cleanup(): void {
		term.off('key', this.handleKey);
		term.grabInput(false);
		process.stdout.write('\x1b[2 q');
		term.processExit(0);
	}

	// ===== Autocomplete Methods =====

	private getCompletions(partial: string): string[] {
		if (!partial) return [];

		const cacheKey = partial.toLowerCase();
		if (this.commandCache.has(cacheKey)) {
			return this.commandCache.get(cacheKey)!;
		}

		const parts = partial.split(' ');
		const lastPart = parts[parts.length - 1];
		const prefix = parts.length > 1 ? parts.slice(0, -1).join(' ') + ' ' : '';

		let completions: string[] = [];

		if (parts.length > 1) {
			completions = this.getContextAwareCompletions(parts, lastPart, prefix);
		} else {
			// First priority: shell history matches
			const historyMatches = this.shellHistory
				.filter((h) => h.toLowerCase().startsWith(partial.toLowerCase()))
				.slice(0, 10);

			// Second priority: system commands
			const systemMatches = this.systemCommands
				.filter((c) => c.toLowerCase().startsWith(partial.toLowerCase()))
				.slice(0, 20);

			// Combine with history first, deduplicated
			const seen = new Set<string>();
			completions = [...historyMatches, ...systemMatches].filter((c) => {
				if (seen.has(c.toLowerCase())) return false;
				seen.add(c.toLowerCase());
				return true;
			});
		}

		// Cache results
		if (this.commandCache.size > 1000) {
			this.commandCache.clear();
		}
		this.commandCache.set(cacheKey, completions);

		return completions;
	}

	private getContextAwareCompletions(parts: string[], lastPart: string, prefix: string): string[] {
		const cmd = parts[0].toLowerCase();

		// Smart completions for common commands
		const smartCompletions = this.getSmartCompletions(parts, lastPart, prefix);
		if (smartCompletions.length > 0) {
			return smartCompletions;
		}

		// cd - directories only
		if (cmd === 'cd') {
			return this.getFileCompletions(lastPart, true).map((c) => prefix + c);
		}

		// Git completions
		if (cmd === 'git') {
			return this.getGitCompletions(parts, lastPart, prefix);
		}

		// npm/yarn/pnpm completions
		if (['npm', 'yarn', 'pnpm'].includes(cmd)) {
			return this.getNpmCompletions(parts, lastPart, prefix);
		}

		// Default: file/directory completion
		return this.getFileCompletions(lastPart, false).map((c) => prefix + c);
	}

	private getSmartCompletions(parts: string[], lastPart: string, prefix: string): string[] {
		const cmd = parts[0].toLowerCase();

		// source - prioritize venv/bin/activate
		if (cmd === 'source' || cmd === '.') {
			const suggestions: string[] = [];
			const seen = new Set<string>();
			
			if (existsSync(join(this.config.cwd, 'venv/bin/activate'))) {
				if ('venv/bin/activate'.startsWith(lastPart) || lastPart === '') {
					const suggestion = prefix + 'venv/bin/activate';
					if (!seen.has(suggestion)) {
						seen.add(suggestion);
						return [suggestion];
					}
				}
			}
			if (existsSync(join(this.config.cwd, '.env'))) {
				if ('.env'.startsWith(lastPart) || lastPart === '') {
					const suggestion = prefix + '.env';
					if (!seen.has(suggestion)) {
						seen.add(suggestion);
						suggestions.push('.env');
					}
				}
			}
			const shellFiles = this.getFileCompletions(lastPart, false).filter(
				(f) => {
					const suggestion = prefix + f;
					if (seen.has(suggestion)) return false;
					seen.add(suggestion);
					return (
						f.endsWith('.sh') ||
						f.endsWith('.bash') ||
						f.endsWith('.zsh') ||
						f.includes('activate') ||
						f === '.env'
					);
				}
			);
			suggestions.push(...shellFiles);
			if (suggestions.length > 0) {
				return suggestions.map((c) => prefix + c);
			}
		}

		// chmod - suggest common permissions
		if (cmd === 'chmod' && parts.length === 2) {
			const perms = ['+x', '-x', '755', '644', '600', '777', '700', 'u+x', 'a+x'];
			return perms.filter((p) => p.startsWith(lastPart)).map((p) => prefix + p);
		}

		// docker completions
		if (cmd === 'docker' && parts.length === 2) {
			const subcommands = [
				'build', 'compose', 'container', 'exec', 'image', 'images',
				'kill', 'logs', 'network', 'ps', 'pull', 'push', 'restart',
				'rm', 'rmi', 'run', 'start', 'stop', 'system', 'volume',
			];
			return subcommands.filter((s) => s.startsWith(lastPart)).map((s) => prefix + s);
		}

		// kubectl completions
		if (cmd === 'kubectl' && parts.length === 2) {
			const subcommands = [
				'apply', 'create', 'delete', 'describe', 'edit', 'exec', 'get',
				'logs', 'port-forward', 'rollout', 'scale', 'set',
			];
			return subcommands.filter((s) => s.startsWith(lastPart)).map((s) => prefix + s);
		}

		// python - suggest .py files
		if ((cmd === 'python' || cmd === 'python3') && parts.length === 2) {
			if (lastPart.startsWith('-')) {
				const flags = ['-m', '-c', '--version', '-V', '-h', '--help'];
				return flags.filter((f) => f.startsWith(lastPart)).map((f) => prefix + f);
			}
			const pyFiles = this.getFileCompletions(lastPart, false).filter(
				(f) => f.endsWith('.py') || f.endsWith('/')
			);
			if (pyFiles.length > 0) return pyFiles.map((c) => prefix + c);
		}

		// make - suggest Makefile targets
		if (cmd === 'make') {
			try {
				if (!existsSync(join(this.config.cwd, 'Makefile'))) return [];
				const content = execSync('cat Makefile 2>/dev/null', {
					encoding: 'utf8',
					cwd: this.config.cwd,
					timeout: 500,
				});
				const targets: string[] = [];
				content.split('\n').forEach((line) => {
					const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/);
					if (match && !match[1].startsWith('.')) {
						targets.push(match[1]);
					}
				});
				return targets.filter((t) => t.startsWith(lastPart)).map((t) => prefix + t);
			} catch {
				return [];
			}
		}

		// brew (macOS)
		if (cmd === 'brew' && parts.length === 2) {
			const subcommands = [
				'install', 'uninstall', 'update', 'upgrade', 'search', 'info',
				'list', 'services', 'doctor', 'cleanup', 'outdated',
			];
			return subcommands.filter((s) => s.startsWith(lastPart)).map((s) => prefix + s);
		}

		// cargo (Rust)
		if (cmd === 'cargo' && parts.length === 2) {
			const subcommands = [
				'build', 'run', 'test', 'check', 'clean', 'doc', 'new', 'init',
				'add', 'remove', 'update', 'publish', 'fmt', 'clippy',
			];
			return subcommands.filter((s) => s.startsWith(lastPart)).map((s) => prefix + s);
		}

		// go
		if (cmd === 'go' && parts.length === 2) {
			const subcommands = [
				'build', 'run', 'test', 'get', 'install', 'mod', 'fmt', 'vet',
				'doc', 'clean', 'env', 'version',
			];
			return subcommands.filter((s) => s.startsWith(lastPart)).map((s) => prefix + s);
		}

		return [];
	}

	private getGitCompletions(parts: string[], lastPart: string, prefix: string): string[] {
		const gitSubcommands = [
			'add', 'bisect', 'branch', 'checkout', 'cherry-pick', 'clone', 'commit',
			'diff', 'fetch', 'grep', 'init', 'log', 'merge', 'mv', 'pull', 'push',
			'rebase', 'remote', 'reset', 'restore', 'revert', 'rm', 'show', 'stash',
			'status', 'switch', 'tag', 'worktree',
		];

		if (parts.length === 2) {
			return gitSubcommands
				.filter((s) => s.startsWith(lastPart.toLowerCase()))
				.map((s) => prefix + s);
		}

		const subCmd = parts[1];

		if (['checkout', 'switch', 'branch', 'merge', 'rebase'].includes(subCmd)) {
			try {
				const branches = execSync('git branch -a 2>/dev/null', {
					encoding: 'utf8',
					cwd: this.config.cwd,
					timeout: 1000,
				});
				return branches
					.split('\n')
					.map((b) => b.replace(/^\*?\s*/, '').replace('remotes/origin/', '').trim())
					.filter((b) => b && b.startsWith(lastPart) && !b.includes('HEAD'))
					.map((b) => prefix + b);
			} catch {
				// Fall through
			}
		}

		if (['add', 'diff', 'restore', 'rm', 'checkout'].includes(subCmd)) {
			try {
				const status = execSync('git status --porcelain 2>/dev/null', {
					encoding: 'utf8',
					cwd: this.config.cwd,
					timeout: 1000,
				});
				const files = status
					.split('\n')
					.map((line) => line.slice(3).trim())
					.filter((f) => f && f.startsWith(lastPart));

				if (files.length > 0) {
					return files.map((f) => prefix + f);
				}
			} catch {
				// Fall through
			}
		}

		return this.getFileCompletions(lastPart, false).map((c) => prefix + c);
	}

	private getNpmCompletions(parts: string[], lastPart: string, prefix: string): string[] {
		const npmSubcommands = [
			'access', 'adduser', 'audit', 'bin', 'bugs', 'cache', 'ci', 'completion',
			'config', 'dedupe', 'deprecate', 'diff', 'dist-tag', 'docs', 'doctor',
			'edit', 'exec', 'explain', 'explore', 'find-dupes', 'fund', 'help',
			'hook', 'init', 'install', 'install-ci-test', 'install-test', 'link',
			'll', 'login', 'logout', 'ls', 'org', 'outdated', 'owner', 'pack',
			'ping', 'pkg', 'prefix', 'profile', 'prune', 'publish', 'rebuild',
			'repo', 'restart', 'root', 'run', 'run-script', 'search', 'set',
			'shrinkwrap', 'star', 'stars', 'start', 'stop', 'team', 'test',
			'token', 'uninstall', 'unpublish', 'unstar', 'update', 'version', 'view', 'whoami',
		];

		if (parts.length === 2) {
			return npmSubcommands
				.filter((s) => s.startsWith(lastPart.toLowerCase()))
				.map((s) => prefix + s);
		}

		if (parts[1] === 'run' && parts.length === 3) {
			try {
				const pkg = JSON.parse(
					execSync('cat package.json 2>/dev/null', {
						encoding: 'utf8',
						cwd: this.config.cwd,
						timeout: 1000,
					})
				);
				const scripts = Object.keys(pkg.scripts || {});
				return scripts.filter((s) => s.startsWith(lastPart)).map((s) => prefix + s);
			} catch {
				// No package.json
			}
		}

		return [];
	}

	private getFileCompletions(partial: string, dirsOnly: boolean): string[] {
		try {
			const dir = partial.includes('/')
				? partial.substring(0, partial.lastIndexOf('/') + 1)
				: '';
			const searchDir = dir ? join(this.config.cwd, dir) : this.config.cwd;
			const filePrefix = partial.includes('/')
				? partial.substring(partial.lastIndexOf('/') + 1)
				: partial;

			const entries = readdirSync(searchDir);
			const completions: string[] = [];

			for (const entry of entries) {
				if (entry.startsWith('.') && !filePrefix.startsWith('.')) continue;
				if (!entry.toLowerCase().startsWith(filePrefix.toLowerCase())) continue;

				try {
					const fullPath = join(searchDir, entry);
					const stat = statSync(fullPath);

					if (dirsOnly && !stat.isDirectory()) continue;

					const completion = dir + entry + (stat.isDirectory() ? '/' : '');
					completions.push(completion);
				} catch {
					// Skip if can't stat
				}
			}

			return completions.sort();
		} catch {
			return [];
		}
	}
}
