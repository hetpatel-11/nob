export type Classification =
  | 'bug_report'
  | 'usage_question'
  | 'environment_issue'
  | 'docs_gap'
  | 'feature_request'
  | 'unclear';

export type SupportMode = 'shadow' | 'guarded' | 'full';

export type AssistantAction = 'auto_reply' | 'escalate';

export interface SupportBotConfig {
  confidence_autopost_threshold: number;
  max_context_chunks: number;
  max_chunk_chars: number;
  skip_labels: string[];
  escalation_label: string;
  auto_answer_label: string;
  maintainers: string[];
  cooldown_minutes: number;
}

export interface Citation {
  path: string;
  why: string;
}

export interface ClaudeResponse {
  classification: Classification;
  confidence: number;
  requires_human: boolean;
  user_reply_markdown: string;
  maintainer_summary: string;
  follow_up_questions: string[];
  citations: Citation[];
}

export interface RepoContextChunk {
  path: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export interface ConflictSignal {
  directive: string;
  positivePaths: string[];
  negativePaths: string[];
}

export interface RepoContextResult {
  chunks: RepoContextChunk[];
  scannedFiles: number;
  skippedFiles: number;
  conflictSignals: ConflictSignal[];
}

export interface DecisionInput {
  mode: SupportMode;
  threshold: number;
  response: ClaudeResponse;
  conflictSignals: ConflictSignal[];
}

export interface DecisionResult {
  action: AssistantAction;
  reason: string;
  normalizedConfidence: number;
}

export interface DraftPayload {
  createdAt: string;
  sourceIssueNumber: number;
  decisionReason: string;
  response: ClaudeResponse;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  labels: Array<{ name?: string }>;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  user: { login: string; type?: string };
  created_at: string;
  author_association?: string;
}
