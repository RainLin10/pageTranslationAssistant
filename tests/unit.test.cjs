const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CONFIG, USAGE_PREFIX, dayOf, estimateTokens, normalizeUsage, UsageStore,
  configError, buildRequest, responseText, parseTranslations, TranslationAccumulator, EventStream, ModelClient, splitText,
} = require('../页面翻译助手.user.js');

const config = { ...DEFAULT_CONFIG, model: 'test-model', apiKey: 'test-key' };
const items = [{ id: '1', text: 'Hello token', context: 'button: Hello token' }];
const reply = JSON.stringify({ translations: [{ id: '1', text: '你好 token' }] });
function memoryStorage() {
  const data = new Map();
  return {
    data,
    get: async key => structuredClone(data.get(key)),
    set: async (key, value) => { await Promise.resolve(); data.set(key, structuredClone(value)); },
    keys: async () => [...data.keys()],
  };
}

test('北京时间日期归属与 UTC 日期不同，午夜切换正确', () => {
  assert.equal(dayOf(new Date('2026-10-05T15:59:59Z')), '2026-10-05');
  assert.equal(dayOf(new Date('2026-10-05T16:00:00Z')), '2026-10-06');
});

test('估算按 Unicode 字符处理，不把 emoji 拆成两个字符', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcd中文あ가😀'), 6);
  assert.equal(estimateTokens(''), 0);
});

test('OpenAI 缓存和推理已包含在总数内，不再重复累计', () => {
  const usage = normalizeUsage('openai', { usage: {
    prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
    prompt_tokens_details: { cached_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 20 },
  } }, 'ignored', 'ignored');
  assert.deepEqual(usage, {
    input: { value: 100, source: 'actual' }, output: { value: 30, source: 'actual' }, total: { value: 130, source: 'actual' },
  });
});

test('Anthropic 正确累计普通输入、缓存写入和缓存读取', () => {
  const usage = normalizeUsage('anthropic', { usage: {
    input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 30,
  } }, '', '');
  assert.equal(usage.input.value, 100);
  assert.equal(usage.total.value, 130);
});

test('Gemini 输出包含推理，但缓存输入不重复计数', () => {
  const usage = normalizeUsage('gemini', { usageMetadata: {
    promptTokenCount: 100, cachedContentTokenCount: 70, candidatesTokenCount: 20, thoughtsTokenCount: 40, totalTokenCount: 160,
  } }, '', '');
  assert.equal(usage.input.value, 100);
  assert.equal(usage.output.value, 60);
  assert.equal(usage.total.value, 160);
});

test('真实零值保留为 actual；缺失、负数和非数值不能伪装成零', () => {
  const zero = normalizeUsage('openai', { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }, 'hello', null);
  assert.equal(zero.total.source, 'actual');
  assert.equal(zero.total.value, 0);
  const invalid = normalizeUsage('openai', { usage: { prompt_tokens: -1, completion_tokens: '3', total_tokens: NaN } }, 'abcd', null);
  assert.equal(invalid.input.source, 'estimated');
  assert.deepEqual(invalid.output, { value: null, source: 'unknown' });
  assert.deepEqual(invalid.total, { value: null, source: 'unknown' });
});

test('部分 usage 优先实际字段，能从实际总量推导时不估算', () => {
  const derived = normalizeUsage('openai', { usage: { prompt_tokens: 10, total_tokens: 30 } }, 'abcd', 'abcd');
  assert.deepEqual(derived.output, { value: 20, source: 'actual' });
  const partial = normalizeUsage('openai', { usage: { prompt_tokens: 10 } }, 'abcd', 'abcdefgh');
  assert.deepEqual(partial.input, { value: 10, source: 'actual' });
  assert.deepEqual(partial.output, { value: 2, source: 'estimated' });
  assert.deepEqual(partial.total, { value: 12, source: 'estimated' });
  const totalOnly = normalizeUsage('openai', { usage: { total_tokens: 100 } }, 'abcd', 'abcd');
  assert.equal(totalOnly.total.value, 100);
  assert.equal(totalOnly.total.source, 'actual');
});

