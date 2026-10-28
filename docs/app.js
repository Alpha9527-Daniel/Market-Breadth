/* 市场宽广度看板 — 零依赖，手写 SVG：上「指数 K 线」下「红盘率 / TRIN」，共用横轴
 * 数据：docs/data/breadth.json（file:// 下用 data/breadth.js 的内嵌数据）
 * 默认窗口：最近 10 个交易日；可切换板块、起始日期、10/20/30/60 日窗口
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_WINDOW = 10;
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const state = {
    markets: [],
    key: 'all',
    indices: {},
    startIndex: 0,
    _info: {},
  };

  const el = {
    marketBtns: document.getElementById('market-btns'),
    select: document.getElementById('start-date'),
    windowBtns: document.getElementById('window-btns'),
    kpis: document.getElementById('kpis'),
    wrap: document.getElementById('chart-wrap'),
    svg: document.getElementById('chart'),
    tooltip: document.getElementById('tooltip'),
    chartMsg: document.getElementById('chart-msg'),
    rangeNote: document.getElementById('range-note'),
    kName: document.getElementById('k-name'),
    thead: document.getElementById('detail-table').querySelector('thead'),
    table: document.getElementById('detail-table').querySelector('tbody'),
    buildInfo: document.getElementById('build-info'),
  };

  /* ------------------------------------------------------------------ utils */
  const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(d);
  const signed = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}`;
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const weekday = (s) => WEEK[parseDate(s).getDay()];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function niceScale(lo, hi, count, steps) {
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { hi = lo + 1; }
    const rough = (hi - lo) / Math.max(1, count);
    let step = steps[steps.length - 1];
    for (const s of steps) { if (s >= rough) { step = s; break; } }
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
    return { min, max, step, ticks };
  }

  /** 价格轴：范围贴紧数据（不做整数取整），刻度只取落在区间内的整数步长 */
  function priceScale(lo, hi, count) {
    const span = hi - lo || Math.abs(hi || 1) * 0.01;
    const min = lo - span * 0.08;
    const max = hi + span * 0.08;
    const rough = (max - min) / Math.max(1, count);
    const steps = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
    let step = steps[steps.length - 1];
    for (const s of steps) { if (s >= rough) { step = s; break; } }
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Number(v.toFixed(2)));
    return { min, max, ticks };
  }

  function svgNode(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* ------------------------------------------------------------------- data */
  const market = () => state.markets.find((m) => m.key === state.key) || state.markets[0];
  const rows = () => market().series.slice(state.startIndex);

  /** 当前板块对应指数的 K 线：date -> bar，date -> 当日涨跌幅（缓存） */
  function indexInfo() {
    const sym = market().index;
    if (!state._info[sym]) {
      const idx = state.indices[sym];
      const map = new Map();
      const pct = new Map();
      if (idx && idx.bars) {
        idx.bars.forEach((b, i) => {
          map.set(b[0], b);
          if (i > 0) pct.set(b[0], (b[4] / idx.bars[i - 1][4] - 1) * 100);
        });
      }
      state._info[sym] = { map, pct };
    }
    return state._info[sym];
  }

  /**
   * 取数：http(s) 下优先 fetch JSON（保证拿到最新一天）；
   * 直接双击打开（file://）时浏览器会拦截 fetch，改用 data/breadth.js 里的内嵌数据。
   */
  async function loadData() {
    let data = null;
    let via = 'json';
    if (location.protocol !== 'file:') {
      try {
        const res = await fetch(`data/breadth.json?v=${Date.now()}`, { cache: 'no-store' });
        if (res.ok) data = await res.json();
      } catch (err) {
        /* 断网或站点只放了 js 版本时，回退到内嵌数据 */
      }
    }
    if (!data && window.BREADTH_DATA) {
      data = window.BREADTH_DATA;
      via = 'js';
    }
    if (!data) throw new Error('没有找到数据（data/breadth.json 或 data/breadth.js），请先运行 build_breadth.py');
    return { data, via };
  }

  async function load() {
    const { data, via } = await loadData();
    state.markets = data.markets || [];
    state.indices = data.indices || {};
    if (!state.markets.length) throw new Error('数据为空');

    state.key = state.markets.some((m) => m.key === (new URLSearchParams(location.search).get('m')))
      ? new URLSearchParams(location.search).get('m') : state.markets[0].key;

    buildMarketButtons();
    state.startIndex = Math.max(0, market().series.length - DEFAULT_WINDOW);
    applyUrlParams();
    el.buildInfo.textContent = `数据生成于 ${data.generatedAt} · 相关系数窗口 ${data.corrWindow} 个交易日 · 来源：${data.source}` +
      (via === 'js' ? '（本地模式：读取内嵌数据）' : '');
    fillDateSelect();
    renderAll();
  }

  function buildMarketButtons() {
    el.marketBtns.innerHTML = state.markets
      .map((m) => `<button type="button" data-key="${m.key}" title="${m.name}（样本 ${m.size} 只）">${m.name}</button>`)
      .join('');
  }

  /** 支持分享链接：?m=hs300 板块 / ?n=60 窗口天数 / ?start=2026-06-01 起始日 */
  function applyUrlParams() {
    const p = new URLSearchParams(location.search);
    const n = Number(p.get('n'));
    if (n > 0) state.startIndex = Math.max(0, market().series.length - n);
    const start = p.get('start');
    if (start) {
      const i = market().series.findIndex((r) => r.d === start);
      if (i >= 0) state.startIndex = i;
    }
  }

  function fillDateSelect() {
    const series = market().series;
    el.select.innerHTML = '';
    for (let i = series.length - 1; i >= 0; i--) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${series[i].d}  ${weekday(series[i].d)}`;
      el.select.appendChild(opt);
    }
  }

  function syncControls() {
    el.select.value = String(state.startIndex);
    const n = market().series.length - state.startIndex;
    el.windowBtns.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.n) === n);
    });
    el.marketBtns.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.key === state.key);
    });
    el.kName.textContent = market().indexName || '';
  }

  /* ------------------------------------------------------------------- kpis */
  function corrCard(last) {
    const c = last.corr || {};
    const cls = (v) => (v === null || v === undefined) ? '' : (v >= 0 ? 'pos' : 'neg');
    return `<div class="kpi kpi-corr" style="--k-color:#22d3ee">
        <div class="kpi-label">TRIN × ${market().indexName} 相关性<span class="kpi-tag">120 日</span></div>
        <div class="kpi-value ${cls(c.t1)}">${signed(c.t1, 3)}<span class="unit">t-1</span></div>
        <div class="kpi-sub"><span class="plain">t-10 ${signed(c.t10, 3)}</span></div>
      </div>`;
  }

  function renderKpis() {
    const series = market().series;
    const last = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const ratioDelta = prev && last.advRatio !== null && prev.advRatio !== null ? last.advRatio - prev.advRatio : null;
    const trinDelta = prev && last.trin !== null && prev.trin !== null ? last.trin - prev.trin : null;

    const cards = [
      {
        color: '#ef4444', label: '红盘率（最新交易日）',
        value: fmt(last.advRatio, 2), unit: '%',
        sub: ratioDelta === null ? '<span class="plain">—</span>'
          : `较前日 <span class="${ratioDelta >= 0 ? 'up' : 'down'}">${ratioDelta > 0 ? '+' : ''}${ratioDelta.toFixed(2)} 个百分点</span>`,
      },
      {
        color: '#f59e0b', label: 'TRIN 阿姆氏指标',
        value: fmt(last.trin, 3), unit: '',
        sub: trinDelta === null ? '<span class="plain">—</span>'
          : `较前日 <span class="${trinDelta <= 0 ? 'up' : 'down'}">${trinDelta > 0 ? '+' : ''}${trinDelta.toFixed(3)}</span>`,
      },
      {
        color: '#3b82f6', label: '上涨家数（最新交易日）',
        value: `${last.adv}`, unit: '家',
        sub: `<span class="plain">下跌 ${last.dec} · 平盘 ${last.flat} · 停牌 ${last.susp} · 样本 ${last.total}</span>`,
      },
      {
        color: '#a78bfa', label: market().key === 'all' ? '两市成交额' : '板块成交额',
        value: fmt(last.amountYi, 0), unit: '亿元',
        sub: `上涨量 ${fmt(last.advVolYi, 0)}亿股 · 下跌量 ${fmt(last.decVolYi, 0)}亿股`,
      },
    ];

    el.kpis.innerHTML = cards.map((c) => `
      <div class="kpi" style="--k-color:${c.color}">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}<span class="unit">${c.unit}</span></div>
        <div class="kpi-sub">${c.sub}</div>
      </div>`).join('') + corrCard(last);
  }

  /* ------------------------------------------------------------------ chart */
  function renderChart() {
    const svg = el.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const data = rows();
    const n = data.length;
    if (!n) return;

    const W = clamp(el.wrap.clientWidth || 900, 300, Math.max(320, document.documentElement.clientWidth - 20));
    const H = el.svg.clientHeight || 560;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);

    const pad = { l: 44, r: 58, t: 24, b: 30 };
    const iw = W - pad.l - pad.r;
    const gap = 34;
    const bodyH = H - pad.t - pad.b - gap;
    const candleH = Math.round(bodyH * 0.36);
    const lineH = bodyH - candleH;
    const cTop = pad.t, cBot = pad.t + candleH;
    const lTop = cBot + gap, lBot = lTop + lineH;

    const xAt = (i) => pad.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));

    const plot = svgNode('g');
    svg.appendChild(plot);

    /* ============================================================== 上半：K 线 */
    const info = indexInfo();
    const bars = info.map;
    const visibleBars = data.map((r) => bars.get(r.d)).filter(Boolean);   // [date, o, h, l, c]
    let yP = null;
    plot.appendChild(svgNode('rect', { x: pad.l, y: cTop, width: iw, height: candleH, fill: '#0e1522', rx: 3 }));

    if (visibleBars.length) {
      const lo = Math.min(...visibleBars.map((b) => b[3]));
      const hi = Math.max(...visibleBars.map((b) => b[2]));
      const pScale = priceScale(lo, hi, 5);
      yP = (v) => cBot - ((v - pScale.min) / (pScale.max - pScale.min)) * candleH;

      pScale.ticks.forEach((t) => {
        const y = yP(t);
        if (y < cTop - 1 || y > cBot + 1) return;
        plot.appendChild(svgNode('line', { x1: pad.l, y1: y, x2: pad.l + iw, y2: y, class: 'grid-line' }));
        const tx = svgNode('text', { x: pad.l + iw + 8, y: y + 3.5, class: 'tick-text', 'text-anchor': 'start' });
        tx.textContent = t >= 1000 ? t.toFixed(0) : t.toFixed(2);
        plot.appendChild(tx);
      });

      const step = n > 1 ? iw / (n - 1) : iw;
      const bw = clamp(step * 0.62, 2, 16);
      data.forEach((r, i) => {
        const b = bars.get(r.d);
        if (!b) return;
        const [, o, h, l, c] = b;
        const x = xAt(i);
        const rising = c >= o;
        const color = rising ? '#ef4444' : '#10b981';
        const yO = yP(o), yC = yP(c), yH = yP(h), yL = yP(l);
        plot.appendChild(svgNode('line', { x1: x, y1: yH, x2: x, y2: yL, stroke: color, 'stroke-width': 1 }));
        const top = Math.min(yO, yC);
        const hgt = Math.max(1.2, Math.abs(yO - yC));
        plot.appendChild(svgNode('rect', {
          x: x - bw / 2, y: top, width: bw, height: hgt,
          fill: rising ? color : color, 'fill-opacity': rising ? 0.95 : 0.95, rx: 0.5,
        }));
      });

      const idxName = market().indexName || '';
      const t1 = svgNode('text', { x: pad.l, y: cTop - 8, class: 'panel-title' });
      t1.textContent = `指数 K 线 · ${idxName}`;
      plot.appendChild(t1);
    } else {
      const t = svgNode('text', { x: pad.l + iw / 2, y: cTop + candleH / 2, class: 'tick-text', 'text-anchor': 'middle' });
      t.textContent = '暂无该指数的 K 线数据';
      plot.appendChild(t);
    }

    /* ========================================================== 下半：宽度指标 */
    plot.appendChild(svgNode('rect', { x: pad.l, y: lTop, width: iw, height: lineH, fill: '#0e1522', rx: 3 }));

    const ratios = data.map((r) => r.advRatio).filter((v) => v !== null && v !== undefined);
    const trins = data.map((r) => r.trin).filter((v) => v !== null && v !== undefined);
    const lScale = niceScale(clamp(Math.min(...ratios) - 6, 0, 100), clamp(Math.max(...ratios) + 6, 0, 100), 4, [5, 10, 20, 25, 50]);
    const tLo = trins.length ? Math.min(...trins) : 0.5;
    const tHi = trins.length ? Math.max(...trins) : 1.5;
    const rScale = niceScale(tLo - (tHi - tLo) * 0.12 - 0.02, tHi + (tHi - tLo) * 0.12 + 0.02, 5, [0.1, 0.2, 0.25, 0.5, 1]);

    const yL = (v) => lBot - ((v - lScale.min) / (lScale.max - lScale.min)) * lineH;
    const yR = (v) => lBot - ((v - rScale.min) / (rScale.max - rScale.min)) * lineH;

    lScale.ticks.forEach((t) => {
      const y = yL(t);
      if (y < lTop - 1 || y > lBot + 1) return;
      plot.appendChild(svgNode('line', { x1: pad.l, y1: y, x2: pad.l + iw, y2: y, class: 'grid-line' }));
      const tx = svgNode('text', { x: pad.l - 8, y: y + 3.5, class: 'tick-text', 'text-anchor': 'end' });
      tx.textContent = `${t}%`;
      plot.appendChild(tx);
    });
    rScale.ticks.forEach((t) => {
      const y = yR(t);
      if (y < lTop - 1 || y > lBot + 1) return;
      const tx = svgNode('text', { x: pad.l + iw + 8, y: y + 3.5, class: 'tick-text axis-trin', 'text-anchor': 'start' });
      tx.textContent = t.toFixed(2);
      plot.appendChild(tx);
    });

    const t2 = svgNode('text', { x: pad.l, y: lTop - 10, class: 'panel-title' });
    t2.textContent = '红盘率 / TRIN';
    plot.appendChild(t2);

    // 参考线
    const refLabels = [];
    if (lScale.min < 50 && lScale.max > 50) {
      const y = yL(50);
      plot.appendChild(svgNode('line', { x1: pad.l, y1: y, x2: pad.l + iw, y2: y, class: 'ref-line', stroke: '#ef4444' }));
      refLabels.push({ x: pad.l + 4, y: y - 5, text: '红盘率 50%', color: '#c05a5a', anchor: 'start' });
    }
    if (rScale.min < 1 && rScale.max > 1) {
      const y = yR(1);
      plot.appendChild(svgNode('line', { x1: pad.l, y1: y, x2: pad.l + iw, y2: y, class: 'ref-line', stroke: '#b98a20' }));
      refLabels.push({ x: pad.l + iw - 4, y: y - 5, text: 'TRIN 1.0', color: '#a3812f', anchor: 'end' });
    }

    // 红盘率面积
    const ratioPts = data.map((r, i) => (r.advRatio === null ? null : [xAt(i), yL(r.advRatio)]));
    const firstIdx = ratioPts.findIndex((p) => p);
    const lastIdx = ratioPts.length - 1 - [...ratioPts].reverse().findIndex((p) => p);
    if (firstIdx >= 0) {
      let dArea = `M ${ratioPts[firstIdx][0]} ${lBot}`;
      for (let i = firstIdx; i <= lastIdx; i++) if (ratioPts[i]) dArea += ` L ${ratioPts[i][0]} ${ratioPts[i][1]}`;
      dArea += ` L ${ratioPts[lastIdx][0]} ${lBot} Z`;
      const defs = svgNode('defs');
      const grad = svgNode('linearGradient', { id: 'gRatio', x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.appendChild(svgNode('stop', { offset: '0%', 'stop-color': '#ef4444', 'stop-opacity': .26 }));
      grad.appendChild(svgNode('stop', { offset: '100%', 'stop-color': '#ef4444', 'stop-opacity': .02 }));
      defs.appendChild(grad);
      svg.insertBefore(defs, svg.firstChild);
      plot.appendChild(svgNode('path', { d: dArea, fill: 'url(#gRatio)', stroke: 'none' }));
    }

    function drawLine(pts, stroke, width) {
      let d = '';
      let pen = false;
      pts.forEach((p) => {
        if (!p) { pen = false; return; }
        d += `${pen ? ' L' : ' M'} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
        pen = true;
      });
      if (d) plot.appendChild(svgNode('path', {
        d, fill: 'none', stroke, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }

    drawLine(ratioPts, '#ef4444', 2);
    const trinPts = data.map((r, i) => (r.trin === null || r.trin === undefined ? null : [xAt(i), yR(r.trin)]));
    drawLine(trinPts, '#f59e0b', 2);
    ratioPts.forEach((p) => p && plot.appendChild(svgNode('circle', { cx: p[0], cy: p[1], r: 2.6, fill: '#ef4444', class: 'dot' })));
    trinPts.forEach((p) => p && plot.appendChild(svgNode('circle', { cx: p[0], cy: p[1], r: 2.6, fill: '#f59e0b', class: 'dot' })));

    // 参考线标签（压在数据线之上，带底色）
    refLabels.forEach((lb) => {
      const tw = lb.text.length * 5.6 + 8;
      const x0 = lb.anchor === 'end' ? lb.x - tw : lb.x;
      plot.appendChild(svgNode('rect', { x: x0, y: lb.y - 8, width: tw, height: 12, rx: 3, fill: '#0e1522', 'fill-opacity': .9 }));
      const t = svgNode('text', { x: lb.x, y: lb.y, class: 'axis-title', fill: lb.color, 'text-anchor': lb.anchor });
      t.textContent = lb.text;
      plot.appendChild(t);
    });

    // x 轴（共用）
    const labelStep = n <= 12 ? 1 : Math.ceil(n / 9);
    const lastLabelX = xAt(n - 1);
    let prevLabelX = -Infinity;
    data.forEach((r, i) => {
      if (!(i % labelStep === 0 || i === n - 1)) return;
      const x = xAt(i);
      if (i !== n - 1 && (x - prevLabelX < 52 || lastLabelX - x < 52)) return;
      const t = svgNode('text', { x, y: lBot + 16, class: 'tick-text', 'text-anchor': 'middle' });
      t.textContent = r.d.slice(5);
      plot.appendChild(t);
      prevLabelX = x;
    });

    /* ------------------------------------------------------------- 悬停交互 */
    const hoverG = svgNode('g');
    plot.appendChild(hoverG);
    const hit = svgNode('rect', { x: pad.l, y: cTop, width: iw, height: lBot - cTop, class: 'axis-zone', style: 'cursor: crosshair' });
    plot.appendChild(hit);

    const geo = { xAt, yL, yR, yP, bars, pct: info.pct, data, pad, iw, cTop, lBot, n };
    hit.addEventListener('mousemove', (ev) => showHover(ev, geo, hoverG));
    hit.addEventListener('mouseleave', () => {
      while (hoverG.firstChild) hoverG.removeChild(hoverG.firstChild);
      el.tooltip.hidden = true;
    });
  }

  function showHover(ev, g, hoverG) {
    const rect = el.svg.getBoundingClientRect();
    const W = Number(el.svg.getAttribute('width'));
    const x = (ev.clientX - rect.left) * (W / rect.width);
    let idx = g.n === 1 ? 0 : Math.round(((x - g.pad.l) / g.iw) * (g.n - 1));
    idx = clamp(idx, 0, g.n - 1);
    const r = g.data[idx];
    const px = g.xAt(idx);

    while (hoverG.firstChild) hoverG.removeChild(hoverG.firstChild);
    hoverG.appendChild(svgNode('line', { x1: px, y1: g.cTop, x2: px, y2: g.lBot, class: 'hover-line' }));

    const bar = g.bars.get(r.d);
    if (bar && g.yP) {
      const color = bar[4] >= bar[1] ? '#ef4444' : '#10b981';
      hoverG.appendChild(svgNode('circle', { cx: px, cy: g.yP(bar[4]), r: 3, fill: color, class: 'hover-dot' }));
    }
    if (r.advRatio !== null) {
      hoverG.appendChild(svgNode('circle', { cx: px, cy: g.yL(r.advRatio), r: 4, fill: '#ef4444', class: 'hover-dot' }));
    }
    if (r.trin !== null && r.trin !== undefined) {
      hoverG.appendChild(svgNode('circle', { cx: px, cy: g.yR(r.trin), r: 4, fill: '#f59e0b', class: 'hover-dot' }));
    }

    const barHtml = bar ? (() => {
      const [, o, h, l, c] = bar;
      const pct = g.pct.get(r.d);
      const color = pct === undefined || pct >= 0 ? '#fca5a5' : '#6ee7b7';
      return `<div class="tt-row"><span>${market().indexName} · 收</span><b>${fmt(c, 2)}</b></div>
        <div class="tt-row"><span>开 / 高 / 低</span><b>${fmt(o, 2)} / ${fmt(h, 2)} / ${fmt(l, 2)}</b></div>
        <div class="tt-row"><span>涨跌幅</span><b style="color:${color}">${signed(pct)}%</b></div>
        <div class="tt-sep"></div>`;
    })() : '';

    el.tooltip.innerHTML = `
      <div class="tt-date">${r.d} ${weekday(r.d)}</div>
      ${barHtml}
      <div class="tt-row"><span>红盘率</span><b style="color:#fca5a5">${fmt(r.advRatio)}%</b></div>
      <div class="tt-row"><span>TRIN</span><b style="color:#fbbf24">${fmt(r.trin, 3)}</b></div>
      <div class="tt-row"><span>涨 / 跌 / 平</span><b>${r.adv} / ${r.dec} / ${r.flat}</b></div>
      <div class="tt-row"><span>量比（额）</span><b>${fmt(r.volRatioAmt)}</b></div>
      <div class="tt-row"><span>成交额</span><b>${fmt(r.amountYi, 0)} 亿元</b></div>`;
    el.tooltip.hidden = false;

    const wrapRect = el.wrap.getBoundingClientRect();
    const localX = ev.clientX - wrapRect.left;
    const tw = el.tooltip.offsetWidth;
    const th = el.tooltip.offsetHeight;
    let left = localX + 16;
    if (left + tw > wrapRect.width - 3) left = localX - tw - 16;
    left = clamp(left, 3, Math.max(3, wrapRect.width - tw - 3));
    const top = clamp((ev.clientY - wrapRect.top) - th / 2, 6, Math.max(6, wrapRect.height - th - 6));
    el.tooltip.style.left = `${left}px`;
    el.tooltip.style.top = `${top}px`;
  }

  /* ------------------------------------------------------------------ table */
  function renderTableHead() {
    const name = market().indexName;
    el.thead.innerHTML = `
      <tr>
        <th rowspan="2">日期</th>
        <th rowspan="2">红盘率</th>
        <th rowspan="2">TRIN</th>
        <th rowspan="2">涨 / 跌 / 平</th>
        <th rowspan="2">量比（额）</th>
        <th rowspan="2">${name} 涨跌幅</th>
        <th colspan="2" class="grp">TRIN 相关系数 <span class="th-sub">120 日滚动</span></th>
        <th rowspan="2">成交额</th>
      </tr>
      <tr>
        <th class="grp">t-1</th>
        <th class="grp">t-10</th>
      </tr>`;
  }

  function renderTable() {
    renderTableHead();
    const list = rows().slice().reverse();
    el.table.innerHTML = list.map((r) => {
      const c = r.corr || {};
      const pctCls = (v) => (v === null || v === undefined) ? '' : (v >= 0 ? 'pos' : 'neg');
      return `<tr>
        <td>${r.d}</td>
        <td class="${r.advRatio >= 50 ? 'pos' : 'neg'}">${fmt(r.advRatio)}%</td>
        <td class="${r.trin !== null && r.trin !== undefined && r.trin < 1 ? 'pos' : 'neg'}">${fmt(r.trin, 3)}</td>
        <td>${r.adv} / ${r.dec} / ${r.flat}</td>
        <td>${fmt(r.volRatioAmt)}</td>
        <td class="${pctCls(r.idxPct)}">${signed(r.idxPct)}%</td>
        <td class="${pctCls(c.t1)}">${signed(c.t1, 3)}</td>
        <td class="${pctCls(c.t10)}">${signed(c.t10, 3)}</td>
        <td>${fmt(r.amountYi, 0)} 亿</td>
      </tr>`;
    }).join('');
  }

  function renderRangeNote() {
    const list = rows();
    if (!list.length) return;
    const ratios = list.map((r) => r.advRatio).filter((v) => v !== null);
    const trins = list.map((r) => r.trin).filter((v) => v !== null && v !== undefined);
    const parts = [`${list[0].d} ~ ${list[list.length - 1].d} · ${list.length} 个交易日`];
    if (ratios.length) parts.push(`红盘率均值 ${(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(1)}%`);
    if (trins.length) parts.push(`TRIN 均值 ${(trins.reduce((a, b) => a + b, 0) / trins.length).toFixed(2)}`);
    el.rangeNote.textContent = parts.join(' · ');
  }

  function renderAll() {
    renderKpis();
    renderRangeNote();
    renderChart();
    renderTable();
    syncControls();
  }

  /* ----------------------------------------------------------------- events */
  el.marketBtns.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn || btn.dataset.key === state.key) return;
    const keep = rows().length;                       // 尽量保持窗口长度不变
    state.key = btn.dataset.key;
    const total = market().series.length;
    state.startIndex = clamp(total - keep, 0, total - 1);
    fillDateSelect();
    renderAll();
  });

  el.select.addEventListener('change', () => {
    const total = market().series.length;
    state.startIndex = clamp(Number(el.select.value), 0, total - 1);
    renderAll();
  });

  el.windowBtns.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const n = Number(btn.dataset.n);
    state.startIndex = Math.max(0, market().series.length - n);
    renderAll();
  });

  let raf = null;
  window.addEventListener('resize', () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (state.markets.length) renderChart(); });
  });

  /* ------------------------------------------------------------------- boot */
  load().catch((err) => {
    el.chartMsg.hidden = false;
    el.chartMsg.textContent = `数据加载失败：${err.message}`;
    el.kpis.innerHTML = '';
  });
})();
