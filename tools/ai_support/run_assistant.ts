import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { decideResponse } from './decision_engine.js';
import type {
  ClaudeResponse,
  DraftPayload,
  GitHubIssue,
  GitHubIssueComment,
  SupportBotConfig,
  SupportMode,
} from './types.js';

const DRAFT_MARKER = 'ai-support:draft';
const ESCALATION_MARKER = '<!-- ai-support:escalation -->';
const AUTO_REPLY_MARKER = '<!-- ai-support:auto-reply -->';
const COMMANDS = ['/ai-draft', '/ai-post', '/ai-ignore'] as const;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const MAX_TOOL_TURNS = 10;
const MAX_TOOL_OUTPUT_CHARS = 24_000;

const EXCLUDED_PATH_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-ai-support',
  'coverage',
  'build',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.pdf', '.zip', '.gz', '.tar', '.tgz', '.mp4', '.mov', '.avi', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.eot', '.bin', '.exe', '.dll', '.so', '.dylib',
]);

const EMIT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'classification',
    'confidence',
    'requires_human',
    'user_reply_markdown',
    'maintainer_summary',
    'follow_up_questions',
    'citations',
  ],
  properties: {
    classification: {
      type: 'string',
      enum: ['bug_report', 'usage_question', 'environment_issue', 'docs_gap', 'feature_request', 'unclear'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    requires_human: { type: 'boolean' },
    user_reply_markdown: { type: 'string' },
    maintainer_summary: { type: 'string' },
    follow_up_questions: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 3,
    },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'why'],
        properties: {
          path: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
  },
};

interface GitHubEventPayload {
  issue?: GitHubIssue & { pull_request?: unknown };
  comment?: GitHubIssueComment;
  action?: string;
  repository?: { full_name?: string };
  sender?: { login?: string; type?: string };
}

interface RunArtifact {
  timestamp: string;
  mode: 'assistant' | 'commands';
  eventName: string;
  issueNumber: number | null;
  action: string;
  reason?: string;
  promptPreview?: string;
  selectedContextFiles?: string[];
  modelResponse?: ClaudeResponse;
  decision?: {
    action: string;
    reason: string;
    confidence: number;
  };
}

interface ToolExecutionResult {
  output: Record<string, unknown>;
  referencedPaths: string[];
}

interface ToolLoopResult {
  response: ClaudeResponse;
  referencedPaths: string[];
}

type AnthropicToolInput = Record<string, unknown>;

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: AnthropicToolInput }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
}

class GitHubClient {
  private readonly token: string;
  private readonly repo: string;

  constructor(token: string, repo: string) {
    this.token = token;
    this.repo = repo;
  }

