import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {createCommandAdmission,CommandAdmissionError} from '../lib/command-admission.ts';
import {translateApiError} from '../app/i18n/api-errors.ts';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
const request=(signal)=>new Request('http://localhost/api/command',{method:'POST',body:'{}',signal});
const pendingBody=(gate,signal)=>{const value=request(signal);Object.defineProperty(value,'json',{value:()=>gate.promise});return value};
const isStatus=status=>error=>error instanceof CommandAdmissionError&&error.status===status;

test('command admission preserves arrival order before an earlier JSON body completes',async()=>{
 const gate=createCommandAdmission({preflightTimeoutMs:200,queueTimeoutMs:300}),body=deferred(),entered=deferred(),events=[];
 const first=gate(pendingBody(body),async context=>{events.push('first admitted');entered.resolve();await context.readJson();context.assertCanMutate();events.push('purchase committed');return'purchase'});
 await entered.promise;
 const second=gate(request(),async()=>{events.push('sale admitted');return'sale'});
 await turn();assert.deepEqual(events,['first admitted']);body.resolve({type:'purchase.post'});
 assert.deepEqual(await Promise.all([first,second]),['purchase','sale']);assert.deepEqual(events,['first admitted','purchase committed','sale admitted']);
});

test('malformed JSON releases admission without entering a mutation',async()=>{
 const gate=createCommandAdmission(),bad=new Request('http://localhost/api/command',{method:'POST',body:'{'});let writes=0;
 const first=gate(bad,async context=>{await context.readJson();writes++});
 const second=gate(request(),async()=>++writes);
 await assert.rejects(first,SyntaxError);assert.equal(await second,1);
});

test('a body deadline releases the queue and late JSON completion never posts the expired command',async()=>{
 const gate=createCommandAdmission({preflightTimeoutMs:20,queueTimeoutMs:200}),body=deferred();let expiredWrites=0;
 const first=gate(pendingBody(body),async context=>{await context.readJson();expiredWrites++});
 const second=gate(request(),async()=>42);
 await assert.rejects(first,isStatus(408));assert.equal(await second,42);body.resolve({valid:true});await turn();assert.equal(expiredWrites,0);
});

test('JSON parsing that finishes after its deadline cannot outrun the delayed timer callback',async()=>{
 const gate=createCommandAdmission({preflightTimeoutMs:10,queueTimeoutMs:200}),slow=request();let writes=0;
 Object.defineProperty(slow,'json',{value:()=>{const until=performance.now()+25;while(performance.now()<until){}return{valid:true}}});
 await assert.rejects(gate(slow,async context=>{await context.readJson();writes++}),isStatus(408));assert.equal(writes,0);assert.equal(await gate(request(),async()=>5),5);
});

test('aborting a queued middle request cannot let its successor overtake the active command',async()=>{
 const gate=createCommandAdmission({preflightTimeoutMs:100,queueTimeoutMs:300}),active=deferred(),entered=deferred(),controller=new AbortController(),events=[];
 const first=gate(request(),async()=>{events.push('first');entered.resolve();await active.promise;events.push('first committed')});await entered.promise;
 const middle=gate(request(controller.signal),async()=>events.push('canceled mutation'));
 const last=gate(request(),async()=>events.push('last'));controller.abort();
 await assert.rejects(middle,isStatus(408));await turn();assert.deepEqual(events,['first']);active.resolve();await Promise.all([first,last]);assert.deepEqual(events,['first','first committed','last']);
});

test('a queued wait deadline preserves its predecessor barrier and the queue recovers afterwards',async()=>{
 const gate=createCommandAdmission({preflightTimeoutMs:100,queueTimeoutMs:20}),active=deferred(),entered=deferred();let nextStarted=false;
 const first=gate(request(),async()=>{entered.resolve();await active.promise});await entered.promise;
 await assert.rejects(gate(request(),async()=>assert.fail('expired ticket ran')),isStatus(503));
 const last=gate(request(),async()=>{nextStarted=true});await turn();assert.equal(nextStarted,false);active.resolve();await Promise.all([first,last]);assert.equal(nextStarted,true);
});

test('read-only preflight timeout fails closed and releases the following command',async()=>{
 const gate=createCommandAdmission({preflightTimeoutMs:20,queueTimeoutMs:200}),license=deferred();let writes=0;
 const first=gate(request(),async context=>{await context.preflight(license.promise);writes++});const next=gate(request(),async()=>7);
 await assert.rejects(first,isStatus(503));assert.equal(await next,7);license.resolve(null);await turn();assert.equal(writes,0);
});

test('a falsy rejected preflight never becomes a successful authorization result',async()=>{
 const gate=createCommandAdmission();let writes=0;
 await gate(request(),async context=>{await context.preflight(Promise.reject(null));writes++}).then(()=>assert.fail('rejection was swallowed'),error=>assert.equal(error,null));
 assert.equal(writes,0);assert.equal(await gate(request(),async()=>9),9);
});

test('aborting an active body read releases admission and ignores the late body',async()=>{
 const gate=createCommandAdmission({preflightTimeoutMs:200,queueTimeoutMs:300}),body=deferred(),entered=deferred(),controller=new AbortController();let writes=0;
 const first=gate(pendingBody(body,controller.signal),async context=>{entered.resolve();await context.readJson();writes++});await entered.promise;
 const next=gate(request(),async()=>11);controller.abort();await assert.rejects(first,isStatus(408));assert.equal(await next,11);body.resolve({valid:true});await turn();assert.equal(writes,0);
});

test('an abort after parsing is checked before the first transactional write',async()=>{
 const gate=createCommandAdmission(),controller=new AbortController(),parsed=deferred(),continueWork=deferred();let writes=0;
 const first=gate(request(controller.signal),async context=>{await context.readJson();parsed.resolve();await continueWork.promise;context.assertCanMutate();writes++});await parsed.promise;controller.abort();continueWork.resolve();
 await assert.rejects(first,isStatus(408));assert.equal(writes,0);assert.equal(await gate(request(),async()=>13),13);
});

test('the preflight deadline never forcibly releases an already running mutation',async()=>{
 const gate=createCommandAdmission({preflightTimeoutMs:10,queueTimeoutMs:200}),mutation=deferred(),entered=deferred(),events=[];
 const first=gate(request(),async context=>{await context.readJson();context.assertCanMutate();events.push('mutation started');entered.resolve();await mutation.promise;events.push('mutation committed')});await entered.promise;
 const second=gate(request(),async()=>events.push('next'));await delay(25);assert.deepEqual(events,['mutation started']);mutation.resolve();await Promise.all([first,second]);assert.deepEqual(events,['mutation started','mutation committed','next']);
});

test('all public admission errors retain Arabic and have a French translation',()=>{
 for(const message of ['أُلغي طلب العملية قبل الحفظ؛ أعد المحاولة إذا لزم الأمر','تعذر بدء العملية في الوقت المحدد؛ أعد المحاولة','تعذر التحقق من الطلب في الوقت المحدد؛ أعد المحاولة','انتهت مهلة قراءة طلب العملية؛ أعد المحاولة']){assert.equal(translateApiError('ar',message),message);const french=translateApiError('fr',message);assert.notEqual(french,message);assert.notEqual(french,'Une erreur est survenue. Veuillez réessayer.')}
});
