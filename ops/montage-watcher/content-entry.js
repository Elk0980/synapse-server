'use strict';
const {createStore}=require('./store'),{createWatcher}=require('./watcher'),{createBudgetedClassifier}=require('./classifier');
const {createCrm,createExecutor}=require('./transport');
function createContentWatcher({db,fallback,crmUrl,crmApiKey,env=process.env,log=()=>{}}){
  if(env.MONTAGE_WATCHER_ENABLED==='0'||!crmApiKey)return {start(){},async stop(){}};
  return createWatcher({store:createStore(db),crm:createCrm({url:crmUrl,key:crmApiKey}),classify:createBudgetedClassifier(fallback),log,
    executor:env.MONTAGE_EXECUTOR_URL?createExecutor({url:env.MONTAGE_EXECUTOR_URL,key:env.MONTAGE_EXECUTOR_KEY||crmApiKey}):null});
}
module.exports={createContentWatcher};
