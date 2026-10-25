const { test, expect } = require('@playwright/test');
const { setup, start, clickPanel, panelText, modelReply, streamingReply } = require('./helpers.cjs');
const { ENABLED_KEY, USAGE_PREFIX, emptyBucket, dayOf } = require('../页面翻译助手.user.js');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('强制 Trusted Types 且禁止内联样式时，面板仍可显示和操作', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { headers: {
    'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types 'none'; style-src 'none'",
  } });
  expect(await page.evaluate(() => {
    const button = window.__panelRoot.getElementById('launcher');
    return !!button && button.getBoundingClientRect().width === 48 && getComputedStyle(button).backgroundColor === 'rgb(37, 99, 235)';
  })).toBe(true);
  await clickPanel(page, 'launcher');
  expect(await panelText(page, 'status')).toBe('全局翻译已关闭');
  expect(await page.evaluate(() => typeof window.__menu.callback)).toBe('function');
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  expect(state.errors).toEqual([]);
  await context.close();
});

test('网页定义 module.exports 不会误触发 Node 导出而跳过 UI', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { beforeScript: 'window.module = { exports: {} };' });
  await clickPanel(page, 'launcher');
  expect(await panelText(page, 'status')).toBe('全局翻译已关闭');
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  expect(state.errors).toEqual([]);
  await context.close();
});

test('首次默认关闭，保存配置不调用，开启后刷新自动翻译', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { config: { model: '' } });
  await clickPanel(page, 'launcher');
  await page.evaluate(() => {
    const root = window.__panelRoot;
    root.querySelector('[name=model]').value = 'test-model';
    root.getElementById('form').requestSubmit();
  });
  await expect.poll(() => panelText(page, 'message')).toContain('配置已保存');
  await page.waitForTimeout(450);
  expect(state.requests).toHaveLength(0);
  expect(await panelText(page, 'pause')).toBe('开启翻译');
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await page.reload();
  await page.waitForFunction(() => !!window.__panelRoot);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  expect(state.requests).toHaveLength(2);
  expect(state.errors).toEqual([]);
  await context.close();
});

test('用户开启纯中文、数字页面仍不调用模型；代码、编辑区和输入值保持原样', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { html: `
    <p>你好，世界。12345</p><pre>Hello world.</pre><code>Run</code>
    <div contenteditable="true">Hello world.</div><input id="input" value="Hello world.">
    <span translate="no">Hello world.</span><span class="notranslate">Run</span>` });
  await start(page);
  await page.waitForTimeout(500);
  expect(state.requests).toHaveLength(0);
  await expect(page.locator('pre')).toHaveText('Hello world.');
  await expect(page.locator('#input')).toHaveValue('Hello world.');
  await context.close();
});

test('文字和属性按编号回填，保留原节点、空白、事件和非源语言', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { html: `
    <p id="text">  Hello world.  </p><button id="action">Run</button><p id="other">Bonjour</p><p>你好</p>
    <input id="input" value="Do not change" placeholder="Search here" aria-label="Accessible label">
    <div id="tooltip" title="Tooltip text"></div><img id="image" alt="Image description">
    <p id="inline">click <a href="/keep">here</a> to continue</p>
    <script>window.clicked=0;window.savedButton=document.querySelector('#action');window.savedNode=window.savedButton.firstChild;window.savedButton.onclick=()=>window.clicked++;</script>` });
  await start(page);
  await expect(page.locator('#text')).toHaveText('  你好，世界。  ', { useInnerText: false });
  await expect(page.locator('#action')).toHaveText('运行');
  await expect(page.locator('#other')).toHaveText('Bonjour');
  await expect(page.locator('#input')).toHaveAttribute('placeholder', '在此搜索');
  await expect(page.locator('#input')).toHaveAttribute('aria-label', '无障碍标签');
  await expect(page.locator('#input')).toHaveValue('Do not change');
  await expect(page.locator('#tooltip')).toHaveAttribute('title', '提示文字');
  await expect(page.locator('#image')).toHaveAttribute('alt', '图片说明');
  await expect(page.locator('#inline a')).toHaveText('这里');
  await expect(page.locator('#inline a')).toHaveAttribute('href', '/keep');
  await page.locator('#action').click();
  expect(await page.evaluate(() => window.clicked === 1 && window.savedButton.firstChild === window.savedNode)).toBe(true);
  const requests = state.requests.length;
  await page.waitForTimeout(400);
  expect(state.requests).toHaveLength(requests);
  expect(state.errors).toEqual([]);
  await context.close();
});

