# Native Controller/Worker build tools

These builders target **DSH 0.2.2-rc.1** and prepare new-named native Session/source providers without modifying the signed application, replacing its module loader, or copying the installed SDK into this repository. Controller and Worker have different provider compositions; do not install a Worker owner in a Controller profile.

## External source prerequisite

**This repository is not a standalone native-source distribution.** The builders require a separate, modified `dsh-remote-core` source checkout, its installed build dependencies, maintained build configuration, current emitted artifacts and version-specific frozen inputs. That source checkout and historical generated snapshots are not included here. Stock installed DSH alone is not a substitute. A clean clone of this repository therefore cannot reproduce the complete Controller/Worker bundles or all native SDK acceptance tests.

The scripts are maintained packaging/reference tools, not an install command for an active profile. Paths and inputs must be supplied/reviewed for the matching source and release; no personal runtime path is assumed. Use the independently published and reviewed release archive when the required external inputs are unavailable. Missing historical snapshots must not be reconstructed from private settings or patched installed files.

## Ownership and composition

- The Controller wrapper mounts the stock Host Controller as a child; its owned Client supplies the source registry.
- The source BFF owns its Host/Client Remote contributions before starting source adapters.
- The Worker provider is a separate native API owner with exact constructor/prototype/helper verification. A package version or configuration flag alone is not readiness.
- Both roles retain the same canonical stock SDK identities. Preserve dependency, generated metadata, third-party notices and module-identity checks when building a successor.
- Replacement patches disable original rows using package-name assertions and insert new unique owners. They do not automatically inherit old row configuration; reviewed deployment settings must be preserved explicitly, including later profile overrides.

## Release and operator boundaries

Generated bundle manifests, patches, reports and proof overlays belong to a particular release output and are not source files promised by this directory. Obtain exact artifacts and checksums from that release. Static verification is not installation, GUI acceptance, native LLM completion or physical Worker evidence.

Never update or restart the sole working remote channel without a verified independent recovery path. Any deployment is a separate operator-approved maintenance step using the existing public package manager; do not hot-switch core/UI owners, modify EXE/ASAR, bypass version checks or read private settings merely to recover build context. The [public overview](../README.md) and [portable Worker instructions](../portable/README.ru.md) describe current distribution limits and already-paired v2 upgrades.
