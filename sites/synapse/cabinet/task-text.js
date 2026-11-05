(() => {
'use strict';
const pattern=/(?:https?:\/\/[^\s<>"']+|(?:github\.com|synapse\.synapsebusiness\.ru)(?:\/[^\s<>"']*)?)/giu;
function fragment(value){
 const text=String(value??''),out=document.createDocumentFragment();let last=0,changed=false;
 for(const match of text.matchAll(pattern)){
   const before=text[match.index-1]||'';
   const suffix=text.slice(match.index+match[0].length);
   if(!/^https?:/i.test(match[0]) && (/^[\p{L}\p{N}_-]/u.test(suffix)||/^\.[\p{L}\p{N}]/u.test(suffix)))continue;
   const tokenPrefix=text.slice(0,match.index).match(/\S*$/u)[0];
   if(/^(?:javascript|data|vbscript|file):/i.test(tokenPrefix))continue;
   // Never extract an apparent host from javascript:, data:, email or another URL.
   if(before && /[\p{L}\p{N}_@:/.-]/u.test(before))continue;
   let display=match[0].replace(/[.,;:!?]+$/u,'');
   while(display.endsWith(')') && (display.match(/\)/g)||[]).length>(display.match(/\(/g)||[]).length)display=display.slice(0,-1);
   display=display.replace(/[\]}>]+$/u,'');
   let url;try{url=new URL(/^https?:/i.test(display)?display:'https://'+display);}catch{continue;}
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname||display.includes('\\'))continue;
   out.append(document.createTextNode(text.slice(last,match.index)));
   const a=document.createElement('a');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';a.textContent=display;out.append(a);
   last=match.index+display.length;changed=true;
 }
 out.append(document.createTextNode(text.slice(last)));return {node:out,changed};
}
function decorate(root){
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];
 while(walker.nextNode())if(!walker.currentNode.parentElement?.closest('a,button,textarea,input,option,select,script,style,[contenteditable]'))nodes.push(walker.currentNode);
 for(const text of nodes){const result=fragment(text.nodeValue);if(result.changed)text.replaceWith(result.node);}
}
const scope='#tasks-view,.tb-board,.tb-overlay';
const observer=new MutationObserver(records=>{
 const roots=new Set();for(const record of records){const parent=record.target.nodeType===1?record.target:record.target.parentElement;
   if(parent?.closest(scope))roots.add(parent);
   for(const node of record.addedNodes)if(node.nodeType===1){if(node.matches(scope))roots.add(node);else node.querySelectorAll?.(scope).forEach(el=>roots.add(el));}
 }for(const root of roots)if(root.isConnected)decorate(root);
});
observer.observe(document.documentElement,{childList:true,subtree:true});
window.SbTaskText=Object.freeze({fragment,decorate});
})();
