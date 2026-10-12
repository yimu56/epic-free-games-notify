/**
 * epic-free-games-notify.user.js 的离线测试台
 *
 * 做法：读取用户脚本源码，注入一套 mock 的 GM_* 接口后在 Node 中执行。
 *   - 提供 fixture 的请求回放合成数据，用于精确构造换周、阵容调整等分支；
 *   - 未提供 fixture 的请求走真实网络，验证 Epic 官方接口的可用性与解析逻辑；
 *   - 对 chat-go.jwzhd.com 的请求一律拦截，只记录 payload 并回放成功响应，避免污染真实群聊。
 *
 * 运行：node test/run-test.js
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', 'epic-free-games-notify.user.js');
const STATE_KEY = 'epic_free_games_state';

let passCount = 0;
let failCount = 0;
const logs = [];

function check(name, ok, extra) {
  if (ok) {
    passCount++;
    console.log('  \u2713 ' + name);
  } else {
    failCount++;
    console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function realRequest(opt) {
  return new Promise((resolve, reject) => {
    const u = new URL(opt.url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: opt.method || 'GET',
        headers: opt.headers || {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, responseText: body }));
      }
    );
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    if (opt.data) req.write(opt.data);
    req.end();
  });
}

function patchConfig(code, patches) {
  let out = code;
  for (const key of Object.keys(patches)) {
    const value = patches[key];
    const literal = typeof value === 'string' ? "'" + value + "'" : String(value);
    const re = new RegExp('(' + key + ':\\s*)(\'[^\']*\'|\\d+|true|false)');
    if (!re.test(out)) throw new Error('配置字段未找到：' + key);
    out = out.replace(re, '$1' + literal);
  }
  return out;
}

/* ---------------- 合成数据 ---------------- */

// 构造一个 Epic 接口元素
function game(id, title, cfg) {
  const c = cfg || {};
  const period = (p) =>
    p
      ? [
          {
            promotionalOffers: [
              {
                startDate: p[0],
                endDate: p[1],
                discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 },
              },
            ],
          },
        ]
      : [];

  return {
    title,
    id,
    namespace: 'demo-ns',
    description: c.desc === undefined ? title : c.desc,
    offerType: c.type || 'BASE_GAME',
    productSlug: c.slug || null,
    urlSlug: 'url-' + id,
    seller: { id: 'demo-seller', name: 'Demo Studio' },
    keyImages: [{ type: 'OfferImageWide', url: 'https://cdn.example.com/' + id + '.jpg' }],
    catalogNs: { mappings: [{ pageSlug: c.slug || 'page-' + id, pageType: 'productHome' }] },
    price: {
      totalPrice: {
        discountPrice: 0,
        originalPrice: c.origPrice === undefined ? 5300 : c.origPrice,
        currencyCode: 'CNY',
        fmtPrice: { originalPrice: c.fmtPrice || '¥53.00' },
      },
    },
    promotions: {
      promotionalOffers: period(c.current),
      upcomingPromotionalOffers: period(c.upcoming),
    },
  };
}

const resp = (elements) => ({
  data: {
    Catalog: { searchStore: { elements, paging: { count: elements.length, total: elements.length } } },
  },
  extensions: {},
});

const FIX_PROMO = (elements) => [{ match: 'freeGamesPromotions', body: resp(elements) }];

// 周 A：10-08 ~ 10-15 免费 A1/A2，预告 10-15 ~ 10-22 的 A3；另有一个 ADD_ON 应被过滤
const WEEK_A_START = '2026-10-08T15:00:00.000Z';
const WEEK_A_END = '2026-10-15T15:00:00.000Z';
const WEEK_B_END = '2026-10-22T15:00:00.000Z';
const WEEK_C_END = '2026-10-29T15:00:00.000Z';

const WEEK_A = [
  game('id-a1', '本周游戏甲', { current: [WEEK_A_START, WEEK_A_END], desc: '甲游戏的简介文字' }),
  game('id-a2', '本周游戏乙', { current: [WEEK_A_START, WEEK_A_END] }),
  game('id-a3', '预告游戏丙', { upcoming: [WEEK_A_END, WEEK_B_END] }),
  game('id-dlc', '某游戏季票', { current: [WEEK_A_START, WEEK_A_END], type: 'ADD_ON' }),
];

// 周 B：10-15 ~ 10-22 免费 B1/B2，预告 10-22 ~ 10-29 的 B3
const WEEK_B = [
  game('id-b1', '次周游戏丁', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b2', '次周游戏戊', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b3', '预告游戏己', { upcoming: [WEEK_B_END, WEEK_C_END] }),
];

