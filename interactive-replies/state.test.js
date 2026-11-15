import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyEvent, validateSpec, parseReply, parseState, MAX_ITEMS, MAX_PER_TURN, MAX_HISTORY, validateReplyAgainstState } from './state.js';
const spec = (extra={})=>({schemaVersion:1,sessionId:'s',turn:1,callId:'c',createdAt:100,title:'Pilot',template:'<div>{{count}}</div>',script:'return {count:1}',...extra});
const result = (value=spec(),seq=1)=>({type:'tool/result',seq,data:{turn:value.turn,message:{role:'tool',toolCallId:value.callId,source:{kind:'tool',callId:value.callId}},meta:{interactiveReply:value}}});
const reply = (value={},seq=2)=>({type:'user/message',seq,data:{role:'user',source:{kind:'user',rpcId:'r'},content:[{type:'text',text:JSON.stringify({kind:'interactive-ui-reply',version:1,sessionId:'s',callId:'c',values:{count:2},summary:'two',...value})}]}});
test('empty state and irrelevant events preserve reference',()=>{const state=createState({id:'s'});assert.equal(applyEvent(state,{type:'step/end',seq:0}),state);assert.equal(parseState(state),state);});
test('successful result durably creates card and duplicate preserves identity',()=>{const state=applyEvent(createState({id:'s'}),result());assert.equal(state.items[0].spec.title,'Pilot');assert.equal(applyEvent(state,result()),state);assert.equal(parseState(state),state);});
test('errors and mismatched call ids never activate code',()=>{const state=createState({id:'s'});const failed=result();failed.data.message.isError=true;assert.equal(applyEvent(state,failed),state);const wrong=result();wrong.data.message.toolCallId='other';assert.equal(applyEvent(state,wrong),state);assert.equal(applyEvent(state,result(spec({schemaVersion:2}))),state);});
test('explicit human submission persists only once',()=>{let state=applyEvent(createState({id:'s'}),result());state=applyEvent(state,reply());assert.deepEqual(state.items[0].submission.values,{count:2});assert.equal(applyEvent(state,reply({values:{count:3}},3)),state);});
test('synthetic agent message or other-session response is ignored',()=>{const state=applyEvent(createState({id:'s'}),result());const fake=reply();fake.data.source.kind='agent';assert.equal(applyEvent(state,fake),state);assert.equal(applyEvent(state,reply({sessionId:'other'})),state);});
test('fork preserves inherited snapshot but rejects cross-session new replies',()=>{let state=createState({id:'child'},3);state=applyEvent(state,result());state=applyEvent(state,reply());assert.equal(state.items[0].submission.summary,'two');assert.equal(applyEvent(state,reply({},4)),state);assert.equal(applyEvent(state,result(spec({callId:'new'}),4)),state);});
test('projection is bounded per turn and across turns',()=>{let state=createState({id:'s'});for(let i=0;i<100;i++)state=applyEvent(state,result(spec({callId:'c'+i}),i));assert.equal(state.items.length,MAX_PER_TURN);for(let i=0;i<100;i++)state=applyEvent(state,result(spec({turn:i+2,callId:'t'+i}),i+100));assert.equal(state.items.length,MAX_ITEMS);parseState(state);});
test('invalid script and input bounds are rejected without evaluation',()=>{assert.equal(validateSpec(spec({script:'x'.repeat(33000)})),null);assert.equal(validateSpec(spec({createdAt:-1})),null);assert.equal(parseReply({...reply().data,content:[{type:'text',text:'not JSON'}]}),null);const bad=reply().data;bad.content[0].text=bad.content[0].text.replace('"values":{"count":2}','"values":1e400');assert.equal(parseReply(bad),null);});