test('已存在的折叠文字提前翻译，展开时新增文字和 SPA 更新及时处理', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { html: `
    <details id="fold"><summary>Expand</summary><p id="folded">Folded text</p></details>
    <div id="spa"></div>` });
  await start(page);
  await expect(page.locator('#folded')).toHaveText('折叠内容');
  await page.locator('summary').click();
  await page.evaluate(() => {
    const p = document.createElement('p'); p.id = 'new'; p.textContent = 'New text'; document.querySelector('#fold').appendChild(p);
    history.pushState({}, '', '/new-route'); document.querySelector('#spa').textContent = 'Latest text';
  });
  await expect(page.locator('#new')).toHaveText('新内容');
  await expect(page.locator('#spa')).toHaveText('最新内容');
  expect(state.errors).toEqual([]);
  await context.close();
});

test('文字连续变化和迟到响应不会覆盖新文案，重新写回原文可命中本地缓存', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { html: '<p id="text">Old text</p>', handler: async request => {
    await sleep(request.items.some(item => item.text === 'Old text') ? 700 : 20);
    return modelReply(request);
  } });
  await start(page);
  await expect.poll(() => state.requests.length).toBe(1);
  await page.evaluate(() => { document.querySelector('#text').firstChild.data = 'Latest text'; });
  await expect(page.locator('#text')).toHaveText('最新内容');
  await page.waitForTimeout(750);
  await expect(page.locator('#text')).toHaveText('最新内容');
  const count = state.requests.length;
  await page.evaluate(() => { document.querySelector('#text').firstChild.data = 'Latest text'; });
  await expect(page.locator('#text')).toHaveText('最新内容');
  expect(state.requests).toHaveLength(count);
  await context.close();
});

test('持续追加文字的防抖不会无限延后，最终内容完整翻译', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { html: '<p id="text">你好</p>' });
  await start(page);
  await page.evaluate(() => new Promise(resolve => {
    let index = 0;
    const timer = setInterval(() => {
      document.querySelector('#text').firstChild.data = 'Streaming ' + index++;
      if (index === 15) { clearInterval(timer); resolve(); }
    }, 50);
  }));
  expect(state.requests.length).toBeGreaterThan(0);
  await expect(page.locator('#text')).toHaveText('译文：Streaming 14');
  await context.close();
});

test('暂停和恢复原文阻止迟到译文，还原不覆盖网页自行更新的内容', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { html: '<p id="text">Hello world.</p>', handler: async request => {
    await sleep(350); return modelReply(request, { duplicate: true });
  } });
  await start(page);
  await expect.poll(() => state.requests.length).toBe(1);
  await clickPanel(page, 'restore');
  await page.waitForTimeout(500);
  await expect(page.locator('#text')).toHaveText('Hello world.');
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await page.evaluate(() => { document.querySelector('#text').firstChild.data = 'Latest text'; });
  await clickPanel(page, 'restore');
  await page.waitForTimeout(500);
  await expect(page.locator('#text')).toHaveText('Latest text');
  expect(state.requests).toHaveLength(2);
  await context.close();
});

test('删除、复用和重新挂载的节点可再次翻译并正确还原', async ({ browser }) => {
  const { context, page } = await setup(browser);
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await page.evaluate(() => { window.detached = document.querySelector('#text'); window.detached.remove(); });
  await page.waitForTimeout(2200);
  await page.evaluate(() => { document.body.appendChild(window.detached); });
  await page.waitForTimeout(250);
  await clickPanel(page, 'restore');
  await expect(page.locator('#text')).toHaveText('Hello world.');
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await page.evaluate(() => { document.querySelector('#text').firstChild.data = 'New text'; });
  await expect(page.locator('#text')).toHaveText('新内容');
  await context.close();
});

