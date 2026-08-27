# weave — binaries

Release artifacts for [weave](https://github.com/gaberger/weave). **No source code lives here.**

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/weave-registry/weave/main/install.sh | sh
```

Detects your platform, downloads the matching installer from the latest release, verifies it
against that release's `SHA256SUMS`, and runs it. No credentials needed — this repository is
public, which is the whole reason it exists separately from the source.

Because a piped `sh` cannot take arguments, options arrive as environment variables:

| | |
|---|---|
| `WEAVE_VERSION=v0.2.90` | install a specific tag instead of the latest |
| `WEAVE_PREFIX=/usr/local` | install root (default `~/.local`) |

Prefer to see what you are running first? Take the installer for your platform from the
[latest release](https://github.com/weave-registry/weave/releases/latest) and run it yourself —
the same artifact, with the checksum then yours to check:

```sh
sh weave-installer-darwin-arm64.sh          # or linux-x64, linux-arm64
sh weave-installer-linux-x64.sh --prefix /opt
sh weave-installer-linux-x64.sh --uninstall # leaves ~/.weave alone
```

Either route installs to `~/.local/bin` with assets beside it, then runs `weave --help` to prove
the artifact works before reporting success.

## Upgrading

```sh
weave upgrade --check     # is there a newer build for this platform?
weave upgrade             # download, verify the checksum, install
```

No flags and no token: this repo is already `weave upgrade`'s default source. It refuses to install
anything whose checksum it cannot verify — an absent `SHA256SUMS` entry and a mismatched one both
stop it before the installer is executed.

## What is here, and why it is separate

Each release publishes a self-extracting installer per platform plus `SHA256SUMS`. Every target is
compiled on its own OS runner in the source repo's release workflow and mirrored here — cross
compiling drops platform-native addons, so a binary built for one OS on another ships broken.

The source repository is private and holds no artifact anyone can install. Keeping the binaries in
a public repo is what lets `weave upgrade` and the one-liner above work with no authentication at
all. Nothing here is source; it is the download side of the same releases.

Released targets are `darwin-arm64`, `linux-x64` and `linux-arm64`. `darwin-x64` is deliberately
not built — Intel Macs run the arm64 build under Rosetta.
