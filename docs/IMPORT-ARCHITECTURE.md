# Migration engine

The settings workspace presents backup restore and external migration together, but they remain separate trust paths. A validated `conta-backup` uses the destructive, transactional restore path. External files are detected, converted by a source adapter to a `CanonicalImportPackage`, matched without changing MongoDB, reviewed, backed up, and only then merged in short resumable phases.

```text
file -> detector -> source adapter -> canonical package -> matcher/review
     -> preview -> safety backup -> phased merge -> mappings + import run audit
```

Adapters own source-specific parsing and stable source keys. The matcher and merge policies only consume canonical entity fields. `importMappings` records source-to-target links while legacy keys remain on existing DataAcc records for backwards compatibility and retry safety. Probable or ambiguous matches are never automatically linked. Unknown groups retain their columns, count and reason as the foundation for a future manual mapper.

Native restore is deliberately not an adapter and external packages can never enter `restoreNativeBackup`. The first adapter is DataAcc SQLite; CSV/XLSX/JSON and generic SQLite can be added by implementing `ImportSourceAdapter` without replacing matching or merge policy contracts.
