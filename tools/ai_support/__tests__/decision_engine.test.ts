import { decideResponse } from '../decision_engine.js';
import type { ClaudeResponse } from '../types.js';

function baseResponse(): ClaudeResponse {
  return {
    classification: 'usage_question',
    confidence: 0.95,
    requires_human: false,
    user_reply_markdown: 'Use the setup script from README.',
    maintainer_summary: 'Common setup issue.',
    follow_up_questions: [],
    citations: [{ path: 'README.md', why: 'Setup instructions' }],
  };
}

describe('decideResponse', () => {
  it('auto replies when criteria pass', () => {
    const result = decideResponse({
      mode: 'full',
      threshold: 0.82,
      response: baseResponse(),
      conflictSignals: [],
    });

    expect(result.action).toBe('auto_reply');
  });

  it('escalates for low confidence', () => {
    const response = baseResponse();
    response.confidence = 0.4;

    const result = decideResponse({
      mode: 'full',
      threshold: 0.82,
      response,
      conflictSignals: [],
    });

    expect(result.action).toBe('escalate');
    expect(result.reason).toContain('below threshold');
  });

  it('escalates in guarded mode for bug_report', () => {
    const response = baseResponse();
    response.classification = 'bug_report';

    const result = decideResponse({
      mode: 'guarded',
      threshold: 0.82,
      response,
      conflictSignals: [],
    });

    expect(result.action).toBe('escalate');
    expect(result.reason).toContain('blocked in guarded mode');
  });

  it('always escalates in shadow mode', () => {
    const result = decideResponse({
      mode: 'shadow',
      threshold: 0.82,
      response: baseResponse(),
      conflictSignals: [],
    });

    expect(result.action).toBe('escalate');
    expect(result.reason).toContain('shadow mode');
  });
});
