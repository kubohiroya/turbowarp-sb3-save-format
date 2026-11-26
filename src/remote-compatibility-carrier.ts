// SPDX-License-Identifier: MPL-2.0

export const remoteCarrierMarker = '// TurboWarp Plus remote compatibility carrier v1\n';

interface RemoteCarrierSource {
  readonly id: string;
  readonly url: string;
  readonly sha256: string;
  readonly version?: string | undefined;
}

interface ExtensionObject {
  getInfo(): {id: string; name?: string; blocks?: readonly unknown[]};
}

interface CarrierScratch {
  extensions: {unsandboxed?: boolean; register(extension: ExtensionObject): void};
  fetch?: typeof fetch;
  canFetch?: (url: string) => Promise<boolean>;
  renderer?: {canvas?: HTMLCanvasElement};
  vm?: {stopAll(): void; runtime?: {
    on(event: string, callback: () => void): void;
    once(event: string, callback: () => void): void;
    removeListener(event: string, callback: () => void): void;
  }};
  translate?: {language?: string};
}

// This function is serialized into the classic extension script. Keep its dependencies local.
function runRemoteCarrier(
  scratch: CarrierScratch,
  source: RemoteCarrierSource,
  limits: {maxBytes: number; timeoutMs: number},
): void {
  class CarrierError extends Error {
    constructor(readonly code: string, readonly retry = false) {
      super(code);
    }
  }

  function showFailure(error: CarrierError): void {
    const doc = scratch.renderer?.canvas?.ownerDocument ?? globalThis.document;
    const parent = scratch.renderer?.canvas?.parentElement ?? doc?.body;
    if (!parent || !doc) return;
    const existing = parent.querySelector('[data-twplus-carrier-error]');
    if (existing) return;

    const ja = (scratch.translate?.language || doc.documentElement.lang || navigator.language)
      .toLowerCase().startsWith('ja');
    const messages: Record<string, [string, string]> = {
      NO_HOST_SUPPORT: ['この環境では拡張のリモート読み込みを使えません。', 'This host cannot load the remote extension.'],
      FETCH_DENIED: ['拡張の取得が許可されませんでした。', 'Permission to download the extension was denied.'],
      FETCH_FAILED: ['拡張の取得先に接続できませんでした。', 'Could not reach the extension download.'],
      FETCH_TIMEOUT: ['拡張の取得が時間内に完了しませんでした。', 'The extension download timed out.'],
      REDIRECT_REFUSED: ['拡張の取得先が別の URL に転送されました。', 'The extension download URL redirected.'],
      HTTP_404: ['指定の版の拡張が配布先にありません。', 'This version of the extension is missing from the download site.'],
      INVALID_BYTES: ['拡張のファイルが空、上限超過、または不正です。', 'The extension file is empty, too large, or invalid.'],
      DIGEST_MISMATCH: ['取得した拡張が作品に記録された内容と一致しません。', 'The downloaded extension does not match the copy pinned by this project.'],
      REGISTER_FAILED: ['検証済みの拡張を登録できませんでした。', 'The verified extension could not be registered.'],
    };
    const heading = doc.createElement('strong');
    heading.textContent = ja ? '作品を開始できません' : 'Could not start this project';
    const reason = doc.createElement('p');
    reason.textContent = (messages[error.code] ?? ['拡張の取得に失敗しました。', 'The extension download failed.'])[ja ? 0 : 1];
    const details = doc.createElement('p');
    details.textContent = `${error.code} · ${source.id}${source.version ? ` ${source.version}` : ''}\n${source.url}`;
    const guidance = doc.createElement('p');
    guidance.textContent = error.retry
      ? ja ? '接続を確認してから、ページを開き直してください。' : 'Check your connection and reopen this page.'
      : ja ? '作品の配布元に、この情報をお知らせください。' : 'Share these details with the project publisher.';

    const panel = doc.createElement('div');
    panel.dataset.twplusCarrierError = error.code;
    panel.setAttribute('role', 'alert');
    panel.lang = ja ? 'ja' : 'en';
    Object.assign(panel.style, {
      position: 'absolute', inset: '0', zIndex: '10000', overflow: 'auto', boxSizing: 'border-box',
      padding: '1.25em', background: '#fff', color: '#202124', font: '16px/1.5 system-ui, sans-serif',
      overflowWrap: 'anywhere', whiteSpace: 'pre-line',
    });
    panel.append(heading, reason, details, guidance);
    const priorPosition = parent.style.position;
    const changePosition = doc.defaultView?.getComputedStyle(parent).position === 'static';
    if (changePosition) parent.style.position = 'relative';
    parent.append(panel);
    scratch.vm?.stopAll();
    const runtime = scratch.vm?.runtime;
    const stopNextRun = () => queueMicrotask(() => { if (panel.isConnected) scratch.vm?.stopAll(); });
    runtime?.on('PROJECT_START', stopNextRun);
    runtime?.once('RUNTIME_DISPOSED', () => {
      runtime.removeListener('PROJECT_START', stopNextRun);
      panel.remove();
      if (changePosition && parent.style.position === 'relative') parent.style.position = priorPosition;
    });
  }

  async function download(signal: AbortSignal): Promise<string> {
    if (!scratch.extensions.unsandboxed || !scratch.fetch || !scratch.canFetch || !globalThis.crypto?.subtle)
      throw new CarrierError('NO_HOST_SUPPORT');
    let response: Response;
    try {
      if (!await scratch.canFetch(source.url)) throw new CarrierError('FETCH_DENIED');
      if (signal.aborted) throw new CarrierError('FETCH_TIMEOUT', true);
      response = await scratch.fetch(source.url, {credentials: 'omit', redirect: 'manual', signal});
    } catch (error) {
      throw error instanceof CarrierError ? error : new CarrierError('FETCH_FAILED', true);
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      throw new CarrierError('REDIRECT_REFUSED');
    if (!response.ok) {
      const status = response.status;
      throw new CarrierError(`HTTP_${status}`, [408, 425, 429].includes(status) || status >= 500);
    }
    if (!response.body) throw new CarrierError('INVALID_BYTES');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limits.maxBytes) {
          void reader.cancel().catch(() => {});
          throw new CarrierError('INVALID_BYTES');
        }
        chunks.push(value);
      }
    } catch (error) {
      throw error instanceof CarrierError ? error : new CarrierError('FETCH_FAILED', true);
    } finally {
      reader.releaseLock();
    }
    if (length === 0) throw new CarrierError('INVALID_BYTES');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== source.sha256) throw new CarrierError('DIGEST_MISMATCH');
    try {
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
      throw new CarrierError('INVALID_BYTES');
    }
  }

  async function load(): Promise<void> {
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        download(controller.signal),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            reject(new CarrierError('FETCH_TIMEOUT', true));
            controller.abort();
          }, limits.timeoutMs);
        }),
      ]);
      const registrations: ExtensionObject[] = [];
      const evaluationScratch = {
        ...scratch,
        extensions: {...scratch.extensions, register: (extension: ExtensionObject) => registrations.push(extension)},
      };
      // Only the bytes verified above execute, with this load's Scratch API and a private registrar.
      new Function('Scratch', code)(evaluationScratch);
      const extension = registrations[0];
      if (registrations.length !== 1 || extension?.getInfo().id !== source.id)
        throw new CarrierError('REGISTER_FAILED');
      scratch.extensions.register(extension);
    } catch (cause) {
      const error = cause instanceof CarrierError ? cause : new CarrierError('REGISTER_FAILED');
      // TurboWarp waits for registration, even if the script has already evaluated or thrown.
      scratch.extensions.register({getInfo: () => ({id: source.id, name: source.id, blocks: []})});
      showFailure(error);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  }
  void load();
}

export function remoteCompatibilityCarrier(
  source: RemoteCarrierSource,
  limits: {maxBytes: number; timeoutMs: number},
): string {
  const script = `${remoteCarrierMarker}(${runRemoteCarrier.toString()})(Scratch, ${JSON.stringify(source)}, ${JSON.stringify(limits)});\n`;
  return `data:text/javascript;base64,${Buffer.from(script, 'utf8').toString('base64')}`;
}
