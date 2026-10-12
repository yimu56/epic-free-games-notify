// ==UserScript==
// @name         Epic 免费游戏监控 · 云湖机器人推送
// @namespace    https://github.com/yimu56/epic-free-games-notify
// @version      1.0.0
// @description  定时查询 Epic 官方免费游戏接口，发现新的本周免费或下周预告时推送到云湖机器人
// @author       yimu56
// @license      MIT
// @homepageURL  https://github.com/yimu56/epic-free-games-notify
// @supportURL   https://github.com/yimu56/epic-free-games-notify/issues
// @downloadURL  https://raw.githubusercontent.com/yimu56/epic-free-games-notify/main/epic-free-games-notify.user.js
// @updateURL    https://raw.githubusercontent.com/yimu56/epic-free-games-notify/main/epic-free-games-notify.user.js
// @crontab      * 9-23 once * *
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_log
// @connect      store-site-backend-static.ak.epicgames.com
// @connect      chat-go.jwzhd.com
// ==/UserScript==

/*
 * 信息来源
 *   Epic 官方免费游戏促销接口（无需鉴权）：
 *   https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN
 *   该接口同时返回「正在免费」与「即将免费」两批促销，比第三方视频或资讯早一个周期。
 *
 * 工作原理
 *   1. 请求接口，取出 elements 中所有折扣为 100%（即免费）的商品；
 *   2. 按促销开始时间把商品归入「本周免费」与「下周预告」两批，批次标识为 类型 + 开始时间；
 *   3. 与本地记录的批次比对：出现新批次、或同批次内商品发生变化时推送；
 *   4. 推送成功后记录该批次，避免重复推送。
 *
 * 定时策略
 *   @crontab * 9-23 once * *
 *   含义：每天 09:00-23:59 之间首次触发时执行一次，当天只执行一次。
 *   Epic 换周的时间点是北京时间周四 23:00，脚本通常在换周当天的下一个触发点即可发现变化。
 *
 * 注意事项
 *   - Epic 商店网页本身受 Cloudflare 保护，直接抓取网页会返回 403，因此统一走上述官方接口；
 *   - 接口的 country / allowCountries 决定可见商品范围，国区与美区商品存在差异；
 *   - 云湖图片消息只能使用「图片上传」接口返回的 imageKey，无法直接引用外链，
 *     因此默认只推送文字，封面图仅在 CONTENT_TYPE 为 html 且 PUSH_COVER 为 true 时使用外链展示。
 */

/* ==================== 配置区 ==================== */

const CONFIG = {
  // ── 商店区域 ──────────────────────────────────────────────
  // LOCALE 控制语言，COUNTRY 控制可见商品与价格货币
  LOCALE: 'zh-CN',
  COUNTRY: 'CN',

  // ── 云湖机器人 ────────────────────────────────────────────
  // YUNHU_TOKEN    ：云湖控制台中「机器人发送消息链接」的 token 参数
  // YUNHU_RECV_ID  ：接收者 ID，群聊填群号，私聊填用户 ID
  // YUNHU_RECV_TYPE：接收者类型，群聊填 group，私聊填 user
  YUNHU_TOKEN: '',
  YUNHU_RECV_ID: '',
  YUNHU_RECV_TYPE: 'group',

  // ── 推送范围 ──────────────────────────────────────────────
  // 是否推送「本周免费」批次
  PUSH_CURRENT: true,
  // 是否推送「下周预告」批次
  PUSH_UPCOMING: true,
  // 仅推送游戏本体，忽略 DLC、附加内容与礼包
  ONLY_BASE_GAME: true,
  // 是否在消息中附带商品简介
  INCLUDE_DESCRIPTION: true,
  // 简介截断长度
  DESC_MAX_LEN: 200,

  // ── 消息行为 ──────────────────────────────────────────────
  // CONTENT_TYPE：markdown（默认，自动适配深浅色）或 html（支持封面图）
  CONTENT_TYPE: 'markdown',
  // 仅在 CONTENT_TYPE 为 html 时生效，是否输出封面图外链
  PUSH_COVER: false,
  // 首次运行（无历史记录）是否推送当前批次，false 表示只记录不推送
  FIRST_RUN_PUSH: false,
  // 本地保留的批次记录数量上限
  KEEP_BATCHES: 12,
};

