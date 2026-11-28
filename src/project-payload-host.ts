// SPDX-License-Identifier: MPL-2.0
import {createNativeAssetConversion} from './native-assets.js';
import type {createProjectPayloadCodec, PayloadCacheClaim, PayloadEntry, PayloadOrigin,
    PayloadProjectArchive as ProjectArchive} from './project-payloads.js';
import {withProjectSerialization} from '@kubohiroya/turbowarp-extension-loader/scratch-vm/runtime';

/** The Loader's bucket for bytes no one project owns. Never released on a project's behalf. */
const SHARED_BUCKET = 'shared';

/** Why a selected cache entry was not embedded. */
export type CacheEmbeddingSkip = 'not-in-project' | 'changed' | 'unsupported';
export interface CacheEmbeddingItem {
    /** The payload item id in this project. */
    readonly id: string;
    readonly kind: 'source' | 'assets';
    readonly label: string;
    /** The SHA-256 the project pins, which is the cache key. */
    readonly sha256: string;
    readonly url: string;
}
export interface CacheEmbeddingResult {
    /** Items now embedded, unsaved until the project is saved. */
    readonly embedded: readonly {id: string; sha256: string; source: 'cache' | 'project'}[];
    readonly skipped: readonly {sha256: string; reason: CacheEmbeddingSkip}[];
    /** Digests no remote reference of this project still uses: what a save lets this project release. */
    readonly releasable: readonly string[];
}
export interface CacheEmbedding {
    readonly items: readonly CacheEmbeddingItem[];
    apply(digests: readonly string[], options: {format: 'embedded-data' | 'embedded-file'; signal?: AbortSignal}): Promise<CacheEmbeddingResult>;
}
export interface CacheReleaseOutcome {
    readonly released: number;
    readonly freed: number;
    /** Digests asked for that this project could not release, with why. */
    readonly kept: readonly {sha256: string; reason: 'not-saved' | 'still-referenced' | 'no-project' | 'unsupported'}[];
}

