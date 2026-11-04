import test from 'node:test';
import assert from 'node:assert/strict';
import {requestEditorReplacement} from '../app/editor-replacement.ts';

function editor({documentId=null,dirty=false,active=dirty||documentId!==null}={}){
 const state={documentId,dirty,active,discarded:0};
 return{state,guard:{isEditing:()=>state.active,isDirty:()=>state.dirty,discard:()=>{state.discarded++;state.active=false;state.dirty=false;state.documentId=null;}}};
}
function replacement(current,{accepted=true,pending=false}={}){
 const calls={confirmed:0,pending:0,guardReads:0},state={current,pending};
 return{calls,state,options:{hasPendingCommands:()=>state.pending,getGuard:()=>{calls.guardReads++;return state.current;},confirmDiscard:async()=>{calls.confirmed++;return accepted;},onPending:()=>{calls.pending++;}}};
}

test('new dirty sales and purchases require confirmation despite having no saved invoice ID',async()=>{
 for(const kind of ['sale','purchase'])for(const accepted of [false,true]){
  const draft=editor({dirty:true}),flow=replacement(draft.guard,{accepted});
  assert.equal(await requestEditorReplacement(flow.options),accepted,kind);assert.equal(flow.calls.confirmed,1,kind);assert.equal(draft.state.discarded,accepted?1:0,kind);assert.equal(draft.state.dirty,!accepted,kind);
 }
});

test('dirty saved invoices also require confirmation when reloading the same invoice',async()=>{
 for(const accepted of [false,true]){const saved=editor({documentId:'same-invoice',dirty:true}),flow=replacement(saved.guard,{accepted});assert.equal(await requestEditorReplacement(flow.options),accepted);assert.equal(flow.calls.confirmed,1);assert.equal(saved.state.discarded,accepted?1:0);if(!accepted)assert.equal(saved.state.documentId,'same-invoice');}
});

test('clean saved invoices replace without prompting and an empty new editor is untouched',async()=>{
 const saved=editor({documentId:'existing',dirty:false}),flow=replacement(saved.guard);assert.equal(await requestEditorReplacement(flow.options),true);assert.equal(flow.calls.confirmed,0);assert.equal(saved.state.discarded,1);
 const empty=editor(),blank=replacement(empty.guard);assert.equal(await requestEditorReplacement(blank.options),true);assert.equal(blank.calls.confirmed,0);assert.equal(empty.state.discarded,0);
});

test('pending saves and deletes block before confirmation or discard, including an empty editor',async()=>{
 for(const value of [editor({dirty:true}),editor({documentId:'old',dirty:true}),editor()]){const flow=replacement(value.guard,{pending:true});assert.equal(await requestEditorReplacement(flow.options),false);assert.equal(flow.calls.pending,1);assert.equal(flow.calls.confirmed,0);assert.equal(flow.calls.guardReads,0);assert.equal(value.state.discarded,0);}
});

test('a save starting while confirmation is open prevents a stale acceptance from discarding the draft',async()=>{
 const draft=editor({dirty:true}),flow=replacement(draft.guard);let accept;flow.options.confirmDiscard=()=>new Promise(resolve=>{flow.calls.confirmed++;accept=resolve;});const pending=requestEditorReplacement(flow.options);assert.equal(flow.calls.confirmed,1);flow.state.pending=true;accept(true);assert.equal(await pending,false);assert.equal(flow.calls.pending,1);assert.equal(draft.state.discarded,0);assert.equal(draft.state.dirty,true);
});

test('confirmation uses the current registered guard after a rerender rather than a stale closure',async()=>{
 const old=editor({documentId:'old',dirty:true}),current=editor({documentId:'old',dirty:true}),flow=replacement(old.guard);let accept;flow.options.confirmDiscard=()=>new Promise(resolve=>{accept=resolve;});const pending=requestEditorReplacement(flow.options);flow.state.current=current.guard;accept(true);assert.equal(await pending,true);assert.equal(old.state.discarded,0);assert.equal(current.state.discarded,1);
});

test('the parent edit request and subsequent editor loading do not prompt twice after accepted discard',async()=>{
 const draft=editor({dirty:true}),flow=replacement(draft.guard);assert.equal(await requestEditorReplacement(flow.options),true);assert.equal(flow.calls.confirmed,1);assert.equal(await requestEditorReplacement(flow.options),true);assert.equal(flow.calls.confirmed,1);assert.equal(draft.state.discarded,1);
});

test('cancelled or failed confirmation never clears the editor',async()=>{
 const draft=editor({dirty:true}),flow=replacement(draft.guard);flow.options.confirmDiscard=async()=>{throw new Error('synthetic cancelled dialog');};await assert.rejects(requestEditorReplacement(flow.options),/synthetic cancelled dialog/);assert.equal(draft.state.discarded,0);assert.equal(draft.state.dirty,true);
});
