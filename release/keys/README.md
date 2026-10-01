# Release keys

This directory holds the **public** half of the release signing identity. Nothing
here is secret, and nothing here may ever be a private key.

## Files

| File | Meaning |
| --- | --- |
| `infra-cod-release.pub` | Committed minisign public key. The trust root every verifier pins. |
| `infra-cod-release.pub.example` | Placeholder showing the expected file shape. Not a trust root. |

The public key is pinned in `release/release-version.json` under `signing.publicKey`
and its key id is recorded under `signing.keyId`. Both are part of the reviewed
tree: changing either is a deliberate, reviewable act, which is the point. A
verifier never learns the public key from the artifact it is checking, and never
from the network.

## This stage has no production key

`infra-cod-release.pub` does **not** exist yet, and that is intentional rather than
an oversight. Stage 9 was implemented by an agent, and an agent must not mint the
production signing identity: the private half has to live in a secret store only
the owner controls, and generating it in a chat session would put it in a
transcript. Until the owner provisions the key, publish builds fail closed with an
explicit error, and the manifest of any artifact that is produced says
`release.signed: false`.

Provisioning it (owner, once):

```bash
minisign -G -W -p release/keys/infra-cod-release.pub -s /secure/offline/infra-cod-release.key
# then commit release/keys/infra-cod-release.pub and set signing.keyId in
# release/release-version.json to the key id printed in the public key comment.
```

`-W` is not optional. It writes an *unencrypted* secret key, which is the only kind
the release path reads: an encrypted key needs scrypt from libsodium, so it is
refused with a clear message rather than half-supported. `-W` also means the release
job never needs a human at a password prompt.

The key file format matters, and this project matches minisign's byte for byte. A
key generated above is 158 bytes, unencrypted (`kdf_alg` = `0x00 0x00`), and carries
**32 zero bytes** where an encrypted key's checksum would be. minisign never
verifies that field on the unencrypted path, and neither does this project — an
earlier version verified it and therefore rejected every genuine `minisign -G -W`
key, which would have failed the release job at signing time on the host.
`services/control-plane/test/release-interop.test.mjs` runs the real `minisign`
binary in both directions and is the check that keeps this true; CI runs it through
`npm run test:release:require-minisign`, which fails rather than skipping when the
binary is absent.

The private key file is never committed, never copied into an artifact, and never
printed. `release/keys/*.key` and `*.minisig` are gitignored so an accidental
local generation cannot be staged.

## Circle of trust

```text
release/keys/infra-cod-release.pub   (committed, reviewed)
        │  pinned by
        ▼
SHA256SUMS.minisig  ──verifies──▶  SHA256SUMS  ──verifies──▶  infra-cod-<version>-linux-x64.tar.gz
```

Signature first, then checksum, then the archive, and only then is anything
extracted. The tarball's own filename is never trusted before the manifest inside
it has been checked against the requested version and target — see
`docs/RELEASE_FORMAT.md`.