export function createProjectPayloadService(codec: ReturnType<typeof createProjectPayloadCodec>) {
    const {configurePayloads, decodePayloads, encodePayloads, inventory, digest} = codec;
    const {nativeAssetConversion} = createNativeAssetConversion(codec);
    const projectFiles = (vm: any) => Object.fromEntries(vm.serializeAssets().map(({fileName, fileContent}: any) =>
        [fileName, fileContent]));

    const installed = new WeakMap();
    const saveProjectForPackager = (vm: any) => withProjectSerialization(vm, {preview: true}, () => {
        const save = () => vm.saveProjectSb3('arraybuffer');
        return installed.get(vm)?.withEmbedded(save) ?? save();
    });

    /**
     * `bucket` is the project URI the cache files this project's claims under, read when needed;
     * `projectName` is the title recorded beside them. Both are optional: without a bucket nothing
     * is released, since a claim filed as shared belongs to no one project.
     */
    function createProjectPayloadHost(vm: any, {fetch, cache, approve, validate, canEdit, vmModules, bucket, projectName}: any) {
        let selection = new Map<string, PayloadEntry>();
        let origins = new Map<string, PayloadOrigin>();
        let revision = 0;
        let expanded = 0;
        /** What the last written archive persisted: embedded digests no remote reference still used. */
        let lastWritten: {revision: number; digests: Set<string>} | undefined;
        const embeddedDigests = () => {
            const remote = new Set([...selection.values()].filter(entry => entry.sha256).map(entry => entry.sha256!));
            const embedded = new Set<string>();
            for (const [id, origin] of origins) {
                const entry = selection.get(id);
                if (entry && !entry.sha256 && !remote.has(origin.sha256)) embedded.add(origin.sha256);
            }
            return embedded;
        };
        const sameBytes = (first: Uint8Array, second: Uint8Array) => first.length === second.length &&
            first.every((byte, index) => byte === second[index]);
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
            loadStarted() { revision++; lastWritten = undefined; },
            clear() { selection = new Map(); origins = new Map(); lastWritten = undefined; },
            dispose() { installed.delete(vm); },
            read(input: any, signal: any, archive?: ProjectArchive) {
                return decodePayloads(input, {fetch, cache, approve, validate, signal, archive});
            },
            async loaded(result: any, signal: any) {
                selection = result.settings;
                origins = result.origins ?? new Map();
                revision++;
                if (cache && result.claims?.length) {
                    // Complete writes before the next queued project changes the cache bucket.
                    const title = typeof projectName === 'function' ? projectName() : undefined;
                    const named = (label: object) => typeof title === 'string' && title ? {...label, projectName: title} : label;
                    const byKey = new Map<string, {bytes: Uint8Array; labels: any[]}>();
                    for (const [key, bytes, labels = []] of result.claims as PayloadCacheClaim[]) {
                        const item = byKey.get(key) ?? {bytes, labels: []};
                        item.labels.push(...labels.map(named));
                        byKey.set(key, item);
                    }
                    // The first label rides on the claim the write makes; the rest are recorded on it.
                    // A cache that predates labels ignores both and still keeps the bytes.
                    await Promise.all([...byKey].map(async ([key, {bytes, labels}]) => {
                        try {
                            await cache.put(key, bytes, {signal, ...(labels[0] ? {label: labels[0]} : {})});
                            if (labels.length > 1 && typeof cache.describe === 'function') {
                                await cache.describe(key, labels.slice(1));
                            }
                        } catch {}
                    }));
                }
            },
            edit() {
                const expected = revision;
                const items = currentItems();
                return {
                    // An embedded item offers the URL it came from, so it can be referenced remotely again.
                    items: [...items].map(([id, {kind, label, key}]) =>
                        ({id, kind, label, key, format: selection.get(id)?.format, url: selection.get(id)?.url ?? origins.get(id)?.url})),
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
                        // A new remote reference replaces the origin kept for the embedded copy.
                        origins = new Map([...origins].filter(([id]) => next.has(id) && !next.get(id)!.sha256));
                        selection = next;
                        revision++;
                        vm.runtime.emitProjectChanged();
                    }
                };
            },
            /**
             * Embed cached remote-cacheable items of this project, chosen by digest.
             *
             * Only items this project references with exactly that pinned digest are changed; a
             * digest this project does not pin is reported, never matched by name. The bytes are
             * the project's own, checked against the pin, and compared with the cached copy when
             * there is one. The change is unsaved until the project is saved.
             */
            cacheEmbedding(): CacheEmbedding {
                const expected = revision;
                const items = currentItems();
                const candidates: CacheEmbeddingItem[] = [];
                for (const [id, entry] of selection) {
                    const item = items.get(id);
                    if (item && entry.format === 'remote-cacheable' && entry.sha256 && entry.url) {
                        candidates.push({id, kind: item.kind, label: item.label, sha256: entry.sha256, url: entry.url});
                    }
                }
                return {
                    items: candidates,
                    async apply(digests, {format, signal}) {
                        ensureCurrent(expected);
                        if (format !== 'embedded-data' && format !== 'embedded-file') throw new TypeError('Choose an embedded format.');
                        const skipped: {sha256: string; reason: CacheEmbeddingSkip}[] = [];
                        const embedded: {id: string; sha256: string; source: 'cache' | 'project'}[] = [];
                        const live = currentItems();
                        for (const sha256 of new Set(digests)) {
                            const matches = candidates.filter(item => item.sha256 === sha256);
                            if (!matches.length) { skipped.push({sha256, reason: 'not-in-project'}); continue; }
                            let cached: Uint8Array | undefined;
                            try {
                                const read = await cache?.get(sha256, {signal: signal ?? new AbortController().signal});
                                if (read instanceof Uint8Array && await digest(read) === sha256) cached = read;
                            } catch {}
                            signal?.throwIfAborted();
                            for (const item of matches) {
                                const bytes = live.get(item.id)?.bytes;
                                if (!bytes || await digest(bytes) !== sha256 || (cached && !sameBytes(cached, bytes))) {
                                    skipped.push({sha256, reason: 'changed'});
                                    continue;
                                }
                                embedded.push({id: item.id, sha256, source: cached ? 'cache' : 'project'});
                            }
                        }
                        signal?.throwIfAborted();
                        ensureCurrent(expected);
                        const next = new Map(selection);
                        const kept = new Map(origins);
                        for (const {id} of embedded) {
                            const entry = selection.get(id)!;
                            next.set(id, {kind: entry.kind, key: entry.key, format});
                            kept.set(id, {url: entry.url!, sha256: entry.sha256!});
                        }
                        if (embedded.length) {
                            selection = next;
                            origins = kept;
                            revision++;
                            vm.runtime.emitProjectChanged();
                        }
                        const now = embeddedDigests();
                        return {embedded, skipped, releasable: [...new Set(embedded.map(item => item.sha256))].filter(key => now.has(key))};
                    }
                };
            },
            /**
             * Release this project's claims on digests whose embedding a save has persisted.
             *
             * Call it only after the host knows the save succeeded. A digest is released only when
             * the last archive this host wrote embedded it, nothing has changed the selection since,
             * and no remote reference of this project still uses it. Only this project's bucket is
             * released: other projects' claims and the shared bucket stay.
             */
            async releaseAfterSave(digests: readonly string[]): Promise<CacheReleaseOutcome> {
                const keys = [...new Set(digests)];
                const projectBucket = typeof bucket === 'function' ? bucket() : undefined;
                const all = (reason: CacheReleaseOutcome['kept'][number]['reason']) =>
                    ({released: 0, freed: 0, kept: keys.map(sha256 => ({sha256, reason}))});
                if (typeof projectBucket !== 'string' || !projectBucket || projectBucket === SHARED_BUCKET) return all('no-project');
                if (typeof cache?.releaseClaims !== 'function') return all('unsupported');
                const written = lastWritten?.revision === revision ? lastWritten.digests : new Set<string>();
                const now = embeddedDigests();
                const kept: {sha256: string; reason: 'not-saved' | 'still-referenced'}[] = [];
                const release: string[] = [];
                for (const sha256 of keys) {
                    if (!now.has(sha256)) kept.push({sha256, reason: 'still-referenced'});
                    else if (!written.has(sha256)) kept.push({sha256, reason: 'not-saved'});
                    else release.push(sha256);
                }
                if (!release.length) return {released: 0, freed: 0, kept};
                const done = await cache.releaseClaims(release.map(key => ({bucket: projectBucket, key})));
                return {released: done.released, freed: done.freed, kept};
            },
            writeZip(zip: any) {
                const {files, removed} = encodePayloads(JSON.parse(vm.toJSON()), projectFiles(vm), selection, origins);
                for (const name of removed) zip.remove(name);
                for (const [name, bytes] of Object.entries(files)) {
                    if (name === 'project.json' || name.startsWith('plus-payloads/')) {
                        if (name !== 'project.json' && zip.file(name)) throw new Error(`SB3 payload path is occupied: ${name}`);
                        zip.file(name, bytes, {date: new Date(1591657163000), compression: 'DEFLATE', createFolders: false});
                    }
                }
                // Recorded once the archive holds the payloads; whether it reached storage is the caller's to say.
                lastWritten = {revision, digests: embeddedDigests()};
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
                    origins = new Map();
                    revision++;
                };
            }
        };
        installed.set(vm, host);
        return host;
    }

    return {saveProjectForPackager, createProjectPayloadHost};
}
