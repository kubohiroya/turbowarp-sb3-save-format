// SPDX-License-Identifier: MPL-2.0
import JSZip from '@turbowarp/jszip';
import {inspectZip} from '@kubohiroya/turbowarp-extension-loader/project-codec';
import {createFetchPort} from '@kubohiroya/turbowarp-extension-loader';
import {sb3SaveFormats, type Sb3SaveFormat} from './index.js';

export interface PayloadProjectArchive {
    readonly project: Record<string, unknown>;
    readonly projectBytes: number;
    openZip(): JSZip;
}
export interface PayloadItem {kind: 'source' | 'assets'; key: string; label: string; bytes: Uint8Array}
export interface PayloadEntry {
    kind: 'source' | 'assets'; key: string; format: Sb3SaveFormat;
    url?: string; sha256?: string; data?: string; bytes?: Uint8Array;
}
/**
 * Where an embedded item was fetched from before it was embedded: the public URL and the SHA-256
 * the project pinned for it. Kept beside the manifest, so the same bytes can later be referenced
 * remotely again. It is informational: it never selects a format and is never fetched on open.
 */
export interface PayloadOrigin {url: string; sha256: string}
/** What the project calls one remote-cacheable item, recorded with the cache claim it makes. */
export interface PayloadCacheLabel {
    ref: string;
    kind?: 'costume' | 'backdrop' | 'sound' | 'document';
    name?: string;
    url?: string;
}
/** One cache write a decoded project asks for: the pinned digest, the verified bytes and its labels. */
export type PayloadCacheClaim = [sha256: string, bytes: Uint8Array, labels: PayloadCacheLabel[]];
type ProjectJSON = Record<string, any>;
type SourceSlot = {record: Record<string, any>; field: string; label: string};
type BundleSlot = {record: Record<string, any>; label: string};
export interface PayloadStorageOptions {
    fetch?: typeof fetch | undefined;
    signal?: AbortSignal | undefined;
}
export interface PayloadArchiveOptions {maxProjectBytes: number; maxEntryBytes: number}
/** The distribution selects archive limits; conversion and validation belong to this package. */
export function createProjectPayloadCodec(extensionProjectArchiveOptions: PayloadArchiveOptions) {
    const payloadKey = 'turboWarpPlusPayloads';
    // Outside the manifest on purpose: a reader that predates it ignores an unknown project key,
    // while an unknown manifest field would make it refuse the whole project.
    const originKey = 'turboWarpPlusPayloadOrigins';
    // Match the Loader's default archive bound before reading a browser File into memory.
    const maxArchiveBytes = 64 * 1024 * 1024;
    const maxEntry = 16 * 1024 * 1024;
    const maxTotal = 32 * 1024 * 1024;
    const maxEntries = 1024;
    const maxDataLength = Math.ceil(maxEntry / 3) * 4;
    const dataPrefix = 'data:application/octet-stream;base64,';
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
    const jsonDecoder = new TextDecoder('utf-8', {fatal: true});
    const startsWithJSONObject = (bytes: Uint8Array) => {
        const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        return bytes.subarray(bom ? 3 : 0).find(byte =>
            byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) === 0x7b;
    };
    const own = (object: any, key: PropertyKey) => object && Object.hasOwn(object, key);
    const record = (value: any): value is Record<string, any> => value && typeof value === 'object' && !Array.isArray(value);
    const remote = (format: string) => format === 'remote-cacheable' || format === 'remote-non-cacheable';
    const failure = (message: string) => Object.assign(new Error(message), {code: 'INVALID_PROJECT_PAYLOAD'});
    function assert(condition: unknown, message: string): asserts condition { if (!condition) throw failure(message); }
    const equalBytes = (first: Uint8Array | undefined, second: Uint8Array | undefined) => first?.length === second?.length &&
        Boolean(first && second && first.every((value, index) => value === second[index]));
    const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
        byte => byte.toString(16).padStart(2, '0')).join('');

    const httpsURL = (value: unknown) => {
        let url;
        try { url = new URL(String(value)); } catch { throw failure('An absolute HTTPS URL is required.'); }
        assert(typeof value === 'string' && value.length <= 4096 && url.protocol === 'https:' &&
            !url.username && !url.password && !url.href.includes('#'), 'Use HTTPS without credentials or a fragment.');
        return url.href;
    };

    const dataURL = (bytes: Uint8Array) => {
        let binary = '';
        for (let index = 0; index < bytes.length; index += 8192) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        }
        return dataPrefix + btoa(binary);
    };

    const dataBytes = (data: unknown) => {
        assert(typeof data === 'string' && data.startsWith(dataPrefix) &&
            data.length <= dataPrefix.length + maxDataLength, 'Invalid embedded payload data.');
        const bytes = Uint8Array.from(atob(data.slice(dataPrefix.length)), char => char.charCodeAt(0));
        assert(dataURL(bytes) === data, 'Invalid embedded payload encoding.');
        return bytes;
    };

    const documentOwners = (project: ProjectJSON): Record<string, [any, any]> => {
        const storage = project.extensionStorage;
        const bundle = storage?.kubohiroyakamishibai4;
        const runtime = storage?.kubohiroyakamishibairuntime4;
        return {
            bundled: [bundle, bundle?.components?.kubohiroyakamishibairuntime4],
            unbundled: [runtime, runtime]
        };
    };

    // Restore exactly the same owner slots before VM load, preserving the owner's integrity metadata.
    function sourceSlots(project: ProjectJSON) {
        const slots = new Map<string, SourceSlot>();
        for (const [id, [storageOwner, owner]] of Object.entries(documentOwners(project))) {
            if (!record(owner) || Object.keys(storageOwner?.documentSourceLocations?.urls || {}).length) continue;
            if (record(owner.source) && owner.source.mode === 'embedded') {
                slots.set(id, {record: owner.source, field: 'text', label: owner.source.displayName || '台本 YAML'});
            }
            for (const [path, file] of Object.entries(owner.sourceDocuments?.files || {})) {
                if (record(file)) slots.set(`${id}/${path}`, {record: file, field: 'source', label: path});
            }
        }
        return slots;
    }

    const assetNames = (project: ProjectJSON) => {
        const assets = new Map<string, string>();
        for (const target of project.targets || []) {
            for (const asset of [...(target.costumes || []), ...(target.sounds || [])]) {
                const file = asset.md5ext || (asset.assetId && asset.dataFormat && `${asset.assetId}.${asset.dataFormat}`);
                if (typeof file === 'string' && /^[0-9a-f]{32}\.[a-z0-9]+$/u.test(file)) assets.set(file, asset.name || file);
            }
        }
        return assets;
    };

    /** Every costume, backdrop and sound that uses one asset file, with its own name. */
    const assetUses = (project: ProjectJSON) => {
        const uses = new Map<string, {name: string; kind: 'costume' | 'backdrop' | 'sound'}[]>();
        for (const target of project.targets || []) {
            const groups: [any[], 'costume' | 'backdrop' | 'sound'][] = [
                [target.costumes || [], target.isStage ? 'backdrop' : 'costume'], [target.sounds || [], 'sound']];
            for (const [assets, kind] of groups) {
                for (const asset of assets) {
                    const file = asset?.md5ext || (asset?.assetId && asset?.dataFormat && `${asset.assetId}.${asset.dataFormat}`);
                    if (typeof file !== 'string') continue;
                    const list = uses.get(file) ?? [];
                    list.push({name: typeof asset.name === 'string' ? asset.name : file, kind});
                    uses.set(file, list);
                }
            }
        }
        return uses;
    };

    const bundledAssetSlots = (project: ProjectJSON) => {
        const slots = new Map<string, BundleSlot>();
        for (const [ownerId, [, owner]] of Object.entries(documentOwners(project))) {
            const files = owner?.assets?.files;
            if (owner?.assets?.formatVersion !== 1 || !Array.isArray(files)) continue;
            for (const file of files) {
                if (record(file) && typeof file.assetId === 'string' && typeof file.path === 'string' &&
                    file.encoding === 'base64') {
                    const key = JSON.stringify([ownerId, file.assetId, file.path]);
                    slots.set(key, {record: file, label: `${file.assetId} / ${file.path}`});
                }
            }
        }
        return slots;
    };

    const itemId = ({kind, key}: {kind: string; key: string}) => `${kind}:${key}`;
    const filePath = (entry: Pick<PayloadEntry, 'kind' | 'key'>, index: number, bundled: unknown) => entry.kind === 'assets' && !bundled ?
        entry.key : `plus-payloads/${entry.kind}-${index}.bin`;

    function bundleMaterials(project: ProjectJSON) {
        const materials = [];
        for (const [key, slot] of bundledAssetSlots(project)) {
            const {assetId, path, data} = slot.record;
            if (typeof data !== 'string' || data.length > maxDataLength) continue;
            materials.push({key, label: slot.label, name: assetId, path, bytes: dataBytes(dataPrefix + data)});
        }
        return materials;
    }

    function inventory(project: ProjectJSON, assets: Record<string, Uint8Array>) {
        const items = new Map<string, PayloadItem>();
        for (const [key, slot] of sourceSlots(project)) {
            if (typeof slot.record[slot.field] !== 'string') continue;
            const item: PayloadItem = {kind: 'source', key, label: slot.label, bytes: encoder.encode(slot.record[slot.field])};
            items.set(itemId(item), item);
        }
        for (const {key, label, bytes} of bundleMaterials(project)) {
            const item: PayloadItem = {kind: 'assets', key, label, bytes};
            items.set(itemId(item), item);
        }
        for (const [key, label] of assetNames(project)) {
            const bytes = assets[key];
            if (!(bytes instanceof Uint8Array)) continue;
            const item: PayloadItem = {kind: 'assets', key, label, bytes};
            items.set(itemId(item), item);
        }
        return items;
    }

    function checkSize(bytes: Uint8Array, total: number) {
        assert(bytes instanceof Uint8Array && bytes.length <= maxEntry, 'A payload exceeds its byte limit.');
        total += bytes.length;
        assert(total <= maxTotal, 'The project payloads exceed their total byte limit.');
        return total;
    }

    const fetcher = (fetch: typeof globalThis.fetch) => createFetchPort(
        (url, options) => fetch(url, {...options, cache: 'no-store'}), {retries: 0});
    async function readURL(fetch: typeof globalThis.fetch, url: string, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        const timer = setTimeout(() => controller.abort(failure('The payload request timed out.')), 15000);
        signal?.addEventListener('abort', abort, {once: true});
        try {
            return (await fetcher(fetch).fetch(url, {maxBytes: maxEntry, signal: controller.signal})).bytes;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }



    async function configurePayloads(items: ReadonlyMap<string, PayloadItem>, choices: ReadonlyMap<string, {format: Sb3SaveFormat; url?: string}>, {fetch = globalThis.fetch, signal}: PayloadStorageOptions = {}) {
        assert(choices.size <= maxEntries, 'Too many project payloads are selected.');
        const selected = new Map<string, PayloadEntry>();
        let total = 0;
        for (const [id, choice] of choices) {
            const item = items.get(id);
            assert(item && sb3SaveFormats.includes(choice.format), 'The payload or its format is unavailable.');
            total = checkSize(item.bytes, total);
            const entry: PayloadEntry = {kind: item.kind, key: item.key, format: choice.format};
            if (remote(entry.format)) {
                entry.url = httpsURL(choice.url);
                const bytes = await readURL(fetch, entry.url!, signal);
                assert(equalBytes(bytes, item.bytes), `The URL does not match the current bytes for ${item.label}.`);
                entry.sha256 = await digest(bytes);
                entry.bytes = bytes;
            }
            selected.set(id, entry);
        }
        return selected;
    }

    /** Rewrite only the selected items. VM asset buffers are never modified. */
    function encodePayloads(project: ProjectJSON, assets: Record<string, Uint8Array>, settings: ReadonlyMap<string, PayloadEntry>,
        origins: ReadonlyMap<string, PayloadOrigin> = new Map()) {
        const files: Record<string, Uint8Array> = {...assets};
        const sources = sourceSlots(project);
        const bundledAssets = bundledAssetSlots(project);
        const items = inventory(project, assets);
        const entries = [];
        const kept: ({kind: string; key: string} & PayloadOrigin)[] = [];
        const removed = [];
        let total = 0;
        for (const [id, setting] of settings) {
            const item = items.get(id);
            if (!item) continue; // The document or asset was removed from the project.
            const {bytes} = item;
            total = checkSize(bytes, total);
            const {kind, key, format, url, sha256} = setting;
            if (remote(format)) {
                assert(equalBytes(bytes, setting.bytes),
                    `The remote reference no longer matches ${item.label}. Update its URL or storage format.`);
            }
            const entry: PayloadEntry = {kind, key, format, ...(url ? {url, sha256} : {})};
            if (format === 'embedded-data') entry.data = dataURL(bytes);
            const bundled = bundledAssets.get(key);
            if (kind === 'source' || bundled) {
                const slot = bundled ? {record: bundled.record, field: 'data'} : sources.get(key);
                assert(slot, 'The source data slot no longer exists.');
                delete slot.record[slot.field];
                if (format === 'embedded-file') files[filePath(entry, entries.length, bundled)] = bytes;
            } else if (format !== 'embedded-file') {
                delete files[key];
                removed.push(key);
            }
            entries.push(entry);
            const origin = origins.get(id);
            if (origin && !remote(format)) kept.push({kind, key, url: origin.url, sha256: origin.sha256});
        }
        if (entries.length) project[payloadKey] = {version: 1, entries};
        else delete project[payloadKey];
        if (kept.length) project[originKey] = {version: 1, entries: kept};
        else delete project[originKey];
        const json = encoder.encode(JSON.stringify(project));
        assert(json.length <= extensionProjectArchiveOptions.maxProjectBytes, 'The project JSON exceeds its byte limit.');
        return {files: {...files, 'project.json': json}, removed};
    }

    /** Repack an already verified, expanded project for a single HTML output. */
    async function embedPackagedProjectData(bytes: Uint8Array, project: Record<string, unknown>) {
        assert(!own(project, payloadKey), 'Open this project in the Editor before changing its export storage.');
        const zip = await JSZip.loadAsync(bytes);
        const assets: Record<string, Uint8Array> = {};
        let total = 0;
        for (const name of assetNames(project).keys()) {
            const bytes = await readEntry(zip, name, maxEntry);
            total = checkSize(bytes, total);
            assets[name] = bytes;
        }
        const items = inventory(project, assets);
        const settings = await configurePayloads(items, new Map([...items.keys()].map(id =>
            [id, {format: 'embedded-data'}])));
        const {files, removed} = encodePayloads(structuredClone(project), assets, settings);
        for (const name of removed) zip.remove(name);
        zip.file('project.json', files['project.json']);
        return zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
    }

    const readEntry = async (zip: JSZip | undefined, path: string, limit: number) => {
        const entry = zip?.file(path);
        assert(entry, `The SB3 is missing ${path}.`);
        return new Promise<Uint8Array>((resolve, reject) => {
            const stream = (entry as unknown as {internalStream(type: 'uint8array'): {
                on(event: string, listener: (...args: any[]) => void): any; pause(): void; resume(): void;
            }}).internalStream('uint8array');
            const chunks: Uint8Array[] = [];
            let size = 0;
            stream.on('data', (chunk: Uint8Array) => {
                size += chunk.length;
                if (size > limit) {
                    stream.pause();
                    reject(failure(`The SB3 entry ${path} exceeds its byte limit.`));
                } else chunks.push(chunk);
            }).on('error', reject).on('end', () => {
                const bytes = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
                resolve(bytes);
            }).resume();
        });
    };

    async function decodePayloads(input: any, {fetch = globalThis.fetch, cache, approve, validate, signal, archive}: PayloadStorageOptions & {
        cache?: import('@kubohiroya/turbowarp-extension-loader').LoaderPorts['cache'];
        approve?: (urls: string[], cacheable: boolean, signal: AbortSignal | undefined) => Promise<boolean | undefined>;
        validate?: (input: unknown, options?: {signal?: AbortSignal | undefined}) => Promise<unknown>;
        archive?: PayloadProjectArchive | undefined;
    } = {}) {
        const {maxProjectBytes} = extensionProjectArchiveOptions;
        if (input instanceof Blob || input instanceof Uint8Array || input instanceof ArrayBuffer) {
            assert((input instanceof Blob ? input.size : input.byteLength) <= maxArchiveBytes, 'The SB3 exceeds its byte limit.');
        } else if (typeof input === 'string') {
            assert(input.length <= maxProjectBytes, 'The project JSON exceeds its byte limit.');
        }
        const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) :
            input instanceof ArrayBuffer ? new Uint8Array(input) : input;
        let zip: JSZip | undefined;
        let project;
        if (archive) {
            if (!own(archive.project, payloadKey)) return {input, settings: new Map()};
            project = structuredClone(archive.project);
            zip = archive.openZip();
        } else if (bytes instanceof Uint8Array && bytes[0] === 0x50 && bytes[1] === 0x4b) {
            inspectZip(bytes, extensionProjectArchiveOptions);
            zip = await JSZip.loadAsync(bytes);
            project = JSON.parse(jsonDecoder.decode(await readEntry(zip, 'project.json', extensionProjectArchiveOptions.maxProjectBytes)));
        } else if (typeof bytes === 'string' || (bytes instanceof Uint8Array && startsWithJSONObject(bytes))) {
            const json = typeof bytes === 'string' ? bytes : jsonDecoder.decode(bytes);
            if (!json.includes(payloadKey)) return {input, settings: new Map()};
            project = JSON.parse(json);
        } else if (own(bytes, payloadKey)) {
            project = JSON.parse(JSON.stringify(bytes));
        }
        const manifest = project?.[payloadKey];
        if (!own(project, payloadKey)) return {input, settings: new Map()};
        const originRecord = project[originKey];
        delete project[originKey];
        // Validate the original archive as well as the reconstructed one. In particular, moving a
        // selected entry out of the ZIP must not hide a CRC or size error from the Loader.
        if (!archive) await validate?.(input, {signal});
        assert(record(manifest) && Object.keys(manifest).length === 2 && manifest.version === 1 && Array.isArray(manifest.entries) &&
            manifest.entries.length <= maxEntries, 'Invalid SB3 payload manifest.');
        const sources = sourceSlots(project);
        const assets = assetNames(project);
        const uses = assetUses(project);
        const bundledAssets = bundledAssetSlots(project);
        const settings = new Map<string, PayloadEntry>();
        const urls = new Set<string>();
        for (const entry of manifest.entries) {
            assert(record(entry) && typeof entry.key === 'string' && sb3SaveFormats.includes(entry.format) &&
                ((entry.kind === 'source' && sources.has(entry.key)) || (entry.kind === 'assets' && (assets.has(entry.key) || bundledAssets.has(entry.key)))),
            'The SB3 payload manifest names an unknown item or format.');
            const id = itemId({kind: entry.kind, key: entry.key});
            assert(!settings.has(id), 'The SB3 payload manifest repeats an item.');
            const {kind, key, format} = entry;
            const fields = ['kind', 'key', 'format', ...(remote(format) ? ['url', 'sha256'] :
                format === 'embedded-data' ? ['data'] : [])];
            assert(Object.keys(entry).length === fields.length && fields.every(field => own(entry, field)),
                'The SB3 payload manifest contains unexpected fields.');
            const selection: PayloadEntry = {kind, key, format};
            if (remote(format)) {
                const url = httpsURL(entry.url);
                assert(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(entry.sha256),
                    'A remote SB3 payload requires a SHA-256 digest.');
                urls.add(url);
                Object.assign(selection, {url, sha256: entry.sha256});
            }
            settings.set(id, selection);
        }
        const useCache = urls.size && await approve?.([...urls], [...settings.values()].some(entry =>
            entry.format === 'remote-cacheable'), signal);
        assert(!urls.size || typeof useCache === 'boolean', 'Opening remote project payloads was cancelled.');
        if (!zip && assets.size) zip = new JSZip();
        let total = 0;
        let index = 0;
        const claims: PayloadCacheClaim[] = [];
        for (const [id, entry] of settings) {
            signal?.throwIfAborted();
            let content;
            const {format, kind, key} = entry;
            const bundled = bundledAssets.get(key);
            if (remote(format)) {
                const store = useCache && format === 'remote-cacheable' ? cache : undefined;
                if (store) content = await store.get(entry.sha256!, {signal: signal ?? new AbortController().signal}).catch(() => undefined);
                if (!(content instanceof Uint8Array) || content.length > maxEntry || await digest(content) !== entry.sha256) {
                    content = await readURL(fetch, entry.url!, signal);
                    assert(await digest(content) === entry.sha256, `The remote payload changed at ${entry.url}.`);
                }
                entry.bytes = content;
                if (store) claims.push([entry.sha256!, content, cacheLabels(id, entry, sources, uses, bundledAssets)]);
            } else if (format === 'embedded-data') content = dataBytes(manifest.entries[index].data);
            else content = await readEntry(zip, filePath(entry, index, bundled), maxEntry);
            total = checkSize(content, total);
            if (kind === 'source' || bundled) {
                const slot = bundled ? {record: bundled.record, field: 'data'} : sources.get(key);
                assert(slot, 'The source data slot no longer exists.');
                assert(!own(slot.record, slot.field), 'The SB3 repeats data in different carriers.');
                slot.record[slot.field] = bundled ? dataURL(content).slice(dataPrefix.length) : decoder.decode(content);
                if (format === 'embedded-file') zip!.remove(filePath(entry, index, bundled));
            } else if (format !== 'embedded-file') {
                assert(zip, 'The asset archive is missing.');
                assert(!zip.file(key), 'The SB3 repeats an asset in different carriers.');
                zip.file(key, content);
            }
            index++;
        }
        delete project[payloadKey];
        const json = JSON.stringify(project);
        assert(encoder.encode(json).length <= extensionProjectArchiveOptions.maxProjectBytes,
            'The restored project JSON exceeds its byte limit.');
        if (zip) {
            const folder = 'plus-payloads/';
            if (zip.files[folder]?.dir && !Object.keys(zip.files).some(name => name !== folder && name.startsWith(folder))) {
                zip.remove(folder);
            }
            zip.file('project.json', json);
        }
        const restored = zip ? await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'}) : json;
        return {input: restored, settings, claims, origins: readOrigins(originRecord, settings)};
    }

    /**
     * The labels one remote-cacheable item is recorded with: one per use, so a file used as two
     * costumes keeps both names. `ref` is the item's own id, with the use's position when it has more.
     */
    function cacheLabels(id: string, entry: PayloadEntry, sources: Map<string, SourceSlot>,
        uses: ReturnType<typeof assetUses>, bundled: Map<string, BundleSlot>): PayloadCacheLabel[] {
        const url = entry.url ? {url: entry.url} : {};
        if (entry.kind === 'source') {
            const label = sources.get(entry.key)?.label;
            return [{ref: id, kind: 'document', ...(label ? {name: label} : {}), ...url}];
        }
        const slot = bundled.get(entry.key);
        if (slot) return [{ref: id, name: slot.label, ...url}];
        const list = uses.get(entry.key) ?? [];
        if (list.length <= 1) return [{ref: id, ...(list[0] ?? {}), ...url}];
        return list.map((use, index) => ({ref: `${id}#${index}`, ...use, ...url}));
    }

    /** The origins kept for items that are still embedded. A malformed record is dropped, not refused. */
    function readOrigins(value: unknown, settings: ReadonlyMap<string, PayloadEntry>) {
        const origins = new Map<string, PayloadOrigin>();
        if (!record(value) || value.version !== 1 || !Array.isArray(value.entries)) return origins;
        for (const entry of value.entries.slice(0, maxEntries)) {
            if (!record(entry) || typeof entry.kind !== 'string' || typeof entry.key !== 'string' ||
                typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)) continue;
            const id = itemId({kind: entry.kind, key: entry.key});
            const setting = settings.get(id);
            if (!setting || remote(setting.format)) continue;
            try { origins.set(id, {url: httpsURL(entry.url), sha256: entry.sha256}); } catch {}
        }
        return origins;
    }

    return {payloadKey, originKey, bundleMaterials, inventory, configurePayloads, encodePayloads, embedPackagedProjectData,
        decodePayloads, digest};
}
