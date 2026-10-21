import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import profileModule from '../desktop/profile.cjs';

const profile=profileModule.desktopProfile({isPackaged:false,appData:process.env.APPDATA||join(homedir(),'.config')});
const child=spawn(process.execPath,[join(process.cwd(),'node_modules','next','dist','bin','next'),'dev',...process.argv.slice(2)],{
  stdio:'inherit',windowsHide:true,
  env:{...process.env,NODE_ENV:'development',ALKARNA_USER_DATA:profile.userData,ALKARNA_DATABASE_PATH:profile.databasePath,ALKARNA_LICENSE_STATE_PATH:profile.licenseStatePath,ALKARNA_LICENSE_DISABLE_REGISTRY:'1'},
});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
