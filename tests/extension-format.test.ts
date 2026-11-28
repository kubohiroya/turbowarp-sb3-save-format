import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {discoverManifest} from '@kubohiroya/turbowarp-extension-loader';

import {
  convertSb3ExtensionFormats,
  readSb3Extensions,
  sha256Hex,
  type Sb3ExtensionFormatChange,
} from '../src/extension-format.js';
import {sb3SaveCapabilities} from '../src/index.js';

const capabilities = sb3SaveCapabilities();
const encode = (source: string) => new TextEncoder().encode(source);
const dataUrl = (source: string) =>
  `data:text/javascript;base64,${btoa(String.fromCharCode(...encode(source)))}`;

const alpha = '// Name: Alpha\n// Version: 1.4.0\nScratch.extensions.register({});\n';
const beta = '// Name: Beta\nScratch.extensions.register({});\n';
const alphaURL = 'https://example.org/alpha@1.4.0/alpha.js';
const betaURL = 'https://example.org/beta@2.0.0/beta.js';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** Serves each body under its URL and records every request it was asked for. */
function serving(bodies: Readonly<Record<string, string>>) {
  const calls: FetchCall[] = [];
  const fetchBytes = (async (url: string, init?: RequestInit) => {
    calls.push({url, init});
    init?.signal?.throwIfAborted();
    const body = bodies[url];
    return body === undefined
      ? new Response('missing', {status: 404})
      : new Response(encode(body), {status: 200});
  }) as unknown as typeof fetch;
  return {calls, fetch: fetchBytes};
}

/** A Plus project with one reference, one embedded file and a Manifest URI beside them. */
async function plusProject() {
  const archive: Record<string, Uint8Array> = {
    'extensions/beta.js': encode(beta),
    'costume.svg': encode('<svg/>'),
  };
  const project = {
    targets: [{isStage: true, blocks: {a: {opcode: 'alpha_go'}}}],
    meta: {semver: '3.0.0'},
    extensions: ['alpha', 'beta'],
    extensionURLs: {},
    turboWarpPlus: {
      schemaVersion: 1,
      uri: 'https://example.org/works/demo.sb3',
      extensions: [
        {
          id: 'alpha',
          source: {type: 'remote-cacheable', url: alphaURL},
          execution: 'sandboxed',
          sha256: await sha256Hex(encode(alpha)),
          version: '1.4.0',
          publisher: 'Example',
          capabilities: ['network'],
          dependencies: ['beta'],
        },
        {
          id: 'beta',
          source: {type: 'embedded-file', path: 'extensions/beta.js', url: betaURL},
          execution: 'sandboxed',
          sha256: await sha256Hex(encode(beta)),
          version: '2.0.0',
          capabilities: [],
          dependencies: [],
        },
      ],
    },
  };
  return {archive, project};
}

const convert = (
  archive: Record<string, Uint8Array>,
  project: Record<string, unknown>,
  changes: Record<string, Sb3ExtensionFormatChange>,
  options: Partial<Parameters<typeof convertSb3ExtensionFormats>[3]> = {},
) => convertSb3ExtensionFormats(archive, project, changes, {capabilities, ...options});

const specOf = (project: Record<string, unknown>, id: string) =>
  discoverManifest(project)!.extensions.find((spec) => spec.id === id)!;

