# Local third-party license overrides

This directory contains only source-pinned license material required by the
bundle-notice validator. The build never downloads license text.

## `@nodable/entities` 3.1.0

The published npm tarball does not contain a license file, although its package
metadata declares MIT. The MIT text in
[`nodable-entities-3.1.0.LICENSE.txt`](nodable-entities-3.1.0.LICENSE.txt) is
the upstream license from
<https://raw.githubusercontent.com/nodable/val-parsers/ac48e7ea591da372be023a481875c747535812b3/LICENSE>
at git commit `ac48e7ea591da372be023a481875c747535812b3`, preserving the
upstream copyright `Copyright (c) 2026 Nodable`.

Provenance for the installed package:

- npm metadata: <https://registry.npmjs.org/@nodable/entities/3.1.0>
- npm tarball: <https://registry.npmjs.org/@nodable/entities/-/entities-3.1.0.tgz>
- npm tarball integrity: `sha512-LsS/DjHr+uDM647Gru/cA8+J3a3HfhttwCKLyuoyN7yXTFCxKBtSgMQBvrW9yNPa2/zDRUNuGPaH5QUFoa4arQ==`

The bundle build validates the package name, exact installed version, declared
license, upstream override bytes, and the matching checked-in third-party
notice. Any change requires an explicit license review and update.
