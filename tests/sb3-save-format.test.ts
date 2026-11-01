import {describe, expect, it} from 'vitest';

import {
  describeSb3SaveFormats,
  normalizeSb3SaveSelection,
  sb3SaveCapabilities,
  sb3SaveFormatKey,
  sb3SaveFormats,
  sb3SaveFormatSupport,
  sb3SavePayloads,
  sb3SupportedSaveFormats,
  type Sb3SaveCapabilities,
  type Sb3SaveFormat,
  type Sb3SavePayload,
} from '../src/index.js';

const everything = sb3SaveCapabilities();

/**
 * The refusals the `save-sb3-format` converter of turbowarp-kamishibai-app keeps today, abridged
 * to one sentence each. They are here to prove the vocabulary can carry an implementation's own
 * reasons unchanged, not to state what that converter should refuse.
 */
const extensionsOnly = sb3SaveCapabilities({
  formats: {
    'source:remote': 'A remote source document is owned by turbowarp-document-source.',
    'source:cached': 'A cached source document is owned by turbowarp-document-source.',
    'source:embedded-file': 'A ZIP file form needs the document-source contract.',
    'source:embedded-data': 'This command does not rewrite source data.',
    'assets:remote': 'Asset delivery is resolved at build time.',
    'assets:cached': 'No command produces a retained copy of a remote asset yet.',
    'assets:embedded-file': 'An arbitrary ZIP entry does not survive the VM asset table.',
    'assets:embedded-data': 'This command does not rewrite assets.',
  },
  projectAssets: 'Use convert-dsl4-assets --to project instead of this command.',
});

describe('the vocabulary', () => {
  it('names three payloads and four formats, in declaration order', () => {
    expect(sb3SavePayloads).toEqual(['extensions', 'source', 'assets']);
    expect(sb3SaveFormats).toEqual(['remote', 'cached', 'embedded-file', 'embedded-data']);
  });

  it('cannot be rewritten by a caller', () => {
    expect(Object.isFrozen(sb3SavePayloads)).toBe(true);
    expect(Object.isFrozen(sb3SaveFormats)).toBe(true);
  });

  it('spells a pair the way a refusal is recorded', () => {
    expect(sb3SaveFormatKey('assets', 'embedded-data')).toBe('assets:embedded-data');
  });
});

describe('capabilities built from refusals', () => {
  it('supports every pair that is not named', () => {
    for (const payload of sb3SavePayloads)
      for (const format of sb3SaveFormats)
        expect(sb3SaveFormatSupport(payload, format, everything).supported).toBe(true);
    expect(everything.projectAssets().supported).toBe(true);
  });

  it('refuses a named pair and repeats what is missing', () => {
    const support = sb3SaveFormatSupport('assets', 'cached', extensionsOnly);
    expect(support.supported).toBe(false);
    expect(support.reason).toBe('No command produces a retained copy of a remote asset yet.');
  });

  it('refuses a refusal that does not say what is missing', () => {
    expect(() => sb3SaveCapabilities({formats: {'assets:remote': ''}})).toThrow(
      /must say what is missing/,
    );
    expect(() => sb3SaveCapabilities({projectAssets: ''})).toThrow(/must say what is missing/);
  });

  it('refuses a refusal recorded under a pair that does not exist', () => {
    expect(() =>
      sb3SaveCapabilities({
        formats: {'sprites:remote': 'nope'} as Record<string, string>,
      }),
    ).toThrow(/Unknown save payload sprites/);
    expect(() =>
      sb3SaveCapabilities({
        formats: {'assets:inline': 'nope'} as Record<string, string>,
      }),
    ).toThrow(/Unknown save format inline/);
  });
});