test('无 usage 时估算全部发送提示词和返回文字；无响应输出仍未知', () => {
  const result = normalizeUsage('openai', null, 'abcd中文', '你好');
  assert.equal(result.input.value, 3);
  assert.equal(result.output.value, 2);
  assert.equal(result.total.value, 5);
  assert.equal(normalizeUsage('openai', null, 'abcd', null).output.source, 'unknown');
});

test('三种协议的端点、认证、系统提示词和响应提取正确', () => {
  const openai = buildRequest(config, items);
  assert.equal(openai.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(openai.headers.Authorization, 'Bearer test-key');
  assert.match(openai.body.messages[0].content, /token/);
  assert.equal(JSON.parse(openai.body.messages[1].content).sourceLanguage, '英语');
  const anthropic = buildRequest({ ...config, provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/' }, items);
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'test-key');
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01');
  assert.equal(anthropic.body.max_tokens, 8192);
  const gemini = buildRequest({ ...config, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }, items);
  assert.equal(gemini.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent?alt=sse');
  assert.equal(gemini.headers['x-goog-api-key'], 'test-key');
  assert.equal(responseText('openai', { choices: [{ message: { content: reply } }] }), reply);
  assert.equal(responseText('anthropic', { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: reply }] }), reply);
  assert.equal(responseText('gemini', { candidates: [{ content: { parts: [{ thought: true, text: 'private' }, { text: reply }] } }] }), reply);
});

test('按编号映射乱序译文，拒绝缺项、重复、多项、空文案和可执行文本', () => {
  const two = [...items, { id: '2', text: 'Goodbye' }];
  const result = parseTranslations('```json\n{"translations":[{"id":"2","text":"再见"},{"id":"1","text":"你好"}]}\n```', two);
  assert.equal(result.get('1'), '你好');
  assert.equal(result.get('2'), '再见');
  for (const text of [
    '{"translations":[]}',
    '{"translations":[{"id":"1","text":"a"},{"id":"1","text":"b"}]}',
    '{"translations":[{"id":"1","text":"a"},{"id":"9","text":"b"}]}',
    '{"translations":[{"id":"1","text":" "},{"id":"2","text":"b"}]}',
    'window.alert("unsafe")',
  ]) assert.throws(() => parseTranslations(text, two));
});

test('超长句切分可无损拼接，保留空白且不截断 surrogate pair', () => {
  const text = '  ' + 'hello world 😀 '.repeat(1000) + '\n';
  const parts = splitText(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 2000);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(part));
    assert.ok(!/[\uD800-\uDBFF]$/.test(part));
  }
});

test('配置校验支持免认证本地服务，拒绝相同语言及非 HTTP 地址', () => {
  assert.equal(configError({ ...config, apiKey: '', baseUrl: 'http://localhost:1234/v1' }), '');
  assert.ok(configError({ ...config, targetLanguage: 'en' }));
  assert.ok(configError({ ...config, baseUrl: 'javascript:alert(1)' }));
  assert.ok(configError({ ...config, model: '' }));
  assert.ok(configError({ ...config, batchSize: 5001 }));
  assert.ok(configError({ ...config, batchCharacters: 1999 }));
});

test('两个运行实例并发写入无丢失，完成替换临时估算且重复 finish 幂等', async () => {
  const storage = memoryStorage();
  const first = new UsageStore(storage, assert.fail, 'first');
  const second = new UsageStore(storage, assert.fail, 'second');
  const usage = normalizeUsage('openai', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, '', '');
  const attempts = Array.from({ length: 100 }, (_, index) => {
    const store = index % 2 ? first : second;
    return { store, attempt: store.begin(config, 'abcd', new Date('2026-10-05T15:59:59Z')) };
  });
  await Promise.all(attempts.map(({ store, attempt }) => store.finish(attempt, usage)));
  await first.finish(attempts[1].attempt, usage);
  const [day] = await second.read();
  assert.equal(day.requests, 100);
  assert.deepEqual(day.actual, { input: 1000, output: 500, total: 1500 });
  assert.deepEqual(day.estimated, { input: 0, output: 0, total: 0 });
  assert.deepEqual(day.unknown, { input: 0, output: 0, total: 0 });
  assert.equal([...storage.data.keys()].filter(key => key.startsWith(USAGE_PREFIX)).length, 2);
  const persisted = JSON.stringify([...storage.data.values()]);
  assert.ok(!persisted.includes('test-key'));
  assert.ok(!persisted.includes('abcd'));
  const reopened = new UsageStore(storage, assert.fail, 'third');
  assert.equal((await reopened.read())[0].actual.total, 1500);
});

