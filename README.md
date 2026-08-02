# weave — binaries

Release artifacts for [weave](https://github.com/gaberger/weave). **No source code lives here.**

Each release publishes a self-extracting installer per platform, plus `SHA256SUMS`. Artifacts are
built on native runners in the source repo's release workflow and mirrored here — cross-compiling
drops platform native addons, so every target is compiled on its own OS.

## Install

```sh
sh weave-installer-darwin-arm64.sh     # or linux-x64, linux-arm64
```

Installs to `~/.local/bin` with assets beside it, then runs `weave --help` to prove the artifact
works before reporting success. `--prefix DIR` relocates; `--uninstall` removes it and leaves
`~/.weave` alone.

## Upgrading

```sh
weave upgrade --check --repo weave-registry/weave
weave upgrade --repo weave-registry/weave
```

Set `WEAVE_RELEASE_REPO=weave-registry/weave` to make that the default. `upgrade` refuses to
install anything whose checksum it cannot verify.

While this repository is private, `weave upgrade` needs a `GITHUB_TOKEN` with read access. Making
it public removes that requirement — nothing here is source.

| target | notes |
|---|---|
| `darwin-arm64` | Apple Silicon |
| `linux-x64` | |
| `linux-arm64` | |

`darwin-x64` is not built.
