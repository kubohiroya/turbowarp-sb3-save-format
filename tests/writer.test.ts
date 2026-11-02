import {createHash} from 'node:crypto';

import {describe, expect, it} from 'vitest';

import {discoverManifest} from '@kubohiroya/turbowarp-extension-loader';

import {sb3SaveCapabilities} from '../src/index.js';
import {
  readSb3ExtensionPayloads,
  sb3PlusExtensionPath,
  writeSb3ExtensionFormat,
} from '../src/writer.js';

const capabilities = sb3SaveCapabilities();
const write = (
  archive: Record<string, Uint8Array>,
  project: Record<string, unknown>,
  format: Parameters<typeof writeSb3ExtensionFormat>[2],
  options: Partial<Parameters<typeof writeSb3ExtensionFormat>[3]> = {},
) => writeSb3ExtensionFormat(archive, project, format, {capabilities, ...options});

const id = 'kubohiroyakamishibai4';
const code = '// Name: Kamishibai DSL 4.0 Runtime\n// ID: kubohiroyakamishibai4\nexport {};\n';
const dataUrl = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
const hex = (source: string) => createHash('sha256').update(source, 'utf8').digest('hex');
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
/** Serves one body, so a conversion from a reference has something pinned to fetch. */
const serving = (source: string) =>
  (async () =>
    new Response(new TextEncoder().encode(source), {status: 200})) as unknown as typeof fetch;

interface TestProject extends Record<string, unknown> {
  extensionURLs: Record<string, unknown>;
}

const embeddedDataProject = (extensionId = id, source = code): TestProject => ({
  targets: [{isStage: true}],
  extensions: [extensionId],
  extensionURLs: {[extensionId]: dataUrl(source)},
});

/** A Plus project another tool wrote, with metadata and a path this writer would not choose. */
function plusProject() {
  const a = '// a\n';
  const b = '// b\n';
  const archive: Record<string, Uint8Array> = {
    [`extensions/alpha-${hex(a)}.js`]: new TextEncoder().encode(a),
    [`extensions/beta-${hex(b)}.js`]: new TextEncoder().encode(b),
  };
  const project: TestProject = {
    targets: [{isStage: true}],
    extensions: ['alpha', 'beta'],
    extensionURLs: {},
    turboWarpPlus: {
      schemaVersion: 1,
      extensions: [
        {
          id: 'beta',
          source: {type: 'embedded-file', path: `extensions/beta-${hex(b)}.js`},
          execution: 'sandboxed',
          sha256: hex(b),
          version: '1.2.3',
          publisher: 'Example',
          capabilities: ['network'],
          dependencies: [],
        },
        {
          id: 'alpha',
          source: {type: 'embedded-file', path: `extensions/alpha-${hex(a)}.js`},
          execution: 'sandboxed',
          sha256: hex(a),
          capabilities: [],
          dependencies: ['beta'],
        },
      ],
    },
  };
  return {archive, project};
}

