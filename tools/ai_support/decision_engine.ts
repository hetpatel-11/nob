import type { DecisionInput, DecisionResult } from './types.js';

const GUARDED_ALLOWED = new Set(['usage_question', 'environment_issue']);

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function decideResponse(input: DecisionInput): DecisionResult {
  const reasons: string[] = [];
  const confidence = clamp(input.response.confidence);

  if (input.mode === 'shadow') {
    reasons.push('shadow mode');
  }

  if (input.conflictSignals.length > 0) {
    reasons.push('conflicting guidance detected');
  }

  if (input.response.requires_human) {
    reasons.push('model requested human review');
  }

  if (confidence < input.threshold) {
    reasons.push(`confidence ${confidence.toFixed(2)} below threshold ${input.threshold.toFixed(2)}`);
  }

  if (!input.response.user_reply_markdown.trim()) {
    reasons.push('empty user reply');
  }

  if (input.response.citations.length === 0) {
    reasons.push('missing citations');
  }

  if (input.response.classification === 'unclear') {
    reasons.push('classification unclear');
  }

  if (input.mode === 'guarded' && !GUARDED_ALLOWED.has(input.response.classification)) {
    reasons.push(`classification ${input.response.classification} blocked in guarded mode`);
  }

  if (reasons.length > 0) {
    return {
      action: 'escalate',
      reason: reasons.join('; '),
      normalizedConfidence: confidence,
    };
  }

  return {
    action: 'auto_reply',
    reason: 'high-confidence grounded response',
    normalizedConfidence: confidence,
  };
}
