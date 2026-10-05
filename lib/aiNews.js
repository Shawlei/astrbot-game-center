'use strict';
// AI 新闻生成器：调 NewAPI /v1/chat/completions，产出结构化股市事件 JSON（含可选反转剧情）。
// 失败/超时返回 null，由调用方降级到模板文案。
let base = '';
let key = '';
let model = '';
let timeoutMs = 30000;

function init(cfg) {
  base = (cfg && cfg.base ? cfg.base : '').replace(/\/+$/, '');
  key = (cfg && cfg.key) || '';
  model = (cfg && cfg.model) || 'agy-gemini-3.8-flash-high';
  timeoutMs = (cfg && cfg.timeoutMs) || 30000;
}

function ready() {
  return !!(base && key && model);
}

// 从模型输出里容错提取 JSON 对象（剥离 ```json 包裹、取首个 { ... } 平衡块）
function extractJSON(text) {
  if (!text) return null;
  const t = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch (e) { /* ignore */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* ignore */ }
  }
  return null;
}

function clampMag(v, lo, hi) {
  if (!(v >= lo)) v = 0.08;
  if (v > hi) v = hi;
  return v;
}

// 归一化股票代码：trim + 大写 + 补零（SIM3 / sim03 / SIM03 → SIM03），
// 减少 AI 偶发的大小写/前导零不一致导致的匹配失败与静默降级。
function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  let c = raw.trim().toUpperCase();
  const m = c.match(/^SIM(\d{1,2})$/);
  if (m) c = 'SIM' + String(parseInt(m[1], 10)).padStart(2, '0');
  return c;
}

// 规范化并校验事件
function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const code = normalizeCode(ev.code);
  const headline = typeof ev.headline === 'string' ? ev.headline.trim() : '';
  const detail = typeof ev.detail === 'string' ? ev.detail.trim() : '';
  if (!code || !headline) return null;
  const direction = ev.direction === 'bad' ? 'bad' : 'good';
  const out = {
    code,
    headline,
    detail: detail || headline,
    direction,
    magnitude: clampMag(parseFloat(ev.magnitude), 0.06, 0.10),
    sector: typeof ev.sector === 'string' ? ev.sector.trim() : '',
  };
  // 后续新闻（方向与主事件独立随机，可同向延续、可反向反转）
  if (ev.followup && typeof ev.followup === 'object') {
    const fh = typeof ev.followup.headline === 'string' ? ev.followup.headline.trim() : '';
    if (fh) {
      let delayHours = parseFloat(ev.followup.delayHours);
      if (!(delayHours >= 1)) delayHours = 5;
      if (delayHours > 24) delayHours = 24;
      out.followup = {
        delayHours,
        headline: fh,
        detail: typeof ev.followup.detail === 'string' ? ev.followup.detail.trim() : fh,
        direction: ev.followup.direction === 'bad' ? 'bad' : 'good',
        magnitude: clampMag(parseFloat(ev.followup.magnitude), 0.06, 0.10),
      };
    }
  }
  return out;
}

