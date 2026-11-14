import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { normalizeBase, safeRequest } from '../server/model-request.js';

test('streaming model transport returns at headers while retaining DNS pinning and bounded body reads', async () => {
  let incoming;
  const transport = (_url, options, callback) => {
    options.lookup('api.example.com', {}, (err, address) => { assert.equal(err, null); assert.equal(address, '8.8.8.8'); });
    const req = new EventEmitter(); req.write = () => {}; req.destroy = error => incoming.destroy(error);
    req.end = () => { incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-type': 'text/event-stream' }; callback(incoming); };
    return req;
  };
  const response = await safeRequest('https://api.example.com/v1/chat/completions', { stream: true }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], transport });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  incoming.end('first frame'); let text = ''; for await (const chunk of response.body) text += chunk;
  assert.equal(text, 'first frame');
});

test('streaming transport enforces its byte cap and closing a consumed body destroys the request', async () => {
  let incoming, destroyed;
  const transport = (_url, _options, callback) => {
    const req = new EventEmitter(); req.write = () => {};
    req.destroy = error => { destroyed = true; incoming.destroy(error); };
    req.end = () => { incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = {}; callback(incoming); };
    return req;
  };
  const deps = { lookup: async () => [{ address: '8.8.8.8', family: 4 }], transport };
  let response = await safeRequest('https://api.example.com/chat', { stream: true }, deps);
  incoming.end(Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(async () => { for await (const _chunk of response.body) {} }, /响应过大/);
  assert.equal(destroyed, true); destroyed = false;
  response = await safeRequest('https://api.example.com/chat', { stream: true }, deps);
  incoming.write('one'); await response.body.next(); await response.body.return();
  assert.equal(destroyed, true);
});

test('full endpoint URLs normalize to a base and private literal addresses remain blocked', () => {
  assert.equal(normalizeBase('https://api.example.com/v1/chat/completions/'), 'https://api.example.com/v1');
  assert.equal(normalizeBase('https://api.example.com/v1/responses'), 'https://api.example.com/v1');
  for (const url of ['https://127.0.0.1/v1', 'http://example.com/v1', 'https://a:b@example.com/v1', 'https://example.com/v1?key=secret']) assert.throws(() => normalizeBase(url));
});

test('model client pins a public address with the correct Node lookup shape and propagates cancellation', async () => {
  let signal;
  const transport = (_url, options, callback) => {
    signal = options.signal;
    options.lookup('api.example.com', { all: true }, (error, addresses) => {
      assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
    });
    const req = new EventEmitter(); req.write = () => {}; req.destroy = error => { req.emit('error', error); }; req.end = () => {
      const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {};
      callback(res); queueMicrotask(() => { res.emit('data', Buffer.from('{"data":[]}')); res.emit('end'); });
    }; return req;
  };
  const controller = new AbortController();
  const result = await safeRequest('https://api.example.com/v1/models', { signal: controller.signal }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], transport });
  assert.deepEqual(await result.json(), { data: [] }); assert.ok(signal);
});

test('private DNS answers are rejected before opening a socket and DNS is cancellable', async () => {
  const transport = () => { throw Error('must not open a socket'); };
  await assert.rejects(safeRequest('https://api.example.com/models', {}, { lookup: async () => [{ address: '10.0.0.1', family: 4 }], transport }));
  const controller = new AbortController();
  const pending = safeRequest('https://api.example.com/models', { signal: controller.signal }, { lookup: () => new Promise(() => {}), transport });
  controller.abort(); await assert.rejects(pending);
});
