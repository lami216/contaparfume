# Desktop developer build

Requirements for developers only: Node.js 22 and npm.

```bash
npm ci
npm test
npm run lint
npm run desktop:dev
npm run desktop:dist
```

`desktop:dist` builds the standalone Next runtime, generates the Windows icon from `public/alkarna-logo.png`, stages all local assets, rebuilds native dependencies for Electron, and creates the existing customer installer: `dist/AlKarna-Perfume-Setup-x64.exe`. Electron Builder still creates `win-unpacked` as an intermediate directory for packaged-runtime smoke testing.

This perfume edition uses the Windows application id `mr.alkarna.perfume.desktop` and the product name `الكرنة للعطور`, so it installs independently from the original `الكرنه` desktop application.

Electron binds the internal server exclusively to `127.0.0.1`. The Next process is the sole database owner. Production perfume data stays under the Electron user-data directory `AlKarna-Perfume`, with the SQLite file at `<userData>/data/alkarna-perfume.sqlite`. Both `npm run dev` and `npm run desktop:dev` now use `AlKarna-Perfume-Sandbox`, including separate activation state. Neither command imports production data. Run one development server at a time.

The signed device license file is stored at `<userData>/config/license.alkarna-license`. Its single-install state is isolated for the perfume edition under LocalAppData `PayZone/AlKarna-Perfume-Licensing`, preventing conflicts with the original application's licensing state.

## Local test package

After `desktop:build`, `desktop:rebuild-native`, and `desktop:test-native`, run:

```bash
npm run desktop:package:sandbox
node scripts/desktop-test-server.mjs --packaged --sandbox
```

The ZIP at `dist/sandbox/AlKarna-Perfume-Sandbox-x64.zip` contains a runnable Windows folder. Extract the entire ZIP and open `AlKarnaPerfumeSandbox.exe`. Its window title says `نسخة التجربة`. It starts with an empty database and needs its own normal signed device license. No production license is copied or automatically consumed. The executable remains unsigned; this local test package does not fix Windows Smart App Control blocking.

The immutable `alkarnaChannel` metadata in `app.asar` selects the data profile. Customer installers default to production; environment variables and launch arguments cannot switch that profile. Test/Store/validation profiles have different application IDs, user data, browser session data, database files, license files, license ledgers and print settings. Sandbox licenses and data survive replacement of the extracted test binaries.

## Microsoft Store MSIX

The Windows CI also creates a **NOT-FOR-STORE** unsigned validation MSIX to exercise Microsoft's MakeAppx packaging and check its manifest, assets and runtime contents. It has a deliberately separate validation identity/profile. Do not install it or submit it to Partner Center.

The real package requires the exact identity from a verified Partner Center account and a reserved app name. Create the ignored file `store-identity.local.json` with the following keys, populated with the actual Partner Center values (not the brand name guessed from this repository):

```json
{
  "identityName": "Package/Identity/Name from Partner Center",
  "publisher": "Package/Identity/Publisher from Partner Center",
  "publisherDisplayName": "Package/Properties/PublisherDisplayName from Partner Center",
  "displayName": "Reserved app name"
}
```

Then, after staging and native checks:

```bash
npm run desktop:package:msix
```

Alternatively run **Build Microsoft Store MSIX** in GitHub Actions with these four identity values. The workflow builds and checks the source before producing an unsigned `.msix` in `dist/store`, with SHA-256 and source metadata. It does not upload to the Store, publish, or install certificates. Microsoft signs the package after submission and certification. MakeAppx creates the `.msix` directly; no EXE or ZIP is renamed. The package declares only the required `runFullTrust` capability and Arabic/French resources.

The MSIX version is `package.json` version plus `.0`; do not derive it from GitHub's run counter. Increase the three-part source version for every Store package update, keeping the same Partner Center identity. Test flights also undergo review, so use the isolated local edition for daily edits.

Store data starts separately in `AlKarna-Perfume-Store`. There is no automatic migration from an existing EXE installation. After the Store version is approved and tested, users can deliberately export a backup from the old app and restore it in the Store edition. Keep the original backup and installation until that migration is verified.

These checks validate packaging, runtime loading and license gates. They do not substitute for Windows App Certification Kit, installation/update testing with a properly signed package, or Microsoft certification.

## Store submission prerequisites

As of 2026-10-21, Microsoft's [distribution guide](https://learn.microsoft.com/en-us/windows/apps/distribute-through-store/how-to-distribute-your-win32-app-through-microsoft-store) permits a non-game MSIX app to retain its own licensing/commerce system. [Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) require accurate disclosure of activation/purchase limitations (10.1/10.8), a testable app and working review access (10.3), and an appropriate account type (10.14). The current manually issued license is hardware-bound: a reusable key for an arbitrary reviewer PC will not work. Agree on a genuine review-access mechanism before submitting; never ship a hidden reviewer bypass or a private license-signing key.

Start account registration at [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com/), the entry point for the new free registration flow. Follow the [current account guidance](https://learn.microsoft.com/en-us/windows/apps/publish/faq/open-developer-account): commercial/professional distribution calls for a Company account and official verification documents. An unregistered brand alone does not establish eligibility. Do not create a misleading company identity or choose an Individual account to evade the commercial-account requirement. Resolve eligibility with Microsoft if no business documentation is available.

Once the account is verified: reserve the name, copy Product identity, build the real MSIX, prepare Arabic/French listing assets, activation/payment disclosures and a public privacy policy/support contact, provide review access in Notes for certification, and submit for certification. Account verification and certification can take business days; same-day publication is not promised.
