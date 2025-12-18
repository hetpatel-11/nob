import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const CONFIG_DIR = join(homedir(), '.nob');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface UserConfig {
	cloudflareAccountId?: string;
	cloudflareApiToken?: string;
	loginToken?: string;
	loginEmail?: string;
	loginExpiry?: number; // Unix timestamp
}

export async function loadUserConfig(): Promise<UserConfig> {
	try {
		if (!existsSync(CONFIG_FILE)) {
			return {};
		}

		const content = await readFile(CONFIG_FILE, 'utf-8');
		return JSON.parse(content) as UserConfig;
	} catch (error) {
		// If file is corrupted or can't be read, return empty config
		return {};
	}
}

export async function saveUserConfig(config: UserConfig): Promise<void> {
	try {
		// Ensure config directory exists
		if (!existsSync(CONFIG_DIR)) {
			await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
		}

		// Write config file
		await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
		
		// Note: File permissions are set, but on some systems you may need to use chmod
		// The mode option should work on Unix-like systems
	} catch (error) {
		throw new Error(`Failed to save config: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function getConfigFilePath(): string {
	return CONFIG_FILE;
}

