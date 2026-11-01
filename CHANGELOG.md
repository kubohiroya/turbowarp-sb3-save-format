# Changelog

## 0.1.0-rc.0 (unreleased)

- Extract the "save in a chosen format" vocabulary from `src/builder/sb3-save-format.ts` of
  turbowarp-kamishibai-app: `Sb3SavePayload` (`extensions` / `source` / `assets`), `Sb3SaveFormat`
  (`remote` / `cached` / `embedded-file` / `embedded-data`), `Sb3SaveSelection` and the shape
  validation of a selection.
- Take the support matrix as an argument instead of shipping one. The matrix that came with the
  vocabulary names the flags and commands of that App's CLI, so sharing it would make a save dialog
  refuse a format with a command-line flag as the reason. `Sb3SaveCapabilities` is passed in, and
  `sb3SaveCapabilities` builds one from the refusals an implementation already keeps.
- Require a refusal to say what is missing, and reject a capability that refuses without a reason.

Not published to npm.
