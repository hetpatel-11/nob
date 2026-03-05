import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ConflictSignal, RepoContextChunk, RepoContextResult } from './types.js';

interface RetrieveOptions {
  cwd: string;
  query: string;
  maxChunks: number;
  maxChunkChars: number;
}

const EXCLUDED_PATH_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'dist-ai-support',
  'build',
  'coverage',
  '.git',
  '.next',
  '.cache',
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.pdf',
  '.mp4',
  '.mov',
  '.zip',
  '.gz',
  '.tgz',
  '.jar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.ico',
  '.lock',
]);

const MAX_FILE_BYTES = 220_000;

function shouldSkipPath(filePath: string): boolean {
  const normalizedParts = filePath.split('/').filter(Boolean);
  for (const part of normalizedParts) {
    if (EXCLUDED_PATH_SEGMENTS.has(part)) {
      return true;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) {
    return true;
  }

  return false;
}

function looksBinary(content: Buffer): boolean {
  if (content.length === 0) {
    return false;
  }

  let suspicious = 0;
  for (let i = 0; i < content.length; i += 1) {
    const byte = content[i]!;
    if (byte === 0) {
      return true;
    }
    if (byte < 7 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }

  return suspicious / content.length > 0.03;
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function scoreTextAgainstQuery(text: string, query: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const tokenCounts = new Map<string, number>();
  for (const token of tokenize(text)) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const token of queryTokens) {
    score += Math.min(6, tokenCounts.get(token) ?? 0);
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length > 2 && text.toLowerCase().includes(normalizedQuery)) {
    score += 8;
  }

  return score;
}

export function splitIntoChunks(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) {
    return [content];
  }

  const lines = content.split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if (line.length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trimEnd());
        current = '';
      }
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trimEnd());
      }
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push(current.trimEnd());
  }

  return chunks;
}

function normalizeDirective(line: string): { key: string; negative: boolean } | null {
  const trimmed = line.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const hasDirectiveVerb =
    trimmed.includes(' should ') ||
    trimmed.startsWith('should ') ||
    trimmed.includes(' must ') ||
    trimmed.startsWith('must ') ||
    trimmed.includes(' use ') ||
    trimmed.startsWith('use ') ||
    trimmed.includes(' enable ') ||
    trimmed.startsWith('enable ') ||
    trimmed.includes(' disable ') ||
    trimmed.startsWith('disable ') ||
    trimmed.includes(' run ') ||
    trimmed.startsWith('run ');

  if (!hasDirectiveVerb) {
    return null;
  }

  const negative =
    trimmed.includes('do not ') ||
    trimmed.includes("don't ") ||
    trimmed.includes(' not ') ||
    trimmed.includes('never ') ||
    trimmed.includes('avoid ');

  const key = trimmed
    .replace(/do not /g, ' ')
    .replace(/don't /g, ' ')
    .replace(/never /g, ' ')
    .replace(/avoid /g, ' ')
    .replace(/\bnot\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

  if (!key) {
    return null;
  }

  return { key, negative };
}

export function detectConflictingGuidance(chunks: RepoContextChunk[]): ConflictSignal[] {
  const positive = new Map<string, Set<string>>();
  const negative = new Map<string, Set<string>>();

  for (const chunk of chunks) {
    for (const line of chunk.content.split('\n')) {
      const directive = normalizeDirective(line);
      if (!directive) {
        continue;
      }

      const target = directive.negative ? negative : positive;
      const set = target.get(directive.key) ?? new Set<string>();
      set.add(chunk.path);
      target.set(directive.key, set);
    }
  }

  const conflicts: ConflictSignal[] = [];
  for (const [directive, positivePaths] of positive.entries()) {
    const negativePaths = negative.get(directive);
    if (!negativePaths || negativePaths.size === 0) {
      continue;
    }

    conflicts.push({
      directive,
      positivePaths: Array.from(positivePaths),
      negativePaths: Array.from(negativePaths),
    });
  }

  return conflicts;
}

function listTrackedFiles(cwd: string): string[] {
  const output = execSync('git ls-files', {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function retrieveRepoContext(options: RetrieveOptions): RepoContextResult {
  const files = listTrackedFiles(options.cwd);
  const candidates: RepoContextChunk[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  for (const relativePath of files) {
    if (shouldSkipPath(relativePath)) {
      skippedFiles += 1;
      continue;
    }

    const absolutePath = path.join(options.cwd, relativePath);
    let buffer: Buffer;
    try {
      buffer = readFileSync(absolutePath);
    } catch {
      skippedFiles += 1;
      continue;
    }

    if (buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) {
      skippedFiles += 1;
      continue;
    }

    const content = buffer.toString('utf8');
    const chunks = splitIntoChunks(content, options.maxChunkChars);
    scannedFiles += 1;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const score = scoreTextAgainstQuery(chunk, options.query);
      if (score <= 0) {
        continue;
      }

      candidates.push({
        path: relativePath,
        chunkIndex: index,
        content: chunk,
        score,
      });
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    return a.chunkIndex - b.chunkIndex;
  });

  const chunks = candidates.slice(0, options.maxChunks);
  const conflictSignals = detectConflictingGuidance(chunks);

  return {
    chunks,
    scannedFiles,
    skippedFiles,
    conflictSignals,
  };
}
