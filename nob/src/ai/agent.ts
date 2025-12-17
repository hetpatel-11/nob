import { generateText } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { NobConfig, AgentResponse, ConversationMessage } from '../types/index.js';

export class NobAgent {
	private config: NobConfig;
	private conversationHistory: ConversationMessage[] = [];

	constructor(config: NobConfig) {
		this.config = config;
	}

	async processInput(input: string, cwd: string): Promise<AgentResponse> {
		this.conversationHistory.push({
			role: 'user',
			content: input,
			timestamp: Date.now(),
		});

		return this.callAI(cwd);
	}

	async continueWithOutput(command: string, output: string, exitCode: number, cwd: string): Promise<AgentResponse> {
		// Add the command execution result to conversation
		const resultMessage = exitCode === 0 
			? `Command executed successfully:\n$ ${command}\n${output || '(no output)'}`
			: `Command failed (exit code ${exitCode}):\n$ ${command}\n${output || '(no output)'}`;
		
		this.conversationHistory.push({
			role: 'user',
			content: resultMessage,
			timestamp: Date.now(),
		});

		return this.callAI(cwd);
	}

	private async callBackendAPI(cwd: string): Promise<AgentResponse> {
		const systemPrompt = this.buildSystemPrompt(cwd);
		
		// Build messages array
		const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
			{ role: 'system', content: systemPrompt },
		];

		// Add conversation history (last 10 messages for context)
		const history = this.conversationHistory.slice(-10);
		for (const msg of history) {
			messages.push({
				role: msg.role,
				content: msg.content,
			});
		}

