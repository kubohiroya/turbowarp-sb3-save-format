// SPDX-License-Identifier: MPL-2.0
import {createNativeAssetConversion} from './native-assets.js';
import type {createProjectPayloadCodec, PayloadProjectArchive as ProjectArchive} from './project-payloads.js';
import {withProjectSerialization} from '@kubohiroya/turbowarp-extension-loader/scratch-vm/runtime';

export function createProjectPayloadService(codec: ReturnType<typeof createProjectPayloadCodec>) {
    const {configurePayloads, decodePayloads, encodePayloads, inventory} = codec;
    const {nativeAssetConversion} = createNativeAssetConversion(codec);
    const projectFiles = (vm: any) => Object.fromEntries(vm.serializeAssets().map(({fileName, fileContent}: any) =>
        [fileName, fileContent]));

    const installed = new WeakMap();
    const saveProjectForPackager = (vm: any) => withProjectSerialization(vm, {preview: true}, () => {
        const save = () => vm.saveProjectSb3('arraybuffer');
        return installed.get(vm)?.withEmbedded(save) ?? save();
    });

    function createProjectPayloadHost(vm: any, {fetch, cache, approve, validate, canEdit, vmModules}: any) {
        let selection = new Map();
        let revision = 0;
        let expanded = 0;
        const currentItems = () => inventory(JSON.parse(vm.toJSON()), projectFiles(vm));
        const ensureCurrent = (expected: any) => {
            if (expected !== revision) throw new Error('The project changed. Reopen its payload settings.');
        };
        const host = {
            canEdit,
            canConvert: canEdit && Boolean(vmModules?.assetUploads),
            convert() {
                const expected = revision;
                return nativeAssetConversion(vm, vmModules, () => ensureCurrent(expected));
            },
            get active() { return !expanded && selection.size > 0; },
            loadStarted() { revision++; },
            clear() { selection = new Map(); },
            dispose() { installed.delete(vm); },
            read(input: any, signal: any, archive?: ProjectArchive) {
                return decodePayloads(input, {fetch, cache, approve, validate, signal, archive});
            },
            async loaded(result: any, signal: any) {
                selection = result.settings;
                revision++;
                if (cache && result.claims?.length) {
                    // Complete writes before the next queued project changes the cache bucket.
                    await Promise.all(result.claims.map(([key, bytes]: any) => cache.put(key, bytes, {signal}).catch(() => {})));
                }
            },
            edit() {
                const expected = revision;
                const items = currentItems();
                return {
                    items: [...items].map(([id, {kind, label, key}]) =>
                        ({id, kind, label, key, format: selection.get(id)?.format, url: selection.get(id)?.url})),
                    async apply(choices: any, signal: any) {
                        ensureCurrent(expected);
                        const next = await configurePayloads(items, choices, {fetch, signal});
                        signal.throwIfAborted();
                        ensureCurrent(expected);
                        const live = currentItems();
                        for (const [id, entry] of next) {
                            const item = live.get(id);
                            if (!item || (entry.bytes && (entry.bytes.length !== item.bytes.length ||
                                !entry.bytes.every((byte, index) => byte === item.bytes[index])))) {
                                throw new Error('A selected payload changed. Reopen its payload settings.');
                            }
                        }
                        selection = next;
                        revision++;
                        vm.runtime.emitProjectChanged();
                    }
                };
            },
            writeZip(zip: any) {
                const {files, removed} = encodePayloads(JSON.parse(vm.toJSON()), projectFiles(vm), selection);
                for (const name of removed) zip.remove(name);
                for (const [name, bytes] of Object.entries(files)) {
                    if (name === 'project.json' || name.startsWith('plus-payloads/')) {
                        if (name !== 'project.json' && zip.file(name)) throw new Error(`SB3 payload path is occupied: ${name}`);
                        zip.file(name, bytes, {date: new Date(1591657163000), compression: 'DEFLATE', createFolders: false});
                    }
                }
                return zip;
            },
            withEmbedded<T>(run: () => T): T {
                expanded++;
                try { return run(); } finally { expanded--; }
            },
            embedOnSave() {
                const expected = revision;
                return () => {
                    if (revision !== expected) return;
                    selection = new Map();
                    revision++;
                };
            }
        };
        installed.set(vm, host);
        return host;
    }

    return {saveProjectForPackager, createProjectPayloadHost};
}