// 生成一条事件。stocks: [{code,name,sector,price,changePct}]
async function generate(stocks) {
  if (!ready()) return null;
  const stockLines = stocks.map((s) =>
    `${s.code} ${s.name}（${s.sector}）现价 ${s.price}，涨跌 ${s.changePct >= 0 ? '+' : ''}${s.changePct}%`
  ).join('\n');

  const prompt = `你是模拟股市的新闻编剧。以下是当前 10 只虚拟股票的盘面：
${stockLines}

请随机选择其中一只股票，编写一条具体、有戏剧性的「公司事件新闻」，就像真实的财经新闻一样。要求：
1. code 必须从上面对应的股票代码里原样复制（如 SIM03），禁止编造或改写。
2. 事件要具体（涉及产品发布/订单/财报/研发突破/监管/战略合作/人事变动等），不要泛泛而谈。
3. headline 是简洁的新闻标题，像真实新闻标题那样客观陈述「某公司发生了什么」，不要出现「利好」「利空」这类字眼。
4. detail 是完整新闻正文（3~5 句话，像新闻通稿，交代事件来龙去脉）。
5. direction 随机为 good（利多，推动股价上涨）或 bad（利空，推动股价下跌），不要刻意交替，纯随机。
6. magnitude 取 0.06~0.10 之间的随机正数，事件强度越大越接近涨跌停。

此外，随机决定（约一半概率）是否附带一条「后续新闻」：几小时后（1~24 小时）再出现一条关于该公司的新闻。后续新闻的方向与主事件完全独立随机——可能是反转（好变坏 / 坏变好），也可能同向延续，也可能是无关的另一个事件，不要刻意配对。

只输出一个 JSON 对象，不要任何解释，不要 markdown 代码块，格式：
{"code":"股票代码","headline":"新闻标题","detail":"完整新闻正文","direction":"good 或 bad","magnitude":0.08,"sector":"该股板块","followup":{"delayHours":5,"headline":"后续新闻标题","detail":"后续新闻正文","direction":"good 或 bad","magnitude":0.08}}

若不带后续新闻，则省略 followup 字段。`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.0,
        // 推理模型会先消耗大量 token 在思考过程上，须给足预算，否则 JSON 答案被截断
        max_tokens: 4000,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = await resp.json();
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return normalizeEvent(extractJSON(content));
  } catch (e) {
    return null;
  }
}

// ---- AI 全驱动：一次性产出「市场情绪 + 舆论 + 每只股票走势目标 + 新闻」 ----
// stocks: [{code,name,sector,price,prevClose,changePct,t0,limitPct}]
// 返回 { sentiment:{overall,sectors:{}}, narrative, stocks:[{code,targetPct}], news:[normalizedEvent...] }
// 失败/超时返回 null，由调用方降级到确定性随机模型。

function clampSentiment(v) {
  if (!(v >= -1)) v = 0;
  if (v > 1) v = 1;
  if (v < -1) v = -1;
  return v;
}

function normalizeEconomy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { sentiment: { overall: 0, sectors: {} }, narrative: '', stocks: [], news: [] };
  const s = raw.sentiment && typeof raw.sentiment === 'object' ? raw.sentiment : {};
  out.sentiment.overall = clampSentiment(parseFloat(s.overall));
  if (s.sectors && typeof s.sectors === 'object') {
    for (const k of Object.keys(s.sectors)) out.sentiment.sectors[k] = clampSentiment(parseFloat(s.sectors[k]));
  }
  if (typeof raw.narrative === 'string') out.narrative = raw.narrative.trim().slice(0, 400);
  const stocks = Array.isArray(raw.stocks) ? raw.stocks : [];
  for (const it of stocks) {
    if (!it || typeof it !== 'object') continue;
    const code = normalizeCode(it.code);
    if (!code) continue;
    const tp = parseFloat(it.targetPct);
    if (!Number.isFinite(tp)) continue;
    // 可选封板决策：up=封涨停、down=封跌停（AI 全驱动下由 AI 决定谁封板/炸板）
    const lock = it.lock === 'up' || it.lock === 'down' ? it.lock : null;
    out.stocks.push({ code, targetPct: Math.max(-20, Math.min(20, tp)), lock });
  }
  const news = Array.isArray(raw.news) ? raw.news : [];
  for (const ev of news) {
    const ne = normalizeEvent(ev);
    if (ne) out.news.push(ne);
  }
  // 至少有一项有效产出才算成功
  if (!out.stocks.length && !out.news.length && !out.narrative) return null;
  return out;
}

