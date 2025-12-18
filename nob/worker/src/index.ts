/**
 * Backend Proxy for nob CLI with Rate Limiting
 * 
 * Deploy this as a Cloudflare Worker to keep your credentials secure.
 * The CLI will call this endpoint instead of Workers AI directly.
 */

interface Env {
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	RATE_LIMIT_KV?: KVNamespace; // KV for rate limiting and user storage
	// OAuth credentials
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	JWT_SECRET: string; // Secret for signing JWT tokens
}

// User data structure
interface UserData {
	id: string;
	email: string;
	provider: 'github' | 'google';
	createdAt: string;
	lastLogin: string;
}

// Rate limit configuration
// ~43 neurons per request, 10,000 free neurons/day
// Budget: ~$280/month for 1000 users at 20 req/day
const MAX_REQUESTS_PER_USER_PER_DAY = 20; // Max requests per user per day
const MAX_GLOBAL_REQUESTS_PER_DAY = 50000; // Safety cap: ~$24/day max

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

// Check rate limits (per-user + global)
async function checkRateLimit(userId: string, kv?: KVNamespace): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
	if (!kv) {
		// No KV configured - allow all requests
		return { allowed: true };
	}

	const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
	const userRequestsKey = `requests:${userId}:${today}`;
	const globalRequestsKey = `requests:global:${today}`;

	// Get current usage
	const [userRequestsStr, globalRequestsStr] = await Promise.all([
		kv.get(userRequestsKey),
		kv.get(globalRequestsKey),
	]);

	const userRequests = parseInt(userRequestsStr || '0', 10);
	const globalRequests = parseInt(globalRequestsStr || '0', 10);

	// Check per-user limit
	if (userRequests >= MAX_REQUESTS_PER_USER_PER_DAY) {
		return { 
			allowed: false, 
			reason: `Daily limit reached: ${MAX_REQUESTS_PER_USER_PER_DAY} requests per day. Use your own API key for unlimited usage: run "nob set-api-key"`,
			remaining: 0
		};
	}

	// Check global safety limit
	if (globalRequests >= MAX_GLOBAL_REQUESTS_PER_DAY) {
		return { 
			allowed: false, 
			reason: `Service is busy. Please try again later or use your own API key: run "nob set-api-key"`,
			remaining: 0
		};
	}

	// Update usage
	await Promise.all([
		kv.put(userRequestsKey, (userRequests + 1).toString(), { expirationTtl: 86400 }),
		kv.put(globalRequestsKey, (globalRequests + 1).toString(), { expirationTtl: 86400 }),
	]);

	return { 
		allowed: true, 
		remaining: MAX_REQUESTS_PER_USER_PER_DAY - userRequests - 1 
	};
}

// Store or update user in KV
async function storeUser(
	userId: string, 
	email: string, 
	provider: 'github' | 'google', 
	kv?: KVNamespace
): Promise<void> {
	if (!kv) return;
	
	const userKey = `user:${provider}:${userId}`;
	const now = new Date().toISOString();
	
	// Check if user exists
	const existing = await kv.get(userKey);
	
	if (existing) {
		// Update last login
		const userData: UserData = JSON.parse(existing);
		userData.lastLogin = now;
		await kv.put(userKey, JSON.stringify(userData));
	} else {
		// Create new user
		const userData: UserData = {
			id: userId,
			email,
			provider,
			createdAt: now,
			lastLogin: now,
		};
		await kv.put(userKey, JSON.stringify(userData));
	}
}