test('open Shadow DOM 含延迟 attach 和嵌套根，开启后动态观察并还原', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { html: '<div id="host"></div>' });
  await start(page);
  await page.evaluate(() => {
    const root = document.querySelector('#host').attachShadow({ mode: 'open' });
    root.innerHTML = '<p id="shadow">Shadow text</p><div id="nested"></div>';
    root.querySelector('#nested').attachShadow({ mode: 'open' }).innerHTML = '<p>New text</p>';
  });
  await expect(page.locator('#shadow')).toHaveText('组件内容');
  await expect(page.locator('#nested p')).toHaveText('新内容');
  await page.evaluate(() => { document.querySelector('#host').shadowRoot.querySelector('#shadow').firstChild.data = 'Latest text'; });
  await expect(page.locator('#shadow')).toHaveText('最新内容');
  await clickPanel(page, 'restore');
  await expect(page.locator('#shadow')).toHaveText('Latest text');
  expect(state.errors).toEqual([]);
  await context.close();
});

test('长段落分批翻译，全部片段完成前不写入半段译文，并发最多两次', async ({ browser }) => {
  const original = Array.from({ length: 700 }, (_, index) => `Long sentence ${index} with unique words. `).join('');
  const { context, page, state } = await setup(browser, { config: { batchCharacters: 16000 }, html: `<p id="text">${original}</p>`, handler: async (request, index) => {
    await sleep(index === 1 ? 10 : 350);
    return modelReply(request, { translate: text => '译文 ' + text });
  } });
  await start(page);
  await expect.poll(() => state.requests.length).toBeGreaterThanOrEqual(2);
  expect(await page.locator('#text').textContent()).toBe(original);
  await expect.poll(() => page.locator('#text').textContent()).toContain('译文');
  expect(state.maxActive).toBeLessThanOrEqual(2);
  expect(state.requests.every(request => request.items.length <= 300)).toBe(true);
  await context.close();
});

test('后台最多一个并发槽，新可见文字优先于隐藏任务', async ({ browser }) => {
  const hidden = Array.from({ length: 65 }, (_, index) => `<p>Hidden ${index}</p>`).join('');
  const { context, page, state } = await setup(browser, { html: `<p id="text">Hello world.</p><div hidden>${hidden}</div>`, handler: async request => {
    await sleep(request.items.some(item => item.text.startsWith('Hidden')) ? 700 : 10);
    return modelReply(request);
  } });
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await page.evaluate(() => { const p = document.createElement('p'); p.id = 'new'; p.textContent = 'New text'; document.body.prepend(p); });
  await expect(page.locator('#new')).toHaveText('新内容');
  expect(state.requests.filter(request => request.items.some(item => item.text.startsWith('Hidden')))).toHaveLength(1);
  expect(state.maxActive).toBeLessThanOrEqual(2);
  await context.close();
});

for (const provider of ['anthropic', 'gemini']) {
  test(`${provider} 原生协议完成 DOM 翻译并累计正确用量`, async ({ browser }) => {
    const { context, page, state, days } = await setup(browser, { config: { provider, baseUrl: provider === 'anthropic'
      ? 'https://api.anthropic.com/v1' : 'https://generativelanguage.googleapis.com/v1beta' } });
    await start(page);
    await expect(page.locator('#text')).toHaveText('你好，世界。');
    expect(days()[0].actual.total).toBe(provider === 'anthropic' ? 130 : 160);
    expect(days()[0].actual.input).toBe(100);
    expect(state.requests).toHaveLength(1);
    await context.close();
  });
}

test('连接测试、格式重试计入用量，模型 HTML 输出不作为 HTML 执行', async ({ browser }) => {
  const { context, page, state, days } = await setup(browser, { handler: async (request, index) =>
    modelReply(request, index === 2 ? { text: 'invalid JSON' } : { translate: () => '<img src=x onerror="window.pwned=true">' }) });
  await clickPanel(page, 'launcher');
  await clickPanel(page, 'test');
  await expect.poll(() => panelText(page, 'message')).toContain('连接成功');
  expect(state.requests).toHaveLength(1);
  await start(page);
  await expect(page.locator('#text')).toHaveText('<img src=x onerror="window.pwned=true">');
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(days()[0].requests).toBe(3);
  expect(days()[0].actual.total).toBe(390);
  await context.close();
});

