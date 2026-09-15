'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createCampaignTransport} = require('./email-campaign-transport');
const environment = {LEADS_SMTP_HOST:'smtp.gmail.com', LEADS_SMTP_PORT:'465',
  LEADS_SMTP_USER:'sender@example.test', LEADS_SMTP_PASSWORD:'SENTINEL_APP_PASSWORD', LEADS_MAIL_FROM:'sender@example.test'};
const message = {to:'subscriber@example.test', subject:'Новости студии', text:'Новый текст рассылки.',
  messageId:'<synapse-campaign-1-contact-2@synapsebusiness.ru>',
  unsubscribeUrl:'https://synapsebusiness.ru/api/unsubscribe/fixture-token', companyCode:'avokado'};
function fixture(env = environment, factory) {
  let current = {...env};
  const connections = [], messages = [];
  const transport = createCampaignTransport({getEnvironment: () => current, createTransport: options => {
    connections.push(options);
    return factory ? factory(options) : {async sendMail(payload) {messages.push(payload);return {accepted:[payload.to]};}};
  }});
  return {transport, connections, messages, replace: value => {current = {...value};}};
}

test('configuration reads never connect and only the three fixed TLS endpoints are enabled', () => {
  for (const host of ['smtp.gmail.com', 'smtp.yandex.ru', 'smtp.mail.ru']) {
    const f = fixture({...environment, LEADS_SMTP_HOST:host});
    assert.equal(f.transport.configured(), true);
    assert.equal(f.transport.sender(), environment.LEADS_MAIL_FROM);
    assert.equal(f.connections.length, 0);
  }
  for (const change of [{LEADS_SMTP_HOST:''}, {LEADS_SMTP_HOST:'smtp-relay.gmail.com'}, {LEADS_SMTP_HOST:'127.0.0.1'},
    {LEADS_SMTP_PORT:'587'}, {LEADS_SMTP_PORT:'465suffix'}, {LEADS_SMTP_USER:''}, {LEADS_SMTP_PASSWORD:''},
    {LEADS_MAIL_FROM:'sender@example.test\r\nBcc: other@example.test'}]) {
    const f = fixture({...environment, ...change});
    assert.equal(f.transport.configured(), false);
    assert.equal(f.transport.sender(), '');
    assert.equal(f.connections.length, 0);
  }
  const f = fixture({...environment, LEADS_MAIL_FROM:''});
  assert.equal(f.transport.sender(), environment.LEADS_SMTP_USER);
});

test('plain text campaigns include a visible unsubscribe footer and fixed one-click headers without accepting caller headers', async () => {
  for (const host of ['smtp.gmail.com', 'smtp.yandex.ru', 'smtp.mail.ru']) {
    const f = fixture({...environment, LEADS_SMTP_HOST:host});
    assert.equal(await f.transport.send({...message, headers:{Bcc:'private@example.test'}, from:'spoof@example.test',
      cc:'private@example.test', html:'<script>never rendered</script>'}), true);
    assert.deepEqual(f.connections[0], {host, port:465, secure:true,
      auth:{user:environment.LEADS_SMTP_USER, pass:environment.LEADS_SMTP_PASSWORD},
      connectionTimeout:15000, greetingTimeout:15000, socketTimeout:30000});
    assert.deepEqual(f.messages[0], {from:environment.LEADS_MAIL_FROM, to:message.to, subject:message.subject,
      text:`${message.text}\n\n---\nОтписаться от рассылки: ${message.unsubscribeUrl}\n`, messageId:message.messageId,
      headers:{'List-Unsubscribe':`<${message.unsubscribeUrl}>`, 'List-Unsubscribe-Post':'List-Unsubscribe=One-Click',
        'List-ID':'<avokado.synapsebusiness.ru>'}});
  }
});

test('unsafe envelope, headers and unsubscribe links are rejected before SMTP is constructed', async () => {
  for (const changes of [{to:'a@example.test,b@example.test'}, {to:'a@example.test\r\nBcc: x@example.test'},
    {subject:'News\r\nBcc: x@example.test'}, {subject:''}, {text:''}, {text:'bad\u0000text'},
    {messageId:'id\r\nBcc: x@example.test'}, {messageId:'<not-an-id>'}, {companyCode:'avokado\r\nX: 1'},
    {companyCode:'../alvi'}, {unsubscribeUrl:'javascript:alert(1)'}, {unsubscribeUrl:'http://example.test/unsubscribe'},
    {unsubscribeUrl:'https://owner:secret@example.test/unsubscribe'}, {unsubscribeUrl:'https://exa\nmple.test/unsubscribe'},
    {unsubscribeUrl:'/unsubscribe'}]) {
    const f = fixture();
    await assert.rejects(f.transport.send({...message, ...changes}), error => error.code === 'SMTP_SEND_FAILED' && !/secret|Bcc/.test(error.message));
    assert.equal(f.connections.length, 0);
  }
  const disabled = fixture({});
  await assert.rejects(disabled.transport.send(message), {code:'SMTP_NOT_CONFIGURED'});
  assert.equal(disabled.connections.length, 0);
});

test('one-character company codes accepted by CRM produce a valid list identifier', async () => {
  const f=fixture();
  assert.equal(await f.transport.send({...message,companyCode:'a'}),true);
  assert.equal(f.messages[0].headers['List-ID'],'<a.synapsebusiness.ru>');
});

test('SMTP responses and credentials never escape through transport failures; a recipient must be accepted', async () => {
  for (const [code, expected] of [['EAUTH','SMTP_AUTH'], ['ETIMEDOUT','SMTP_CONNECTION'], ['PRIVATE_CODE','SMTP_SEND_FAILED']]) {
    const f = fixture(environment, () => ({async sendMail() {
      throw Object.assign(new Error('PRIVATE_SERVER_REPLY SENTINEL_APP_PASSWORD'), {code, response:'private'});
    }}));
    await assert.rejects(f.transport.send(message), error => error.code === expected &&
      !/PRIVATE|SENTINEL|private/.test(JSON.stringify({message:error.message, ...error})) && error.response === undefined);
  }
  for (const result of [undefined, {}, {accepted:[]}, {accepted:['someone-else@example.test']}, {rejected:[message.to]}]) {
    const f = fixture(environment, () => ({async sendMail() {return result;}}));
    await assert.rejects(f.transport.send(message), {code:'EMAIL_RECIPIENT_REJECTED'});
  }
});

test('sender changes affect the next send while an in-flight message retains its own settings', async () => {
  let finish;
  const sends = [];
  const f = fixture(environment, options => ({async sendMail(payload) {
    sends.push({options, payload});
    if (sends.length === 1) return new Promise(resolve => {finish = () => resolve({accepted:[payload.to]});});
    return {accepted:[payload.to]};
  }}));
  const first = f.transport.send(message);
  f.replace({...environment, LEADS_SMTP_HOST:'smtp.yandex.ru', LEADS_SMTP_USER:'next@example.test',
    LEADS_SMTP_PASSWORD:'NEXT_SENTINEL', LEADS_MAIL_FROM:'next@example.test'});
  assert.equal(f.transport.sender(), 'next@example.test');
  assert.equal(f.connections.length, 1, 'reading the new sender still must not construct SMTP');
  assert.equal(await f.transport.send({...message, messageId:'<campaign-next@synapsebusiness.ru>'}), true);
  finish();assert.equal(await first, true);
  assert.equal(sends[0].options.host, 'smtp.gmail.com');
  assert.equal(sends[0].payload.from, 'sender@example.test');
  assert.equal(sends[1].options.host, 'smtp.yandex.ru');
  assert.equal(sends[1].payload.from, 'next@example.test');
});