		// Call your backend API
		const response = await fetch(this.config.apiEndpoint!, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				messages,
				model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
				userId: this.config.userId, // Send userId for rate limiting
			}),
		});

		if (!response.ok) {
			// Handle rate limit errors
			if (response.status === 429) {
				const errorData = await response.json().catch(() => ({})) as { error?: string; code?: string };
				const errorMessage = errorData.error || 'Rate limit exceeded';
				throw new Error(`${errorMessage}\n\nTo use your own API key, set:\nexport NOB_CLOUDFLARE_ACCOUNT_ID=your_account_id\nexport NOB_CLOUDFLARE_API_TOKEN=your_api_token`);
			}
			throw new Error(`Backend API error: ${response.statusText}`);
		}

		const data = await response.json() as { text?: string; response?: string; error?: string };
		
		if (data.error) {
			throw new Error(data.error);
		}
		
		const responseText = data.text || data.response || '';
		
		const agentResponse = this.parseResponse(responseText);

		this.conversationHistory.push({
			role: 'assistant',
			content: responseText,
			timestamp: Date.now(),
		});

		return agentResponse;
	}

	private async callAI(cwd: string): Promise<AgentResponse> {
		try {
			// Priority 1: Use custom credentials if user provided their own (BYO API key)
			if (this.config.cloudflareAccountId && this.config.cloudflareApiToken) {
				return await this.callDirectWorkersAI(cwd);
			}

			// Priority 2: Use backend API (rate limited, uses your credentials)
			if (this.config.apiEndpoint) {
				return await this.callBackendAPI(cwd);
			}

			throw new Error('No AI configuration available. Set NOB_CLOUDFLARE_ACCOUNT_ID and NOB_CLOUDFLARE_API_TOKEN to use your own API key, or configure the backend endpoint.');
		} catch (error) {
			console.error('Agent error:', error);
			throw error;
		}
	}

	private async callDirectWorkersAI(cwd: string): Promise<AgentResponse> {
		// Note: workers-ai-provider API may have changed, using type assertion for now
		// This is only used when users provide their own API keys (BYO)
		const workersai = createWorkersAI({
			accountId: this.config.cloudflareAccountId!,
			apiKey: this.config.cloudflareApiToken!,
		} as any);

		const systemPrompt = this.buildSystemPrompt(cwd);

		const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
			{ role: 'system', content: systemPrompt },
		];

		// Add conversation history (last 10 messages for context)
		const history = this.conversationHistory.slice(-10);
		for (const msg of history) {
			messages.push({
				role: msg.role,
				content: msg.content,
			});
		}

		const result = await generateText({
			model: workersai('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
			messages: messages,
		} as any);

		const responseText = this.extractResponseText(result);
		const agentResponse = this.parseResponse(responseText);

		this.conversationHistory.push({
			role: 'assistant',
			content: responseText,
			timestamp: Date.now(),
		});

		return agentResponse;
	}

	private buildSystemPrompt(cwd: string): string {
		return `You are nob, an agentic terminal assistant that completes tasks step by step.

Directory: ${cwd}
OS: ${process.platform}
Shell: ${this.config.shell}

NOB COMMANDS - You can answer questions about these and execute them:
- "nob on" - Enable AI mode (you're currently in AI mode)
- "nob off" - Switch to manual mode with autosuggestion
- "nob exit" - Exit nob terminal
- "nob help" - Show help message
- "nob set-api-key" - Configure user's Cloudflare Workers AI API key (unlimited usage)
- "nob show-config" - Show current configuration
- "nob remove-api-key" - Remove user's API key (use free tier)
- "nob version" - Show version

If users ask about nob commands, configuration, API keys, rate limits, or how to use nob features:
- Answer their questions clearly
- If they want to configure their API key, you can run "nob set-api-key" for them
- If they want to check their config, run "nob show-config"
- If they want to switch modes, run "nob on" or "nob off"
- Explain the free tier (100 requests/day) and how to use their own API key for unlimited usage

FOR CONVERSATIONS (greetings, questions about nob, general questions):
Just respond naturally and helpfully. If they ask about nob features, explain them.

FOR TERMINAL TASKS - you work in a loop until the task is done:
1. Analyze what needs to be done
2. Output the NEXT command to run
3. After seeing output, decide if more commands needed

OUTPUT FORMAT for commands:
THOUGHT: <what you're thinking/planning>
COMMAND: <single shell command>
STATUS: <CONTINUE if more steps needed, DONE if task complete>

EXAMPLES:

User: "set up a python project"
THOUGHT: First I'll create a virtual environment
COMMAND: python3 -m venv venv
STATUS: CONTINUE

[After seeing success output]
THOUGHT: Now activate and install common packages
COMMAND: source venv/bin/activate && pip install requests
STATUS: CONTINUE

[After seeing success]
THOUGHT: Project is set up with venv and requests installed
STATUS: DONE

User: "push to github"
THOUGHT: First check git status to see what needs committing
COMMAND: git status
STATUS: CONTINUE

[After seeing untracked files]
THOUGHT: Need to stage and commit these files first
COMMAND: git add . && git commit -m "Update files"
STATUS: CONTINUE

[After commit success]
THOUGHT: Now push to remote
COMMAND: git push
STATUS: DONE

User: "how do I set up my own API key?"
THOUGHT: User wants to configure their API key. I should run the set-api-key command for them.
COMMAND: nob set-api-key
STATUS: DONE

User: "what's my current config?"
THOUGHT: User wants to see their configuration. I'll run show-config.
COMMAND: nob show-config
STATUS: DONE

RULES:
- ONE command at a time
- Use STATUS: CONTINUE if more steps needed
- Use STATUS: DONE when task is complete
- After errors, analyze and try to fix
- NEVER refuse - always attempt the task
- If users ask about nob commands or features, you can execute those commands to help them`;
	}

	private buildConversationContext(): string {
		const recentMessages = this.conversationHistory.slice(-6);
		return recentMessages
			.map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
			.join('\n');
	}

	private extractResponseText(result: any): string {
		// Try multiple paths to extract response text
		let responseText = result.text;

		// Check steps array - Workers AI uses content array with type/text structure
		if (!responseText && result.steps && Array.isArray(result.steps)) {
			for (const step of result.steps) {
				// Check direct text property
				if (step.text) {
					responseText = step.text;
					break;
				}
				
				// Check content array (Workers AI format)
				if (step.content && Array.isArray(step.content)) {
					for (const item of step.content) {
						if (item.type === 'text' && item.text && item.text.trim()) {
							responseText = item.text;
							break;
						}
					}
					if (responseText) break;
				}
				
				// Check response object
				if (step.response?.text) {
					responseText = step.response.text;
					break;
				}
			}
		}

		// Check top-level content array
		if (!responseText && result.content && Array.isArray(result.content)) {
			for (const item of result.content) {
				if (item.type === 'text' && item.text && item.text.trim()) {
					responseText = item.text;
					break;
				}
			}
		}

		// Check resolvedOutput
		if (!responseText && result.resolvedOutput) {
			responseText = result.resolvedOutput.text || result.resolvedOutput.response?.text;
			
			// Also check content array in resolvedOutput
			if (!responseText && result.resolvedOutput.content && Array.isArray(result.resolvedOutput.content)) {
				for (const item of result.resolvedOutput.content) {
					if (item.type === 'text' && item.text && item.text.trim()) {
						responseText = item.text;
						break;
					}
				}
			}
		}

		// Check finishReason and text in result
		if (!responseText && result.finishReason) {
			responseText = result.text;
		}

		// Check toolResults - sometimes response is in tool results
		if (!responseText && result.toolResults && Array.isArray(result.toolResults)) {
			for (const toolResult of result.toolResults) {
				if (toolResult.result?.text) {
					responseText = toolResult.result.text;
					break;
				}
			}
		}

		// Last resort: check if result itself is a string
		if (!responseText && typeof result === 'string') {
			responseText = result;
		}

		// If still no text, return empty
		if (!responseText || responseText.trim() === '') {
			return '';
		}

		return responseText.trim();
	}

	private parseResponse(text: string): AgentResponse {
		// Extract THOUGHT, COMMAND, STATUS format
		const thoughtMatch = text.match(/THOUGHT:\s*(.+?)(?=\n|COMMAND:|STATUS:|$)/is);
		const commandMatch = text.match(/COMMAND:\s*(.+?)(?=\n|STATUS:|$)/i);
		const statusMatch = text.match(/STATUS:\s*(CONTINUE|DONE)/i);
		
		// If we have a command, it's an action
		if (commandMatch) {
			const command = commandMatch[1].trim().replace(/`/g, '');
			const thought = thoughtMatch ? thoughtMatch[1].trim() : '';
			const status = statusMatch ? statusMatch[1].toUpperCase() as 'CONTINUE' | 'DONE' : 'DONE';
			
			return {
				isConversational: false,
				thought,
				command,
				status,
			};
		}
		
		// Check for STATUS: DONE without command (task complete)
		if (statusMatch && statusMatch[1].toUpperCase() === 'DONE') {
			return {
				isConversational: true,
				thought: thoughtMatch ? thoughtMatch[1].trim() : '',
				response: thoughtMatch ? thoughtMatch[1].trim() : 'Task completed!',
				status: 'DONE',
			};
		}
		
		// Look for backtick-wrapped command as fallback
		const backtickMatch = text.match(/`([^`]+)`/);
		if (backtickMatch) {
			const potentialCmd = backtickMatch[1].trim();
			if (/^(source|ls|cd|mkdir|rm|cp|mv|cat|grep|find|git|npm|node|python|pip|echo|pwd|chmod|sudo|brew|yarn|pnpm|docker|kubectl|make|go|cargo|curl|wget|ssh|tar|zip)/i.test(potentialCmd)) {
				return {
					isConversational: false,
					command: potentialCmd,
					thought: '',
					status: 'DONE',
				};
			}
		}

		// Direct command detection
		const firstLine = text.trim().split('\n')[0];
		if (/^(source|ls|cd|mkdir|rm|cp|mv|cat|grep|find|git|npm|node|python|pip|echo|pwd|chmod|sudo|brew|yarn|pnpm|docker|kubectl|make|go|cargo|curl|wget|ssh|tar|zip)\s/i.test(firstLine)) {
			return {
				isConversational: false,
				command: firstLine,
				thought: '',
				status: 'DONE',
			};
		}

		// Default: conversational
		return {
			isConversational: true,
			response: text.trim(),
			status: 'CONVERSATION',
		};
	}

	clearHistory() {
		this.conversationHistory = [];
	}
}

