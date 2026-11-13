import { describe, expect, it } from 'vitest';
import { buildFeedback } from '../src/feedback';

describe('comments and suggestions', () => {
  it('puts the kind and the first words in the subject, version and system at the end', () => {
    const f = buildFeedback('idea', 'Aggiungere le playlist di Apple Music\nsarebbe bello', '1.5.4', 'Windows');
    expect(f.subject).toBe('PartyMix – Suggerimento: Aggiungere le playlist di Apple Music');
    expect(f.body).toContain('sarebbe bello');
    expect(f.body).toContain('Suggerimento da PartyMix 1.5.4 su Windows');
  });
  it('still opens a usable message when nothing was written', () => {
    const f = buildFeedback('problem', '  ', '1.5.4', 'Android');
    expect(f.subject).toBe('PartyMix – Problema');
    expect(f.body).toContain('(scrivi qui il tuo messaggio)');
  });
});