test('跨午夜完成仍记到请求发起日，未完成请求持久保留未知输出', async () => {
  const storage = memoryStorage();
  const store = new UsageStore(storage, assert.fail, 'one');
  const old = store.begin(config, 'abcd', new Date('2026-10-05T15:59:59Z'));
  store.begin(config, 'abcdefgh', new Date('2026-10-05T16:00:00Z'));
  await store.finish(old, normalizeUsage('openai', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, '', ''));
  const days = await store.read();
  assert.equal(days[0].day, '2026-10-06');
  assert.equal(days[0].unknown.output, 1);
  assert.equal(days[0].estimated.input, 2);
  assert.equal(days[1].actual.total, 15);
});

test('重复网络回调只计一次；译文 JSON 失败的请求也统计', async () => {
  const storage = memoryStorage();
  const store = new UsageStore(storage, assert.fail, 'model');
  let calls = 0;
  const client = new ModelClient(details => {
    calls++;
    queueMicrotask(() => {
      const response = { status: 200, responseText: JSON.stringify({
        choices: [{ message: { content: calls === 1 ? 'bad json' : reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }) };
      details.onload(response);
      details.onload(response);
    });
    return { abort: () => details.onabort() };
  }, store);
  assert.equal((await client.translate(config, items, new AbortController().signal)).get('1'), '你好 token');
  const [day] = await store.read();
  assert.equal(calls, 2);
  assert.equal(day.requests, 2);
  assert.equal(day.actual.total, 30);
});

test('401 不重试，429 重试一次成功，各次 HTTP 尝试均记账', async () => {
  const store = new UsageStore(memoryStorage(), assert.fail, 'retry');
  let calls = 0;
  const client = new ModelClient(details => {
    const status = ++calls === 1 ? 429 : 200;
    queueMicrotask(() => details.onload({ status, responseText: JSON.stringify({
      choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }) }));
    return { abort: () => details.onabort() };
  }, store);
  await client.translate(config, items, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal((await store.read())[0].actual.total, 30);
  let unauthorizedCalls = 0;
  const unauthorized = new ModelClient(details => {
    unauthorizedCalls++;
    queueMicrotask(() => details.onload({ status: 401, responseText: '{}' }));
    return { abort: () => details.onabort() };
  }, store);
  await assert.rejects(unauthorized.translate(config, items, new AbortController().signal), /认证/);
  assert.equal(unauthorizedCalls, 1);
});

test('取消前未发送的请求不记账；发送后取消与迟到响应不重复统计', async () => {
  const store = new UsageStore(memoryStorage(), assert.fail, 'cancel');
  const before = new AbortController(); before.abort();
  const never = new ModelClient(() => assert.fail('should not send'), store);
  await assert.rejects(never.translate(config, items, before.signal), { name: 'AbortError' });
  assert.equal((await store.read()).length, 0);
  let details;
  const client = new ModelClient(value => { details = value; return { abort: () => value.onabort() }; }, store);
  const controller = new AbortController();
  const request = client.translate(config, items, controller.signal);
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  details.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: reply } }], usage: { total_tokens: 100 } }) });
  const [day] = await store.read();
  assert.equal(day.requests, 1);
  assert.equal(day.actual.total, 0);
  assert.equal(day.unknown.output, 1);
  assert.ok(day.estimated.input > 0);
});

test('GM 未触发 timeout 时自有超时仍会取消请求，并保留未知输出', async () => {
  const storage = memoryStorage();
  const store = new UsageStore(storage, assert.fail, 'timeout');
  let aborted = 0;
  const client = new ModelClient(details => ({ abort: () => { aborted++; details.onabort(); } }), store);
  const nativeTimeout = global.setTimeout;
  global.setTimeout = (callback, milliseconds, ...args) => nativeTimeout(callback, milliseconds === 30000 ? 10 : milliseconds, ...args);
  try {
    await assert.rejects(client.send(config, items, new AbortController().signal), /超时/);
    const [day] = await store.read();
    assert.equal(day.requests, 1);
    assert.equal(day.unknown.output, 1);
    assert.equal(aborted, 1);
  } finally { global.setTimeout = nativeTimeout; }
});

