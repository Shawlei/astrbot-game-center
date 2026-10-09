// 刮刮乐/大厅 无头浏览器真机验证（puppeteer-core + 本机 Chrome）
'use strict';
const puppeteer = require('puppeteer-core');

const BASE = 'http://127.0.0.1:46110';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1280,900'],
  });
  const errors = [];
  async function newPage(tag) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${tag}] console: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
    return page;
  }

  // ---- 1. 大厅：彩票专区渲染 ----
  const lobby = await newPage('lobby');
  await lobby.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 800));
  const lobbyRes = await lobby.evaluate(() => {
    const cards = [...document.querySelectorAll('#lotteryGames .game-card')];
    return {
      sectionCnt: document.getElementById('lotteryCnt')?.textContent,
      soloCnt: document.getElementById('soloCnt')?.textContent,
      cards: cards.map(c => c.querySelector('.gc-name')?.textContent.trim()),
      lotteryInSolo: [...document.querySelectorAll('#soloGames .game-card .gc-name')].some(e => e.textContent.includes('双色球')),
      lbTabs: [...document.querySelectorAll('#lbTabs button, #lbTabs *')].map(e => e.textContent.trim()).filter(t => t.includes('刮刮乐')).length > 0,
    };
  });
  console.log('大厅:', JSON.stringify(lobbyRes, null, 1));

  // ---- 2. 刮刮乐页：面值/奖级渲染 ----
  const sp = await newPage('scratch');
  await sp.goto(BASE + '/scratch.html', { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 800));
  const spRes = await sp.evaluate(() => ({
    denoms: [...document.querySelectorAll('.denom .face')].map(e => e.textContent),
    denomSubs: [...document.querySelectorAll('.denom .sub')].map(e => e.textContent.replace(/\s+/g, ' ')),
    buyBtn: document.getElementById('btnBuy').textContent,
    prizeRows: document.querySelectorAll('#prizeBody tr').length,
    prizeNote: document.getElementById('prizeNote').textContent,
    tabs: [...document.querySelectorAll('#prizeTabs button')].map(b => b.textContent),
  }));
  console.log('刮刮乐页:', JSON.stringify(spRes, null, 1));

  // ---- 3. 模拟开卡（已结算卡直接展示结果）----
  const mockCard = {
    id: 123, denom: 10, winNums: [7, 22], winUsd: 20, costUsd: 10, settled: true, createdAt: Date.now(),
    cells: [
      { num: 7, prize: 10, x10: false }, { num: 22, prize: 10, x10: false }, { num: 3, prize: 50, x10: false }, { num: 11, prize: 20, x10: false },
      { num: 9, prize: 30, x10: false }, { num: 14, prize: 10, x10: false }, { num: 27, prize: 100, x10: false }, { num: 1, prize: 250, x10: false },
      { num: 30, prize: 20, x10: false }, { num: 18, prize: 10, x10: false }, { num: 25, prize: 1000, x10: false }, { num: 5, prize: 10, x10: true },
    ],
  };
  const openRes = await sp.evaluate((card) => {
    openCard(card);
    return {
      visible: document.getElementById('scratchCard').style.display,
      winNums: [...document.querySelectorAll('.win-num')].map(e => e.textContent),
      cells: document.querySelectorAll('.cell').length,
      winCells: document.querySelectorAll('.cell.win').length,
      banner: document.getElementById('resultBanner').textContent,
      bannerCls: document.getElementById('resultBanner').className,
      canvasFaded: document.getElementById('scratchCanvas').classList.contains('faded'),
      nextBtn: document.getElementById('btnNext').style.display,
    };
  }, mockCard);
  console.log('已结算卡展示:', JSON.stringify(openRes, null, 1));

  // ---- 4. 未结算卡：涂层初始化 + 一键刮开 ----
  const mockCard2 = Object.assign({}, mockCard, { id: 124, settled: false });
  const scratchRes = await sp.evaluate((card) => {
    openCard(card);
    const cv = document.getElementById('scratchCanvas');
    const r = { canvasW: cv.width, canvasH: cv.height, faded: cv.classList.contains('faded') };
    // 模拟一键刮开（无 token，doSettle 会早退，但涂层应消失）
    revealAll();
    r.afterRevealFaded = cv.classList.contains('faded');
    return r;
  }, mockCard2);
  console.log('刮开流程:', JSON.stringify(scratchRes, null, 1));

  // ---- 5. 模拟指针刮擦（检查事件链不报错）----
  await sp.evaluate((card) => { openCard(card); }, mockCard2);
  const box = await (await sp.$('#scratchCanvas')).boundingBox();
  if (box) {
    await sp.mouse.move(box.x + 30, box.y + 30);
    await sp.mouse.down();
    for (let i = 0; i < 20; i++) await sp.mouse.move(box.x + 30 + i * 20, box.y + 30 + (i % 2) * 40, { steps: 2 });
    await sp.mouse.up();
  }
  const afterDrag = await sp.evaluate(() => {
    const cv = document.getElementById('scratchCanvas');
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let clear = 0, total = 0;
    for (let i = 3; i < d.length; i += 4 * 16) { total++; if (d[i] === 0) clear++; }
    return { clearedRatio: (clear / total).toFixed(3), faded: cv.classList.contains('faded') };
  });
  console.log('指针刮擦:', JSON.stringify(afterDrag));

  // 截图留档
  await sp.screenshot({ path: 'test_scratch_page.png', fullPage: false });
  await lobby.screenshot({ path: 'test_lobby.png', fullPage: false });

  console.log('\n=== 控制台/页面错误 ===');
  console.log(errors.length ? errors.join('\n') : '（无）');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