test('两标签页与跨域 iframe 用量共享、还原联动且刷新后历史保留', async ({ browser }) => {
  const { context, page, state, days } = await setup(browser, { fixtures: {
    '/main': '<p id="text">Hello world.</p><iframe src="http://embedded.test/frame"></iframe>',
    '/frame': '<p id="frameText">Frame text</p>',
    '/second': '<p id="second">New text</p>',
  } });
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await expect(page.frameLocator('iframe').locator('#frameText')).toHaveText('嵌入页内容');
  const second = await context.newPage();
  await second.goto('http://translation.test/second');
  await second.waitForFunction(() => !!window.__panelRoot);
  await start(second);
  await expect(second.locator('#second')).toHaveText('新内容');
  await expect.poll(() => days()[0]?.requests).toBe(3);
  expect(days()[0].actual.total).toBe(390);
  await clickPanel(page, 'restore');
  await expect(page.frameLocator('iframe').locator('#frameText')).toHaveText('Frame text');
  await expect(second.locator('#second')).toHaveText('新内容');
  await page.reload();
  await page.waitForFunction(() => !!window.__panelRoot);
  await clickPanel(page, 'launcher');
  await clickPanel(page, 'usageTab');
  await expect.poll(() => panelText(page, 'usageContent')).toContain('390');
  await expect(page.locator('#text')).toHaveText('Hello world.');
  await expect(page.frameLocator('iframe').locator('#frameText')).toHaveText('Frame text');
  expect(state.requests).toHaveLength(3);
  const serialized = JSON.stringify([...state.values].filter(([key]) => key.startsWith(USAGE_PREFIX)));
  expect(serialized).not.toContain('fake-secret');
  expect(serialized).not.toContain('Hello world');
  await context.close();
});

test('全局开关同步已打开页面、新页面及重新打开浏览器，关闭时所有页面停止处理', async ({ browser }) => {
  const initial = await setup(browser);
  const { context, page, state } = initial;
  const second = await context.newPage();
  await second.goto('http://translation.test/second');
  await second.waitForFunction(() => !!window.__panelRoot);
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await expect(second.locator('#text')).toHaveText('你好，世界。');
  expect(state.values.get(ENABLED_KEY)).toBe(true);
  await expect.poll(() => panelText(second, 'pause')).toBe('关闭翻译');
  const third = await context.newPage();
  await third.goto('http://translation.test/third');
  await expect(third.locator('#text')).toHaveText('你好，世界。');
  await context.close();
  const reopened = await setup(browser, { sharedState: state });
  await expect(reopened.page.locator('#text')).toHaveText('你好，世界。');
  expect(state.requests).toHaveLength(4);
  await clickPanel(reopened.page, 'pause');
  await expect.poll(() => panelText(reopened.page, 'pause')).toBe('开启翻译');
  expect(state.values.get(ENABLED_KEY)).toBe(false);
  const calls = state.requests.length;
  await reopened.page.evaluate(() => { document.querySelector('#text').firstChild.data = 'New text'; });
  await reopened.page.waitForTimeout(450);
  await expect(reopened.page.locator('#text')).toHaveText('New text');
  const closed = await reopened.context.newPage();
  await closed.goto('http://translation.test/fourth');
  await closed.waitForFunction(() => !!window.__panelRoot);
  await closed.waitForTimeout(450);
  await expect(closed.locator('#text')).toHaveText('Hello world.');
  expect(state.requests).toHaveLength(calls);
  await reopened.context.close();
});

test('无 usage 时显示估算，实时刷新保留展开状态，历史每页 30 天', async ({ browser }) => {
  const values = Array.from({ length: 65 }, (_, index) => {
    const day = dayOf(new Date(Date.UTC(2026, 0, index + 1)));
    const row = emptyBucket(day, 'openai', 'history-model');
    row.requests = 1; row.actual = { input: 10, output: 5, total: 15 };
    return [USAGE_PREFIX + 'history-' + index, row];
  });
  const { context, page, days } = await setup(browser, { values, handler: request => modelReply(request, { noUsage: true }) });
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await clickPanel(page, 'launcher');
  await clickPanel(page, 'usageTab');
  await expect.poll(() => panelText(page, 'usageContent')).toContain('估算补充');
  expect(days()[0].actual.total).toBe(0);
  expect(days()[0].estimated.total).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__panelRoot.querySelectorAll('#usageContent > details').length)).toBe(30);
  await page.evaluate(() => { window.__panelRoot.querySelector('#usageContent > details').open = true; });
  await page.waitForTimeout(2300);
  expect(await page.evaluate(() => window.__panelRoot.querySelector('#usageContent > details').open)).toBe(true);
  await page.evaluate(() => window.__panelRoot.querySelector('.pager button:last-child').click());
  await expect.poll(() => panelText(page, 'usageContent')).toContain('2 / 3');
  await context.close();
});

