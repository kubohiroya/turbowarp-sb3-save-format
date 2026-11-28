# Changelog

## Unreleased

- Read a legacy `data:` extension in every JavaScript form a host saves (#901 of
  turbowarp-plus-editor). Besides `data:text/javascript;base64,`, `readSb3Extensions` and
  `convertSb3ExtensionFormats` now accept `application/javascript`, `application/x-javascript`,
  `text/ecmascript` and `application/ecmascript`, media type parameters such as `charset`, and a
  percent-encoded payload. An extension loaded from a file in TurboWarp is often saved as
  `data:application/javascript;base64,`, and such an extension was left out of the list without a
  word. A `data:` URL of another media type is still left alone. Written carriers keep the
  `data:text/javascript;base64,` form. Add `isExtensionDataUrl` to tell the accepted forms apart.

## 0.7.0

Released on 2026-11-28.

- Name cached project data (#902 of turbowarp-plus-editor). When a project is opened, each
  `remote-cacheable` item it writes to the Loader cache is recorded with what the project calls it:
  one label per use, with the costume, backdrop, sound or document kind, its name, the URL it was
  fetched from and the project title the host supplies. A cache that predates labels keeps the
  bytes as before. The Loader drops credentials and queries from the recorded URL.
- Add `cacheEmbedding()` to the project payload host: embed chosen cached items of the open
  project as `embedded-data` or `embedded-file`. Only items this project pins with that SHA-256
  change, and only when their bytes still match the pin and the cached copy; anything else is
  reported with a reason. The change is unsaved until the project is saved.
- Add `releaseAfterSave(digests)`: once the host knows a save succeeded, release this project's
  cache claims on digests the last written archive embedded. Claims of other projects, the shared
  bucket and digests a remote reference still uses are kept. The host takes the project's cache
  bucket as `bucket`, and records nothing without one.
- Keep the URL and digest an embedded item came from in `turboWarpPlusPayloadOrigins`, beside the
  manifest, so the payload formats screen offers the same URL to reference it remotely again. A
  reader that predates it ignores the key.
- Depend on the loader `^0.17.0`, which records labels.

- Add `./extension-format`, the one implementation of the extension form conversion, for a browser
  and Node alike (#901 of turbowarp-plus-editor). `convertSb3ExtensionFormats` converts only the
  extensions it is given, returns a new archive and project and leaves its input untouched, keeps
  the same bytes and digest across a form change, accepts a cancellation signal, and fetches a
  reference with `cache: 'no-store'` and no cache port. `readSb3Extensions` lists every extension
  with its digest, including a legacy `data:` one whose origin is unknown.
- `./writer` now delegates its conversion to it. Its API and refusals are unchanged.
- A conversion now keeps the Manifest's own fields beside `extensions`, such as `uri`, which the
  writer used to drop, and refuses carried bytes that differ from the digest the Manifest pins.
- The remote compatibility carrier no longer uses `Buffer`.

## 0.4.0-rc.1

Released on 2026-11-03. One dependency change, no API change.

- Depend on the loader `^0.7.0` instead of `^0.6.0`. A `^0.6.0` range does not accept 0.7.0, so a
  host on the 0.7.0 loader got a second, nested 0.6.0 copy for `./writer`, and the SB3 it wrote and
  the one the host read went through different loaders. 0.7.0 only adds API, so nothing here
  changes.

## 0.4.0-rc.0

- Add `./writer`: writing the chosen form into an SB3 that is already unpacked. Moved here from
  `src/builder/sb3-extension-format.ts` of turbowarp-kamishibai-app, where the vocabulary's only
  writer lived in one application.
- It is a separate entry point, not part of the root, because it hashes with `node:crypto`. The
  root export stays dependency-free and safe to bundle for a browser.
- A browser does not need it. Converting a form whose bytes may come from the cached copy is the
  loader's `prepareExtensionAddition`, which has a cache port and verifies with `crypto.subtle`.
  This writer has none, so its only byte source is the network: it can write which form a work
  records, never the copy a viewer's browser holds.
- Two things changed in the move, both pushing knowledge back to the caller. Which IDs may be
  requested unsandboxed is now named by the caller alone — the application's own three extension
  IDs stayed in that application — and `capabilities` is a required option, because "writable" is
  a property of the build doing the writing, not of the vocabulary.
- Adds a dependency on `@kubohiroya/turbowarp-extension-loader`: the four forms are its Manifest
  source types, so reading and writing a Manifest belongs with it.

## 0.3.0-rc.0

- Add the dialog. `./dialog-model` holds every rule about what can be chosen, derived from one
  implementation's capabilities and dependency-free, so a CLI can print the same rows a dialog
  draws. `./react` draws them, and `./styles.css` carries its own scoped styles.
- A form the host cannot write is shown disabled with the reason beside it rather than hidden: a
  person who came looking for it should learn what is missing.
- A draft naming a form the host cannot write is not an error — a project saved by another build
  can carry one. The payload is kept as built, the reason is reported in `refusals`, and the
  selection a save receives holds only honourable choices.
- React is an optional peer (`^16.14 || ^17 || ^18 || ^19`) and the root export stays
  dependency-free, so a Node CLI still imports the vocabulary with no React in its tree. The
  component is emitted with the classic JSX runtime, which React 16 hosts need.

## 0.2.0-rc.0

- **Breaking.** Rename the four forms to the Loader's four Manifest source types, spelled
  identically: `remote` becomes `remote-non-cacheable`, `cached` becomes `remote-cacheable`, and
  `embedded-file` / `embedded-data` stay. One vocabulary, so a choice made in a save screen reaches
  the Manifest without being translated.
- The old `cached` was not simply renamed. Here it meant bytes in the ZIP beside a URL, and one
  layer over it meant the opposite — nothing in the SB3, a verified copy in the browser. A work
  carrying its own bytes is embedded, so the name was wrong. `remote-cacheable` stores only the
  reference and leaves the copy to the opener, who may decline it.
- `remote-non-cacheable` says the author forbids a copy: a copy hides a URL that stopped serving
  the pinned bytes until the copy runs out, and a work handed to a shared machine should leave no
  code behind.

This follows turbowarp-kamishibai-app#1121, which made the same change to the vocabulary's original
home. 0.1.0-rc.0 had no consumers.

## 0.1.0-rc.0

- Extract the "save in a chosen format" vocabulary from `src/builder/sb3-save-format.ts` of
  turbowarp-kamishibai-app: `Sb3SavePayload` (`extensions` / `source` / `assets`), `Sb3SaveFormat`
  (`remote` / `cached` / `embedded-file` / `embedded-data`), `Sb3SaveSelection` and the shape
  validation of a selection.
- Take the support matrix as an argument instead of shipping one. The matrix that came with the
  vocabulary names the flags and commands of that App's CLI, so sharing it would make a save dialog
  refuse a format with a command-line flag as the reason. `Sb3SaveCapabilities` is passed in, and
  `sb3SaveCapabilities` builds one from the refusals an implementation already keeps.
- Require a refusal to say what is missing, and reject a capability that refuses without a reason.

Published to npm as `0.1.0-rc.0` under the `next` and `latest` dist-tags, tagged `v0.1.0-rc.0`.
