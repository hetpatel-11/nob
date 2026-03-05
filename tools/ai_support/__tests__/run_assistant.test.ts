import {
  extractJsonObject,
  parseDraftPayload,
  parseMode,
  validateClaudeResponse,
} from '../run_assistant.js';

describe('run_assistant helpers', () => {
  it('parses mode with fallback', () => {
    expect(parseMode('shadow')).toBe('shadow');
    expect(parseMode('guarded')).toBe('guarded');
    expect(parseMode('full')).toBe('full');
    expect(parseMode('unknown')).toBe('full');
  });

  it('extracts json from fenced block', () => {
    const raw = '```json\n{"a":1}\n```';
    expect(extractJsonObject(raw)).toBe('{"a":1}');
  });

  it('validates claude response schema', () => {
    const parsed = validateClaudeResponse({
      classification: 'usage_question',
      confidence: 0.9,
      requires_human: false,
      user_reply_markdown: 'reply',
      maintainer_summary: 'summary',
      follow_up_questions: [],
      citations: [{ path: 'README.md', why: 'details' }],
    });

    expect(parsed.classification).toBe('usage_question');
    expect(parsed.citations).toHaveLength(1);
  });

  it('defaults optional arrays when omitted', () => {
    const parsed = validateClaudeResponse({
      classification: 'usage_question',
      confidence: 0.9,
      requires_human: false,
      user_reply_markdown: 'reply',
      maintainer_summary: 'summary',
    });

    expect(parsed.follow_up_questions).toEqual([]);
    expect(parsed.citations).toEqual([]);
  });

  it('parses embedded draft payload', () => {
    const body =
      'hello\n<!-- ai-support:draft\n{"createdAt":"2026-03-04","sourceIssueNumber":1,"decisionReason":"low confidence","response":{"classification":"unclear","confidence":0.2,"requires_human":true,"user_reply_markdown":"draft","maintainer_summary":"summary","follow_up_questions":[],"citations":[]}}\n-->\n';
    const draft = parseDraftPayload(body);

    expect(draft).not.toBeNull();
    expect(draft?.sourceIssueNumber).toBe(1);
  });
});
