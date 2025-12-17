/**
 * Backend Proxy for nob CLI with Rate Limiting
 * 
 * Deploy this as a Cloudflare Worker to keep your credentials secure.
 * The CLI will call this endpoint instead of Workers AI directly.
 */

interface Env {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	RATE_LIMIT_KV?: KVNamespace; // Optional KV for rate limiting
}

// Rate limit configuration
const MAX_REQUESTS_PER_DAY = 100; // Max requests per user per day
const MAX_TOKENS_PER_DAY = 100000; // Max tokens per user per day (rough estimate)

// Estimate tokens (rough: ~4 chars per token)
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// Get user identifier (IP address or user ID from request)
function getUserIdentifier(request: Request, body: any): string {
	// Try to get user ID from request body if provided
	if (body?.userId) {
		return `user:${body.userId}`;
	}
	// Fallback to IP address
	const ip = request.headers.get('CF-Connecting-IP') || 
	           request.headers.get('X-Forwarded-For')?.split(',')[0] || 
	           'unknown';
	return `ip:${ip}`;
}

// Check rate limits
async function checkRateLimit(userId: string, estimatedTokens: number, kv?: KVNamespace): Promise<{ allowed: boolean; reason?: string }> {
	if (!kv) {
		// No KV configured - allow all requests (you can remove this if you want to require KV)
		return { allowed: true };
	}

	const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
	const requestsKey = `requests:${userId}:${today}`;
	const tokensKey = `tokens:${userId}:${today}`;

	// Get current usage
	const [requestsStr, tokensStr] = await Promise.all([
		kv.get(requestsKey),
		kv.get(tokensKey),
	]);

	const requests = parseInt(requestsStr || '0', 10);
	const tokens = parseInt(tokensStr || '0', 10);

	// Check limits
	if (requests >= MAX_REQUESTS_PER_DAY) {
		return { 
			allowed: false, 
			reason: `Rate limit exceeded: ${MAX_REQUESTS_PER_DAY} requests per day. Use your own API key by running "nob set-api-key" or setting NOB_CLOUDFLARE_ACCOUNT_ID and NOB_CLOUDFLARE_API_TOKEN environment variables.` 
		};
	}

	if (tokens + estimatedTokens > MAX_TOKENS_PER_DAY) {
		return { 
			allowed: false, 
			reason: `Token limit exceeded: ${MAX_TOKENS_PER_DAY} tokens per day. Use your own API key by running "nob set-api-key" or setting NOB_CLOUDFLARE_ACCOUNT_ID and NOB_CLOUDFLARE_API_TOKEN environment variables.` 
		};
	}

	// Update usage
	await Promise.all([
		kv.put(requestsKey, (requests + 1).toString(), { expirationTtl: 86400 }), // 24 hours
		kv.put(tokensKey, (tokens + estimatedTokens).toString(), { expirationTtl: 86400 }),
	]);

	return { allowed: true };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// CORS headers for browser/cli access
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405, headers: corsHeaders });
		}

		try {
			const body = await request.json();
			const { messages, model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast', userId } = body;

			// Estimate tokens from messages
			const messagesText = JSON.stringify(messages);
			const estimatedTokens = estimateTokens(messagesText);

			// Get user identifier and check rate limits
			const userIdentifier = getUserIdentifier(request, body);
			const rateLimitCheck = await checkRateLimit(userIdentifier, estimatedTokens, env.RATE_LIMIT_KV);

			if (!rateLimitCheck.allowed) {
				return new Response(
					JSON.stringify({ 
						error: rateLimitCheck.reason || 'Rate limit exceeded',
						code: 'RATE_LIMIT_EXCEEDED'
					}),
					{ 
						status: 429, 
						headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
					}
				);
			}

			// Proxy to Workers AI
			const response = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`,
				{
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						messages: messages,
					}),
				}
			);

			if (!response.ok) {
				const error = await response.text();
				return new Response(
					JSON.stringify({ error: `Workers AI error: ${error}` }),
					{ status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
				);
			}

			const data = await response.json();
			
			// Extract text from Workers AI response
			let text = '';
			if (data.result?.response) {
				text = data.result.response;
			} else if (data.result?.text) {
				text = data.result.text;
			} else if (typeof data.result === 'string') {
				text = data.result;
			}

			return new Response(
				JSON.stringify({ text }),
				{ headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
			);
		} catch (error) {
			return new Response(
				JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
				{ status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
			);
		}
	},
};

