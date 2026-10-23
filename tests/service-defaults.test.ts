import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,agentAdmission} from '../tools/service';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(patch:Record<string,unknown>={}){const root=realpathSync(mkdtempSync(join(tmpdir(),'sis-defaults-')));roots.push(root);const c={id:'defaults',db:join(root,'tasks.db'),goal:'g',actor:'worker',stateDir:join(root,'state'),sis:'/bin/true',jobRoot:join(root,'jobs'),...patch},file=join(root,'config.json');writeFileSync(file,JSON.stringify(c));return file;}
test('omitted cost settings default to enabled zero-cost lock and four workers',async()=>{
 const c=await loadConfig(fixture());expect(c.zeroCostLock).toBe(1);expect(c.extraSpendEur).toBe(0);expect(c.providerMode).toBe('local-only');expect(c.maxConcurrent).toBe(4);expect(c.pollMs).toBe(1000);
});
test('disabled or ambiguous locks and nonzero spending fail closed',async()=>{
 for(const patch of[{zeroCostLock:0},{zeroCostLock:false},{zeroCostLock:'1'},{zeroCostLock:null},{extraSpendEur:null},{extraSpendEur:1},{providerMode:'remote'}])await expect(loadConfig(fixture(patch))).rejects.toThrow();
});
test('explicit bounds accept more workers without unlimited fanout',async()=>{
 expect((await loadConfig(fixture({maxConcurrent:8}))).maxConcurrent).toBe(8);expect((await loadConfig(fixture({maxConcurrent:16}))).maxConcurrent).toBe(16);for(const maxConcurrent of[0,17,Infinity])await expect(loadConfig(fixture({maxConcurrent}))).rejects.toThrow();
});
function receipt(){return {source:'mcp__codex_app__get_usage_limits',observedAt:Date.now(),capacity:{ownActive:0,freeSlots:3,ownScopes:[] as string[],foreignScopes:[]},usage:{ordinaryUsageAllowed:true,accountId:'fixture',rateLimits:{limitId:'codex',planType:'pro',spendControlReached:false,rateLimitReachedType:null,credits:{hasCredits:false,unlimited:false,balance:'0'},primary:{usedPercent:41,resetsAt:Math.floor(Date.now()/1000)+3600}}}};}
test('existing host quota previews up to three agents without granting dispatch authority',()=>{const r=agentAdmission(receipt());expect(r.eligible).toBe(true);expect(r.slots).toBe(3);expect(r.remainingPercent).toBe(59);expect(r.dispatchAuthorized).toBe(false);expect(r.requiresLiveHostCheck).toBe(true);});
test('missing/stale quota, paid credits, exhausted reserve and capacity deny agent starts',()=>{
 expect(agentAdmission({}).eligible).toBe(false);let r=receipt();r.observedAt-=300001;expect(agentAdmission(r).reason).toBe('fresh_host_quota_required');r=receipt();r.usage.rateLimits.credits.hasCredits=true;expect(agentAdmission(r).reason).toBe('paid_fallback_not_disabled');r=receipt();r.usage.rateLimits.primary.usedPercent=98;expect(agentAdmission(r).reason).toBe('quota_reserve');r=receipt();r.capacity.freeSlots=0;expect(agentAdmission(r).reason).toBe('capacity_full');r=receipt();r.capacity.ownActive=2;r.capacity.ownScopes=['/private/owned'];expect(agentAdmission(r).slots).toBe(1);
});
