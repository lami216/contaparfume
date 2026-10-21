import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,basename} from 'node:path';
import {channelConfig} from './desktop-channel-config.mjs';

const [channel,...args]=process.argv.slice(2);
if(process.platform!=='win32')throw new Error('Windows packaging must run on Windows.');
if(args.length>2||(args.length&&args[0]!=='--identity')||(args.length===1))throw new Error('Usage: node scripts/desktop-package.mjs <sandbox|store-validation|store> [--identity path.json]');
const pkg=JSON.parse(await readFile('package.json','utf8'));
// Validate identity before importing builder or producing an output. A validation
// package is deliberately separate; it must never be mistaken for a Store upload.
const identity=channel==='store'?JSON.parse(await readFile(args[1]||'store-identity.local.json','utf8')):undefined;
const config=channelConfig(channel,pkg.version,identity,pkg.storeVersion);
await readFile('desktop-dist/app/server.js');
await readFile('desktop-dist/shell/package.json');
process.env.CSC_IDENTITY_AUTO_DISCOVERY='false';
const {build,Platform,Arch}=await import('electron-builder');
if(channel!=='sandbox') {
  const {default:sharp}=await import('sharp');
  await mkdir('build/appx',{recursive:true});
  for(const [file,width,height] of [['StoreLogo.png',50,50],['Square150x150Logo.png',150,150],['Square44x44Logo.png',44,44],['Wide310x150Logo.png',310,150]]) {
    await sharp('public/alkarna-logo.png').resize(width,height,{fit:'contain',background:'#ffffff'}).png().toFile(`build/appx/${file}`);
  }
}
// electron-builder invokes Microsoft's MakeAppx pack directly with a .msix
// output path. There is no installer renaming or locally trusted certificate.
// Pass explicit API targets: merging win.target with package.json otherwise
// retains the production NSIS target and its installer identity.
const files=await build({config,targets:Platform.WINDOWS.createTarget(channel==='sandbox'?'zip':'appx',Arch.x64),publish:'never'});
const extension=channel==='sandbox'?'.zip':'.msix';
if(files.length!==1||!files[0].endsWith(extension))throw new Error(`Unexpected ${channel} outputs: ${files.map(file=>basename(file)).join(', ')}`);
for(const file of files) {
  const hash=createHash('sha256').update(await readFile(file)).digest('hex');
  await writeFile(`${file}.sha256`,`${hash} *${basename(file)}\n`);
}
await writeFile(resolve(config.directories.output,'BUILD-INFO.json'),JSON.stringify({
  channel,sourceVersion:pkg.version,packageVersion:`${channel==='sandbox'?pkg.version:pkg.storeVersion}.0`,
  sourceCommit:process.env.GITHUB_SHA||null,storeIdentity:config.appx?{identityName:config.appx.identityName,publisher:config.appx.publisher}:null,
  validationOnly:channel==='store-validation',files:files.map(file=>basename(file)),
  note:channel==='store-validation'?'Unsigned packaging validation only. Not for installation or Store submission.':channel==='store'?'Unsigned Partner Center input. Store signing and certification are pending.':'Local test edition. Starts empty and requires a separate device license. Production data is never imported automatically.',
},null,2)+'\n');