test('面板菜单可打开、密钥默认遮蔽；修改配置使用原文重译，未保存字段不会进入接口', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { handler: request => {
    const language = JSON.parse(request.body.messages.at(-1).content).targetLanguage;
    return modelReply(request, { translate: () => language === '日语' ? 'こんにちは' : '你好，世界。' });
  } });
  await page.evaluate(() => window.__menu.callback());
  expect(await page.evaluate(() => window.__panelRoot.querySelector('[name=apiKey]').type)).toBe('password');
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await page.evaluate(() => {
    const root = window.__panelRoot; root.querySelector('[name=targetLanguage]').value = 'ja'; root.getElementById('form').requestSubmit();
  });
  await expect(page.locator('#text')).toHaveText('こんにちは');
  expect(state.requests[1].items[0].text).toBe('Hello world.');
  await page.evaluate(() => { window.__panelRoot.querySelector('[name=model]').value = 'unsaved-model'; });
  await page.evaluate(() => { document.querySelector('#text').firstChild.data = 'New text'; });
  await expect.poll(() => state.requests.length).toBe(3);
  expect(state.requests[2].body.model).toBe('test-model');
  await context.close();
});

test('认证失败停止剩余任务，修正配置后恢复；关闭开关取消所有标签页中的请求', async ({ browser }) => {
  const { context, page, state } = await setup(browser, {
    config: { model: 'bad-model' },
    html: '<p id="text">Hello world.</p><div hidden>' + Array.from({ length: 50 }, (_, index) => `<p>Hidden ${index}</p>`).join('') + '</div>',
    handler: async request => {
      if (request.body.model === 'bad-model') return { status: 401, body: {} };
      await sleep(500); return modelReply(request);
    },
  });
  await start(page);
  await expect.poll(() => panelText(page, 'status')).toContain('认证失败');
  await page.waitForTimeout(400);
  expect(state.requests.length).toBeLessThanOrEqual(2);
  await page.evaluate(() => {
    window.__panelRoot.querySelector('[name=model]').value = 'test-model';
    window.__panelRoot.getElementById('form').requestSubmit();
  });
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  const second = await context.newPage();
  await second.goto('http://translation.test/second');
  await second.waitForFunction(() => !!window.__panelRoot);
  await expect.poll(() => state.requests.some(request => request.frameUrl.endsWith('/second'))).toBe(true);
  await clickPanel(page, 'pause');
  await expect.poll(() => panelText(second, 'status')).toContain('全局翻译已关闭');
  const calls = state.requests.length;
  await second.evaluate(() => { document.querySelector('#text').firstChild.data = 'Latest text'; });
  await page.waitForTimeout(700);
  await expect(second.locator('#text')).toHaveText('Latest text');
  expect(state.requests).toHaveLength(calls);
  await context.close();
});

test('请求期间属性被移除或节点转为禁止翻译后，重新启用不会遗留卡住的任务', async ({ browser }) => {
  const { context, page, state } = await setup(browser, {
    html: '<div id="label" title="Tooltip text"></div><p id="text">Hello world.</p>',
    handler: async request => { await sleep(250); return modelReply(request); },
  });
  await start(page);
  await expect.poll(() => state.requests.length).toBe(1);
  await page.evaluate(() => {
    document.querySelector('#label').removeAttribute('title');
    document.querySelector('#text').setAttribute('translate', 'no');
  });
  await page.waitForTimeout(350);
  await expect(page.locator('#text')).toHaveText('Hello world.');
  await page.evaluate(() => {
    document.querySelector('#label').setAttribute('title', 'Tooltip text');
    document.querySelector('#text').removeAttribute('translate');
  });
  await expect(page.locator('#label')).toHaveAttribute('title', '提示文字');
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  await expect.poll(() => panelText(page, 'status')).not.toContain('待处理');
  await context.close();
});

