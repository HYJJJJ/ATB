import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpportunityClient} from '../public/opportunity-client.js';
test('none produces no message and hidden/disabled client never starts a request',async()=>{let state={enabled:true,visible:true,account:'alice'},calls=0,replies=[];const c=createOpportunityClient({request:async()=>{calls++;return {action:'none',reply:''};},state:()=>state,onReply:r=>replies.push(r)});await c.poll();assert.equal(calls,1);assert.deepEqual(replies,[]);state.visible=false;await c.poll(true);assert.equal(calls,1);state.visible=true;state.enabled=false;await c.poll(true);assert.equal(calls,1);c.close();});
test('busy availability is posted and late reply after activity/account switch is discarded',async()=>{let resolve;let state={enabled:true,visible:true,busy:true,account:'alice'};let replies=[];const c=createOpportunityClient({request:async(_url,body)=>{assert.equal(body.busy,true);return new Promise(r=>{resolve=r;});},state:()=>state,onReply:r=>replies.push(r)});const p=c.poll();c.cancel();state.account='bob';resolve({reply:'late'});await p;assert.deepEqual(replies,[]);c.close();});

import {backgroundOpportunityState} from '../public/opportunity-client.js';
test('desktop opportunities do not require camera or microphone, but optional face guard never admits a visitor',()=>{
 const base={assistant:{proactiveChat:true},presence:{enabled:false},account:'alice',foregroundBusy:false,voiceActive:false,openingActive:false};
 assert.equal(backgroundOpportunityState(base).enabled,true);assert.equal(backgroundOpportunityState(base).visible,true);
 assert.equal(backgroundOpportunityState({...base,presence:{enabled:true,proactiveEnabled:true},person:{isSelf:false,active:true},matched:true,present:true,fresh:true}).enabled,false);
 assert.equal(backgroundOpportunityState({...base,presence:{enabled:true,proactiveEnabled:true},person:{isSelf:true,active:true},matched:true,present:true,fresh:true}).enabled,true);
 assert.equal(backgroundOpportunityState({...base,foregroundBusy:true}).busy,true);
 assert.equal(backgroundOpportunityState({...base,presence:{enabled:true,proactiveEnabled:true},person:{isSelf:true,active:true},matched:false,present:true,fresh:true}).visible,false);
});
