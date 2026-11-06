const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs');
test('DOM links preserve literal HTML, safe protocols, punctuation and edit drafts; late comments also gain links',async()=>{
 const dom=new JSDOM('<div id="tasks-view"></div>',{runScripts:'outside-only',url:'https://example.test'});try{const w=dom.window;w.eval(fs.readFileSync(__dirname+'/task-text.js','utf8'));const root=w.document.querySelector('div');
 const text='https://example.test/a. github.com/test/repo, synapse.synapsebusiness.ru/cabinet/people.html\n<img src=x onerror=alert(1)> javascript:github.com/test data:text/html,https://bad.test file:https://bad.test';
 const p=w.document.createElement('p');p.textContent=text;root.append(p);w.SbTaskText.decorate(root);
 assert.equal(p.textContent,text);assert.equal(p.querySelectorAll('a').length,3);assert.equal(p.querySelector('a').href,'https://example.test/a');assert.equal(p.querySelector('img'),null);
 const input=w.document.createElement('textarea');input.value='https://example.test/private-draft';root.append(input);w.SbTaskText.decorate(root);assert.equal(input.value,'https://example.test/private-draft');assert.equal(input.querySelector('a'),null);
 const late=w.document.createElement('p');late.textContent='Поздний комментарий github.com/test/repo';root.append(late);await new Promise(w.queueMicrotask);assert.equal(late.querySelectorAll('a').length,1);
 }finally{dom.window.close();}
});
