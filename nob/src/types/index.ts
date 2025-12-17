export interface NobConfig {
	apiEndpoint?: string; // Backend API endpoint (preferred - keeps credentials secure)
	cloudflareAccountId: string; // Fallback for direct Workers AI (not recommended for open source)
	cloudflareApiToken: string; // Fallback for direct Workers AI (not recommended for open source)
	userId: string;
	shell: string;
}

export type NobMode = 'on' | 'off';

export interface CommandResult {
	command: string;
	output: string;
	exitCode: number;
	success: boolean;
	error?: string;
}

export interface ConversationMessage {
	role: 'user' | 'assistant';
	content: string;
	timestamp: number;
}

export interface AgentResponse {
	isConversational: boolean;
	response?: string;
	thought?: string;
	command?: string;
	status: 'CONTINUE' | 'DONE' | 'CONVERSATION';
}