// 周 B 批次内临时追加一款
const WEEK_B_UPDATED = [
  game('id-b1', '次周游戏丁', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b2', '次周游戏戊', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b4', '追加游戏庚', { current: [WEEK_A_END, WEEK_B_END] }),
  game('id-b3', '预告游戏己', { upcoming: [WEEK_B_END, WEEK_C_END] }),
];

/* ---------------- 执行器 ---------------- */

function run(store, pushCapture, patches, fixtures) {
  const code = patchConfig(fs.readFileSync(SCRIPT_PATH, 'utf8'), patches);
  const requestLog = [];

  const GM_xmlhttpRequest = (opt) => {
    requestLog.push({ url: opt.url, method: opt.method || 'GET', headers: opt.headers || {} });

    if (opt.url.indexOf('https://chat-go.jwzhd.com') === 0) {
      pushCapture.push(JSON.parse(opt.data));
      setTimeout(
        () =>
          opt.onload({
            status: 200,
            responseText: JSON.stringify({ code: 1, data: {}, msg: 'success' }),
          }),
        0
      );
      return;
    }

    const fixture = (fixtures || []).find((f) => opt.url.indexOf(f.match) >= 0);
    if (fixture) {
      const body = typeof fixture.body === 'function' ? fixture.body(opt.url) : fixture.body;
      setTimeout(() => opt.onload({ status: 200, responseText: JSON.stringify(body) }), 0);
      return;
    }

    realRequest(opt).then(
      (r) => opt.onload(r),
      (e) => opt.onerror({ error: e.message })
    );
  };

  const GM_getValue = (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d);
  const GM_setValue = (k, v) => {
    store[k] = v;
  };
  const GM_notification = (o) => logs.push('[通知] ' + o.title + '：' + o.text);
  const GM_log = (t) => logs.push(t);

  const fn = new Function(
    'GM_xmlhttpRequest',
    'GM_getValue',
    'GM_setValue',
    'GM_notification',
    'GM_log',
    code
  );

  return Promise.resolve(
    fn(GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_notification, GM_log)
  ).then((result) => ({ result, requestLog }));
}

/* ---------------- 用例 ---------------- */

