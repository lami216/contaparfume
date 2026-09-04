import {readdirSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const files=readdirSync('tests').filter(file=>file.endsWith('.test.mjs')).map(file=>`tests/${file}`);const result=spawnSync(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit',env:{...process.env,NODE_ENV:'test',ALKARNA_TEST_LICENSE_BYPASS:'1'}});process.exit(result.status??1);