describe('the carriers', () => {
  it('round-trips the exact bytes between embedded-data and embedded-file', async () => {
    const archive: Record<string, Uint8Array> = {};
    const project = embeddedDataProject();
    await write(archive, project, 'embedded-file');
    expect(text(archive[sb3PlusExtensionPath(id)]!)).toBe(code);
    expect(project.extensionURLs[id]).toBeUndefined();

    await write(archive, project, 'embedded-data');
    expect(project.extensionURLs[id]).toBe(dataUrl(code));
    expect(archive[sb3PlusExtensionPath(id)]).toBeUndefined();
    // A standard host ignores the Manifest and reads the carrier, so keeping it costs that host
    // nothing and keeps the digest, the execution mode and the dependencies for a Plus host.
    const carried = discoverManifest(project)!.extensions[0]!;
    expect(carried.source).toEqual({type: 'embedded-data'});
    expect(carried.sha256).toBe(hex(code));
  });

  it('releases the archive entry an extension occupied, wherever it was', async () => {
    const {archive, project} = plusProject();
    const original = Object.keys(archive).sort();
    await write(archive, project, 'embedded-file');
    for (const entry of original) expect(archive[entry]).toBeUndefined();
    expect(Object.keys(archive).sort()).toEqual(['extensions/alpha.js', 'extensions/beta.js']);
  });

  it('keeps the data carrier beside a Plus form when asked, for standard hosts', async () => {
    const archive: Record<string, Uint8Array> = {};
    const project = embeddedDataProject();
    await write(archive, project, 'embedded-file', {keepEmbeddedData: true});
    expect(project.extensionURLs[id]).toBe(dataUrl(code));
    expect(discoverManifest(project)).toBeTruthy();
    expect(archive[sb3PlusExtensionPath(id)]).toBeTruthy();

    // A reference has no bytes in hand, but it names where they are, so the carrier can be added.
    const reference = embeddedDataProject();
    await write({}, reference, 'remote-cacheable', {urls: {[id]: 'https://example.test/x.js'}});
    await write({}, reference, 'remote-cacheable', {keepEmbeddedData: true, fetch: serving(code)});
    expect(reference.extensionURLs[id]).toBe(dataUrl(code));
  });

  it('leaves an undeclared leftover data: URL alone rather than bringing it back', async () => {
    const project: TestProject = {
      ...embeddedDataProject(),
      extensionURLs: {[id]: dataUrl(code), leftover: dataUrl('// not declared\n')}
    };
    await write({}, project, 'embedded-file');
    expect(project.extensions).toEqual([id]);
    expect(project.extensionURLs.leftover).toBe(dataUrl('// not declared\n'));
    expect(discoverManifest(project)!.extensions.map((spec) => spec.id)).toEqual([id]);
  });
});

describe('what a rewrite preserves', () => {
  it('keeps the execution mode, dependencies and metadata it found', async () => {
    const {archive, project} = plusProject();
    await write(archive, project, 'embedded-file');
    const manifest = discoverManifest(project)!;
    const beta = manifest.extensions.find((spec) => spec.id === 'beta')!;
    const alpha = manifest.extensions.find((spec) => spec.id === 'alpha')!;
    expect(beta.execution).toBe('sandboxed');
    expect(alpha.execution).toBe('sandboxed');
    expect(alpha.dependencies).toEqual(['beta']);
    // So the Loader still orders the dependency first.
    expect(manifest.extensions.map((spec) => spec.id)).toEqual(['beta', 'alpha']);
    expect(beta.version).toBe('1.2.3');
    expect(beta.publisher).toBe('Example');
    expect(beta.capabilities).toEqual(['network']);
  });

  it('keeps dependencies in the data carrier, because the Manifest records them', async () => {
    const {archive, project} = plusProject();
    await write(archive, project, 'embedded-data');
    const manifest = discoverManifest(project)!;
    expect(manifest.extensions.find((spec) => spec.id === 'alpha')!.dependencies).toEqual(['beta']);
    expect(manifest.extensions.map((spec) => spec.id)).toEqual(['beta', 'alpha']);
    // A standard host still finds both, in `extensions` order, knowing nothing of the dependency.
    expect(String(project.extensionURLs.alpha).startsWith('data:text/javascript;base64,')).toBe(true);
  });

  // Comparing the archive and the project directly, rather than a re-serialised SB3: packing is
  // the caller's job, so this package has no serialiser to compare bytes with.
  it('is a no-op on its own output, so a converted SB3 can be rebuilt or rewritten', async () => {
    for (const format of ['embedded-file', 'remote-cacheable', 'embedded-data'] as const) {
      const archive: Record<string, Uint8Array> = {};
      const project = embeddedDataProject();
      const options = {urls: {[id]: `https://example.test/${id}.js`}, keepEmbeddedData: true};
      await write(archive, project, format, options);
      const once = {archive: structuredClone(archive), project: structuredClone(project)};
      await write(archive, project, format, options);
      expect({archive, project}).toEqual(once);
    }
  });
});