describe('sb3SaveFormatSupport', () => {
  it('rejects a payload or a format outside the vocabulary', () => {
    expect(() => sb3SaveFormatSupport('sprites' as Sb3SavePayload, 'remote', everything)).toThrow(
      /Unknown save payload sprites/,
    );
    expect(() => sb3SaveFormatSupport('assets', 'inline' as Sb3SaveFormat, everything)).toThrow(
      /Unknown save format inline/,
    );
  });

  it('rejects an implementation that refuses without a reason', () => {
    const silent: Sb3SaveCapabilities = {
      format: () => ({supported: false}),
      projectAssets: () => ({supported: true}),
    };
    expect(() => sb3SaveFormatSupport('assets', 'remote', silent)).toThrow(
      /without saying what is missing/,
    );
  });
});

describe('sb3SupportedSaveFormats', () => {
  it('keeps declaration order and drops the refused formats', () => {
    expect(sb3SupportedSaveFormats('extensions', extensionsOnly)).toEqual([
      'remote',
      'cached',
      'embedded-file',
      'embedded-data',
    ]);
    expect(sb3SupportedSaveFormats('source', extensionsOnly)).toEqual([]);
    expect(sb3SupportedSaveFormats('assets', extensionsOnly)).toEqual([]);
  });
});

describe('normalizeSb3SaveSelection', () => {
  it('keeps a payload that was left unset', () => {
    const selection = normalizeSb3SaveSelection({extensions: 'cached'}, extensionsOnly);
    expect(selection.extensions).toBe('cached');
    expect(selection.source).toBeUndefined();
    expect(selection.assets).toBeUndefined();
    expect(selection.assetsAsProjectAssets).toBe(false);
  });

  it('names the payload, the format and what is missing when it refuses', () => {
    expect(() => normalizeSb3SaveSelection({source: 'remote'}, extensionsOnly)).toThrow(
      'Cannot save source as remote: A remote source document is owned by turbowarp-document-source.',
    );
  });

  it('accepts a payload the capabilities can write', () => {
    expect(normalizeSb3SaveSelection({source: 'remote'}, everything).source).toBe('remote');
  });

  it('refuses project assets with the reason, and allows them when supported', () => {
    expect(() => normalizeSb3SaveSelection({assetsAsProjectAssets: true}, extensionsOnly)).toThrow(
      'Cannot store assets as project assets: Use convert-dsl4-assets --to project instead of this command.',
    );
    expect(
      normalizeSb3SaveSelection({assetsAsProjectAssets: true}, everything).assetsAsProjectAssets,
    ).toBe(true);
  });

  it('rejects anything that is not a selection object', () => {
    for (const input of [null, undefined, 'remote', 3, []])
      expect(() => normalizeSb3SaveSelection(input, everything)).toThrow(
        /A save selection object is required/,
      );
  });

  it('rejects an option or a value outside the vocabulary', () => {
    expect(() => normalizeSb3SaveSelection({sprites: 'remote'}, everything)).toThrow(
      /Unknown save option sprites/,
    );
    expect(() => normalizeSb3SaveSelection({assets: 'inline'}, everything)).toThrow(
      /The assets format must be one of remote, cached, embedded-file, embedded-data/,
    );
    expect(() => normalizeSb3SaveSelection({assetsAsProjectAssets: 'yes'}, everything)).toThrow(
      /assetsAsProjectAssets must be a boolean/,
    );
  });

  it('returns a selection a caller cannot rewrite', () => {
    expect(Object.isFrozen(normalizeSb3SaveSelection({}, everything))).toBe(true);
  });
});

describe('describeSb3SaveFormats', () => {
  it('reports what an extensions-only converter can write, as it did before the extraction', () => {
    expect(describeSb3SaveFormats(extensionsOnly)).toBe(
      'extensions: remote|cached|embedded-file|embedded-data; source: kept as built; assets: kept as built',
    );
  });

  it('reports every format when nothing is refused', () => {
    expect(describeSb3SaveFormats(everything)).toBe(
      'extensions: remote|cached|embedded-file|embedded-data; ' +
        'source: remote|cached|embedded-file|embedded-data; ' +
        'assets: remote|cached|embedded-file|embedded-data',
    );
  });
});
