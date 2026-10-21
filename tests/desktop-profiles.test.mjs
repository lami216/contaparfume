import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import profileModule from '../desktop/profile.cjs';
import {channelConfig} from '../scripts/desktop-channel-config.mjs';
const {desktopProfile}=profileModule;
const roots={appData:join(tmpdir(),'profile-fixture','roaming'),localAppData:join(tmpdir(),'profile-fixture','local')};

test('existing customer database and licensing locations stay compatible',()=>{
  const profile=desktopProfile({...roots,isPackaged:true});
  assert.equal(profile.channel,'production');
  assert.equal(profile.appId,'mr.alkarna.perfume.desktop');
  assert.equal(profile.databasePath,join(roots.appData,'AlKarna-Perfume','data','alkarna-perfume.sqlite'));
  assert.equal(profile.licenseStatePath,join(roots.localAppData,'PayZone','AlKarna-Perfume-Licensing','state-v2.json'));
});

test('development always selects the test profile, including a production metadata request',()=>{
  for(const channel of [undefined,'production','store','sandbox']) {
    const profile=desktopProfile({...roots,isPackaged:false,channel});
    assert.equal(profile.channel,'sandbox');
    assert.equal(profile.userData,join(roots.appData,'AlKarna-Perfume-Sandbox'));
  }
});

test('packaged channels have distinct data, license state and Windows identities',()=>{
  const channels=['production','sandbox','store','store-validation'];
  const profiles=channels.map(channel=>desktopProfile({...roots,isPackaged:true,channel}));
  for(const field of ['appId','userData','databasePath','licenseStatePath'])assert.equal(new Set(profiles.map(profile=>profile[field])).size,channels.length,field);
  assert.throws(()=>desktopProfile({...roots,isPackaged:true,channel:'typo'}),/Unknown/);
});

test('writing test data, activation and settings leaves a production fixture byte-identical',async()=>{
  const root=await mkdtemp(join(tmpdir(),'alkarna-profile-isolation-'));
  try {
    const paths={appData:join(root,'roaming'),localAppData:join(root,'local'),isPackaged:true};
    const production=desktopProfile(paths),before=new Map();
    const files=profile=>[profile.databasePath,profile.licenseStatePath,join(profile.userData,'config','license.alkarna-license'),join(profile.userData,'printing-settings.json'),join(profile.userData,'Cookies')];
    for(const file of files(production)) {
      const bytes=Buffer.from(`production fixture: ${relative(root,file)}`);
      await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes);before.set(file,bytes);
    }
    for(const channel of ['sandbox','store','store-validation']) {
      const profile=desktopProfile({...paths,channel});
      for(const file of files(profile)) {
        const relativePath=relative(profile.userData,file);
        assert.ok(relativePath&&!relativePath.startsWith('..')&&!isAbsolute(relativePath));
        await assert.rejects(readFile(file),{code:'ENOENT'});
        await mkdir(dirname(file),{recursive:true});await writeFile(file,`test-only ${channel}`);
      }
    }
    for(const [file,bytes] of before)assert.deepEqual(await readFile(file),bytes);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Store packaging refuses missing and validation identities; MSIX uses real Store metadata',()=>{
  assert.throws(()=>channelConfig('store','0.1.9'),/identity is required/);
  const validation=channelConfig('store-validation','0.1.9');
  assert.throws(()=>channelConfig('store','0.1.9',validation.appx),/Validation\/placeholder/);
  const identity={identityName:'12345.TestProduct',publisher:'CN=12345678-1234-1234-1234-123456789abc',publisherDisplayName:'Test Publisher',displayName:'Test Product'};
  const config=channelConfig('store','0.1.9',identity);
  for(const key of Object.keys(identity))assert.equal(config.appx[key],identity[key]);
  assert.equal(config.appx.setBuildNumber,false);
  assert.equal(config.appx.artifactName,'AlKarna-Perfume-Store-${version}-x64.msix');
  assert.deepEqual(config.appx.capabilities,['runFullTrust']);
  assert.deepEqual(config.appx.languages,['ar','fr']);
  assert.equal(config.extraMetadata.alkarnaChannel,'store');
  assert.throws(()=>channelConfig('store','1.2.65536',identity),/65535/);
  assert.throws(()=>channelConfig('store','1.2.3-beta',identity),/numeric/);
});
