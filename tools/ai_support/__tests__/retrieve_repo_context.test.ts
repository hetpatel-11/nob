import { detectConflictingGuidance, scoreTextAgainstQuery, splitIntoChunks } from '../retrieve_repo_context.js';

describe('retrieve_repo_context utilities', () => {
  it('scores matching content higher than non-matching content', () => {
    const match = scoreTextAgainstQuery('run setup script and restart panel', 'setup panel restart');
    const miss = scoreTextAgainstQuery('unrelated content', 'setup panel restart');

    expect(match).toBeGreaterThan(miss);
  });

  it('splits long text into bounded chunks', () => {
    const input = 'a'.repeat(10) + '\n' + 'b'.repeat(10) + '\n' + 'c'.repeat(10);
    const chunks = splitIntoChunks(input, 12);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(12);
    }
  });

  it('detects conflicting guidance between positive and negative directives', () => {
    const conflicts = detectConflictingGuidance([
      {
        path: 'README.md',
        chunkIndex: 0,
        score: 10,
        content: 'You should run setup before launch.',
      },
      {
        path: 'KNOWN_ISSUES.md',
        chunkIndex: 0,
        score: 9,
        content: 'You should not run setup before launch.',
      },
    ]);

    expect(conflicts.length).toBeGreaterThan(0);
  });
});
