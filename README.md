# turbowarp-sb3-save-format

The vocabulary for saving an SB3 in a chosen format: which form the **extensions**, the **source
data** and the **assets** of one project are stored in.

Japanese: [README.ja.md](README.ja.md)

## Why this is a package of its own

Extensions, source data and assets each already had their own words for where their bytes live, in
three different packages. A save or a conversion that offers a choice per payload needs one set of
names, readable from a CLI, from a save dialog in the GUI and from each per-payload converter, and
depended on by none of them in return.

## The vocabulary

| Payload | What it is |
| --- | --- |
| `extensions` | The custom extensions the project loads |
| `source` | The source data a document owner keeps, such as a DSL script |
| `assets` | The images and sounds the project uses |

| Format | Where the bytes are |
| --- | --- |
| `remote-non-cacheable` | Only an HTTPS reference is stored; the bytes are fetched every time and no copy is kept |
| `remote-cacheable` | Only an HTTPS reference is stored, and a verified copy may be kept in the browser |
| `embedded-file` | A file inside the SB3 ZIP, named by a relative path |
| `embedded-data` | Inside `project.json`, as a `data:` URL — the one form a standard TurboWarp host opens on its own |

A payload left unset in a selection is kept exactly as the project already stores it.
`assetsAsProjectAssets` additionally stores each asset as a costume, a backdrop or a sound.

These are the Loader's four Manifest source types, spelled identically, so a choice made in a save
screen reaches the Manifest without being translated.

This refines **where** the bytes are, not how a payload is represented. A document source kind of
[`@kubohiroya/turbowarp-document-source`](https://github.com/kubohiroya/turbowarp-document-source)
also spells one of its values `embedded-file`, but that is a reference kind whose representation
(text, YAML blocks, schema blocks) is independent. The two are separate types, and neither is an
alias of the other.

## Capabilities belong to the implementation, not here

What can actually be written differs per implementation: a CLI that rewrites a built SB3, a save
dialog in the GUI and a per-payload converter do not support the same pairs. So this package does
not decide that. Each caller passes its own `Sb3SaveCapabilities`, and a refusal has to say what is
missing. One shared table would make a save dialog refuse a format with a command-line flag as the
reason.

```ts
import {
  normalizeSb3SaveSelection,
  sb3SaveCapabilities,
  describeSb3SaveFormats,
} from '@kubohiroya/turbowarp-sb3-save-format';

// A converter that rewrites extensions only.
const capabilities = sb3SaveCapabilities({
  formats: {
    'source:remote-non-cacheable': 'A remote source document is owned by turbowarp-document-source.',
    // ...one entry per pair this implementation cannot write
  },
  projectAssets: 'Use the asset conversion command instead of this one.',
});

describeSb3SaveFormats(capabilities);
// 'extensions: remote-non-cacheable|remote-cacheable|embedded-file|embedded-data; source: ...'

normalizeSb3SaveSelection({extensions: 'remote-cacheable'}, capabilities);
// {extensions: 'remote-cacheable', source: undefined, assets: undefined, assetsAsProjectAssets: false}

normalizeSb3SaveSelection({source: 'remote-non-cacheable'}, capabilities);
// TypeError: Cannot save source as remote-non-cacheable: A remote source document is owned by ...
```

A named payload is never silently downgraded or ignored: a choice the capabilities cannot honour is
refused, naming the payload, the format and what is missing.

## API

- `Sb3SavePayload`, `Sb3SaveFormat`, `sb3SavePayloads`, `sb3SaveFormats`, `sb3SaveFormatKey`
- `Sb3SaveSelection`, `Sb3SaveFormatSupport`, `Sb3SaveFormatKey`
- `Sb3SaveCapabilities`, `Sb3SaveRefusals`, `sb3SaveCapabilities`
- `sb3SaveFormatSupport`, `sb3SupportedSaveFormats`, `normalizeSb3SaveSelection`,
  `describeSb3SaveFormats`

No dependencies and no runtime of its own.

## Development

```bash
pnpm install
pnpm run check   # typecheck, tests, build, pack --dry-run
```

## License

[MPL-2.0](LICENSE). The vocabulary was extracted from `src/builder/sb3-save-format.ts` of
[turbowarp-kamishibai-app](https://github.com/kubohiroya/turbowarp-kamishibai-app), which is under
the same license and by the same author.