for (const provider of ['openai', 'anthropic', 'gemini']) {
  test(`${provider} 流式译文在 HTTP 结束前显示，最终 token 正确累计`, async ({ browser }) => {
    const { context, page, state, days } = await setup(browser, {
      config: { provider }, html: '<p id="first">Hello world.</p><p id="second">New text</p>',
      handler: request => streamingReply(request, { delay: 1500 }),
    });
    await start(page);
    await expect(page.locator('#first')).toHaveText('你好，世界。');
    await expect(page.locator('#second')).toHaveText('New text');
    expect(days()[0].actual.total).toBe(0);
    await expect(page.locator('#second')).toHaveText('新内容');
    await expect.poll(() => days()[0].actual.total).toBe(provider === 'gemini' ? 160 : 130);
    expect(state.requests).toHaveLength(1);
    expect(state.errors).toEqual([]);
    await context.close();
  });
}

test('大批次减少请求；相同上下文的重复文案只发一份，后续新增可命中进行中的请求', async ({ browser }) => {
  const labels = Array.from({ length: 100 }, (_, index) => `<span style="display:block;font-size:1px;line-height:2px">Label ${index}</span>`).join('');
  const large = await setup(browser, { html: '<div>' + labels + '</div>' });
  await start(large.page);
  await expect(large.page.locator('span').last()).toHaveText('译文：Label 99');
  expect(large.state.requests).toHaveLength(1);
  expect(large.state.requests[0].items).toHaveLength(100);
  const data = JSON.parse(large.state.requests[0].body.messages.at(-1).content);
  expect(Object.keys(data.contexts)).toHaveLength(1);
  await large.context.close();
  const small = await setup(browser, { config: { batchSize: 20 }, html: '<div>' + labels + '</div>' });
  await start(small.page);
  await expect(small.page.locator('span').last()).toHaveText('译文：Label 99');
  expect(small.state.requests).toHaveLength(5);
  await small.context.close();
  const duplicate = await setup(browser, {
    html: '<button>Hello world.</button>'.repeat(30),
    handler: async request => { await sleep(400); return modelReply(request); },
  });
  await start(duplicate.page);
  await expect.poll(() => duplicate.state.requests.length).toBe(1);
  await duplicate.page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Hello world.'; document.body.appendChild(button); });
  await expect(duplicate.page.locator('button').last()).toHaveText('你好，世界。');
  expect(duplicate.state.requests).toHaveLength(1);
  expect(duplicate.state.requests[0].items).toHaveLength(1);
  await duplicate.context.close();
});

test('流中断后只重试未完成的编号，关闭全局开关后不回填迟到流式内容', async ({ browser }) => {
  const { context, page, state, days } = await setup(browser, {
    html: '<p id="first">Hello world.</p><p id="second">New text</p>',
    handler: (request, index) => index === 1 ? streamingReply(request, { interrupted: true }) : streamingReply(request, { delay: 700 }),
  });
  await start(page);
  await expect(page.locator('#first')).toHaveText('你好，世界。');
  await expect.poll(() => state.requests.length).toBe(2);
  expect(state.requests[1].items.map(item => item.text)).toEqual(['New text']);
  await expect(page.locator('#second')).toHaveText('新内容');
  await expect.poll(() => days()[0].actual.total).toBe(130);
  expect(days()[0].unknown.output).toBe(1);
  await page.evaluate(() => { document.querySelector('#first').firstChild.data = 'Old text'; document.querySelector('#second').firstChild.data = 'Latest text'; });
  await expect.poll(() => state.requests.length).toBe(3);
  await clickPanel(page, 'pause');
  await page.waitForTimeout(900);
  await expect(page.locator('#second')).toHaveText('Latest text');
  expect(state.requests).toHaveLength(3);
  await context.close();
});