/* ================================================ */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TAG = '[Epic免费游戏监控]';
const STATE_KEY = 'epic_free_games_state';
const FREE_GAMES_PAGE = 'https://store.epicgames.com/zh-CN/free-games';

/* ---------------- 基础工具 ---------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gmFetch(opt) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      url: opt.url,
      method: opt.method || 'GET',
      headers: opt.headers || {},
      data: opt.data,
      timeout: opt.timeout || 20000,
      onload: resolve,
      onerror: (e) => reject(new Error('网络错误：' + ((e && e.error) || 'unknown'))),
      ontimeout: () => reject(new Error('请求超时')),
    });
  });
}

// 兼容同步实现（Tampermonkey）与 Promise 实现（ScriptCat）
function gmGet(key, def) {
  return Promise.resolve(GM_getValue(key, def));
}

function gmSet(key, value) {
  return Promise.resolve(GM_setValue(key, value));
}

function log(text) {
  try {
    GM_log(TAG + ' ' + text);
  } catch (e) {
    /* 忽略日志异常 */
  }
}

function notify(title, text) {
  try {
    GM_notification({ title, text, timeout: 6000 });
  } catch (e) {
    /* 忽略通知异常 */
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 接口返回 UTC 时间戳，统一转换为运行环境的本地时间显示
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '');
  return (
    pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  );
}

function truncate(text, max) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max) + '……（简介过长，已截断）';
}

function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 数据解析 ---------------- */

// 从促销分组中取出「折扣 100%（免费）」的那一条
function pickFreeOffer(groups) {
  for (const group of groups || []) {
    for (const offer of (group && group.promotionalOffers) || []) {
      const pct = offer && offer.discountSetting && offer.discountSetting.discountPercentage;
      if (pct === 0) return offer;
    }
  }
  return null;
}

function buildStoreUrl(el) {
  let slug = el.productSlug;
  if (!slug && el.catalogNs && el.catalogNs.mappings && el.catalogNs.mappings.length) {
    slug = el.catalogNs.mappings[0].pageSlug;
  }
  if (!slug) slug = el.urlSlug;
  if (!slug) return FREE_GAMES_PAGE;
  return 'https://store.epicgames.com/' + CONFIG.LOCALE + '/p/' + slug;
}

function pickCover(keyImages) {
  const images = keyImages || [];
  const prefer = ['OfferImageWide', 'Thumbnail', 'OfferImageTall'];
  for (const type of prefer) {
    const hit = images.find((img) => img && img.type === type && img.url);
    if (hit) return hit.url;
  }
  return (images[0] && images[0].url) || '';
}

function buildItem(el, offer, kind) {
  const price = (el.price && el.price.totalPrice) || {};
  const fmt = price.fmtPrice || {};
  const desc = String(el.description || '').trim();

  return {
    kind,
    id: el.id,
    title: el.title || '未知商品',
    // 简介与标题完全相同时视为无有效简介
    description: desc && desc !== el.title ? desc : '',
    seller: (el.seller && el.seller.name) || '',
    offerType: el.offerType || '',
    priceText: fmt.originalPrice || (price.originalPrice ? String(price.originalPrice / 100) : ''),
    currency: price.currencyCode || '',
    startDate: offer.startDate,
    endDate: offer.endDate,
    url: buildStoreUrl(el),
    cover: pickCover(el.keyImages),
  };
}

// 把接口返回的元素拆成带类型的商品列表（kind 为 current 或 upcoming）
function parseBatches(elements) {
  const items = [];

  for (const el of elements || []) {
    if (CONFIG.ONLY_BASE_GAME && el.offerType !== 'BASE_GAME') continue;
    const promo = el.promotions || {};

    const current = pickFreeOffer(promo.promotionalOffers);
    if (current) items.push(buildItem(el, current, 'current'));

    const upcoming = pickFreeOffer(promo.upcomingPromotionalOffers);
    if (upcoming) items.push(buildItem(el, upcoming, 'upcoming'));
  }

  return items;
}

