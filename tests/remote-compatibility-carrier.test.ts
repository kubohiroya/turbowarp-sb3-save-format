// SPDX-License-Identifier: MPL-2.0
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';
import {remoteCompatibilityCarrier} from '../src/remote-compatibility-carrier.js';

const id = 'carrierfixture';
const url = 'https://example.test/v1/extension.js';
const code = `Scratch.extensions.register({getInfo: () => ({id: '${id}', blocks: []}), report: () => 42});`;
const sha256 = createHash('sha256').update(code).digest('hex');

class Element {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: Element[] = [];
  readonly attributes: Record<string, string> = {};
  private parent?: Element;
  lang = '';
  textContent = '';
  get isConnected() { return this.parent !== undefined; }
  querySelector() { return this.children.find(node => node.dataset.twplusCarrierError); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(...nodes: Element[]) {
    for (const item of nodes) {
      this.children.push(item);
      item.parent = this;
    }
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    delete this.parent;
  }
}

async function execute(fetcher: () => Promise<Response>, {allowed = true, timeoutMs = 1000, language = 'ja', maxBytes = 1000} = {}) {
  const stage = new Element();
  stage.style.position = 'static';
  const document = {documentElement: {lang: language}, createElement: () => new Element(),
    defaultView: {getComputedStyle: (el: Element) => ({position: el.style.position})}};
  const stopAll = vi.fn();
  const events = new Map<string, () => void>();
  const runtime = {
    on: (name: string, callback: () => void) => events.set(name, callback),
    once: (name: string, callback: () => void) => events.set(name, callback),
    removeListener: (name: string) => events.delete(name),
  };
  let registration: {getInfo(): {id: string}; report?(): unknown} | undefined;
  let finish!: () => void;
  const registered = new Promise<void>(resolve => { finish = resolve; });
  const Scratch = {
    extensions: {unsandboxed: true, register: (extension: typeof registration) => {registration = extension; finish();}},
    canFetch: async () => allowed,
    fetch: vi.fn(fetcher),
    renderer: {canvas: {parentElement: stage, ownerDocument: document}},
    vm: {stopAll, runtime},
  };
  const source = remoteCompatibilityCarrier({id, url, version: '1.0.0', sha256}, {maxBytes, timeoutMs});
  const javascript = Buffer.from(source.split(',')[1]!, 'base64').toString('utf8');
  runInNewContext(javascript, {Scratch, AbortController, crypto, TextDecoder, Uint8Array, queueMicrotask, setTimeout, clearTimeout});
  await registered;
  return {stage, stopAll, events, registration, requests: Scratch.fetch};
}

describe('remote compatibility carrier', () => {
  it('registers the original extension only after verifying its bytes', async () => {
    const {registration, stage, stopAll, requests} = await execute(async () => new Response(code));
    expect(registration?.getInfo().id).toBe(id);
    expect(registration?.report?.()).toBe(42);
    expect(stage.children).toHaveLength(0);
    expect(stopAll).not.toHaveBeenCalled();
    expect(requests).toHaveBeenCalledWith(url, expect.objectContaining({redirect: 'manual', credentials: 'omit'}));
  });

  it.each([
    [404, 'HTTP_404', false],
    [503, 'HTTP_503', true],
    [302, 'REDIRECT_REFUSED', false],
  ] as const)('shows status %i to the viewer and does not leave the host waiting', async (status, kind, retry) => {
    const {registration, stage, stopAll, events} = await execute(async () => new Response('invalid', {status}));
    const panel = stage.children[0]!;
    expect(registration?.getInfo().id).toBe(id);
    expect(registration?.report).toBeUndefined();
    expect(panel.attributes.role).toBe('alert');
    expect(panel.dataset.twplusCarrierError).toBe(kind);
    expect(panel.children[2]?.textContent).toContain(`1.0.0\n${url}`);
    expect(panel.children[3]?.textContent.includes('開き直してください')).toBe(retry);
    expect(stopAll).toHaveBeenCalledOnce();
    events.get('PROJECT_START')?.();
    await Promise.resolve();
    expect(stopAll).toHaveBeenCalledTimes(2);
    events.get('RUNTIME_DISPOSED')?.();
    expect(stage.children).toHaveLength(0);
    expect(stage.style.position).toBe('static');
    expect(events.has('PROJECT_START')).toBe(false);
  });

  it('refuses a mismatched digest, overlarge body or denied request before evaluation', async () => {
    const mismatch = await execute(async () => new Response('throw Error("never evaluate")'), {language: 'en'});
    expect(mismatch.stage.children[0]?.dataset.twplusCarrierError).toBe('DIGEST_MISMATCH');
    expect(mismatch.stage.children[0]?.children[0]?.textContent).toBe('Could not start this project');
    const oversized = await execute(async () => new Response(code), {maxBytes: 2});
    expect(oversized.stage.children[0]?.dataset.twplusCarrierError).toBe('INVALID_BYTES');
    const denied = await execute(async () => new Response(code), {allowed: false});
    expect(denied.stage.children[0]?.dataset.twplusCarrierError).toBe('FETCH_DENIED');
    expect(denied.requests).not.toHaveBeenCalled();
  });

  it('registers a fallback and reports a deadline even if the host never settles the fetch', async () => {
    const result = await execute(() => new Promise(() => {}), {timeoutMs: 20});
    expect(result.registration?.getInfo().id).toBe(id);
    expect(result.stage.children[0]?.dataset.twplusCarrierError).toBe('FETCH_TIMEOUT');
  });
});
