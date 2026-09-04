# Desktop developer build

Requirements for developers only: Node.js 22 and npm.

```bash
npm ci
npm test
npm run lint
npm run desktop:dev
npm run desktop:dist
```

`desktop:dist` builds the standalone Next runtime, generates the Windows icon from `public/alkarna-logo.png`, stages all local assets, rebuilds native dependencies for Electron, and creates the sole customer artifact: `dist/AlKarna-Setup-x64.exe`. Electron Builder still creates `win-unpacked` as an intermediate directory for packaged-runtime smoke testing; it is not uploaded as a customer artifact.

Electron binds the internal server exclusively to `127.0.0.1`. The Next process is the sole database owner. Production data is derived from Electron's `app.getPath("userData")`; development uses `.dev-data`.

The signed device license is also machine configuration rather than business data. It is stored independently at `<userData>/config/license.alkarna-license`, so application updates and business database backup/restore operations do not move or replace it.