test('增量 JSON 在对象完成时回调，转义引号、括号、换行和 emoji 跨块不破坏解析', () => {
  const values = [{ id: '1', text: '引号 " 与 {括号} \\ 路径 😀\n第二行' }, { id: '2', text: '再见' }];
  const received = [];
  const parser = new TranslationAccumulator([{ id: '1' }, { id: '2' }], (id, text) => received.push({ id, text }));
  const first = '{"translations":[' + JSON.stringify(values[0]);
  for (const character of first) parser.feed(character);
  assert.deepEqual(received, [values[0]]);
  parser.feed(',' + JSON.stringify(values[1]) + ']}');
  assert.deepEqual(received, values);
  assert.throws(() => new TranslationAccumulator([{ id: '1' }], assert.fail).feed('{"translations":[{"id":"wrong","text":"a"}]}'));
});

test('SSE 跨 CRLF 和多行数据解析；OpenAI reasoning 不写入翻译，usage 取最终值', () => {
  const text = [];
  const parser = new EventStream('openai', delta => text.push(delta));
  const source = ': heartbeat\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你好"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"reasoning_content":"ignore"}}]}\r\n\r\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":30,"total_tokens":130}}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const character of source) parser.feed(character);
  assert.equal(parser.end(), '你好');
  assert.deepEqual(text, ['你好']);
  assert.equal(normalizeUsage('openai', parser.body, '', parser.text).total.value, 130);
});

test('Anthropic 累计输出和 Gemini 累计 usage 使用最新值，断流不把暂时零输出当最终用量', () => {
  const event = body => 'data: ' + JSON.stringify(body) + '\n\n';
  const anthropic = new EventStream('anthropic');
  anthropic.feed(event({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 } } }));
  assert.equal(normalizeUsage('anthropic', anthropic.interruptedBody(), '', null).output.source, 'unknown');
  anthropic.feed(event({ type: 'message_delta', usage: { output_tokens: 10 }, delta: {} }));
  anthropic.feed(event({ type: 'message_delta', usage: { output_tokens: 30 }, delta: { stop_reason: 'end_turn' } }));
  assert.equal(normalizeUsage('anthropic', anthropic.body, '', '').total.value, 130);
  const gemini = new EventStream('gemini');
  gemini.feed(event({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 } }));
  assert.equal(normalizeUsage('gemini', gemini.interruptedBody(), '', null).total.source, 'unknown');
  gemini.feed(event({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 40, totalTokenCount: 160 } }));
  assert.equal(normalizeUsage('gemini', gemini.body, '', '').total.value, 160);
});

