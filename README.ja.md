# turbowarp-sb3-save-format

SB3を「形式を指定して保存」するための語彙です。1つの作品の**機能拡張**・**ソースデータ**・**アセット**を、それぞれどの形で格納するかを言います。

English: [README.md](README.md)

## 独立したパッケージにする理由

機能拡張・ソースデータ・アセットは、バイト列がどこにあるかを言う言葉をそれぞれ別のパッケージに持っていました。payloadごとに形式を選べる保存や変換には、CLIからも、GUIの保存ダイアログからも、payloadごとの変換器からも読めて、どれにも依存し返さない1組の名前が必要です。

## 語彙

| payload | 内容 |
| --- | --- |
| `extensions` | 作品が読み込むカスタム機能拡張 |
| `source` | 文書の所有者が保持するソースデータ（DSL台本など） |
| `assets` | 作品が使う画像と音 |

| 形式 | バイト列の所在 |
| --- | --- |
| `remote` | HTTPS参照だけを格納し、バイト列は読込時または実行時に取得する |
| `cached` | HTTPS参照を格納し、検証済みバイト列をその隣に保持してオフラインでも使う |
| `embedded-file` | SB3 ZIP内のファイル。相対パスで指す |
| `embedded-data` | `project.json` の中。`data:` URLまたはbase64のフィールド |

選択で指定しなかったpayloadは、作品が既に格納している形のまま保持します。`assetsAsProjectAssets` は、各アセットをコスチューム・背景・音としても格納します。

これはバイト列が**どこにあるか**を細かくするもので、payloadの表現方法ではありません。[`@kubohiroya/turbowarp-document-source`](https://github.com/kubohiroya/turbowarp-document-source) の文書ソース種別にも `embedded-file` という値がありますが、あちらは参照の種別で、表現（テキスト・YAMLブロック・スキーマブロック）は独立しています。両者は別の型のままにし、片方をもう片方のaliasにしません。

## 対応可否は実装側が持つ

実際に書ける組み合わせは実装ごとに違います。ビルド済みSB3を書き換えるCLI、GUIの保存ダイアログ、payloadごとの変換器は同じ組み合わせに対応していません。そのため本パッケージは対応可否を決めません。呼び出し側がそれぞれ自分の `Sb3SaveCapabilities` を渡し、拒否には何が足りないかを必ず書きます。1つの表を共有すると、保存ダイアログがコマンドラインのフラグを理由に拒否することになります。

```ts
import {
  normalizeSb3SaveSelection,
  sb3SaveCapabilities,
  describeSb3SaveFormats,
} from '@kubohiroya/turbowarp-sb3-save-format';

// 機能拡張だけを書き換える変換器の場合
const capabilities = sb3SaveCapabilities({
  formats: {
    'source:remote': 'remoteのソース文書は turbowarp-document-source が所有します。',
    // ...この実装が書けない組み合わせを1件ずつ
  },
  projectAssets: 'このコマンドではなくアセット変換コマンドを使ってください。',
});

describeSb3SaveFormats(capabilities);
// 'extensions: remote|cached|embedded-file|embedded-data; source: kept as built; assets: ...'

normalizeSb3SaveSelection({extensions: 'cached'}, capabilities);
// {extensions: 'cached', source: undefined, assets: undefined, assetsAsProjectAssets: false}

normalizeSb3SaveSelection({source: 'remote'}, capabilities);
// TypeError: Cannot save source as remote: remoteのソース文書は ...
```

指定したpayloadを黙って格下げしたり無視したりはしません。対応できない選択は、payload・形式・足りないものを挙げて拒否します。

## API

- `Sb3SavePayload`、`Sb3SaveFormat`、`sb3SavePayloads`、`sb3SaveFormats`、`sb3SaveFormatKey`
- `Sb3SaveSelection`、`Sb3SaveFormatSupport`、`Sb3SaveFormatKey`
- `Sb3SaveCapabilities`、`Sb3SaveRefusals`、`sb3SaveCapabilities`
- `sb3SaveFormatSupport`、`sb3SupportedSaveFormats`、`normalizeSb3SaveSelection`、`describeSb3SaveFormats`

依存はなく、独自のランタイムも持ちません。

## 開発

```bash
pnpm install
pnpm run check   # typecheck、テスト、ビルド、pack --dry-run
```

## ライセンス

[MPL-2.0](LICENSE)。語彙は [turbowarp-kamishibai-app](https://github.com/kubohiroya/turbowarp-kamishibai-app) の `src/builder/sb3-save-format.ts` から切り出しました。同じライセンス・同じ著者です。