const spec2 = (extra={}) => spec({schemaVersion:2,id:'logical',revision:1,dataVersion:0,anchorTurn:1,data:{rows:[1]},fields:[{name:'count',type:'number',min:0,max:10,required:true}],...extra});
const reply2 = (extra={},seq=2) => reply({version:2,id:'logical',revision:1,...extra},seq);
test('v2 full source snapshots require data, structural revision, anchor and fields',()=>{
  assert.equal(validateSpec(spec2()).id,'logical');
  for(const extra of [{revision:0},{dataVersion:-1},{anchorTurn:2},{data:undefined},{fields:undefined},{fields:[{name:'x',type:'invalid'}]}])assert.equal(validateSpec(spec2(extra)),null);
});
test('v2 data update preserves accepted submission and anchor without resetting draft identity',()=>{
  let state=applyEvent(createState({id:'s'}),result(spec2()));state=applyEvent(state,reply2());
  const accepted=state.items[0].submission;
  state=applyEvent(state,result(spec2({callId:'u',turn:2,dataVersion:1,data:{rows:[2]}}),3));
  assert.equal(state.items.length,1);assert.equal(state.items[0].submission,accepted);assert.equal(state.items[0].spec.anchorTurn,1);assert.equal(state.items[0].spec.dataVersion,1);parseState(state);
});
test('v2 stale structural edits and jumps cannot masquerade as data updates',()=>{
  const state=applyEvent(createState({id:'s'}),result(spec2()));
  for(const extra of [{script:'changed',dataVersion:1},{fields:[],dataVersion:1},{revision:3},{dataVersion:3},{revision:2,dataVersion:1},{anchorTurn:0,dataVersion:1},{createdAt:101,dataVersion:1}])assert.equal(applyEvent(state,result(spec2({callId:'u',...extra}),3)),state);
});
test('v2 replace creates a new revision and keeps previous accepted values in bounded history',()=>{
  let state=applyEvent(createState({id:'s'}),result(spec2()));state=applyEvent(state,reply2());
  state=applyEvent(state,result(spec2({callId:'replace',revision:2,template:'<Form/>',fields:[]}),3));
  assert.equal(state.items[0].submission,null);assert.deepEqual(state.items[0].history,[{revision:1,values:{count:2},summary:'two',seq:2}]);
  assert.equal(applyEvent(state,reply2({},4)),state);parseState(state);
});
test('data-only update accepts previous callId within same logical revision, rejects stale rev/invalid fields',()=>{
  let state=applyEvent(createState({id:'s'}),result(spec2()));state=applyEvent(state,result(spec2({callId:'update',dataVersion:1}),2));
  assert.equal(applyEvent(state,reply2({values:{count:'2'}},3)),state);assert.equal(applyEvent(state,reply2({values:{count:2,unknown:1}},3)),state);
  assert.equal(applyEvent(state,reply2({revision:2},3)),state);state=applyEvent(state,reply2({},3));assert.equal(state.items[0].submission.values.count,2);
});
test('inbox admission locks immediately and preserves snapshot across later replacement and message commit',()=>{
  let state=applyEvent(createState({id:'s'}),result(spec2()));const message=reply2().data;
  state=applyEvent(state,{type:'agent/inbox/spliced',seq:2,data:{target:'next-turn',start:0,inserted:[message]}});
  assert.equal(state.items[0].submission.seq,2);
  state=applyEvent(state,result(spec2({revision:2,callId:'new'}),3));assert.equal(state.items[0].history[0].revision,1);
  assert.equal(applyEvent(state,{type:'user/message',seq:4,data:message}),state);parseState(state);
});
test('revision history stays bounded and ordered',()=>{
  let state=applyEvent(createState({id:'s'}),result(spec2()));let seq=2;
  for(let revision=1;revision<=20;revision++){
    state=applyEvent(state,reply2({revision,callId:'r'+revision},seq++));
    state=applyEvent(state,result(spec2({revision:revision+1,callId:'r'+(revision+1)}),seq++));
  }
  assert.equal(state.items[0].history.length,MAX_HISTORY);assert.equal(state.items[0].history[0].revision,5);parseState(state);
});
test('v2 fork inherits accepted state but cannot receive new foreign live submissions',()=>{
  let state=createState({id:'fork'},3);state=applyEvent(state,result(spec2()));state=applyEvent(state,reply2());
  assert.equal(state.items[0].submission.summary,'two');assert.equal(applyEvent(state,result(spec2({callId:'u',dataVersion:1}),3)),state);
  assert.equal(validateReplyAgainstState(state,JSON.parse(reply2().data.content[0].text)).code,'foreign-session');
});
test('cached parser rejects duplicate logical ids and malformed histories',()=>{
  const item={spec:spec2(),resultSeq:1,submission:null};
  assert.throws(()=>parseState({sessionId:'s',inheritedEventCount:0,items:[item,{...item,spec:spec2({callId:'other'})}]}));
  assert.throws(()=>parseState({sessionId:'s',inheritedEventCount:0,items:[{...item,history:[{revision:1,values:{},summary:'bad',seq:0}]}]}));
});