async function generateEconomy(stocks) {
  if (!ready()) return null;
  const stockLines = stocks.map((s) => {
    const lp = ((s.limitPct != null ? s.limitPct : 0.10) * 100).toFixed(0);
    let line = `${s.code} ${s.name}（${s.sector}，${s.t0 ? 'T+0 当日可卖' : 'T+1'}，涨跌停 ±${lp}%）现价 ${s.price}，昨收 ${s.prevClose}，当前 ${s.changePct >= 0 ? '+' : ''}${s.changePct}%`;
    // 玩家资金面（AI 感知玩家行为，据此生成游资进出类新闻与走势）
    if (s.inflow != null) {
      const inw = (s.inflow / 1e8).toFixed(2);
      line += `；玩家净流入 ${s.inflow >= 0 ? '+' : ''}${inw} 亿元，持仓 ${s.holders} 人，最大单一持仓集中度 ${(s.concentration * 100).toFixed(0)}%`;
    }
    return line;
  }).join('\n');

  const prompt = `你是模拟股市的 AI 操盘总导演，负责驱动整个虚拟市场的情绪、舆论与走势。以下是当前 ${stocks.length} 只虚拟股票的盘面：
${stockLines}

请综合宏观氛围、板块轮动、个股事件，以及「玩家资金面」（净流入方向、持仓人数、筹码集中度），输出一份市场指令 JSON，包含四部分：
1. sentiment：整体市场情绪 overall（-1 极空 ~ +1 极多），以及各板块情绪 sectors（板块名做 key，值 -1~+1）。
2. narrative：一段 2~4 句的「市场舆论/盘面解读」中文文案，像财经媒体收盘点评那样，客观描述今天大盘的基调、领涨/领跌板块、资金情绪，不要出现「利好」「利空」字眼。
3. stocks：为「其中一部分」股票（建议 6~12 只）指定未来一段时间的目标涨跌幅 targetPct（%），正值上涨、负值下跌，绝对值不超过该股涨跌停幅度。没有提到的股票按随机游走处理。可选 lock 字段：当某只股票的目标涨跌幅达到涨跌停时，用 "up"（封涨停）或 "down"（封跌停）标记该股今日封板，否则省略。
4. news：编写 1~3 条具体的公司事件新闻，每条与 stocks 里的走势目标呼应（方向一致），格式与字段同新闻编剧（code/headline/detail/direction/magnitude/sector，可含 followup）。

关于「玩家资金面」的运用规则：若某股玩家大量净买入、持仓人数激增或筹码高度集中，可写「游资进场」「主力吸筹」类新闻并给正 targetPct；若玩家大量净卖出或持仓过度拥挤，可写「主力出货」「获利盘回吐」类新闻并给负 targetPct（制造洗盘）。但不要每只股票都这样，只对资金面异动明显的股票这么做。

要求：情绪、走势目标、新闻三者要自洽（某只股票利空新闻就应负 targetPct、板块情绪同步偏空）。

只输出一个 JSON 对象，不要任何解释，不要 markdown，格式：
{"sentiment":{"overall":0.2,"sectors":{"科技":0.4,"能源":-0.1,"医药":0.3,"消费":0.1}},"narrative":"……","stocks":[{"code":"SIM01","targetPct":3.5},{"code":"SIM05","targetPct":-9.8,"lock":"down"}],"news":[{"code":"SIM01","headline":"……","detail":"……","direction":"good","magnitude":0.08,"sector":"科技"}]}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.0,
        max_tokens: 8000,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = await resp.json();
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return normalizeEconomy(extractJSON(content));
  } catch (e) {
    return null;
  }
}

// ---- 公共请求封装 ----
async function chat(prompt, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 1.0, max_tokens: maxTokens || 4000 }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const j = await resp.json();
    return j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 公司档案 / 人设：生成每只股票的公司名 + 一句话主营 ----
// 返回 { stocks:[{code,name,desc}] }，失败返回 null。
function normalizeProfiles(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stocks = Array.isArray(raw.stocks) ? raw.stocks : [];
  const out = [];
  for (const it of stocks) {
    if (!it || typeof it !== 'object') continue;
    const code = normalizeCode(it.code);
    const name = typeof it.name === 'string' ? it.name.trim().slice(0, 12) : '';
    if (!code || !name) continue;
    out.push({ code, name, desc: typeof it.desc === 'string' ? it.desc.trim().slice(0, 60) : '' });
  }
  return out.length ? { stocks: out } : null;
}

async function generateProfiles(stocks) {
  if (!ready()) return null;
  const stockLines = stocks.map((s) => `${s.code}（${s.sector}，现价 ${s.price}）`).join('\n');
  const prompt = `你是模拟股市的上市公司资料编辑。以下是 ${stocks.length} 只虚拟股票代码与所属板块：
${stockLines}

请为每只股票拟一个「贴切、真实、像 A 股上市公司」的中文简称（2~4 个汉字，不带「股份」「集团」等后缀，也不要和下面的现名重复），并写一句话主营业务介绍（desc，20 字以内，点明所属行业与拳头产品）。

要求：
1. code 必须原样复制，禁止编造或改写。
2. name 要贴合其板块（如科技板块可叫「云图科技」「星链半导体」，医药可叫「仁和生物」）。
3. desc 客观陈述主营，不要出现「利好」「龙头」等字眼。

只输出一个 JSON 对象，不要解释，不要 markdown，格式：
{"stocks":[{"code":"SIM01","name":"云图科技","desc":"主营人工智能芯片与云端算力服务"},{"code":"SIM02","name":"仁和生物","desc":"主营创新药研发与体外诊断试剂"}]}`;
  return normalizeProfiles(extractJSON(await chat(prompt, 8000)));
}

// ---- 财报：改写 eps/bvps（让 PE/PB 真正因业绩变化而跳动）+ 配一条财报新闻 ----
// 返回 { reports:[{code,eps,bvps,headline,detail,direction}] }，失败返回 null。
function normalizeEarnings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reports = Array.isArray(raw.reports) ? raw.reports : [];
  const out = [];
  for (const it of reports) {
    if (!it || typeof it !== 'object') continue;
    const code = normalizeCode(it.code);
    if (!code) continue;
    const eps = parseFloat(it.eps);
    const bvps = parseFloat(it.bvps);
    const headline = typeof it.headline === 'string' ? it.headline.trim() : '';
    if (!Number.isFinite(eps) || !Number.isFinite(bvps) || !headline) continue;
    out.push({
      code,
      eps: Math.max(0.01, eps),
      bvps: Math.max(0.5, bvps),
      headline,
      detail: typeof it.detail === 'string' ? it.detail.trim() : headline,
      direction: it.direction === 'bad' ? 'bad' : 'good',
    });
  }
  return out.length ? { reports: out } : null;
}

async function generateEarnings(stocks) {
  if (!ready()) return null;
  const stockLines = stocks.map((s) =>
    `${s.code} ${s.name}（${s.sector}）现价 ${s.price}，EPS ${s.eps}，每股净资产 ${s.bvps}，市盈率 ${s.eps > 0 ? (s.price / s.eps).toFixed(1) : '-'}`
  ).join('\n');
  const prompt = `你是模拟股市的财报编剧。以下是部分虚拟股票的当前基本面：
${stockLines}

请为其中 2~4 只股票「发布最新一季财报」，调整其业绩。要求：
1. 每份财报给出新的每股收益 eps（>0）与每股净资产 bvps（>0），业绩应相对当前值有明显变化（好转或恶化，即财报超预期或不及预期）。
2. headline 是客观的财报标题（如「{name}前三季度净利同比大增 60%」或「{name}计提大额减值，业绩转亏」），不要出现「利好」「利空」字眼。
3. detail 是 2~3 句财报正文。
4. direction：业绩好转为 good，恶化为 bad。
5. 每股净资产 bvps 变化幅度应远小于 eps（净资产较稳定）。

只输出一个 JSON 对象，不要解释，不要 markdown，格式：
{"reports":[{"code":"SIM01","eps":2.35,"bvps":18.6,"headline":"……","detail":"……","direction":"good"},{"code":"SIM05","eps":0.21,"bvps":5.8,"headline":"……","detail":"……","direction":"bad"}]}`;
  return normalizeEarnings(extractJSON(await chat(prompt, 8000)));
}

// ---- 收盘复盘：收盘后生成当日大盘总结 ----
// 返回 { narrative }，失败返回 null。
function normalizeRecap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const narrative = typeof raw.narrative === 'string' ? raw.narrative.trim() : '';
  return narrative ? { narrative: narrative.slice(0, 600) } : null;
}

async function generateRecap(snapshot) {
  if (!ready()) return null;
  const up = (snapshot.stocks || []).filter((s) => s.changePct > 0).slice(0, 5).map((s) => `${s.name}(+${s.changePct}%)`).join('、') || '无';
  const down = (snapshot.stocks || []).filter((s) => s.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 5).map((s) => `${s.name}(${s.changePct}%)`).join('、') || '无';
  const locked = (snapshot.stocks || []).filter((s) => s.lock).map((s) => s.name + (s.lock === 'up' ? '涨停' : '跌停')).join('、') || '无';
  const prompt = `你是模拟股市的收盘评论员。今日收盘数据如下：
大盘指数 ${snapshot.index}（${snapshot.indexChangePct >= 0 ? '+' : ''}${snapshot.indexChangePct}%）
上涨 ${snapshot.breadth.up} 家 / 下跌 ${snapshot.breadth.down} 家 / 平盘 ${snapshot.breadth.flat} 家
领涨：${up}
领跌：${down}
涨跌停封板：${locked}
板块表现：${(snapshot.sectors || []).map((r) => `${r.sector} ${r.changePct >= 0 ? '+' : ''}${r.changePct}%`).join('，')}

请写一段 3~5 句的「当日收盘复盘」中文文案，像财经媒体收盘点评那样，客观总结今日大盘走势、领涨领跌板块、资金情绪，并对后市给出谨慎展望。不要出现「利好」「利空」「推荐买入」等字眼，不要虚构具体公司事件。

只输出一个 JSON 对象，不要解释，不要 markdown，格式：
{"narrative":"……"}`;
  return normalizeRecap(extractJSON(await chat(prompt, 4000)));
}

// ---- 龙虎榜：标注哪些股票被大资金进出 ----
// 返回 { list:[{code,direction,amount,reason}] }，失败返回 null。
function normalizeDragonTiger(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw.list) ? raw.list : [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const code = normalizeCode(it.code);
    if (!code) continue;
    const direction = it.direction === 'sell' ? 'sell' : 'buy';
    out.push({
      code,
      direction,
      amount: Math.max(0.1, Math.min(500, parseFloat(it.amount) || 1)), // 亿元，clamp
      reason: typeof it.reason === 'string' ? it.reason.trim().slice(0, 80) : '',
    });
  }
  return out.length ? { list: out } : null;
}

async function generateDragonTiger(stocks) {
  if (!ready()) return null;
  const stockLines = stocks.slice(0, 10).map((s) => {
    let line = `${s.code} ${s.name}（${s.sector}）`;
    if (s.inflow != null) {
      line += `；玩家净流入 ${s.inflow >= 0 ? '+' : ''}${(s.inflow / 1e8).toFixed(2)} 亿元，持仓 ${s.holders} 人`;
    }
    return line;
  }).join('\n');
  const prompt = `你是模拟股市的龙虎榜编辑。以下是一些虚拟股票（含玩家真实资金动向）：
${stockLines}

请为其中 3~6 只股票编制今日「龙虎榜」，标注大资金动向。要求：
1. 每项给出 code（原样复制）、direction（buy=大资金净买入，sell=大资金净卖出）、amount（净买入/净卖出金额，单位亿元，0.5~20 之间）、reason（一句话理由，如「游资合力封板」「机构出货」）。
2. 理由要像真实龙虎榜席位点评，客观不夸张。可参考玩家净流入方向与持仓人数（资金面异动明显的股票优先入选）。

只输出一个 JSON 对象，不要解释，不要 markdown，格式：
{"list":[{"code":"SIM01","direction":"buy","amount":3.2,"reason":"游资合力封板"},{"code":"SIM03","direction":"sell","amount":1.8,"reason":"机构出货"}]}`;
  return normalizeDragonTiger(extractJSON(await chat(prompt, 4000)));
}

module.exports = { init, ready, generate, generateEconomy, generateProfiles, generateEarnings, generateRecap, generateDragonTiger, extractJSON };
