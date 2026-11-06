'use strict';

const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const { endpointOf, validateVapid } = require('./palitra-push.cjs');
const publicV6 = new net.BlockList(); publicV6.addSubnet('2000::', 3, 'ipv6');
const denied = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of [['2001:db8::',32],['2001::',32],['2001:10::',28],['2001:20::',28],['2002::',16]]) denied.addSubnet(ip,bits,'ipv6');
const isPublic = (address) => net.isIP(address) === 4 ? !denied.check(address,'ipv4')
  : net.isIP(address) === 6 && publicV6.check(address,'ipv6') && !denied.check(address,'ipv6');

/* Actual socket DNS lookup: no precheck/re-resolve race, no proxies/redirect follow. */
function guardedLookup(host, authorized, lookup = dns.lookup) {
  return (hostname, options, callback) => {
    if (hostname !== host || authorized() !== true) return callback(Object.assign(new Error('PUSH_LOOKUP_REFUSED'), { code: 'EPERM' }));
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      if (authorized() !== true || !Array.isArray(addresses) || !addresses.length || addresses.length > 32
        || addresses.some((item) => !isPublic(item.address) || item.family !== net.isIP(item.address))) return callback(Object.assign(new Error('PUSH_LOOKUP_REFUSED'), { code: 'EPERM' }));
      const requested = typeof options === 'number' ? options : options?.family;
      const chosen = requested === 4 || requested === 6 ? addresses.filter((item) => item.family === requested) : addresses;
      if (!chosen.length) return callback(Object.assign(new Error('PUSH_LOOKUP_REFUSED'), { code: 'EPERM' }));
      if (options?.all) return callback(null, chosen);
      callback(null, chosen[0].address, chosen[0].family);
    });
  };
}
function createSafeSender({ webpush, vapid, lookup = dns.lookup } = {}) {
  const keys = validateVapid(vapid);
  if (!webpush || typeof webpush.sendNotification !== 'function') throw new TypeError('Pinned web-push transport required');
  return async (subscription, payload, authorized) => {
    const endpoint = endpointOf(subscription.endpoint), host = new URL(endpoint).hostname;
    if (typeof authorized !== 'function' || authorized() !== true) return { stopped: true, statusCode: 0 };
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, lookup: guardedLookup(host, authorized, lookup) });
    try {
      const result = await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 300, urgency: 'normal', timeout: 10000, agent,
      });
      return { statusCode: Number(result?.statusCode) || 0 };
    } catch (error) { return { statusCode: Number(error?.statusCode) || 0 }; }
    finally { agent.destroy(); }
  };
}
module.exports = { createSafeSender, guardedLookup, isPublic };
