// SPDX-License-Identifier: MPL-2.0
import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import {createProjectPayloadCodec} from '../src/project-payloads.js';
import {createProjectPayloadService} from '../src/project-payload-host.js';

const codec = createProjectPayloadCodec({maxProjectBytes: 64 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024});
const {createProjectPayloadHost} = createProjectPayloadService(codec);
const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
const md5 = createHash('md5').update(bytes).digest('hex');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const other = 'f'.repeat(64);
const filename = `${md5}.svg`;
const id = `assets:${filename}`;
const url = 'https://assets.example.test/scene.svg';
const project = () => ({targets: [
    {isStage: true, costumes: [{assetId: md5, dataFormat: 'svg', md5ext: filename, name: 'Sky'}], sounds: []},
    {isStage: false, costumes: [{assetId: md5, dataFormat: 'svg', md5ext: filename, name: 'Cloud'}], sounds: []}
]});
const fetchBytes: typeof fetch = async input => {
    const response = new Response(bytes);
    Object.defineProperty(response, 'url', {value: String(input)});
    return response;
};

function fakeCache() {
    const store = new Map<string, Uint8Array>();
    const calls = {put: [] as any[], describe: [] as any[], release: [] as any[]};
    return {store, calls, cache: {
        async get(key: string) { return store.get(key); },
        async put(key: string, value: Uint8Array, options: any) { store.set(key, value); calls.put.push([key, options?.label]); },
        async describe(key: string, labels: any) { calls.describe.push([key, labels]); return labels.length; },
        async releaseClaims(claims: any[]) { calls.release.push(claims); return {released: claims.length, freed: 10 * claims.length}; }
    }};
}

function fakeVM(json: object, files: Record<string, Uint8Array>) {
    let changed = 0;
    return {
        get changed() { return changed; },
        toJSON: () => JSON.stringify(json),
        serializeAssets: () => Object.entries(files).map(([fileName, fileContent]) => ({fileName, fileContent})),
        runtime: {emitProjectChanged() { changed++; }}
    };
}

/** An SB3 whose one asset is referenced as remote-cacheable at `url`. */
async function remoteProject() {
    const items = codec.inventory(project(), {[filename]: bytes});
    const settings = await codec.configurePayloads(items, new Map([[id, {format: 'remote-cacheable' as const, url}]]), {fetch: fetchBytes});
    const {files} = codec.encodePayloads(project(), {[filename]: bytes}, settings);
    const zip = new JSZip();
    for (const [name, value] of Object.entries(files)) zip.file(name, value);
    return zip.generateAsync({type: 'uint8array'});
}

async function openProject(options: {bucket?: string; files?: Record<string, Uint8Array>; named?: any[]} = {}) {
    const {cache, calls, store} = fakeCache();
    const vm = fakeVM(project(), options.files ?? {[filename]: bytes});
    const host: any = createProjectPayloadHost(vm, {fetch: fetchBytes, cache, approve: async () => true, canEdit: true,
        bucket: () => options.bucket ?? 'https://example.test/projects/a', projectName: (decoded: any) => {
            options.named?.push(decoded);
            return 'Story';
        }});
    host.loadStarted();
    const result = await host.read(await remoteProject(), undefined);
    await host.loaded(result, undefined);
    return {host, vm, calls, store};
}

describe('naming cached project data', () => {
    it('records each use of a remote-cacheable asset with its name, kind, URL and the project title', async () => {
        const {calls} = await openProject();
        expect(calls.put).toEqual([[sha256, {ref: `${id}#0`, kind: 'backdrop', name: 'Sky', url, projectName: 'Story'}]]);
        expect(calls.describe).toEqual([[sha256, [{ref: `${id}#1`, kind: 'costume', name: 'Cloud', url, projectName: 'Story'}]]]);
    });

    it('asks for the title of the project just decoded, not of the project open before', async () => {
        const named: any[] = [];
        await openProject({named});
        expect(named).toHaveLength(1);
        expect(named[0].targets.map((target: any) => target.costumes[0].name)).toEqual(['Sky', 'Cloud']);
        expect(named[0]).not.toHaveProperty('turboWarpPlusPayloads');
    });
});

