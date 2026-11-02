import {describe, expect, it} from 'vitest';

import {
  chooseSb3ProjectAssets,
  chooseSb3SaveFormat,
  sb3SaveDialogModel,
  type Sb3SaveDraft,
} from '../src/dialog-model.js';
import {sb3SaveCapabilities, type Sb3SaveFormat, type Sb3SavePayload} from '../src/index.js';

const everything = sb3SaveCapabilities();

/** An editor-shaped build: it can rewrite extensions, and nothing else yet. */
const extensionsOnly = sb3SaveCapabilities({
  formats: {
    'extensions:embedded-data': 'The authoring API has no data: carrier form yet.',
    'source:remote-non-cacheable': 'Source conversion is not implemented.',
    'source:remote-cacheable': 'Source conversion is not implemented.',
    'source:embedded-file': 'Source conversion is not implemented.',
    'source:embedded-data': 'Source conversion is not implemented.',
    'assets:remote-non-cacheable': 'Asset conversion is not implemented.',
    'assets:remote-cacheable': 'Asset conversion is not implemented.',
    'assets:embedded-file': 'Asset conversion is not implemented.',
    'assets:embedded-data': 'Asset conversion is not implemented.',
  },
  projectAssets: 'No command writes project assets in this build.',
});

const row = (model: ReturnType<typeof sb3SaveDialogModel>, payload: Sb3SavePayload) => {
  const found = model.rows.find((candidate) => candidate.payload === payload);
  if (!found) throw new Error(`no row for ${payload}`);
  return found;
};
const option = (model: ReturnType<typeof sb3SaveDialogModel>, payload: Sb3SavePayload, format: Sb3SaveFormat) => {
  const found = row(model, payload).options.find((candidate) => candidate.format === format);
  if (!found) throw new Error(`no option for ${payload}:${format}`);
  return found;
};

describe('an empty draft', () => {
  const model = sb3SaveDialogModel(extensionsOnly);

  it('offers one row per payload, each listing every form in declaration order', () => {
    expect(model.rows.map((r) => r.payload)).toEqual(['extensions', 'source', 'assets']);
    expect(row(model, 'extensions').options.map((o) => o.format)).toEqual([
      'remote-non-cacheable',
      'remote-cacheable',
      'embedded-file',
      'embedded-data',
    ]);
  });

  it('keeps every payload as built and changes nothing', () => {
    expect(model.rows.every((r) => r.keepSelected)).toBe(true);
    expect(model.unchanged).toBe(true);
    expect(model.selection).toEqual({
      extensions: undefined,
      source: undefined,
      assets: undefined,
      assetsAsProjectAssets: false,
    });
    expect(model.refusals).toEqual([]);
  });

  it('disables a form this build cannot write and keeps the reason with it', () => {
    const disabled = option(model, 'extensions', 'embedded-data');
    expect(disabled.enabled).toBe(false);
    expect(disabled.reason).toBe('The authoring API has no data: carrier form yet.');
    expect(option(model, 'extensions', 'embedded-file').enabled).toBe(true);
  });

  it('marks a payload with no writable form at all', () => {
    expect(row(model, 'extensions').writable).toBe(true);
    expect(row(model, 'source').writable).toBe(false);
    expect(row(model, 'assets').writable).toBe(false);
  });

  it('disables the project-asset toggle with its own reason', () => {
    expect(model.projectAssets).toEqual({
      enabled: false,
      reason: 'No command writes project assets in this build.',
      selected: false,
    });
  });
});

describe('choosing a form', () => {
  it('puts it in the selection and stops keeping that payload as built', () => {
    const draft = chooseSb3SaveFormat({}, 'extensions', 'remote-cacheable');
    const model = sb3SaveDialogModel(extensionsOnly, draft);
    expect(option(model, 'extensions', 'remote-cacheable').selected).toBe(true);
    expect(row(model, 'extensions').keepSelected).toBe(false);
    expect(model.selection.extensions).toBe('remote-cacheable');
    expect(model.unchanged).toBe(false);
  });

  it('goes back to keeping it when the choice is cleared', () => {
    const draft = chooseSb3SaveFormat(
      chooseSb3SaveFormat({}, 'extensions', 'embedded-file'),
      'extensions',
      null,
    );
    const model = sb3SaveDialogModel(extensionsOnly, draft);
    expect(row(model, 'extensions').keepSelected).toBe(true);
    expect(model.selection.extensions).toBeUndefined();
    expect(model.unchanged).toBe(true);
  });

  it('leaves the draft it was given untouched', () => {
    const before: Sb3SaveDraft = {extensions: 'embedded-file'};
    chooseSb3SaveFormat(before, 'extensions', 'remote-cacheable');
    expect(before.extensions).toBe('embedded-file');
  });

  it('rejects a payload or a form outside the vocabulary', () => {
    expect(() => chooseSb3SaveFormat({}, 'sprites' as Sb3SavePayload, null)).toThrow(
      /Unknown save payload sprites/,
    );
    expect(() => chooseSb3SaveFormat({}, 'assets', 'inline' as Sb3SaveFormat)).toThrow(
      /Unknown save format inline/,
    );
  });
});

describe('a draft this build cannot honour', () => {
  const model = sb3SaveDialogModel(extensionsOnly, {
    source: 'embedded-file',
    assetsAsProjectAssets: true,
  });

  it('keeps the payload as built instead of writing something else', () => {
    expect(model.selection.source).toBeUndefined();
    expect(row(model, 'source').keepSelected).toBe(true);
    expect(model.selection.assetsAsProjectAssets).toBe(false);
    expect(model.unchanged).toBe(true);
  });

  it('reports each refused choice with what is missing', () => {
    expect(model.refusals).toEqual([
      {
        payload: 'source',
        format: 'embedded-file',
        reason: 'Source conversion is not implemented.',
      },
      {
        payload: 'assetsAsProjectAssets',
        reason: 'No command writes project assets in this build.',
      },
    ]);
  });

  it('shows no refused option as selected', () => {
    expect(row(model, 'source').options.every((o) => !o.selected)).toBe(true);
  });
});

describe('the project-asset toggle', () => {
  it('can be turned on when the build supports it', () => {
    const model = sb3SaveDialogModel(everything, chooseSb3ProjectAssets({}, true));
    expect(model.projectAssets).toEqual({enabled: true, selected: true});
    expect(model.selection.assetsAsProjectAssets).toBe(true);
    expect(model.unchanged).toBe(false);
    expect(model.refusals).toEqual([]);
  });

  it('rejects a value that is not a boolean', () => {
    expect(() => chooseSb3ProjectAssets({}, 'yes' as unknown as boolean)).toThrow(
      /assetsAsProjectAssets must be a boolean/,
    );
  });
});

describe('a build that can write everything', () => {
  it('enables every form for every payload', () => {
    const model = sb3SaveDialogModel(everything);
    expect(model.rows.every((r) => r.writable && r.options.every((o) => o.enabled))).toBe(true);
    expect(model.projectAssets.enabled).toBe(true);
  });
});
