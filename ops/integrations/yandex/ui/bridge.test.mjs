import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServiceAdapter } from './service-adapter.mjs';
import { buildProfile, createCompanyController, validateBindings } from './ui-state.mjs';

const require = createRequire(import.meta.url);
const { YandexIntegration } = require('../server/index.js');
const { losslessParse } = require('../server/core.js');
const root = fileURLToPath(new URL('.', import.meta.url));
const permissions = ['ads.configure','ads.read','ads.propose','ads.approve','ads.execute'];
const actor = (who, kind = 'human') => ({ id:who,kind,companyIds:['fixture-a','fixture-b'],permissions });

function setup(t) {
  const directory = mkdtempSync(path.join(root,'.test-state-'));
  t.after(() => {
    const relative=path.relative(root,path.resolve(directory));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),'Удаляем только созданную папку внутри ui');
    rmSync(directory,{recursive:true,force:true});
  });
  const now=()=>Date.parse('2026-10-28T12:00:00Z');
  const transport=async (request) => {
    const body=losslessParse(request.body);
    assert.equal(body.method,'get','В bridge тесте нет внешнего update');
    if (request.url.endsWith('/campaigns')) return {status:200,body:{result:{Campaigns:[{Id:'101',Status:'DRAFT',State:'OFF',Type:'UNIFIED_CAMPAIGN',Currency:'RUB'}]}}};
    return {status:200,body:{result:{Ads:[{Id:'1001',CampaignId:'101',AdGroupId:'10001',Type:'RESPONSIVE_AD',Status:'DRAFT',State:'OFF',ResponsiveAd:{Titles:[{Title:'Первый'},{Title:'Второй'}],Texts:[{Text:'Текст 1'},{Text:'Текст 2'}],Href:'https://a.example/'}}]}}};
  };
  const config={directory,now,transport,resolveSecret:async ()=>'synthetic-only'};
  const service=new YandexIntegration(config);
  const dispatch=(currentActor)=>(method,args) => {
    switch(method){
      case 'getCompanyView':return service.getCompanyView(currentActor,args.companyId);
      case 'saveProfile':return service.saveProfile(currentActor,args.profile);
      case 'saveBindings':return service.saveBindings(currentActor,args.companyId,args.binding);
      case 'createProposal':return service.createProposal(currentActor,args.companyId,args.proposal);
      case 'approveProposal':return service.approveProposal(currentActor,args.companyId,args.proposalId,args.digest);
      case 'enqueueProposal':return service.enqueueProposal(currentActor,args.companyId,args.proposalId,args.digest);
      default:throw new Error('UNSUPPORTED_UI_METHOD');
    }
  };
  return {service,config,now,adapter:createServiceAdapter({invoke:dispatch(actor('owner'))}),agentAdapter:createServiceAdapter({invoke:dispatch(actor('agent','agent'))})};
}

test('UI shim проходит onboarding пустой компании и сохраняет профиль без реального OAuth',async (t)=>{
  const f=setup(t);
  const view=await f.adapter.getCompanyView('fixture-a');
  assert.equal(view.capabilities.connection,'unverified');assert.equal(view.policy.totalBudgetMinor,undefined);
  const profile=buildProfile(view.profile,{label:'Учебная A',siteHosts:'a.example',methodologyVersion:'v1',services:'Услуга 1\nУслуга 2',region:'Учебный регион',goalMeaning:'Заявка\nещё не оплата',source:'Учебный бриф',checkedAt:'2026-10-28'});
  const controller=createCompanyController({adapter:f.adapter,companies:[{id:'fixture-a'}]});
  await controller.load('fixture-a');await controller.act('saveProfile',profile);
  assert.equal(controller.getState().uncertain,false,controller.getState().error);
  assert.equal(controller.getState().view.profile.businessFacts.services,'Услуга 1\nУслуга 2');
  assert.equal(controller.getState().view.capabilities.connection,'unverified');
  assert.match(controller.getState().message,/подтверждено повторным чтением/);
});