describe('what the writer refuses to decide on its own', () => {
  // Which IDs may ask for an unsandboxed host is the caller's knowledge. A legacy `data:` URL
  // records no execution mode, so without being named an extension is requested sandboxed: a
  // rewrite never promotes one by itself.
  it('promotes nothing unless the caller names it', async () => {
    const unnamed = embeddedDataProject();
    await write({}, unnamed, 'embedded-file');
    expect(discoverManifest(unnamed)!.extensions[0]!.execution).toBe('sandboxed');

    const named = embeddedDataProject();
    await write({}, named, 'embedded-file', {unsandboxed: [id]});
    expect(discoverManifest(named)!.extensions[0]!.execution).toBe('unsandboxed');
  });

  it('refuses anything but the bytes the project pins', async () => {
    const archive: Record<string, Uint8Array> = {};
    const project = embeddedDataProject();
    await write(archive, project, 'remote-cacheable', {urls: {[id]: `https://example.test/${id}.js`}});
    // Embedding unverified bytes would make a conversion a way to replace an extension.
    await expect(
      write(archive, project, 'embedded-file', {fetch: serving('// not it\n')})
    ).rejects.toThrow(/does not serve the bytes/u);

    // With nothing to fetch from, there is nothing to obtain and nothing to skip.
    const noURL: TestProject = {targets: [{isStage: true}], extensions: [], extensionURLs: {}};
    noURL.turboWarpPlus = structuredClone(discoverManifest(project));
    (noURL.turboWarpPlus as {extensions: {source: unknown}[]}).extensions[0]!.source = {
      type: 'embedded-data'
    };
    await expect(write({}, noURL, 'embedded-file')).rejects.toThrow(/missing the data: carrier/u);
  });

  it('refuses unrelated content at the path it would use', async () => {
    await expect(
      write({[sb3PlusExtensionPath(id)]: new Uint8Array([1])}, embeddedDataProject(), 'embedded-file')
    ).rejects.toThrow(/already contains unrelated content/u);
  });

  // The caller owns what is writable, so a build that cannot write a form says so through its
  // capabilities and the writer repeats that reason instead of inventing one.
  it('refuses a form the capabilities it was given cannot write', async () => {
    const refusing = sb3SaveCapabilities({
      formats: {'extensions:embedded-data': 'This build has no data: carrier.'}
    });
    await expect(
      writeSb3ExtensionFormat({}, embeddedDataProject(), 'embedded-data', {capabilities: refusing})
    ).rejects.toThrow(/This build has no data: carrier/u);
  });
});

describe('a reference', () => {
  it('reuses the URL a project already names, and comes back by fetching it', async () => {
    const archive: Record<string, Uint8Array> = {};
    const project = embeddedDataProject();
    const url = `https://example.test/${id}.js`;
    await write(archive, project, 'embedded-file', {urls: {[id]: url}});
    // Either carrier records the address, which is what keeps the way back open.
    expect(discoverManifest(project)!.extensions[0]!.source).toEqual({
      type: 'embedded-file',
      url,
      path: sb3PlusExtensionPath(id)
    });

    for (const format of ['remote-cacheable', 'remote-non-cacheable'] as const) {
      await write(archive, project, format);
      expect(discoverManifest(project)!.extensions[0]!.source).toEqual({type: format, url});
      expect(archive[sb3PlusExtensionPath(id)]).toBeUndefined();
    }

    // The project is now a reference with no bytes. It names the URL and pins the digest, so the
    // bytes are obtainable: the conversion fetches them rather than refusing.
    await write(archive, project, 'embedded-file', {fetch: serving(code)});
    expect(text(archive[sb3PlusExtensionPath(id)]!)).toBe(code);
  });
});

describe('a project with no extension', () => {
  it('is left alone', async () => {
    const project: Record<string, unknown> = {targets: []};
    const archive: Record<string, Uint8Array> = {};
    expect((await write(archive, project, 'embedded-file')).converted).toEqual([]);
    expect(project).toEqual({targets: []});
    expect(archive).toEqual({});
    expect(readSb3ExtensionPayloads(archive, project)).toEqual([]);
  });
});