(async function main() {
  const PATCH = { YUNHU_TOKEN: 'test-token-abcdef', YUNHU_RECV_ID: '10000001' };

  // ── 场景 1：首次运行 ──
  console.log('\n[场景 1] 首次运行：记录批次但不推送，且过滤非游戏商品');
  const store = {};
  const pushes = [];
  const r1 = await run(store, pushes, PATCH, FIX_PROMO(WEEK_A));
  console.log('  返回：' + r1.result.split('\n').join('\n  '));
  check('未产生推送', pushes.length === 0, '推送数=' + pushes.length);
  check('返回文案说明已记录', /首次运行，已记录/.test(r1.result), r1.result);
  check('记录了本周与预告两个批次', Object.keys((store[STATE_KEY] || {}).batches || {}).length === 2, JSON.stringify(Object.keys((store[STATE_KEY] || {}).batches || {})));
  check('ADD_ON 商品已被过滤', !/某游戏季票/.test(r1.result), r1.result);
  check('状态中记录了商店区域', (store[STATE_KEY] || {}).region === 'zh-CN/CN', String((store[STATE_KEY] || {}).region));

  // ── 场景 2：重复执行 ──
  console.log('\n[场景 2] 数据未变化：不应重复推送');
  const before2 = pushes.length;
  const r2 = await run(store, pushes, PATCH, FIX_PROMO(WEEK_A));
  console.log('  返回：' + r2.result.split('\n').join('\n  '));
  check('未产生推送', pushes.length === before2, '推送数=' + (pushes.length - before2));
  check('返回文案为无变化', (r2.result.match(/无变化/g) || []).length === 2, r2.result);

  // ── 场景 3：换周 ──
  console.log('\n[场景 3] 进入新一周：应推送本周免费与下周预告两条');
  const before3 = pushes.length;
  const r3 = await run(store, pushes, PATCH, FIX_PROMO(WEEK_B));
  console.log('  返回：' + r3.result.split('\n').join('\n  '));
  const batch3 = pushes.slice(before3);
  check('推送了 2 条', batch3.length === 2, '推送数=' + batch3.length);
  check('第一条为本周免费', batch3.length === 2 && /本周免费游戏/.test(batch3[0].content.text), batch3.length === 2 ? batch3[0].content.text.split('\n')[0] : '');
  check('第二条为下周预告', batch3.length === 2 && /下周免费游戏预告/.test(batch3[1].content.text), batch3.length === 2 ? batch3[1].content.text.split('\n')[0] : '');
  check('本周批次含两款游戏', batch3.length === 2 && /次周游戏丁/.test(batch3[0].content.text) && /次周游戏戊/.test(batch3[0].content.text));
  check('消息含商店链接', batch3.length === 2 && /https:\/\/store\.epicgames\.com\/zh-CN\/p\//.test(batch3[0].content.text));
  check('消息含领取入口', batch3.length === 2 && batch3[0].content.text.indexOf('free-games') >= 0);
  check('消息含原价', batch3.length === 2 && batch3[0].content.text.indexOf('¥53.00') >= 0);

  if (batch3.length) {
    console.log('\n  ── 推送到云湖的请求体（第 1 条）──');
    console.log('  ' + JSON.stringify(batch3[0], null, 2).split('\n').join('\n  '));
    check('recvId 正确', batch3[0].recvId === '10000001', String(batch3[0].recvId));
    check('recvType 正确', batch3[0].recvType === 'group', String(batch3[0].recvType));
    check('contentType 为 markdown', batch3[0].contentType === 'markdown', String(batch3[0].contentType));
    const pushReq = r3.requestLog.find((x) => x.url.indexOf('chat-go.jwzhd.com') >= 0);
    check('推送 URL 携带 token', /[?&]token=test-token-abcdef/.test(pushReq.url), pushReq.url);
  }

  // ── 场景 4：换周后再执行 ──
  console.log('\n[场景 4] 换周后再次执行：不应重复推送');
  const before4 = pushes.length;
  const r4 = await run(store, pushes, PATCH, FIX_PROMO(WEEK_B));
  check('未产生推送', pushes.length === before4, '推送数=' + (pushes.length - before4));

  // ── 场景 5：同批次阵容调整 ──
  console.log('\n[场景 5] 同一批次内追加一款游戏：应推送调整提示');
  const before5 = pushes.length;
  const r5 = await run(store, pushes, PATCH, FIX_PROMO(WEEK_B_UPDATED));
  console.log('  返回：' + r5.result.split('\n').join('\n  '));
  const batch5 = pushes.slice(before5);
  check('推送了 1 条', batch5.length === 1, '推送数=' + batch5.length);
  check('正文提示阵容有调整', batch5.length === 1 && /免费阵容有调整/.test(batch5[0].content.text));
  check('正文含追加的游戏', batch5.length === 1 && /追加游戏庚/.test(batch5[0].content.text));

  // ── 场景 6：切换商店区域 ──
  console.log('\n[场景 6] 商店区域变更：应视为首次运行重新记录');
  const otherRegionKey = 'current|' + WEEK_A_START;
  const otherRegionBatches = {};
  otherRegionBatches[otherRegionKey] = { ids: ['x'], pushedAt: 1 };
  store[STATE_KEY] = { region: 'en-US/US', batches: otherRegionBatches };
  const before6 = pushes.length;
  const r6 = await run(store, pushes, PATCH, FIX_PROMO(WEEK_B));
  console.log('  返回：' + r6.result.split('\n').join('\n  '));
  check('未产生推送', pushes.length === before6, '推送数=' + (pushes.length - before6));
  check('返回文案为首次运行记录', /首次运行，已记录/.test(r6.result), r6.result);
  check('区域已更新为当前配置', (store[STATE_KEY] || {}).region === 'zh-CN/CN', String((store[STATE_KEY] || {}).region));

  // ── 场景 7：配置缺失 ──
  console.log('\n[场景 7] 云湖参数缺失：应跳过执行且不发请求');
  const r7 = await run({}, [], { YUNHU_TOKEN: '', YUNHU_RECV_ID: '' }, FIX_PROMO(WEEK_A));
  console.log('  返回：' + r7.result);
  check('提示配置缺失', /配置区未填写/.test(r7.result), r7.result);
  check('未发起任何网络请求', r7.requestLog.length === 0, '请求数=' + r7.requestLog.length);

  // ── 场景 8：真实接口可用性 ──
  console.log('\n[场景 8] 真实网络：验证官方接口可用并正确解析');
  const realStore = {};
  const r8 = await run(realStore, [], PATCH, []);
  console.log('  返回：' + r8.result.split('\n').join('\n  '));
  check('接口请求成功且返回促销数据', /首次运行，已记录|无变化|已推送/.test(r8.result), r8.result);
  const realBatches = Object.keys((realStore[STATE_KEY] || {}).batches || {});
  check('解析出至少一个批次', realBatches.length >= 1, JSON.stringify(realBatches));

  console.log('\n──────────────────────────────');
  console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
  console.log('──────────────────────────────\n');
  process.exit(failCount === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试台异常：', e);
  process.exit(1);
});
