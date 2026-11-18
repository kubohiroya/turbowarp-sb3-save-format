// SPDX-License-Identifier: MPL-2.0
import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import JSZip from '@turbowarp/jszip';
import {createProjectPayloadCodec} from '../src/project-payloads.js';
import {sb3SaveFormats} from '../src/index.js';

const codec = createProjectPayloadCodec({maxProjectBytes: 64 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024});
const owner = 'kubohiroyakamishibairuntime4';
const source = "kamishibai: '4.0'\nscenes:\n  opening: []\n";
const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>');
const id = createHash('md5').update(bytes).digest('hex');
const filename = `${id}.svg`;
const fixture = () => ({project: {targets: [{costumes: [{assetId: id, dataFormat: 'svg', md5ext: filename, name: 'Scene'}], sounds: []}],
    extensionStorage: {[owner]: {source: {mode: 'embedded', text: source}}}}, assets: {[filename]: bytes}});
const zipOf = async (files: Record<string, Uint8Array>) => {
    const zip = new JSZip();
    for (const [name, value] of Object.entries(files)) zip.file(name, value);
    return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
};
const fetchBytes: typeof fetch = async input => {
    const url = String(input);
    const response = new Response(url.endsWith('/source') ? new TextEncoder().encode(source) : bytes);
    Object.defineProperty(response, 'url', {value: url});
    return response;
};

describe('independent project payload conversion', () => {
    for (const format of sb3SaveFormats) {
        it(`round trips source text and native assets through ${format}`, async () => {
            const {project, assets} = fixture();
            const items = codec.inventory(project, assets);
            const settings = await codec.configurePayloads(items, new Map([...items].map(([key, item]) =>
                [key, {format, url: `https://payload.test/${item.kind}`}])) , {fetch: fetchBytes});
            const {files} = codec.encodePayloads(structuredClone(project), assets, settings);
            const packed = await zipOf(files);
            const restored = await codec.decodePayloads(packed, {fetch: fetchBytes, approve: async () => false});
            const zip = await JSZip.loadAsync(restored.input);
            const json = JSON.parse(await zip.file('project.json')!.async('string'));
            expect(json.extensionStorage[owner].source.text).toBe(source);
            expect(json[codec.payloadKey]).toBeUndefined();
            expect(await zip.file(filename)!.async('uint8array')).toEqual(bytes);
        });
    }
    it('refuses changed remote contents and preserves the caller archive', async () => {
        const {project, assets} = fixture();
        const items = codec.inventory(project, assets);
        const settings = await codec.configurePayloads(items, new Map([...items].map(([key, item]) =>
            [key, {format: 'remote-cacheable' as const, url: `https://payload.test/${item.kind}`}])) , {fetch: fetchBytes});
        const {files} = codec.encodePayloads(structuredClone(project), assets, settings);
        const packed = await zipOf(files);
        const original = packed.slice();
        await expect(codec.decodePayloads(packed, {approve: async () => false,
            fetch: async input => {
                const response = new Response('changed');
                Object.defineProperty(response, 'url', {value: String(input)});
                return response;
            }})).rejects.toThrow(/remote payload changed/);
        expect(packed).toEqual(original);
    });
    it('detects edits made after a remote reference was configured', async () => {
        const {project, assets} = fixture();
        const settings = await codec.configurePayloads(codec.inventory(project, assets),
            new Map([[`assets:${filename}`, {format: 'remote-non-cacheable', url: 'https://payload.test/assets'}]]), {fetch: fetchBytes});
        expect(() => codec.encodePayloads(project, {[filename]: new TextEncoder().encode('edited')}, settings)).toThrow(/no longer matches/);
    });
});
