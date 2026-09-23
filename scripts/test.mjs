import {readdirSync} from 'node:fs';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const collect=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{const path=join(dir,entry.name);return entry.isDirectory()?collect(path):entry.isFile()&&entry.name.endsWith('.test.mjs')?[path]:[]});
const files=collect('tests').sort();const result=spawnSync(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit',env:{...process.env,NODE_ENV:'test',ALKARNA_TEST_LICENSE_BYPASS:'1'}});process.exit(result.status??1);
