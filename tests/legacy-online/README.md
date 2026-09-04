# Retained online-deployment reference suites

These tests target the removed MongoDB/PM2 online deployment (`MongoMemoryServer`, `lib/mongodb.ts`, `ecosystem.config.cjs`). They are retained as historical specifications rather than silently excluded. SQLite accounting coverage lives in the root integration suites; the DataAcc file parser remains covered by `backup-legacy.test.mjs`.