test('共享上下文只发送一次，输出上限按协议映射，DeepSeek 思考默认关闭', () => {
  const two = [...items, { id: '2', text: 'Goodbye', context: items[0].context }];
  const payload = buildRequest({ ...config, maxOutputTokens: 65536 }, two);
  const data = JSON.parse(payload.body.messages.at(-1).content);
  assert.equal(Object.keys(data.contexts).length, 1);
  assert.equal(data.items[0].contextId, data.items[1].contextId);
  assert.equal(payload.body.stream, true);
  assert.equal(payload.body.stream_options.include_usage, true);
  assert.equal(payload.body.max_completion_tokens, 65536);
  const deepseek = buildRequest({ ...config, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxOutputTokens: 65536 }, two);
  assert.equal(deepseek.body.max_tokens, 65536);
  assert.deepEqual(deepseek.body.thinking, { type: 'disabled' });
  const deepseekAnthropic = buildRequest({ ...config, provider: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' }, two);
  assert.equal(deepseekAnthropic.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.deepEqual(deepseekAnthropic.body.thinking, { type: 'disabled' });
  assert.deepEqual(buildRequest({ ...config, baseUrl: 'https://api.deepseek.com', deepseekThinking: true }, items).body.thinking, { type: 'enabled' });
  assert.equal(buildRequest(config, items).body.thinking, undefined);
  const gemini = buildRequest({ ...config, provider: 'gemini', maxOutputTokens: 65536 }, two);
  assert.equal(gemini.body.generationConfig.maxOutputTokens, 65536);
  const normal = buildRequest({ ...config, streaming: false }, two);
  assert.equal(normal.body.stream, false);
  assert.equal(normal.body.stream_options, undefined);
});

test('真实 ReadableStream 的 UTF-8 字节边界分割可提前回调，并只记一次最终 usage', async () => {
  const store = new UsageStore(memoryStorage(), assert.fail, 'stream');
  const received = [];
  let ended = false;
  const client = new ModelClient(details => {
    const wire = 'data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n';
    const bytes = new TextEncoder().encode(wire);
    const stream = new ReadableStream({ async start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 2) controller.enqueue(bytes.slice(offset, offset + 2));
      await new Promise(resolve => setTimeout(resolve, 20));
      ended = true; controller.close();
    } });
    const response = { status: 200, response: stream };
    queueMicrotask(() => { details.onloadstart(response); details.onload(response); });
    return { abort: () => details.onabort() };
  }, store);
  await client.translate(config, items, new AbortController().signal, (id, text) => {
    assert.equal(ended, false); received.push({ id, text });
  });
  assert.deepEqual(received, [{ id: '1', text: '你好 token' }]);
  const [day] = await store.read();
  assert.equal(day.requests, 1);
  assert.equal(day.actual.total, 15);
});

test('数字编号只在与已请求编号精确对应时接受，完整和增量解析行为一致', () => {
  const text = '{"translations":[{"id":1,"text":"你好 token"}]}';
  assert.equal(parseTranslations(text, items).get('1'), '你好 token');
  const received = [];
  new TranslationAccumulator(items, (id, value) => received.push([id, value])).feed(text);
  assert.deepEqual(received, [['1', '你好 token']]);
  assert.throws(() => parseTranslations('{"translations":[{"id":99,"text":"a"}]}', items));
});

test('三种协议的逻辑结束标记或最终 usage 可以结束流，不要求物理 EOF', () => {
  const event = body => 'data: ' + JSON.stringify(body) + '\n\n';
  const openai = new EventStream('openai');
  openai.feed('data: [DONE]\n\n'); assert.equal(openai.finished, true);
  const usageOnly = new EventStream('openai');
  usageOnly.feed(event({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  assert.equal(usageOnly.finished, true);
  const anthropic = new EventStream('anthropic');
  anthropic.feed(event({ type: 'message_delta', usage: { output_tokens: 30 }, delta: { stop_reason: 'end_turn' } }));
  assert.equal(anthropic.finished, true);
  const gemini = new EventStream('gemini');
  gemini.feed(event({ candidates: [{ finishReason: 'STOP' }] })); assert.equal(gemini.finished, true);
});

test('持续保活但没有生成进展时会自动回收；GM 回调不返回等待流结束的 Promise', async () => {
  const store = new UsageStore(memoryStorage(), assert.fail, 'heartbeat');
  let interval;
  let cancelled = 0;
  const client = new ModelClient(details => {
    const stream = new ReadableStream({
      start(controller) { interval = setInterval(() => controller.enqueue(new TextEncoder().encode(': ping\n\n')), 3); },
      cancel() { cancelled++; clearInterval(interval); },
    });
    queueMicrotask(() => assert.equal(details.onloadstart({ status: 200, response: stream }), undefined));
    return { abort: () => details.onabort() };
  }, store);
  const nativeTimeout = global.setTimeout;
  global.setTimeout = (callback, milliseconds, ...args) => nativeTimeout(callback, milliseconds === 120000 ? 20 : milliseconds, ...args);
  try {
    await assert.rejects(client.send(config, items, new AbortController().signal), /120 秒/);
    assert.equal(cancelled, 1);
    assert.equal((await store.read())[0].unknown.output, 1);
  } finally { global.setTimeout = nativeTimeout; clearInterval(interval); }
});
