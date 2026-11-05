'use strict';
(()=>{const telegram=window.Telegram?.WebApp,api=window.PalitraMiniappTransport.create({fetch:(url,options)=>window.fetch(url,options),telegram});
 const app=window.PalitraMiniappUI.create({document,window,api,telegram,workflowFactory:window.PalitraWorkflowUI?.create,draftStoreFactory:window.PalitraMiniappDrafts.create,sourceReportFactory:window.PalitraMiniappSourceReport.createSourceReport,sourceLabel:window.PalitraMiniappSourceReport.managerEntrySource});void app.start();
 window.addEventListener('pagehide',()=>app.dispose(),{once:true});})();
