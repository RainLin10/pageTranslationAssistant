const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG, CONFIG_KEY, ENABLED_KEY, USAGE_PREFIX, aggregateBuckets } = require('../页面翻译助手.user.js');
const script = fs.readFileSync(path.join(__dirname, '../页面翻译助手.user.js'), 'utf8');

function browserMock() {
  const listeners = new Map();
  window.__gmDispatch = (key, oldValue, value, remote) => {
    for (const callback of listeners.get(key) || []) callback(key, oldValue, value, remote);
  };
  window.GM_getValue = async (key, fallback) => (await window.__gmRead(key)) ?? fallback;
  window.GM_setValue = (key, value) => window.__gmWrite({ key, value });
  window.GM_listValues = () => window.__gmKeys();
  window.GM_addValueChangeListener = (key, callback) => {
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(callback);
  };
  window.GM_registerMenuCommand = (name, callback) => { window.__menu = { name, callback }; };
  window.GM_xmlhttpRequest = details => {
    window.__gmRequest({ url: details.url, headers: details.headers, body: JSON.parse(details.data) }).then(response => {
      if (response.streamChunks) {
        let cancelled = false;
        const stream = new ReadableStream({
          async start(controller) {
            for (const part of response.streamChunks) {
              if (part.delay) await new Promise(resolve => setTimeout(resolve, part.delay));
              if (cancelled) return;
              controller.enqueue(new TextEncoder().encode(part.data));
            }
            if (response.streamError) {
              await new Promise(resolve => setTimeout(resolve, 50));
              if (!cancelled) controller.error(new Error('simulated disconnect'));
            }
            else if (!response.keepOpen) controller.close();
          },
          cancel() { cancelled = true; },
        });
        const value = { status: response.status || 200, response: stream };
        details.onloadstart(value);
        details.onload(value);
        if (response.abortAfter) setTimeout(() => { if (!cancelled) details.onabort(); }, response.abortAfter);
        return;
      }
      if (response.kind === 'timeout') details.ontimeout();
      else if (response.kind === 'error') details.onerror();
      else {
        const value = { status: response.status || 200, responseText: JSON.stringify(response.body) };
        details.onload(value);
        if (response.duplicate) details.onload(value);
      }
    }).catch(() => details.onerror());
    return { abort: () => details.onabort() };
  };
  // Test-only access to the isolated UI, before the production script creates it.
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    const root = attachShadow.call(this, options);
    if (this.hasAttribute('data-pta-ui')) window.__panelRoot = root;
    return root;
  };
}

const dictionary = {
  'Hello world.': '你好，世界。', 'New text': '新内容', 'Folded text': '折叠内容',
  'Expand': '展开', 'Run': '运行', 'Save': '保存', 'Old text': '旧内容',
  'Latest text': '最新内容', 'Frame text': '嵌入页内容', 'Shadow text': '组件内容',
  'Hello, token!': '你好，token！', 'Hello token': '你好 token',
  'Search here': '在此搜索', 'Accessible label': '无障碍标签', 'Image description': '图片说明',
  'Tooltip text': '提示文字', 'click': '点击', 'here': '这里', 'to continue': '继续',
  'Bonjour': 'Bonjour', '你好': '你好',
};
function translate(text) {
  return dictionary[text.trim()] ?? `译文：${text.trim()}`;
}

function modelItems(request) {
  const body = request.body;
  const user = body.messages?.at(-1)?.content ?? body.contents?.[0]?.parts?.[0]?.text;
  return JSON.parse(user).items;
}

function modelReply(request, options = {}) {
  const items = modelItems(request);
  const text = options.text ?? JSON.stringify({ translations: [...items].reverse().map(item => ({
    id: item.id, text: (options.translate || translate)(item.text),
  })) });
  let body;
  if (request.url.endsWith('/messages')) {
    body = { content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 30 } };
  } else if (/:streamGenerateContent|:generateContent/.test(request.url)) {
    body = { candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }, { text }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 40, totalTokenCount: 160 } };
  } else {
    body = { choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
  }
  if (options.noUsage) { delete body.usage; delete body.usageMetadata; }
  return { status: options.status || 200, body, duplicate: options.duplicate };
}