// 批次标识：类型 + 开始时间，同批次内商品变化通过 ids 判断
function toBatches(items) {
  const map = {};
  for (const item of items) {
    const key = item.kind + '|' + item.startDate;
    if (!map[key]) {
      map[key] = {
        kind: item.kind,
        startDate: item.startDate,
        endDate: item.endDate,
        ids: [],
        items: [],
      };
    }
    map[key].ids.push(item.id);
    map[key].items.push(item);
  }
  const list = Object.keys(map).map((k) => {
    map[k].ids.sort();
    map[k].key = k;
    return map[k];
  });
  list.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return list;
}

/* ---------------- 消息构造 ---------------- */

function batchTitle(batch) {
  const range = fmtDateTime(batch.startDate) + ' ~ ' + fmtDateTime(batch.endDate);
  return batch.kind === 'upcoming'
    ? 'Epic 下周免费游戏预告（' + range + '）'
    : 'Epic 本周免费游戏（' + range + '）';
}

function buildMarkdown(batch, isUpdate) {
  const lines = [];
  lines.push('**' + batchTitle(batch) + '**');
  if (isUpdate) lines.push('（免费阵容有调整）');
  lines.push('');

  for (const item of batch.items) {
    lines.push('**《' + item.title + '》**' + (item.priceText ? '　原价 ' + item.priceText : ''));
    lines.push(item.url);
    if (CONFIG.INCLUDE_DESCRIPTION && item.description) {
      lines.push(truncate(item.description, CONFIG.DESC_MAX_LEN));
    }
    lines.push('');
  }

  lines.push('领取入口：' + FREE_GAMES_PAGE);
  return lines.join('\n').trim();
}

function buildHtml(batch, isUpdate) {
  const parts = [];
  parts.push('<p><b>' + esc(batchTitle(batch)) + '</b></p>');
  if (isUpdate) parts.push('<p>（免费阵容有调整）</p>');

  for (const item of batch.items) {
    parts.push('<p><b>《' + esc(item.title) + '》</b>' + (item.priceText ? '　原价 ' + esc(item.priceText) : '') + '</p>');
    if (CONFIG.PUSH_COVER && item.cover) {
      parts.push('<p><img src="' + esc(item.cover) + '" width="360"></p>');
    }
    parts.push('<p><a href="' + esc(item.url) + '">' + esc(item.url) + '</a></p>');
    if (CONFIG.INCLUDE_DESCRIPTION && item.description) {
      parts.push('<p>' + esc(truncate(item.description, CONFIG.DESC_MAX_LEN)) + '</p>');
    }
  }

  parts.push('<p>领取入口：<a href="' + FREE_GAMES_PAGE + '">' + FREE_GAMES_PAGE + '</a></p>');
  return parts.join('');
}

/* ---------------- 网络请求 ---------------- */