// Simple JWT-like token generation (for production, use a proper JWT library)
async function generateToken(userId: string, email: string, secret: string): Promise<string> {
	const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const payload = btoa(JSON.stringify({
		userId,
		email,
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
	}));
	
	// Simple HMAC-like signature (in production, use proper crypto)
	const signature = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	).then(key => 
		crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`))
	).then(sig => 
		btoa(String.fromCharCode(...new Uint8Array(sig)))
	);
	
	return `${header}.${payload}.${signature}`;
}

async function verifyToken(token: string, secret: string): Promise<{ userId: string; email: string } | null> {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		
		const payload = JSON.parse(atob(parts[1]));
		
		// Check expiry
		if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
			return null;
		}
		
		// Verify signature
		const signature = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		).then(key => 
			crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
		).then(sig => 
			btoa(String.fromCharCode(...new Uint8Array(sig)))
		);
		
		if (signature !== parts[2]) return null;
		
		return { userId: payload.userId, email: payload.email };
	} catch {
		return null;
	}
}

async function handleOAuthLogin(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const provider = url.searchParams.get('provider');
	const redirectUri = url.searchParams.get('redirect_uri');
	
	// If no provider specified, show login page
	if (!provider) {
		return new Response(getLoginPage(url, redirectUri || ''), {
			headers: { 'Content-Type': 'text/html' },
		});
	}
	
	if (!redirectUri) {
		return new Response('Missing redirect_uri', { status: 400 });
	}
	
	let authUrl: string;
	const state = crypto.randomUUID();
	// Store redirect_uri in state (encode it)
	const stateData = `${provider}:${state}:${btoa(redirectUri)}`;
	
	if (provider === 'github') {
		if (!env.GITHUB_CLIENT_ID) {
			return new Response('GitHub OAuth not configured', { status: 500 });
		}
		const callbackUrl = `${url.origin}/auth/callback`;
		authUrl = `https://github.com/login/oauth/authorize?client_id=${env.GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=user:email&state=${encodeURIComponent(stateData)}`;
	} else if (provider === 'google') {
		if (!env.GOOGLE_CLIENT_ID) {
			return new Response('Google OAuth not configured', { status: 500 });
		}
		const callbackUrl = `${url.origin}/auth/callback`;
		authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&response_type=code&scope=openid%20email%20profile&state=${encodeURIComponent(stateData)}`;
	} else {
		return new Response('Invalid provider', { status: 400 });
	}
	
	return Response.redirect(authUrl, 302);
}

function getLoginPage(url: URL, redirectUri: string): string {
	const githubUrl = `${url.pathname}?provider=github${redirectUri ? `&redirect_uri=${encodeURIComponent(redirectUri)}` : ''}`;
	const googleUrl = `${url.pathname}?provider=google${redirectUri ? `&redirect_uri=${encodeURIComponent(redirectUri)}` : ''}`;
	
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Login to nob</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
			background: #000000;
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
		}
		.container {
			background: #1a1a1a;
			border-radius: 8px;
			border: 1px solid #333;
			padding: 48px;
			max-width: 420px;
			width: 100%;
			text-align: center;
		}
		h1 {
			color: #ffffff;
			font-size: 28px;
			margin-bottom: 8px;
			font-weight: 600;
		}
		p {
			color: #999;
			margin-bottom: 32px;
			font-size: 16px;
		}
		.login-buttons {
			display: flex;
			flex-direction: column;
			gap: 12px;
		}
		.btn {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 12px;
			padding: 14px 24px;
			border: none;
			border-radius: 8px;
			font-size: 16px;
			font-weight: 500;
			cursor: pointer;
			text-decoration: none;
			color: white;
		}
		.btn-github {
			background: #24292e;
		}
		.btn-google {
			background: #ffffff;
			color: #333;
		}
		.icon {
			width: 20px;
			height: 20px;
		}
		.footer {
			margin-top: 32px;
			padding-top: 24px;
			border-top: 1px solid #333;
			color: #666;
			font-size: 14px;
		}
	</style>
</head>
<body>
	<div class="container">
		<h1>Login to nob</h1>
		<p>Choose your preferred login method</p>
		
		<div class="login-buttons">
			<a href="${githubUrl}" class="btn btn-github">
				<svg class="icon" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
					<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
				</svg>
				Login with GitHub
			</a>
			
			<a href="${googleUrl}" class="btn btn-google">
				<svg class="icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
					<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
					<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
					<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
					<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
				</svg>
				Login with Google
			</a>
		</div>
		
		<div class="footer">
			<p>nob - AI-Powered Terminal</p>
		</div>
	</div>
</body>
</html>`;
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const error = url.searchParams.get('error');
	
	// Extract provider and redirect URI from state
	let provider: string = 'github';
	let redirectUri: string = 'http://localhost:8765/callback';
	
	if (state) {
		try {
			// State format: provider:uuid:base64(redirectUri)
			const parts = state.split(':');
			provider = parts[0] || 'github';
			if (parts[2]) {
				redirectUri = atob(parts[2]);
			}
		} catch (e) {
			// Keep defaults if parsing fails
			console.error('State parsing error:', e);
		}
	}
	
	if (error) {
		return Response.redirect(`${redirectUri}?error=${encodeURIComponent(error)}`, 302);
	}
	
	if (!code) {
		return Response.redirect(`${redirectUri}?error=missing_code`, 302);
	}
	
	if (!provider || !['github', 'google'].includes(provider)) {
		return Response.redirect(`${redirectUri}?error=invalid_provider`, 302);
	}

	try {
		let userInfo: { email: string; id: string };
		
		if (provider === 'github') {
			// Check for required secrets
			if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
				return Response.redirect(`${redirectUri}?error=github_not_configured`, 302);
			}
			
			// Exchange code for access token
			const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					client_id: env.GITHUB_CLIENT_ID,
					client_secret: env.GITHUB_CLIENT_SECRET,
					code,
				}),
			});
			
			const tokenData = await tokenResponse.json() as { access_token?: string; error?: string; error_description?: string };
			
			if (!tokenData.access_token) {
				return Response.redirect(`${redirectUri}?error=${encodeURIComponent(tokenData.error || 'token_exchange_failed')}`, 302);
			}
			
			// Get user info
			const userResponse = await fetch('https://api.github.com/user', {
				headers: {
					'Authorization': `Bearer ${tokenData.access_token}`,
					'Accept': 'application/vnd.github.v3+json',
					'User-Agent': 'nob-cli',
				},
			});
			
			const userData = await userResponse.json() as { email?: string; id: number; login: string };
			
			// Get email if not public
			let email = userData.email;
			if (!email) {
				const emailResponse = await fetch('https://api.github.com/user/emails', {
					headers: {
						'Authorization': `Bearer ${tokenData.access_token}`,
						'Accept': 'application/vnd.github.v3+json',
						'User-Agent': 'nob-cli',
					},
				});
				const emails = await emailResponse.json() as Array<{ email: string; primary: boolean }>;
				email = emails.find(e => e.primary)?.email || emails[0]?.email || `${userData.login}@users.noreply.github.com`;
			}
			
			userInfo = { email, id: userData.id.toString() };
		} else if (provider === 'google') {
			// Check for required secrets
			if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
				return Response.redirect(`${redirectUri}?error=google_not_configured`, 302);
			}
			
			// Exchange code for access token
			const callbackUrl = `${url.origin}/auth/callback`;
			const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					client_id: env.GOOGLE_CLIENT_ID,
					client_secret: env.GOOGLE_CLIENT_SECRET,
					code,
					grant_type: 'authorization_code',
					redirect_uri: callbackUrl,
				}),
			});
			
			const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };
			
			if (!tokenData.access_token) {
				return Response.redirect(`${redirectUri}?error=${encodeURIComponent(tokenData.error || 'token_exchange_failed')}`, 302);
			}
			
			// Get user info
			const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
				headers: {
					'Authorization': `Bearer ${tokenData.access_token}`,
				},
			});
			
			const userData = await userResponse.json() as { email: string; id: string };
			userInfo = { email: userData.email, id: userData.id };
		} else {
			return Response.redirect(`${redirectUri}?error=invalid_provider`, 302);
		}
		
		// Store user in KV for identification (reuse RATE_LIMIT_KV)
		await storeUser(userInfo.id, userInfo.email, provider as 'github' | 'google', env.RATE_LIMIT_KV);
		
		// Generate JWT token
		if (!env.JWT_SECRET) {
			return Response.redirect(`${redirectUri}?error=jwt_not_configured`, 302);
		}
		const jwtToken = await generateToken(userInfo.id, userInfo.email, env.JWT_SECRET);
		
		// Redirect back to CLI with token
		return Response.redirect(`${redirectUri}?token=${encodeURIComponent(jwtToken)}`, 302);
	} catch (e) {
		console.error('OAuth callback error:', e);
		return Response.redirect(`${redirectUri}?error=${encodeURIComponent('internal_error')}`, 302);
	}
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return new Response(JSON.stringify({ error: 'Missing authorization' }), { 
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	
	const token = authHeader.substring(7);
	const user = await verifyToken(token, env.JWT_SECRET);
	
	if (!user) {
		return new Response(JSON.stringify({ error: 'Invalid token' }), { 
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	
	return new Response(JSON.stringify({ 
		email: user.email,
		userId: user.userId,
		expiresIn: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
	}), {
		headers: { 'Content-Type': 'application/json' }
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		
		// Handle OAuth endpoints
		if (url.pathname === '/auth/login') {
			return handleOAuthLogin(request, env);
		}
		
		if (url.pathname === '/auth/callback') {
			return handleOAuthCallback(request, env);
		}
		
		if (url.pathname === '/auth/verify') {
			return handleVerify(request, env);
		}
		
		// CORS headers for browser/cli access
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		};

		// Handle preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// Handle root path - only POST requests for API
		if (url.pathname === '/' || url.pathname === '') {
			if (request.method !== 'POST') {
				return new Response('Method not allowed. Use POST for API requests.', { 
					status: 405, 
					headers: { ...corsHeaders, 'Content-Type': 'text/plain' } 
				});
			}
			
			const authHeader = request.headers.get('Authorization');
			if (authHeader && authHeader.startsWith('Bearer ')) {
				const token = authHeader.substring(7);
				const user = await verifyToken(token, env.JWT_SECRET);
				if (!user) {
					return new Response(
						JSON.stringify({ error: 'Invalid or expired token. Please login again: nob login' }),
						{ status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
					);
				}
			}
		} else {
			// For non-root paths, only allow POST (except auth endpoints which handle their own methods)
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405, headers: corsHeaders });
			}
		}

		try {
			const body = await request.json() as { messages?: any[]; model?: string; userId?: string };
			const { messages, model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } = body;

			// Get user identifier from JWT token or fallback
			let userIdentifier: string;
			const authHeader = request.headers.get('Authorization');
			if (authHeader && authHeader.startsWith('Bearer ')) {
				const token = authHeader.substring(7);
				const user = await verifyToken(token, env.JWT_SECRET);
				userIdentifier = user ? `user:${user.userId}` : getUserIdentifier(request, body);
			} else {
				userIdentifier = getUserIdentifier(request, body);
			}
			
			const rateLimitCheck = await checkRateLimit(userIdentifier, env.RATE_LIMIT_KV);

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

			const data = await response.json() as { result?: { response?: string; text?: string } | string };
			
			// Extract text from Workers AI response
			let text = '';
			if (data.result && typeof data.result === 'object') {
				text = data.result.response || data.result.text || '';
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

