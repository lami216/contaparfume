# Desktop developer build

Requirements for developers only: Node.js 22 and npm.

```bash
npm ci
npm test
npm run lint
npm run desktop:dev
npm run desktop:dist
```

`desktop:dist` builds the standalone Next runtime, generates the Windows icon from `public/alkarna-logo.png`, stages all local assets, rebuilds native dependencies for Electron, and creates the sole customer artifact: `dist/AlKarna-Perfume-Setup-x64.exe`. Electron Builder still creates `win-unpacked` as an intermediate directory for packaged-runtime smoke testing; it is not uploaded as a customer artifact.

This perfume edition uses the Windows application id `mr.alkarna.perfume.desktop` and the product name `الكرنة للعطور`, so it installs independently from the original `الكرنه` desktop application.

Electron binds the internal server exclusively to `127.0.0.1`. The Next process is the sole database owner. Production perfume data is stored under the isolated Electron user-data directory `AlKarna-Perfume`, with the SQLite file at `<userData>/data/alkarna-perfume.sqlite`; development uses `.dev-data`.

The signed device license file is stored at `<userData>/config/license.alkarna-license`. Its single-install state is isolated for the perfume edition under LocalAppData `PayZone/AlKarna-Perfume-Licensing`, preventing conflicts with the original application's licensing state.