async function setup(browser, options = {}) {
  const context = await browser.newContext();
  const state = options.sharedState || {
    values: new Map([[CONFIG_KEY, { ...DEFAULT_CONFIG, model: 'test-model', apiKey: 'fake-secret', ...options.config }], [ENABLED_KEY, options.enabled === true]]),
    requests: [], errors: [], active: 0, maxActive: 0,
  };
  for (const [key, value] of options.values || []) state.values.set(key, value);
  await context.exposeBinding('__gmRead', (_source, key) => structuredClone(state.values.get(key)));
  await context.exposeBinding('__gmKeys', () => [...state.values.keys()]);
  await context.exposeBinding('__gmWrite', async (source, { key, value }) => {
    const oldValue = state.values.get(key);
    state.values.set(key, structuredClone(value));
    await Promise.all(context.pages().flatMap(page => page.frames().map(frame =>
      frame.evaluate(({ key, oldValue, value, remote }) => window.__gmDispatch?.(key, oldValue, value, remote),
        { key, oldValue, value, remote: frame !== source.frame }).catch(() => {}))));
  });
  await context.exposeBinding('__gmRequest', async (source, request) => {
    request.items = modelItems(request);
    request.frameUrl = source.frame.url();
    request.time = Date.now();
    state.requests.push(request);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      return options.handler ? await options.handler(request, state.requests.length) : modelReply(request);
    } finally { state.active--; }
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const body = options.fixtures?.[url.pathname] ?? options.html ?? '<p id="text">Hello world.</p>';
    await route.fulfill({ status: 200, contentType: 'text/html', headers: options.headers,
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>` });
  });
  await context.addInitScript({ content: `(${browserMock.toString()})();\n${options.beforeScript || ''}\n${script}` });
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto('http://translation.test/main');
  await page.waitForFunction(() => !!window.__panelRoot, null, { timeout: 5000 });
  return { context, page, state, days: () => aggregateBuckets([...state.values].filter(([key]) => key.startsWith(USAGE_PREFIX)).map(([, value]) => value)) };
}

async function clickPanel(page, id) {
  await page.evaluate(id => window.__panelRoot.getElementById(id).click(), id);
}
async function start(page) {
  await page.evaluate(() => {
    const button = window.__panelRoot.getElementById('pause');
    if (button.textContent === '开启翻译') button.click();
  });
}
async function panelText(page, id) {
  return page.evaluate(id => window.__panelRoot.getElementById(id).textContent, id);
}

function streamingReply(request, options = {}) {
  const items = modelItems(request);
  const first = JSON.stringify({ id: items[0].id, text: (options.translate || translate)(items[0].text) });
  const rest = items.slice(1).map(item => JSON.stringify({ id: item.id, text: (options.translate || translate)(item.text) }));
  const initial = '{"translations":[' + first;
  const ending = (rest.length ? ',' + rest.join(',') : '') + ']}';
  const event = body => 'data: ' + JSON.stringify(body) + '\r\n\r\n';
  let beginning;
  let end;
  if (request.url.endsWith('/messages')) {
    beginning = event({ type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 0 } } }) +
      event({ type: 'content_block_delta', delta: { type: 'text_delta', text: initial } });
    end = event({ type: 'content_block_delta', delta: { type: 'text_delta', text: ending } }) +
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }) + event({ type: 'message_stop' });
  } else if (request.url.includes(':streamGenerateContent')) {
    beginning = event({ candidates: [{ content: { parts: [{ text: initial }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } });
    end = event({ candidates: [{ content: { parts: [{ text: ending }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 40, totalTokenCount: 160 } });
  } else {
    beginning = event({ choices: [{ delta: { reasoning_content: 'not a translation' } }] }) + event({ choices: [{ delta: { content: initial } }] });
    end = event({ choices: [{ delta: { content: ending }, finish_reason: 'stop' }] }) +
      event({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) + 'data: [DONE]\r\n\r\n';
  }
  const cut = Math.floor(beginning.length / 2);
  return { streamChunks: [{ data: beginning.slice(0, cut) }, { data: beginning.slice(cut) },
    ...options.interrupted ? [] : [{ data: end, delay: options.delay ?? 700 }]], streamError: options.interrupted, keepOpen: options.keepOpen };
}

module.exports = { setup, start, clickPanel, panelText, modelReply, streamingReply, modelItems, translate };