describe('convertSb3ExtensionFormats', () => {
  it('embeds a remote-cacheable extension with the same bytes, digest and provenance', async () => {
    const {archive, project} = await plusProject();
    const before = structuredClone({archive, project});
    const server = serving({[alphaURL]: alpha});
    const result = await convert(archive, project, {alpha: {format: 'embedded-data'}}, server);

    expect(result.changes).toEqual([
      {
        id: 'alpha',
        from: 'remote-cacheable',
        to: 'embedded-data',
        sha256: await sha256Hex(encode(alpha)),
        url: alphaURL,
        version: '1.4.0',
        fetched: true,
      },
    ]);
    expect(result.project.extensionURLs).toEqual({alpha: dataUrl(alpha)});
    expect(specOf(result.project, 'alpha')).toMatchObject({
      source: {type: 'embedded-data', url: alphaURL},
      sha256: await sha256Hex(encode(alpha)),
      version: '1.4.0',
      publisher: 'Example',
      capabilities: ['network'],
      dependencies: ['beta'],
    });
    // Nothing the conversion did not ask for changed, and the input is untouched.
    expect(specOf(result.project, 'beta')).toEqual(specOf(project, 'beta'));
    expect(result.archive['extensions/beta.js']).toBe(archive['extensions/beta.js']);
    expect(result.archive['costume.svg']).toBe(archive['costume.svg']);
    expect((result.project.turboWarpPlus as {uri: string}).uri).toBe('https://example.org/works/demo.sb3');
    expect(result.project.targets).toBe(project.targets);
    expect({archive, project}).toEqual(before);
  });

  it('goes back to the same reference without fetching, keeping the digest', async () => {
    const {archive, project} = await plusProject();
    const server = serving({[alphaURL]: alpha});
    const embedded = await convert(archive, project, {alpha: {format: 'embedded-data'}}, server);
    const back = await convert(
      {...embedded.archive},
      embedded.project,
      {alpha: {format: 'remote-cacheable'}},
      server,
    );
    expect(server.calls).toHaveLength(1);
    expect(back.changes[0]).toMatchObject({fetched: false, sha256: specOf(project, 'alpha').sha256});
    expect(specOf(back.project, 'alpha')).toEqual(specOf(project, 'alpha'));
    expect(back.project.extensionURLs).toEqual({});
  });

  it('turns a legacy data: extension into a reference at the address the caller names', async () => {
    const archive = {};
    const project = {targets: [], extensions: ['legacy'], extensionURLs: {legacy: dataUrl(beta)}};
    const [payload] = await readSb3Extensions(archive, project);
    expect(payload).toMatchObject({id: 'legacy', format: 'embedded-data', sha256: await sha256Hex(encode(beta))});
    expect(payload!.url).toBeUndefined();

    await expect(convert(archive, project, {legacy: {format: 'remote-cacheable'}})).rejects.toMatchObject({
      code: 'K4-EXT-FORMAT-004',
    });
    const result = await convert(archive, project, {legacy: {format: 'remote-cacheable', url: betaURL, version: '2.0.0'}});
    expect(result.project.extensionURLs).toEqual({});
    expect(specOf(result.project, 'legacy')).toMatchObject({
      source: {type: 'remote-cacheable', url: betaURL},
      sha256: await sha256Hex(encode(beta)),
      execution: 'sandboxed',
      version: '2.0.0',
    });
  });

  it('reads a legacy data: extension in every JavaScript form a host saves', async () => {
    const base64 = btoa(String.fromCharCode(...encode(beta)));
    const forms = {
      file: `data:application/javascript;base64,${base64}`,
      charset: `data:text/javascript;charset=utf-8;base64,${base64}`,
      legacyType: `data:application/x-javascript;base64,${base64}`,
      plain: `data:text/javascript,${encodeURIComponent(beta)}`,
    };
    const project = {targets: [], extensions: Object.keys(forms), extensionURLs: forms};
    const payloads = await readSb3Extensions({}, project);
    const digest = await sha256Hex(encode(beta));
    expect(payloads.map(({id, format, sha256}) => ({id, format, sha256}))).toEqual(
      Object.keys(forms).map((id) => ({id, format: 'embedded-data', sha256: digest})),
    );

    // A form change keeps the bytes, so the digest survives the move to a reference and back.
    const remote = await convert({}, project, {file: {format: 'remote-cacheable', url: betaURL}});
    expect(specOf(remote.project, 'file')).toMatchObject({sha256: digest});
    expect(remote.project.extensionURLs).not.toHaveProperty('file');
    expect(remote.project.extensionURLs).toMatchObject({plain: forms.plain});
    const back = await convert(remote.archive, remote.project, {file: {format: 'embedded-data'}}, serving({[betaURL]: beta}));
    const [again] = (await readSb3Extensions(back.archive, back.project)).filter(({id}) => id === 'file');
    expect(again).toMatchObject({format: 'embedded-data', sha256: digest});
  });

  it('leaves a data: URL that is not JavaScript alone', async () => {
    const project = {
      targets: [],
      extensions: ['image'],
      extensionURLs: {image: `data:image/png;base64,${btoa('png')}`},
    };
    expect(await readSb3Extensions({}, project)).toEqual([]);
  });

  it('embeds a remote-non-cacheable extension without asking for a stored copy', async () => {
    const {archive, project} = await plusProject();
    const manifest = project.turboWarpPlus.extensions[0]!;
    manifest.source.type = 'remote-non-cacheable';
    const server = serving({[alphaURL]: alpha});
    const result = await convert(archive, project, {alpha: {format: 'embedded-file'}}, server);
    expect(server.calls[0]!.init).toMatchObject({redirect: 'error', credentials: 'omit', cache: 'no-store'});
    expect(new TextDecoder().decode(result.archive['extensions/alpha.js'])).toBe(alpha);
    expect(specOf(result.project, 'alpha').source).toEqual({
      type: 'embedded-file',
      path: 'extensions/alpha.js',
      url: alphaURL,
    });
  });

  it('moves an embedded file into a data: carrier and releases the file', async () => {
    const {archive, project} = await plusProject();
    const result = await convert(archive, project, {beta: {format: 'embedded-data'}});
    expect(result.archive['extensions/beta.js']).toBeUndefined();
    expect(result.archive['costume.svg']).toBe(archive['costume.svg']);
    expect(result.project.extensionURLs).toEqual({beta: dataUrl(beta)});
    expect(specOf(result.project, 'beta')).toMatchObject({
      source: {type: 'embedded-data', url: betaURL},
      sha256: specOf(project, 'beta').sha256,
    });
    expect(specOf(result.project, 'alpha')).toEqual(specOf(project, 'alpha'));
  });

  it('is a no-op on its own output', async () => {
    const {archive, project} = await plusProject();
    const first = await convert(archive, project, {beta: {format: 'embedded-data'}});
    const second = await convert({...first.archive}, first.project, {beta: {format: 'embedded-data'}});
    expect(second.project).toEqual(first.project);
    expect(second.archive).toEqual(first.archive);
  });

  it('changes nothing when the served bytes are not the pinned ones', async () => {
    const {archive, project} = await plusProject();
    const before = structuredClone({archive, project});
    await expect(
      convert(archive, project, {alpha: {format: 'embedded-data'}}, serving({[alphaURL]: beta})),
    ).rejects.toMatchObject({code: 'K4-EXT-FORMAT-008'});
    await expect(
      convert(archive, project, {alpha: {format: 'embedded-data'}}, serving({})),
    ).rejects.toMatchObject({code: 'K4-EXT-FORMAT-005'});
    expect({archive, project}).toEqual(before);
  });

  it('refuses stored bytes that differ from the digest the Manifest pins', async () => {
    const {archive, project} = await plusProject();
    archive['extensions/beta.js'] = encode('// tampered\n');
    await expect(convert(archive, project, {beta: {format: 'embedded-data'}})).rejects.toMatchObject({
      code: 'K4-EXT-FORMAT-008',
    });
  });

  it('stops on cancellation and on an extension the project does not use', async () => {
    const {archive, project} = await plusProject();
    const controller = new AbortController();
    controller.abort();
    await expect(
      convert(archive, project, {alpha: {format: 'embedded-data'}}, {
        ...serving({[alphaURL]: alpha}),
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    await expect(convert(archive, project, {gamma: {format: 'embedded-data'}})).rejects.toMatchObject({
      code: 'K4-EXT-FORMAT-011',
    });
  });

  it('converts several extensions at once or not at all', async () => {
    const {archive, project} = await plusProject();
    const before = structuredClone({archive, project});
    // beta can become a reference, but alpha cannot be fetched, so neither changes.
    await expect(
      convert(archive, project, {
        beta: {format: 'remote-cacheable'},
        alpha: {format: 'embedded-data'},
      }, serving({})),
    ).rejects.toMatchObject({code: 'K4-EXT-FORMAT-005'});
    expect({archive, project}).toEqual(before);
  });
});

describe('the browser entry', () => {
  it('pulls in nothing that only Node has', () => {
    for (const file of ['extension-format.ts', 'bytes.ts', 'remote-compatibility-carrier.ts', 'index.ts']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(source, file).not.toMatch(/from ['"]node:|\bBuffer\b|\bprocess\.|require\(/);
      expect(source, file).not.toMatch(/from ['"]\.\/writer\.js['"]/);
    }
  });
});
