import { spawn } from 'child_process';
import type { CommandResult } from '../types/index.js';

export async function executeCommand(
	command: string,
	cwd: string,
	onCwdChange?: (newCwd: string) => void
): Promise<CommandResult> {
	// Handle cd specially
	if (command.trim().startsWith('cd ')) {
		const newPath = command.trim().substring(3).trim();
		try {
			const targetPath = newPath === '~' ? process.env.HOME || '' : newPath;
			process.chdir(targetPath);
			const newCwd = process.cwd();
			if (onCwdChange) {
				onCwdChange(newCwd);
			}
			return {
				command,
				output: `Changed to ${newCwd}`,
				exitCode: 0,
				success: true,
			};
		} catch (error: any) {
			return {
				command,
				output: error.message,
				exitCode: 1,
				success: false,
				error: error.message,
			};
		}
	}

	return new Promise((resolve) => {
		let output = '';

		const child = spawn(command, {
			shell: true,
			cwd,
			stdio: ['inherit', 'pipe', 'pipe'],
		});

		child.stdout?.on('data', (data) => {
			const text = data.toString();
			output += text;
			process.stdout.write(text);
		});

		child.stderr?.on('data', (data) => {
			const text = data.toString();
			output += text;
			process.stderr.write(text);
		});

		child.on('close', (code) => {
			resolve({
				command,
				output: output.slice(-2000),
				exitCode: code ?? 0,
				success: code === 0,
			});
		});

		child.on('error', (error) => {
			resolve({
				command,
				output: error.message,
				exitCode: 1,
				success: false,
				error: error.message,
			});
		});
	});
}
