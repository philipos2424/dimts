# URI decoder compatibility adapter

`query-string@7`, used by Expo Router 57, requires a callable CommonJS decoder.
The patched upstream `decode-uri-component@0.5.0` is ESM. This adapter exports
that patched default function without copying or changing its algorithm.
Its dependency is pinned to the actual upstream release through an npm alias.

The root override replaces the decoder dependency with this adapter. Node 22.13 or newer is
required by both this adapter and Expo SDK 57; Metro resolves the ESM default
for mobile/web bundles. Local version 1.0.0 identifies this compatibility adapter,
not an upstream decoder release or a relabeled vulnerable copy. npm audit must also inspect the aliased upstream
dependency. Remove this override when Expo's query-string dependency uses a
patched decoder directly.

The repository sets `install-links=true` so npm installs this local package and
its pinned dependency rather than creating a directory symlink. `npm ci` and
the compatibility tests must succeed from the committed lockfile.

Reference: [upstream advisory and patched version](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).
