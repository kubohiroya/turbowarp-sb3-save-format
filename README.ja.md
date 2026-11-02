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
| `remote-non-cacheable` | HTTPS参照だけを格納し、バイト列は毎回取得する。控えも残さない |
| `remote-cacheable` | HTTPS参照だけを格納し、検証済みの控えをブラウザに保持してよい |
| `embedded-file` | SB3 ZIP内のファイル。相対パスで指す |
| `embedded-data` | `project.json` の中の `data:` URL。標準のTurboWarpホストが自力で開ける唯一の形 |

選択で指定しなかったpayloadは、作品が既に格納している形のまま保持します。`assetsAsProjectAssets` は、各アセットをコスチューム・背景・音としても格納します。

この4つは Loader の Manifest の source type と同じ綴りです。保存画面での選択が翻訳されずに Manifest へ届くようにするためです。

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
    'source:remote-non-cacheable': 'remoteのソース文書は turbowarp-document-source が所有します。',
    // ...この実装が書けない組み合わせを1件ずつ
  },
  projectAssets: 'このコマンドではなくアセット変換コマンドを使ってください。',
});

describeSb3SaveFormats(capabilities);
// 'extensions: remote-non-cacheable|remote-cacheable|embedded-file|embedded-data; source: ...'

normalizeSb3SaveSelection({extensions: 'remote-cacheable'}, capabilities);
// {extensions: 'remote-cacheable', source: undefined, assets: undefined, assetsAsProjectAssets: false}

normalizeSb3SaveSelection({source: 'remote-non-cacheable'}, capabilities);
// TypeError: Cannot save source as remote-non-cacheable: remoteのソース文書は ...
```

指定したpayloadを黙って格下げしたり無視したりはしません。対応できない選択は、payload・形式・足りないものを挙げて拒否します。

## ダイアログ

`./dialog-model` は capabilities と下書きから、ダイアログが描く行を作ります。DOMにも依存せず、依存パッケージもありません。何を選べるかの規則はすべてここにあるので、一度テストすれば済み、CLIから同じ行を印字することもできます。

```ts
import {sb3SaveDialogModel, chooseSb3SaveFormat} from '@kubohiroya/turbowarp-sb3-save-format/dialog-model';

const model = sb3SaveDialogModel(capabilities, chooseSb3SaveFormat({}, 'extensions', 'remote-cacheable'));
model.rows;          // payloadごとに1行。各選択肢は enabled と、無効なときの理由を持つ
model.selection;     // 書ける選択だけ。そのまま保存へ渡せる
model.refusals;      // このビルドが書けない下書きの選択と、足りないもの
model.unchanged;     // 何も変わらない選択なら true
```

書けない形式は隠さず、理由を添えて無効表示にします。それを探して来た人には、何が足りないのかが分かる必要があります。書けない形式を持つ下書きはエラーではありません（別のビルドで保存された作品が持ち得ます）。そのpayloadはそのまま保持し、理由を報告します。

`./react` がその行を描き、`./styles.css` が自分の範囲に限ったスタイルを持ちます。React は任意のpeerなので、root の export を使うNodeのCLIにReactは入りません。

```tsx
import {Sb3SaveFormatDialog} from '@kubohiroya/turbowarp-sb3-save-format/react';
import '@kubohiroya/turbowarp-sb3-save-format/styles.css';

<Sb3SaveFormatDialog
  capabilities={capabilities}
  language="ja"
  onSave={(selection) => save(selection)}
  onCancel={close}
/>;
```

コンポーネントは古典的なJSXランタイムで出力しています。React 16 のホストがこれを必要とするためです。`draft` と `onDraftChange` を渡すと制御でき、渡さなければ自分で下書きを保持します。

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