describe('embedding cached data into the open project', () => {
    it('lists only remote-cacheable items of this project and skips digests it does not pin', async () => {
        const {host, vm} = await openProject();
        const embedding = host.cacheEmbedding();
        expect(embedding.items).toEqual([{id, kind: 'assets', label: 'Cloud', sha256, url}]);
        const result = await embedding.apply([sha256, other], {format: 'embedded-file'});
        expect(result).toEqual({embedded: [{id, sha256, source: 'cache'}], skipped: [{sha256: other, reason: 'not-in-project'}],
            releasable: [sha256]});
        expect(vm.changed).toBe(1);
        expect(host.cacheEmbedding().items).toEqual([]);
    });

    it('refuses an item whose bytes no longer match the pinned digest', async () => {
        const {host, vm} = await openProject();
        const embedding = host.cacheEmbedding();
        // The open project's copy changed after it was opened; the pin no longer describes it.
        (vm as any).serializeAssets = () => [{fileName: filename, fileContent: new TextEncoder().encode('edited')}];
        const result = await embedding.apply([sha256], {format: 'embedded-data'});
        expect(result.embedded).toEqual([]);
        expect(result.skipped).toEqual([{sha256, reason: 'changed'}]);
    });

    it('keeps the source URL beside the manifest so a save and reopen can reference it again', async () => {
        const {host} = await openProject();
        await host.cacheEmbedding().apply([sha256], {format: 'embedded-data'});
        expect(host.edit().items).toEqual([expect.objectContaining({id, format: 'embedded-data', url})]);
        const zip = host.writeZip(new JSZip());
        const json = JSON.parse(await zip.file('project.json').async('string'));
        expect(json[codec.payloadKey].entries).toEqual([{kind: 'assets', key: filename, format: 'embedded-data',
            data: expect.stringMatching(/^data:application\/octet-stream;base64,/)}]);
        expect(json[codec.originKey]).toEqual({version: 1, entries: [{kind: 'assets', key: filename, url, sha256}]});

        const reopened = await codec.decodePayloads(await zip.generateAsync({type: 'uint8array'}), {approve: async () => true});
        expect(reopened.origins).toEqual(new Map([[id, {url, sha256}]]));
        expect(reopened.claims).toEqual([]);
        const restored = await JSZip.loadAsync(reopened.input as Uint8Array);
        expect(await restored.file(filename)!.async('uint8array')).toEqual(bytes);
        expect(JSON.parse(await restored.file('project.json')!.async('string'))[codec.originKey]).toBeUndefined();
    });
});

describe('releasing after a save', () => {
    it('releases nothing before an archive with the embedding was written', async () => {
        const {host, calls} = await openProject();
        await host.cacheEmbedding().apply([sha256], {format: 'embedded-file'});
        expect(await host.releaseAfterSave([sha256])).toEqual({released: 0, freed: 0, kept: [{sha256, reason: 'not-saved'}]});
        expect(calls.release).toEqual([]);
    });

    it('releases only this project bucket once the embedding was written', async () => {
        const {host, calls} = await openProject();
        await host.cacheEmbedding().apply([sha256], {format: 'embedded-file'});
        host.writeZip(new JSZip());
        expect(await host.releaseAfterSave([sha256])).toEqual({released: 1, freed: 10, kept: []});
        expect(calls.release).toEqual([[{bucket: 'https://example.test/projects/a', key: sha256}]]);
    });

    it('does not release when the written archive is stale or the project has no bucket of its own', async () => {
        const stale = await openProject();
        await stale.host.cacheEmbedding().apply([sha256], {format: 'embedded-file'});
        stale.host.writeZip(new JSZip());
        stale.host.loadStarted();
        expect((await stale.host.releaseAfterSave([sha256])).kept).toEqual([{sha256, reason: 'not-saved'}]);

        const shared = await openProject({bucket: 'shared'});
        await shared.host.cacheEmbedding().apply([sha256], {format: 'embedded-file'});
        shared.host.writeZip(new JSZip());
        expect((await shared.host.releaseAfterSave([sha256])).kept).toEqual([{sha256, reason: 'no-project'}]);
        expect(shared.calls.release).toEqual([]);
    });

    it('keeps a digest that a remote reference of this project still uses', async () => {
        const {host, calls} = await openProject();
        host.writeZip(new JSZip());
        expect((await host.releaseAfterSave([sha256])).kept).toEqual([{sha256, reason: 'still-referenced'}]);
        expect(calls.release).toEqual([]);
    });
});