async function fetchPromotions() {
  const url =
    'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions' +
    '?locale=' + encodeURIComponent(CONFIG.LOCALE) +
    '&country=' + encodeURIComponent(CONFIG.COUNTRY) +
    '&allowCountries=' + encodeURIComponent(CONFIG.COUNTRY);

  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(1500 * i);
    try {
      const res = await gmFetch({ url, headers: { 'User-Agent': UA } });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      let json;
      try {
        json = JSON.parse(res.responseText);
      } catch (e) {
        throw new Error('响应内容不是合法 JSON');
      }
      const elements =
        json && json.data && json.data.Catalog && json.data.Catalog.searchStore &&
        json.data.Catalog.searchStore.elements;
      if (!elements || !elements.length) throw new Error('接口未返回任何促销数据');
      return elements;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function pushYunhu(text, contentType) {
  const url =
    'https://chat-go.jwzhd.com/open-apis/v1/bot/send?token=' + encodeURIComponent(CONFIG.YUNHU_TOKEN);

  const payload = JSON.stringify({
    recvId: String(CONFIG.YUNHU_RECV_ID),
    recvType: CONFIG.YUNHU_RECV_TYPE,
    contentType,
    content: { text },
  });

  const res = await gmFetch({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    data: payload,
  });

  if (res.status !== 200) throw new Error('云湖接口 HTTP ' + res.status);

  let json;
  try {
    json = JSON.parse(res.responseText);
  } catch (e) {
    throw new Error('云湖接口返回内容不是合法 JSON：' + String(res.responseText).slice(0, 200));
  }
  // 云湖的成功码为 1
  if (json.code !== 1) {
    throw new Error('云湖推送失败 code=' + json.code + (json.msg ? ' ' + json.msg : ''));
  }
  return json;
}

/* ---------------- 主流程 ---------------- */

function pruneBatches(batches) {
  const keys = Object.keys(batches);
  if (keys.length <= CONFIG.KEEP_BATCHES) return batches;
  keys.sort((a, b) => (batches[a].pushedAt || 0) - (batches[b].pushedAt || 0));
  const kept = {};
  for (const k of keys.slice(-CONFIG.KEEP_BATCHES)) kept[k] = batches[k];
  return kept;
}

async function main() {
  const missing = [];
  if (!CONFIG.YUNHU_TOKEN) missing.push('YUNHU_TOKEN');
  if (!CONFIG.YUNHU_RECV_ID) missing.push('YUNHU_RECV_ID');
  if (missing.length) {
    return '配置区未填写 ' + missing.join('、') + '，本次未执行';
  }

  const elements = await fetchPromotions();
  const items = parseBatches(elements);

  const region = CONFIG.LOCALE + '/' + CONFIG.COUNTRY;
  const state = (await gmGet(STATE_KEY, null)) || {};
  // 切换商店区域后，旧的批次记录不再适用，重新开始记录
  const batches = state.region && state.region !== region ? {} : state.batches || {};
  const isFirstRun = Object.keys(batches).length === 0;

  const summary = [];
  let pushCount = 0;

  for (const batch of toBatches(items)) {
    const label = batch.kind === 'upcoming' ? '下周预告' : '本周免费';
    if (batch.kind === 'current' && !CONFIG.PUSH_CURRENT) continue;
    if (batch.kind === 'upcoming' && !CONFIG.PUSH_UPCOMING) continue;

    const prev = batches[batch.key];
    const sameIds = prev && prev.ids && prev.ids.join(',') === batch.ids.join(',');

    if (sameIds) {
      summary.push(label + '（' + batch.items.map((i) => i.title).join('、') + '）无变化');
      continue;
    }

    if (isFirstRun && !CONFIG.FIRST_RUN_PUSH) {
      batches[batch.key] = {
        ids: batch.ids,
        startDate: batch.startDate,
        titles: batch.items.map((i) => i.title),
        pushedAt: Date.now(),
        pushed: false,
      };
      summary.push(label + '（' + batch.items.map((i) => i.title).join('、') + '）首次运行，已记录');
      continue;
    }

    const isUpdate = !!(prev && prev.pushed);
    const contentType = CONFIG.CONTENT_TYPE === 'html' ? 'html' : 'markdown';
    const text =
      contentType === 'html' ? buildHtml(batch, isUpdate) : buildMarkdown(batch, isUpdate);

    if (pushCount > 0) await sleep(800);
    await pushYunhu(text, contentType);
    pushCount++;
    log(label + ' 已推送：' + batch.items.map((i) => i.title).join('、'));

    batches[batch.key] = {
      ids: batch.ids,
      startDate: batch.startDate,
      titles: batch.items.map((i) => i.title),
      pushedAt: Date.now(),
      pushed: true,
    };
    summary.push(label + ' 已推送 ' + batch.items.length + ' 款：' + batch.items.map((i) => i.title).join('、'));
  }

  if (!summary.length) {
    const msg = '接口未返回任何免费游戏促销，本次未推送';
    log(msg);
    return msg;
  }

  await gmSet(STATE_KEY, {
    region: region,
    batches: pruneBatches(batches),
    updatedAt: Date.now(),
  });

  const text = summary.join('\n');
  log(text);
  if (pushCount > 0) notify('Epic 免费游戏监控', summary.filter((s) => s.indexOf('已推送') >= 0).join('\n').slice(0, 200));
  return text;
}

return (async function () {
  try {
    return await main();
  } catch (err) {
    const msg = '执行失败：' + ((err && err.message) || String(err));
    log(msg);
    notify('Epic 免费游戏监控执行失败', msg);
    return msg;
  }
})();