test('面板保存大批次、输出上限、流式及 DeepSeek 思考选项，默认不改模型名称', async ({ browser }) => {
  const { context, page, state } = await setup(browser, { config: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' } });
  await page.evaluate(() => {
    const form = window.__panelRoot.getElementById('form');
    form.elements.batchSize.value = '1000';
    form.elements.batchCharacters.value = '200000';
    form.elements.maxOutputTokens.value = '65536';
    form.elements.streaming.checked = false;
    form.elements.deepseekThinking.checked = true;
    form.requestSubmit();
  });
  await expect.poll(() => panelText(page, 'message')).toContain('配置已保存');
  expect(state.requests).toHaveLength(0);
  await start(page);
  await expect(page.locator('#text')).toHaveText('你好，世界。');
  const body = state.requests[0].body;
  expect(body.model).toBe('deepseek-v4-pro');
  expect(body.stream).toBe(false);
  expect(body.stream_options).toBeUndefined();
  expect(body.max_tokens).toBe(65536);
  expect(body.thinking).toEqual({ type: 'enabled' });
  await context.close();
});

test('SSE 已结束但底层连接没有关闭时，释放并发槽并继续后面的批次', async ({ browser }) => {
  const { context, page, state, days } = await setup(browser, {
    config: { batchSize: 1 }, html: '<p id="first">Hello world.</p><p id="second">New text</p><p id="third">Latest text</p>',
    handler: request => streamingReply(request, { delay: 20, keepOpen: true }),
  });
  await start(page);
  await expect(page.locator('#first')).toHaveText('你好，世界。');
  await expect(page.locator('#second')).toHaveText('新内容');
  await expect(page.locator('#third')).toHaveText('最新内容');
  await expect.poll(() => days()[0]?.actual.total).toBe(390);
  expect(state.requests).toHaveLength(3);
  await context.close();
});

test('中途出现错误编号时立即终止坏流，保留已完成文案并分批补译剩余内容', async ({ browser }) => {
  const { context, page, state } = await setup(browser, {
    html: '<p id="first">Hello world.</p><p id="second">New text</p><p id="third">Latest text</p>',
    handler: (request, index) => {
      if (index > 1) return streamingReply(request, { delay: 20 });
      const data = '{"translations":[' + JSON.stringify({ id: request.items[0].id, text: '你好，世界。' }) + ',{"id":"unexpected","text":"错误编号"}';
      return { streamChunks: [{ data: 'data: ' + JSON.stringify({ choices: [{ delta: { content: data } }] }) + '\n\n' }], keepOpen: true };
    },
  });
  await start(page);
  await expect(page.locator('#first')).toHaveText('你好，世界。');
  await expect(page.locator('#second')).toHaveText('新内容');
  await expect(page.locator('#third')).toHaveText('最新内容');
  expect(state.requests.slice(1).every(request => request.items.every(item => item.text !== 'Hello world.'))).toBe(true);
  await context.close();
});

test('异常大批次自动拆成小批次，已完成的编号不重复发送', async ({ browser }) => {
  const labels = Array.from({ length: 150 }, (_, index) => `<span style="display:block;font-size:1px;line-height:2px">Label ${index}</span>`).join('');
  const { context, page, state } = await setup(browser, {
    html: '<div>' + labels + '</div>',
    handler: (request, index) => {
      if (index > 1) return streamingReply(request, { delay: 20 });
      const data = '{"translations":[' + JSON.stringify({ id: request.items[0].id, text: '译文：Label 0' }) + ',{"id":"bad","text":"错误"}';
      return { streamChunks: [{ data: 'data: ' + JSON.stringify({ choices: [{ delta: { content: data } }] }) + '\n\n' }], keepOpen: true };
    },
  });
  await start(page);
  await expect(page.locator('span').last()).toHaveText('译文：Label 149');
  expect(state.requests[0].items).toHaveLength(150);
  expect(state.requests.slice(1).every(request => request.items.length <= 64 && request.items.every(item => item.text !== 'Label 0'))).toBe(true);
  await expect.poll(() => panelText(page, 'status')).not.toContain('待处理');
  await context.close();
});

test('GM 意外中止请求会自动补译，尚未完成的任务不会永久停留在队列中', async ({ browser }) => {
  const { context, page, state } = await setup(browser, {
    html: '<p id="first">Hello world.</p><p id="second">New text</p>',
    handler: (request, index) => index === 1 ? { ...streamingReply(request, { delay: 10000 }), abortAfter: 50 } : streamingReply(request, { delay: 20 }),
  });
  await start(page);
  await expect(page.locator('#first')).toHaveText('你好，世界。');
  await expect(page.locator('#second')).toHaveText('新内容');
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1].items.map(item => item.text)).toEqual(['New text']);
  await context.close();
});