  async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-issue-assistant',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${method} ${endpoint} failed (${response.status}): ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>('GET', `/repos/${this.repo}/issues/${issueNumber}`);
  }

  async listComments(issueNumber: number): Promise<GitHubIssueComment[]> {
    return this.request<GitHubIssueComment[]>(
      'GET',
      `/repos/${this.repo}/issues/${issueNumber}/comments?per_page=100`,
    );
  }

  async createComment(issueNumber: number, body: string): Promise<void> {
    await this.request('POST', `/repos/${this.repo}/issues/${issueNumber}/comments`, { body });
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    await this.request('POST', `/repos/${this.repo}/issues/${issueNumber}/labels`, { labels });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.request('DELETE', `/repos/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('404')) {
        throw error;
      }
    }
  }
}

function defaultConfig(): SupportBotConfig {
  return {
    confidence_autopost_threshold: 0.82,
    max_context_chunks: 24,
    max_chunk_chars: 1800,
    skip_labels: ['no-ai'],
    escalation_label: 'ai-needs-review',
    auto_answer_label: 'ai-answered',
    maintainers: [],
    cooldown_minutes: 10,
  };
}

function parseMode(input: string | undefined): SupportMode {
  if (input === 'shadow' || input === 'guarded' || input === 'full') {
    return input;
  }
  return 'full';
}

function resolveSupportFilePath(cwd: string, relativePath: string): string | null {
  const localPath = path.join(cwd, relativePath);
  if (existsSync(localPath)) {
    return localPath;
  }

  const assistantRoot = process.env.AI_SUPPORT_ASSISTANT_ROOT;
  if (!assistantRoot) {
    return null;
  }

  const assistantPath = path.join(assistantRoot, relativePath);
  if (existsSync(assistantPath)) {
    return assistantPath;
  }

  return null;
}

function loadConfig(cwd: string): SupportBotConfig {
  const configPath = resolveSupportFilePath(cwd, path.join('.github', 'support-bot', 'config.yml'));
  if (!configPath) {
    return defaultConfig();
  }

  const parsed = yaml.load(readFileSync(configPath, 'utf8')) as Partial<SupportBotConfig>;
  const defaults = defaultConfig();

  return {
    confidence_autopost_threshold:
      typeof parsed.confidence_autopost_threshold === 'number'
        ? parsed.confidence_autopost_threshold
        : defaults.confidence_autopost_threshold,
    max_context_chunks:
      typeof parsed.max_context_chunks === 'number' ? parsed.max_context_chunks : defaults.max_context_chunks,
    max_chunk_chars:
      typeof parsed.max_chunk_chars === 'number' ? parsed.max_chunk_chars : defaults.max_chunk_chars,
    skip_labels: Array.isArray(parsed.skip_labels) ? parsed.skip_labels.map(String) : defaults.skip_labels,
    escalation_label:
      typeof parsed.escalation_label === 'string' ? parsed.escalation_label : defaults.escalation_label,
    auto_answer_label:
      typeof parsed.auto_answer_label === 'string' ? parsed.auto_answer_label : defaults.auto_answer_label,
    maintainers: Array.isArray(parsed.maintainers) ? parsed.maintainers.map(String) : defaults.maintainers,
    cooldown_minutes:
      typeof parsed.cooldown_minutes === 'number' ? parsed.cooldown_minutes : defaults.cooldown_minutes,
  };
}

function readMarkdown(cwd: string, relativePath: string): string {
  const fullPath = resolveSupportFilePath(cwd, relativePath);
  if (!fullPath) {
    return '';
  }
  return readFileSync(fullPath, 'utf8');
}

function issueHasSkipLabel(issue: GitHubIssue, skipLabels: string[]): boolean {
  const labels = new Set(issue.labels.map((l) => String(l.name ?? '').toLowerCase()));
  return skipLabels.some((label) => labels.has(label.toLowerCase()));
}

function buildThreadContext(issue: GitHubIssue, comments: GitHubIssueComment[]): string {
  const latestComments = comments.slice(-12);
  const lines = [
    `Issue title: ${issue.title}`,
    `Issue body: ${issue.body ?? ''}`,
    'Comments:',
  ];

  for (const comment of latestComments) {
    lines.push(`- ${comment.user.login}: ${comment.body}`);
  }

  return lines.join('\n');
}

function shouldSkipCooldown(comments: GitHubIssueComment[], cooldownMinutes: number): boolean {
  const now = Date.now();
  const cutoffMs = cooldownMinutes * 60 * 1000;
  const recentBotComment = [...comments]
    .reverse()
    .find(
      (comment) =>
        comment.user.login.endsWith('[bot]') &&
        (comment.body.includes(AUTO_REPLY_MARKER) || comment.body.includes(ESCALATION_MARKER)),
    );

  if (!recentBotComment) {
    return false;
  }

  const commentTime = Date.parse(recentBotComment.created_at);
  if (!Number.isFinite(commentTime)) {
    return false;
  }

  return now - commentTime < cutoffMs;
}

function buildPrompt(params: {
  policy: string;
  style: string;
  thread: string;
}): string {
  return [
    'You are an issue support assistant.',
    'You can call tools to inspect repository code and docs: read_file, glob_files, grep_files.',
    'Use those tools before finalizing your answer.',
    'When complete, call emit_response exactly once with the final structured output.',
    '',
    'Policy:',
    params.policy,
    '',
    'Style:',
    params.style,
    '',
    'Issue thread:',
    params.thread,
    '',
    'Output constraints:',
    '- confidence must be between 0 and 1',
    '- requires_human=true when uncertain, conflicting, or missing evidence',
    '- citations must use repo-relative paths and short reasons',
    '- follow_up_questions: 0 to 3 entries',
    '- in user_reply_markdown, identify the assistant as "Nob"',
  ].join('\n');
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1].trim();
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  throw new Error('Model output did not include a JSON object');
}

function validateClaudeResponse(parsed: unknown): ClaudeResponse {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Claude response is not an object');
  }

  const obj = parsed as Record<string, unknown>;
  const allowed = new Set([
    'bug_report',
    'usage_question',
    'environment_issue',
    'docs_gap',
    'feature_request',
    'unclear',
  ]);

  if (!allowed.has(String(obj.classification))) {
    throw new Error('Invalid classification');
  }

  if (typeof obj.confidence !== 'number') {
    throw new Error('Confidence must be number');
  }

  if (typeof obj.requires_human !== 'boolean') {
    throw new Error('requires_human must be boolean');
  }

  if (typeof obj.user_reply_markdown !== 'string') {
    throw new Error('user_reply_markdown must be string');
  }

  if (typeof obj.maintainer_summary !== 'string') {
    throw new Error('maintainer_summary must be string');
  }

  let followUpQuestions: string[] = [];
  if (Array.isArray(obj.follow_up_questions)) {
    if (!obj.follow_up_questions.every((v) => typeof v === 'string')) {
      throw new Error('follow_up_questions must be string[]');
    }
    followUpQuestions = obj.follow_up_questions;
  }

  let citations: Array<{ path: string; why: string }> = [];
  if (Array.isArray(obj.citations)) {
    citations = obj.citations
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
      .filter((citation) => typeof citation.path === 'string' && typeof citation.why === 'string')
      .map((citation) => ({ path: citation.path as string, why: citation.why as string }));
  }

  return {
    classification: obj.classification as ClaudeResponse['classification'],
    confidence: obj.confidence,
    requires_human: obj.requires_human,
    user_reply_markdown: obj.user_reply_markdown,
    maintainer_summary: obj.maintainer_summary,
    follow_up_questions: followUpQuestions,
    citations,
  };
}

function normalizeRepoPath(cwd: string, userPath: string): { absolute: string; relative: string } {
  const absolute = path.resolve(cwd, userPath);
  const rootWithSep = cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`;
  if (!(absolute === cwd || absolute.startsWith(rootWithSep))) {
    throw new Error('Path escapes repository root');
  }

  const relative = path.relative(cwd, absolute).replace(/\\/g, '/');
  if (relative.startsWith('..')) {
    throw new Error('Path escapes repository root');
  }

  return { absolute, relative };
}

function isExcludedPath(relativePath: string): boolean {
  const parts = relativePath.split('/').filter(Boolean);
  for (const part of parts) {
    if (EXCLUDED_PATH_SEGMENTS.has(part)) {
      return true;
    }
  }
  return false;
}

function isLikelyBinary(relativePath: string): boolean {
  const ext = path.extname(relativePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

const trackedFilesCache = new Map<string, string[]>();

function getTrackedFiles(cwd: string): string[] {
  const cached = trackedFilesCache.get(cwd);
  if (cached) {
    return cached;
  }

  let files: string[] = [];
  try {
    const output = execSync('git ls-files', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    files = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => !isExcludedPath(file));
  } catch {
    files = [];
  }

  trackedFilesCache.set(cwd, files);
  return files;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${escaped}$`);
}

function clampLimit(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const integer = Math.floor(value);
  if (integer < min) {
    return min;
  }
  if (integer > max) {
    return max;
  }
  return integer;
}

function capToolOutput(value: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(value);
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) {
    return value;
  }

  return {
    truncated: true,
    note: `Tool output exceeded ${MAX_TOOL_OUTPUT_CHARS} characters and was truncated`,
    preview: text.slice(0, MAX_TOOL_OUTPUT_CHARS),
  };
}

function executeReadFileTool(cwd: string, input: AnthropicToolInput): ToolExecutionResult {
  const filePath = String(input.path ?? '');
  if (!filePath) {
    throw new Error('read_file requires `path`');
  }

  const { absolute, relative } = normalizeRepoPath(cwd, filePath);
  if (!existsSync(absolute)) {
    throw new Error(`File not found: ${relative}`);
  }

  if (isLikelyBinary(relative)) {
    throw new Error(`Cannot read likely binary file: ${relative}`);
  }

  const raw = readFileSync(absolute, 'utf8');
  const lines = raw.split('\n');

  const startLine = clampLimit(input.start_line, 1, 1, lines.length || 1);
  const defaultEnd = Math.min(lines.length || 1, startLine + 199);
  const endLine = clampLimit(input.end_line, defaultEnd, startLine, Math.max(startLine, lines.length || startLine));

  const content = lines.slice(startLine - 1, endLine).join('\n');
  return {
    output: capToolOutput({
      path: relative,
      start_line: startLine,
      end_line: endLine,
      total_lines: lines.length,
      content,
    }),
    referencedPaths: [relative],
  };
}

function executeGlobFilesTool(cwd: string, input: AnthropicToolInput): ToolExecutionResult {
  const pattern = String(input.pattern ?? '**/*');
  const limit = clampLimit(input.limit, 200, 1, 1000);
  const regex = globToRegex(pattern);

  const files = getTrackedFiles(cwd)
    .filter((file) => regex.test(file))
    .slice(0, limit);

  return {
    output: {
      pattern,
      count: files.length,
      files,
      truncated: files.length >= limit,
    },
    referencedPaths: files,
  };
}

function executeGrepFilesTool(cwd: string, input: AnthropicToolInput): ToolExecutionResult {
  const query = String(input.query ?? '');
  if (!query) {
    throw new Error('grep_files requires `query`');
  }

  const pathPattern = input.path_pattern ? String(input.path_pattern) : '**/*';
  const pathRegex = globToRegex(pathPattern);
  const isRegex = Boolean(input.is_regex);
  const caseSensitive = Boolean(input.case_sensitive);
  const limit = clampLimit(input.limit, 80, 1, 500);

  const files = getTrackedFiles(cwd)
    .filter((file) => pathRegex.test(file))
    .filter((file) => !isLikelyBinary(file));

  const matches: Array<{ path: string; line: number; text: string }> = [];
  const referenced = new Set<string>();
  const regex = isRegex
    ? new RegExp(query, caseSensitive ? '' : 'i')
    : null;

  for (const file of files) {
    if (matches.length >= limit) {
      break;
    }

    const absolute = path.join(cwd, file);
    let text: string;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= limit) {
        break;
      }

      const line = lines[i] ?? '';
      const hit = regex
        ? regex.test(line)
        : caseSensitive
          ? line.includes(query)
          : line.toLowerCase().includes(query.toLowerCase());

      if (hit) {
        referenced.add(file);
        matches.push({
          path: file,
          line: i + 1,
          text: line.slice(0, 280),
        });
      }
    }
  }

  return {
    output: capToolOutput({
      query,
      path_pattern: pathPattern,
      count: matches.length,
      truncated: matches.length >= limit,
      matches,
    }),
    referencedPaths: Array.from(referenced),
  };
}

function executeTool(cwd: string, toolName: string, input: AnthropicToolInput): ToolExecutionResult {
  switch (toolName) {
    case 'read_file':
      return executeReadFileTool(cwd, input);
    case 'glob_files':
      return executeGlobFilesTool(cwd, input);
    case 'grep_files':
      return executeGrepFilesTool(cwd, input);
    default:
      throw new Error(`Unsupported tool: ${toolName}`);
  }
}

async function callAnthropic(model: string, apiKey: string, messages: AnthropicMessage[]): Promise<AnthropicResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1400,
      temperature: 0,
      messages,
      tools: [
        {
          name: 'read_file',
          description: 'Read a text file from the repository by relative path.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            properties: {
              path: { type: 'string' },
              start_line: { type: 'number' },
              end_line: { type: 'number' },
            },
          },
        },
        {
          name: 'glob_files',
          description: 'List tracked repository files matching a glob pattern like **/*.ts.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pattern: { type: 'string' },
              limit: { type: 'number' },
            },
          },
        },
        {
          name: 'grep_files',
          description: 'Search tracked repository files for text or regex matches.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['query'],
            properties: {
              query: { type: 'string' },
              path_pattern: { type: 'string' },
              is_regex: { type: 'boolean' },
              case_sensitive: { type: 'boolean' },
              limit: { type: 'number' },
            },
          },
        },
        {
          name: 'emit_response',
          description: 'Emit the final structured issue response after repository analysis is complete.',
          input_schema: EMIT_RESPONSE_SCHEMA,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { content?: AnthropicContentBlock[]; stop_reason?: string | null };
  if (!Array.isArray(data.content)) {
    throw new Error('Claude API response missing content array');
  }

  return {
    content: data.content,
    stop_reason: data.stop_reason ?? null,
  };
}

async function callClaudeWithTools(prompt: string, model: string, apiKey: string, cwd: string): Promise<ToolLoopResult> {
  const messages: AnthropicMessage[] = [{ role: 'user', content: prompt }];
  const referencedPaths = new Set<string>();

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const response = await callAnthropic(model, apiKey, messages);
    const toolUses = response.content.filter((block): block is Extract<AnthropicContentBlock, { type: 'tool_use' }> => block.type === 'tool_use');

    const emitResponse = toolUses.find((tool) => tool.name === 'emit_response');
    if (emitResponse) {
      const parsed = validateClaudeResponse(emitResponse.input);
      return {
        response: parsed,
        referencedPaths: Array.from(referencedPaths),
      };
    }

    if (toolUses.length === 0) {
      const textBlocks = response.content
        .filter((block): block is Extract<AnthropicContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      if (textBlocks) {
        try {
          const parsed = validateClaudeResponse(JSON.parse(extractJsonObject(textBlocks)) as unknown);
          return {
            response: parsed,
            referencedPaths: Array.from(referencedPaths),
          };
        } catch {
          // Fall through and fail below with context.
        }
      }

      throw new Error('Model returned no tool calls and no parseable structured response');
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: AnthropicContentBlock[] = [];
    for (const toolUse of toolUses) {
      try {
        const result = executeTool(cwd, toolUse.name, toolUse.input ?? {});
        for (const refPath of result.referencedPaths) {
          referencedPaths.add(refPath);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.output),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: message }),
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error(`Model did not emit emit_response within ${MAX_TOOL_TURNS} turns`);
}

function formatSources(response: ClaudeResponse): string {
  if (response.citations.length === 0) {
    return 'Sources:\n- (none provided)';
  }
  return `Sources:\n${response.citations.map((c) => `- ${c.path}: ${c.why}`).join('\n')}`;
}

function encodeDraftPayload(payload: DraftPayload): string {
  return `<!-- ${DRAFT_MARKER}\n${JSON.stringify(payload)}\n-->`;
}

function parseDraftPayload(commentBody: string): DraftPayload | null {
  const match = commentBody.match(new RegExp(`<!-- ${DRAFT_MARKER}\\n([\\s\\S]*?)\\n-->`));
  if (!match || !match[1]) {
    return null;
  }

  try {
    return JSON.parse(match[1]) as DraftPayload;
  } catch {
    return null;
  }
}

function isMaintainer(comment: GitHubIssueComment, config: SupportBotConfig): boolean {
  if (config.maintainers.includes(comment.user.login)) {
    return true;
  }

  const assoc = comment.author_association ?? '';
  return assoc === 'OWNER' || assoc === 'MEMBER' || assoc === 'COLLABORATOR';
}

async function handleCommand(params: {
  gh: GitHubClient;
  issue: GitHubIssue;
  comment: GitHubIssueComment;
  config: SupportBotConfig;
  artifact: RunArtifact;
}): Promise<void> {
  const { gh, issue, comment, config, artifact } = params;
  const command = comment.body.trim().split(/\s+/)[0] ?? '';
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) {
    artifact.action = 'ignored';
    artifact.reason = 'unknown command';
    return;
  }

  if (!isMaintainer(comment, config)) {
    artifact.action = 'ignored';
    artifact.reason = 'comment author not maintainer';
    return;
  }

  if (command === '/ai-ignore') {
    await gh.addLabels(issue.number, ['no-ai']);
    await gh.createComment(issue.number, 'AI automation disabled for this issue via `/ai-ignore`.');
    artifact.action = 'ai-ignore';
    return;
  }

  const comments = await gh.listComments(issue.number);
  const draftComment = [...comments]
    .reverse()
    .find((c) => c.body.includes(DRAFT_MARKER) && c.user.login.endsWith('[bot]'));

  if (!draftComment) {
    await gh.createComment(issue.number, 'No saved AI draft found on this issue yet.');
    artifact.action = 'no-draft';
    return;
  }

  const draft = parseDraftPayload(draftComment.body);
  if (!draft) {
    await gh.createComment(issue.number, 'Saved draft payload was invalid. Run assistant again to regenerate.');
    artifact.action = 'invalid-draft';
    return;
  }

  if (command === '/ai-draft') {
    await gh.createComment(
      issue.number,
      [
        'Maintainer draft preview:',
        '',
        draft.response.user_reply_markdown,
        '',
        formatSources(draft.response),
      ].join('\n'),
    );
    artifact.action = 'ai-draft';
    return;
  }

  await gh.createComment(
    issue.number,
    [AUTO_REPLY_MARKER, draft.response.user_reply_markdown, '', formatSources(draft.response)].join('\n'),
  );
  await gh.addLabels(issue.number, [config.auto_answer_label]);
  await gh.removeLabel(issue.number, config.escalation_label);
  artifact.action = 'ai-post';
}

async function writeArtifact(artifact: RunArtifact): Promise<string> {
  const dir = '/tmp/ai-issue-assistant';
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `run-${Date.now()}.json`);
  writeFileSync(filePath, JSON.stringify(artifact, null, 2));

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `artifact_path=${filePath}\n`);
  }

  return filePath;
}

async function run(): Promise<void> {
  const runMode = process.env.AI_SUPPORT_RUN_MODE === 'commands' ? 'commands' : 'assistant';
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME ?? 'unknown';
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  const artifact: RunArtifact = {
    timestamp: new Date().toISOString(),
    mode: runMode,
    eventName,
    issueNumber: null,
    action: 'started',
  };

  try {
    if (!eventPath || !existsSync(eventPath)) {
      throw new Error('GITHUB_EVENT_PATH is missing or invalid');
    }
    if (!repo) {
      throw new Error('GITHUB_REPOSITORY is required');
    }
    if (!token) {
      throw new Error('GITHUB_TOKEN is required');
    }

    const payload = JSON.parse(readFileSync(eventPath, 'utf8')) as GitHubEventPayload;
    const issue = payload.issue;

    if (!issue) {
      artifact.action = 'skipped';
      artifact.reason = 'no issue in event payload';
      await writeArtifact(artifact);
      return;
    }

    artifact.issueNumber = issue.number;

    if (issue.pull_request) {
      artifact.action = 'skipped';
      artifact.reason = 'pull request events are ignored';
      await writeArtifact(artifact);
      return;
    }

    const gh = new GitHubClient(token, repo);
    const config = loadConfig(process.cwd());

    if (runMode === 'commands') {
      if (!payload.comment) {
        artifact.action = 'skipped';
        artifact.reason = 'no comment for command mode';
        await writeArtifact(artifact);
        return;
      }
      await handleCommand({ gh, issue, comment: payload.comment, config, artifact });
      await writeArtifact(artifact);
      return;
    }

    if (payload.sender?.type === 'Bot' || payload.comment?.user.type === 'Bot') {
      artifact.action = 'skipped';
      artifact.reason = 'bot-authored event';
      await writeArtifact(artifact);
      return;
    }

    const freshIssue = await gh.getIssue(issue.number);
    if (issueHasSkipLabel(freshIssue, config.skip_labels)) {
      artifact.action = 'skipped';
      artifact.reason = 'issue has skip label';
      await writeArtifact(artifact);
      return;
    }

    const comments = await gh.listComments(issue.number);
    if (shouldSkipCooldown(comments, config.cooldown_minutes)) {
      artifact.action = 'skipped';
      artifact.reason = 'cooldown active';
      await writeArtifact(artifact);
      return;
    }

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY is required');
    }

    const policy = readMarkdown(process.cwd(), '.github/support-bot/policy.md');
    const style = readMarkdown(process.cwd(), '.github/support-bot/response-style.md');
    const threadContext = buildThreadContext(freshIssue, comments);

    const prompt = buildPrompt({
      policy,
      style,
      thread: threadContext,
    });

    artifact.promptPreview = prompt.slice(0, 3000);

    const model = process.env.CLAUDE_MODEL ?? DEFAULT_MODEL;
    const toolLoopResult = await callClaudeWithTools(prompt, model, anthropicApiKey, process.cwd());
    const response = toolLoopResult.response;
    artifact.modelResponse = response;

    artifact.selectedContextFiles = Array.from(
      new Set([...toolLoopResult.referencedPaths, ...response.citations.map((citation) => citation.path)]),
    );

    const decision = decideResponse({
      mode: parseMode(process.env.AI_SUPPORT_MODE),
      threshold: config.confidence_autopost_threshold,
      response,
      conflictSignals: [],
    });

    artifact.decision = {
      action: decision.action,
      reason: decision.reason,
      confidence: decision.normalizedConfidence,
    };

    if (decision.action === 'auto_reply') {
      const body = [AUTO_REPLY_MARKER, response.user_reply_markdown, '', formatSources(response)].join('\n');
      await gh.createComment(freshIssue.number, body);
      await gh.addLabels(freshIssue.number, [config.auto_answer_label]);
      await gh.removeLabel(freshIssue.number, config.escalation_label);
      artifact.action = 'auto_reply';
      await writeArtifact(artifact);
      return;
    }

    const maintainersToPing = config.maintainers.map((name) => `@${name}`).join(' ');
    const draftPayload: DraftPayload = {
      createdAt: new Date().toISOString(),
      sourceIssueNumber: freshIssue.number,
      decisionReason: decision.reason,
      response,
    };

    const escalationComment = [
      ESCALATION_MARKER,
      `Escalating for maintainer review ${maintainersToPing}`.trim(),
      '',
      `Reason: ${decision.reason}`,
      '',
      `Summary: ${response.maintainer_summary}`,
      '',
      encodeDraftPayload(draftPayload),
    ].join('\n');

    await gh.createComment(freshIssue.number, escalationComment);
    await gh.addLabels(freshIssue.number, [config.escalation_label]);
    await gh.removeLabel(freshIssue.number, config.auto_answer_label);
    artifact.action = 'escalated';
    await writeArtifact(artifact);
  } catch (error) {
    artifact.action = 'failed';
    artifact.reason = error instanceof Error ? error.message : String(error);
    await writeArtifact(artifact);
    throw error;
  }
}

if (process.env.GITHUB_ACTIONS === 'true' || process.env.AI_SUPPORT_AUTORUN === '1') {
  run().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

export {
  buildPrompt,
  extractJsonObject,
  parseMode,
  validateClaudeResponse,
  parseDraftPayload,
};
