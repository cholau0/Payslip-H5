/** 员工端：查看并签收自己的工资条 */
(function () {
  const { PAuth } = window;
  const $ = (id) => document.getElementById(id);
  const state = { months: [], current: '', fields: [], slip: null };

  function queryMonth() {
    const m = new URLSearchParams(location.search).get('month');
    return /^\d{4}-\d{2}$/.test(m || '') ? m : '';
  }

  /**
   * 页面斜向水印：以签收人姓名平铺，截图外传可溯源。
   * 纯前端水印可被开发者工具移除，属于常规威慑手段（与钉钉/飞书同类实现）。
   */
  function applyWatermark(text) {
    const t = String(text || '').trim();
    const old = document.getElementById('wm');
    if (old) old.remove();
    if (!t) return;
    const safe = t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="170">' +
      '<text x="140" y="85" text-anchor="middle" transform="rotate(-22 140 85)" ' +
      'font-size="20" font-family="sans-serif" fill="#4b5563" fill-opacity="0.07">' + safe + '</text></svg>';
    const el = document.createElement('div');
    el.id = 'wm';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:60;' +
      'background-image:url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '");';
    document.body.appendChild(el);
  }

  function showApp() {
    $('boot').classList.add('hidden');
    $('app').classList.remove('hidden');
  }

  function showFallback(msg) {
    $('boot').classList.add('hidden');
    $('fallback').classList.remove('hidden');
    if (msg) PAuth.toast(msg, true);
  }

  function fmtMonthLabel(m) {
    const [y, mo] = m.split('-');
    return `${y}年${Number(mo)}月`;
  }

  function renderMonthSwitch() {
    const sel = $('monthSwitch');
    if (state.months.length <= 1) {
      sel.classList.add('hidden');
      return;
    }
    sel.classList.remove('hidden');
    sel.innerHTML = state.months
      .map((m) => `<option value="${m.pay_month}"${m.pay_month === state.current ? ' selected' : ''}>${fmtMonthLabel(m.pay_month)}</option>`)
      .join('');
  }

  function rowHtml(f, items) {
    const v = Number(items[f.key] || 0);
    const isDeduct = f.group === 'deduct' && f.agg === 'add';
    const cls = ['v'];
    if (isDeduct || f.agg === 'minus') cls.push('neg');
    if (v === 0) cls.push('zero');
    const text = f.decimals === 2 && f.agg === 'none' ? v.toFixed(2) : PAuth.money(v);
    return `<div class="row"><span class="k">${PAuth.esc(f.label)}</span><span class="${cls.join(' ')}">${text}</span></div>`;
  }

  function renderSlip(data) {
    const s = data.payslip;
    const fields = data.fields || [];
    state.fields = fields;
    state.slip = s;

    $('heroMonth').textContent = fmtMonthLabel(s.payMonth) + ' 工资条';
    $('heroName').textContent = s.name + (s.deptName ? ' · ' + s.deptName : '');
    $('heroNet').textContent = PAuth.money(s.net);
    applyWatermark(s.name);

    const badge = $('heroBadge');
    if (s.status === 'confirmed') {
      badge.className = 'hero-badge is-confirmed';
      badge.textContent = '✓ 已确认签收';
    } else {
      badge.className = 'hero-badge';
      badge.textContent = '待确认签收';
    }

    const income = fields.filter((f) => f.group === 'income' && f.agg !== 'sub');
    const deduct = fields.filter((f) => f.group === 'deduct' && f.agg !== 'sub');
    const html = [];

    if (s.remark) {
      html.push(`<div class="remark"><span class="remark-tag">提醒</span><span>${PAuth.esc(s.remark)}</span></div>`);
    }

    html.push('<div class="group-title">应发项目</div><div class="rows">');
    html.push(income.map((f) => rowHtml(f, s.items)).join(''));
    html.push(`<div class="row sub"><span class="k">应发数合计</span><span class="v">${PAuth.money(s.gross)}</span></div>`);
    html.push('</div>');

    html.push('<div class="group-title">代扣项目</div><div class="rows">');
    html.push(deduct.length ? deduct.map((f) => rowHtml(f, s.items)).join('') : '<div class="row"><span class="k">无</span><span class="v zero">0.00</span></div>');
    html.push(`<div class="row sub"><span class="k">代扣合计</span><span class="v neg">${PAuth.money(s.deduct)}</span></div>`);
    html.push('</div>');

    html.push(
      `<div class="summary">
         <div class="summary-line"><span>应发数合计</span><span class="v">${PAuth.money(s.gross)}</span></div>
         <div class="summary-line"><span>减：代扣合计</span><span class="v">-${PAuth.money(s.deduct)}</span></div>
         <div class="summary-line total"><span>实发合计</span><span class="v">${PAuth.money(s.net)}</span></div>
       </div>`
    );
    $('detail').innerHTML = html.join('');
    $('summary').classList.add('hidden');

    const dock = $('dock');
    if (s.status === 'confirmed') {
      $('btnConfirm').classList.add('hidden');
      const tip = $('confirmedTip');
      tip.classList.remove('hidden');
      tip.innerHTML = `已于 ${PAuth.esc(s.confirmedAt || '')} 确认签收<small>本条记录将作为签收凭证留存</small>`;
    } else {
      $('btnConfirm').classList.remove('hidden');
      $('btnConfirm').disabled = false;
      $('btnConfirm').textContent = '确认收到';
      $('confirmedTip').classList.add('hidden');
    }
  }

  async function loadMonth(month) {
    $('boot').classList.remove('hidden');
    try {
      const data = await PAuth.api('/api/me/payslip' + (month ? `?month=${encodeURIComponent(month)}` : ''));
      state.current = data.payslip.payMonth;
      renderSlip(data);
    } catch (err) {
      $('detail').innerHTML = `<div class="empty"><h3>暂无工资条</h3><p>${PAuth.esc(err.message)}</p></div>`;
      $('heroMonth').textContent = '我的工资条';
      $('heroNet').textContent = '—';
      $('dock').classList.add('hidden');
    } finally {
      $('boot').classList.add('hidden');
      showApp();
    }
  }

  async function refreshMonths() {
    const data = await PAuth.api('/api/me/months');
    state.months = data.months || [];
    if (!state.months.length) {
      $('boot').classList.add('hidden');
      showApp();
      applyWatermark('');
      $('detail').innerHTML = '<div class="empty"><h3>还没有发放给你的工资条</h3><p>发放后会通过钉钉工作通知提醒你</p></div>';
      $('dock').classList.add('hidden');
      return;
    }
    renderMonthSwitch();
    const want = queryMonth();
    const first = state.months.some((m) => m.pay_month === want) ? want : state.months[0].pay_month;
    await loadMonth(first);
  }

  async function confirm() {
    if (!state.current) return;
    const btn = $('btnConfirm');
    if (!window.confirm(`确认已收到 ${fmtMonthLabel(state.current)} 工资条（实发 ￥${PAuth.money(state.slip.net)}）？`)) return;
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      await PAuth.api('/api/me/confirm', { method: 'POST', json: { month: state.current } });
      PAuth.toast('已确认签收，谢谢');
      await refreshMonths();
    } catch (err) {
      PAuth.toast(err.message, true);
      btn.disabled = false;
      btn.textContent = '确认收到';
    }
  }

  function bind() {
    $('btnConfirm').addEventListener('click', confirm);
    $('monthSwitch').addEventListener('change', (e) => loadMonth(e.target.value));
    $('noticeClose').addEventListener('click', () => $('notice').classList.add('hidden'));
    $('devLogin').addEventListener('click', async () => {
      const uid = $('devUserId').value.trim();
      if (!uid) return PAuth.toast('请输入 userId', true);
      try {
        await PAuth.loginDev(uid);
        await refreshMonths();
      } catch (err) {
        PAuth.toast(err.message, true);
      }
    });
  }

  async function boot() {
    bind();
    try {
      await refreshMonths();
    } catch (err) {
      if (!PAuth.inDingTalk()) {
        showFallback(err.message);
      } else {
        $('boot').classList.add('hidden');
        showApp();
        $('detail').innerHTML = `<div class="empty"><h3>加载失败</h3><p>${PAuth.esc(err.message)}</p></div>`;
        $('dock').classList.add('hidden');
      }
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