test('UI shim: импорт, отдельное согласование, durable job и повторное чтение после перезапуска',async(t)=>{
  const f=setup(t);const owner=actor('owner');
  f.service.saveProfile(owner,{companyId:'fixture-a',label:'Учебная A',siteHosts:['a.example'],methodologyVersion:'v1'});
  f.service.registerConnection(owner,{id:'synthetic-connection',principalId:'synthetic-principal',accountId:'synthetic-account',clientLogin:'synthetic-login',secretRef:'synthetic-ref',companyIds:['fixture-a'],active:true,verifiedAt:'2026-10-28T12:00:00Z',quota:{limit:100,windowMs:60000}});
  f.service.saveBindings(owner,'fixture-a',{connectionId:'synthetic-connection',accountId:'synthetic-account',campaignIds:['101'],counterIds:['11']});
  await f.service.importExisting(owner,'fixture-a',{campaignIds:['101'],adIds:['1001']});
  f.service.setPolicy(owner,'fixture-a',{mode:'draft',period:{from:'2026-10-28',to:'2026-11-28',timezone:'Europe/Moscow'},currency:'RUB',maxBudgetMinor:'10000',allocations:[{campaignId:'101',budgetMinor:'10000'}],allowedAdIds:['1001']});
  const view=await f.adapter.getCompanyView('fixture-a');
  const saved=await f.adapter.saveBindings('fixture-a',validateBindings(view,{campaignIds:['101'],counterIds:['11']}));
  assert.equal(saved.outcome,'saved','version не отправляется в строгий серверный контракт');
  await f.agentAdapter.createProposal('fixture-a',{adId:'1001',patch:{Titles:['Уточнённый','Второй'],Texts:['Текст 1','Текст 2']},expiresAt:'2026-10-29T12:00:00Z'});
  const proposal=(await f.adapter.getCompanyView('fixture-a')).proposals[0];
  assert.equal(proposal.canApprove,true);
  assert.equal((await f.agentAdapter.getCompanyView('fixture-a')).proposals[0].canApprove,false);
  const controller=createCompanyController({adapter:f.adapter,companies:[{id:'fixture-a'}]});
  await controller.load('fixture-a');await controller.act('approveProposal',{proposalId:proposal.id,digest:proposal.digest});
  assert.equal(controller.getState().uncertain,false,controller.getState().error);
  await controller.act('enqueueProposal',{proposalId:proposal.id,digest:proposal.digest});
  assert.equal(controller.getState().uncertain,false,controller.getState().error);
  assert.equal(controller.getState().view.jobs[0].status,'queued');
  const restored=new YandexIntegration(f.config).getCompanyView(owner,'fixture-a');
  assert.equal(restored.jobs[0].state,'queued');
  assert.equal(restored.objects.ads[0].ResponsiveAd.Titles[0],'Первый','Постановка в очередь не меняет рекламу');
});

test('сохранение управляемых полей профиля сохраняет прочие ранее записанные бизнес-факты',async(t)=>{
  const f=setup(t);
  f.service.saveProfile(actor('owner'),{companyId:'fixture-a',label:'Учебная A',siteHosts:['a.example'],methodologyVersion:'v1',businessFacts:[{kind:'legacy-offer',value:'Ранее проверенное предложение',source:'Архив',verifiedAt:'2026-10-01T10:00:00Z'}]});
  const view=await f.adapter.getCompanyView('fixture-a');
  const profile=buildProfile(view.profile,{services:'Новая учебная услуга',source:'Учебный бриф',checkedAt:'2026-10-28'});
  await f.adapter.saveProfile('fixture-a',profile);
  const facts=f.service.getCompanyView(actor('owner'),'fixture-a').profile.businessFacts;
  assert.equal(facts.find((fact)=>fact.kind==='legacy-offer').value,'Ранее проверенное предложение');
});
