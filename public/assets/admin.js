/** HR 管理台 */
(function () {
  const { PAuth } = window;
  const $ = (id) => document.getElementById(id);
  const esc = PAuth.esc;
  const state = { file: null, month: '', fields: [], preview: null, listRows: [], selected: new Set() };

  function fmtMonth(m) {
    if (!m) return '';
    const [y, mo] = m.split('-');
    return `${y}年${Number(mo)}月`;
  }
  function nowMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function show(id) {
    $('boot').classList.add('hidden');
    $(id).classList.remove('hidden');
  }

  /* ---------------- 身份 ---------------- */
  async function boot() {
    if (new URLSearchParams(location.search).get('logout')) {
      PAuth.clearToken();
      location.href = '/admin.html';
      return;
    }
    bindTabs();
    bindImport();
    bindSelect();
    bindList();
    bindRoster();
    try {
      await ensureAdmin();
    } catch (err) {
      $('boot').classList.add('hidden');
      $('gate').classList.remove('hidden');
      $('gateMsg').textContent = err.message || '';
    }
  }

  async function ensureAdmin() {
    let data;
    try {
      data = await PAuth.api('/api/admin/overview');
    } catch (err) {
      // 免登后角色不是管理员时，api 已自动重登过一次，这里直接报错给外层
      throw err;
    }
    const me = await PAuth.api('/api/meta');
    state.fields = me.fields || [];
    $('whoami').textContent = '管理员工作台';
    show('app');
    renderOverview(data);
    renderFieldDoc(me.fields);
    $('impMonth').value = nowMonth();
    $('qMonth').value = nowMonth();
    // 勾选发送区默认选最近有数据的月份，避免每次手点
    const latest = (data.months && data.months.length) ? data.months[0].pay_month : nowMonth();
    $('sMonth').value = latest;
    await loadSelect();
    return true;
  }

  $('pwLogin') && $('pwLogin').addEventListener('click', async () => {
    try {
      await PAuth.loginByPassword($('acct').value.trim(), $('pw').value);
      await ensureAdmin();
      $('gate').classList.add('hidden');
    } catch (err) {
      $('gateMsg').textContent = err.message;
    }
  });

  /* ---------------- 标签页 ---------------- */
  function bindTabs() {
    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        ['overview', 'import', 'list', 'roster', 'logs'].forEach((t) => $(`tab-${t}`).classList.add('hidden'));
        $(`tab-${btn.dataset.tab}`).classList.remove('hidden');
        if (btn.dataset.tab === 'logs') loadLogs();
        if (btn.dataset.tab === 'roster') loadRoster();
        if (btn.dataset.tab === 'overview') { loadOverview(); loadSelect(); }
        if (btn.dataset.tab === 'list') loadAudit();
      });
    });
  }

  /* ---------------- 概览 ---------------- */
  async function loadOverview() {
    renderOverview(await PAuth.api('/api/admin/overview'));
  }

  function renderOverview(data) {
    const cards = (data.months || []).map((m) => {
      const total = Number(m.total);
      const confirmed = Number(m.confirmed || 0);
      const sent = Number(m.sent || 0);
      const pending = Number(m.pending || 0);
      const rate = total ? Math.round((confirmed / total) * 100) : 0;
      return `
      <div class="card" style="margin-bottom:12px">
        <h2>${fmtMonth(m.pay_month)} <span class="sub">共 ${total} 人 · 实发合计 ￥${PAuth.money(m.total_net)}</span></h2>
        <div class="kpis">
          <div class="kpi"><div class="n">${pending}</div><div class="l">未发送</div></div>
          <div class="kpi warn"><div class="n">${sent}</div><div class="l">已发送未签收</div></div>
          <div class="kpi ok"><div class="n">${confirmed}</div><div class="l">已签收</div></div>
          <div class="kpi"><div class="n">${rate}%</div><div class="l">签收率</div></div>
        </div>
        <div class="form-row" style="margin-top:12px">
          <button class="btn primary" data-act="send" data-m="${m.pay_month}" ${pending > 0 ? '' : 'disabled'}>发送（${pending} 人）</button>
          <button class="btn" data-act="remind" data-m="${m.pay_month}" ${sent > 0 ? '' : 'disabled'}>催办未签收（${sent}）</button>
          <button class="btn" data-act="csv" data-m="${m.pay_month}">导出 CSV</button>
          <button class="btn" data-act="list" data-m="${m.pay_month}">看明细</button>
          <button class="btn danger" data-act="drop" data-m="${m.pay_month}" ${pending > 0 ? '' : 'disabled'}>删除未发送</button>
        </div>
      </div>`;
    });

    $('monthCards').innerHTML = cards.length
      ? cards.join('')
      : '<div class="hint">还没有任何月份的工资条，先去「导入工资表」上传 Excel。</div>';

    $('monthCards').querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', () => monthAction(b.dataset.act, b.dataset.m, b));
    });
  }

  async function monthAction(act, month, btn) {
    try {
      if (act === 'send') {
        const pendingCount = Number((await PAuth.api('/api/admin/payslips?month=' + month + '&status=pending')).rows.length);
        const personalized = window.confirm(
          `将向 ${pendingCount} 人发送 ${fmtMonth(month)} 工资条。\n\n「确定」= 每人一条卡片，内容显示各自的实发金额（150 人约需十几秒）\n「取消」= 发统一内容，金额只在点开后才可见（更快、更保密）`
        );
        btn.disabled = true;
        btn.textContent = '发送中…';
        const r = await PAuth.api('/api/admin/send', { method: 'POST', json: { month, personalized } });
        if (r.failed && r.failed.length) {
          const names = r.failed.slice(0, 8).map((x) => x.name).join('、');
          PAuth.toast(`成功 ${r.delivered} 人，失败 ${r.failed.length} 人：${names}${r.failed.length > 8 ? ' 等' : ''}`, true);
        } else {
          PAuth.toast(`已发送 ${r.delivered} 人`);
        }
        await loadOverview();
      } else if (act === 'remind') {
        const r = await PAuth.api('/api/admin/remind', { method: 'POST', json: { month } });
        PAuth.toast(r.target ? `已向 ${r.target} 人发催办` : r.note);
        await loadOverview();
      } else if (act === 'csv') {
        await downloadCsv(month);
      } else if (act === 'list') {
        document.querySelector('.tab[data-tab="overview"]').click();
        $('sMonth').value = month;
        $('sStatus').value = '';
        await loadSelect();
        document.querySelector('#tab-overview .card:last-child').scrollIntoView({ behavior: 'smooth' });
      } else if (act === 'drop') {
        const t = window.prompt(`删除 ${fmtMonth(month)} 所有「未发送」的工资条？此操作不可恢复。\n请输入 DELETE 确认：`, '');
        if (t !== 'DELETE') return PAuth.toast('已取消');
        const r = await PAuth.api('/api/admin/drop-pending', { method: 'POST', json: { month, confirmText: t } });
        PAuth.toast(`已删除 ${r.deleted} 条`);
        await loadOverview();
      }
    } catch (err) {
      PAuth.toast(err.message, true);
      if (btn) {
        btn.disabled = false;
      }
      await loadOverview().catch(() => {});
    }
  }

  async function downloadCsv(month) {
    const res = await fetch('/api/admin/export.csv?month=' + encodeURIComponent(month), {
      headers: { Authorization: 'Bearer ' + PAuth.token() }
    });
    if (!res.ok) {
      const t = await res.json().catch(() => ({}));
      throw new Error(t.error || '导出失败');
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `工资条台账-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------------- 导入 ---------------- */
  function bindImport() {
    const drop = $('drop');
    const fileInput = $('file');
    drop.addEventListener('click', () => fileInput.click());
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('on');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('on');
    }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setFile(f);
    });
    fileInput.addEventListener('change', () => fileInput.files[0] && setFile(fileInput.files[0]));
    $('btnPreview').addEventListener('click', doPreview);
    $('btnCommit').addEventListener('click', doCommit);
    $('btnTemplate').addEventListener('click', async () => {
      const res = await fetch('/api/admin/template.xlsx', { headers: { Authorization: 'Bearer ' + PAuth.token() } });
      if (!res.ok) return PAuth.toast('模板下载失败', true);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '工资表导入模板.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  function setFile(f) {
    state.file = f;
    $('fileName').textContent = `${f.name}（${(f.size / 1024).toFixed(0)} KB）`;
    $('btnPreview').disabled = false;
    $('btnCommit').disabled = true;
    $('previewOut').innerHTML = '';
  }

  async function uploadTo(path) {
    const fd = new FormData();
    fd.append('month', $('impMonth').value);
    fd.append('file', state.file, state.file.name);
    if (path === '/api/admin/import/commit') {
      fd.append('mode', document.querySelector('input[name=mode]:checked').value);
    }
    return PAuth.apiForm(path, fd);
  }

  async function doPreview() {
    if (!$('impMonth').value) return PAuth.toast('请先选工资月份', true);
    if (!state.file) return PAuth.toast('请先选择文件', true);
    $('btnPreview').disabled = true;
    $('btnPreview').textContent = '解析中…';
    try {
      const p = await uploadTo('/api/admin/import/preview');
      state.preview = p;
      renderPreview(p);
      $('btnCommit').disabled = p.rows.length === 0;
    } catch (err) {
      PAuth.toast(err.message, true);
    } finally {
      $('btnPreview').disabled = false;
      $('btnPreview').textContent = '预检';
    }
  }

  function renderPreview(p) {
    const s = p.summary;
    const html = [];
    html.push(
      `<div class="ok-line">可导入 <b>${s.ready}</b> 条（应发合计 ￥${PAuth.money(s.totalGross)}，实发合计 ￥${PAuth.money(s.totalNet)}）；` +
      `Excel 共 ${s.excelRows} 行，花名册 ${s.rosterSize} 人${s.warning ? `，其中 ${s.warning} 条存在 1 元内取整差异（已按你表内金额导入）` : ''}</div>`
    );
    if (p.unrecognizedHeaders && p.unrecognizedHeaders.length) {
      html.push(`<div class="hint" style="margin-top:8px">以下列未被识别，将被忽略：${p.unrecognizedHeaders.map(esc).join('、')}</div>`);
    }
    if (p.warnings && p.warnings.length) {
      html.push('<div class="problems">');
      html.push(p.warnings.map((x) => `<div class="warn"><span class="t">第${x.line}行 ${esc(x.name)}</span><span>${esc(x.message)}</span></div>`).join(''));
      html.push('</div>');
    }
    if (p.problems.length) {
      html.push('<div class="problems">');
      html.push(p.problems.map((x) => `<div class="problem"><span class="t">第${x.line}行 ${esc(x.name || '')}</span><span>${esc(x.message)}</span></div>`).join(''));
      html.push('</div>');
    }
    html.push('<div class="hint" style="margin-top:10px">确认无误后点「确认导入」。导入后状态为「未发送」，需回概览页点发送。</div>');
    $('previewOut').innerHTML = html.join('');
  }

  async function doCommit() {
    if (!state.file) return;
    if (!window.confirm(`确认把 ${fmtMonth($('impMonth').value)} 的工资条导入系统？`)) return;
    $('btnCommit').disabled = true;
    $('btnCommit').textContent = '导入中…';
    try {
      const r = await uploadTo('/api/admin/import/commit');
      PAuth.toast(`导入完成：新增 ${r.inserted}，覆盖 ${r.updated}，跳过 ${r.skipped}`);
      state.file = null;
      $('fileName').textContent = '支持 .xlsx / .xls / .csv，第一行需含「姓名」列';
      $('btnPreview').disabled = true;
      $('previewOut').innerHTML = '';
      await loadOverview();
    } catch (err) {
      PAuth.toast(err.message, true);
    } finally {
      $('btnCommit').textContent = '确认导入';
      $('btnCommit').disabled = false;
    }
  }

  function renderFieldDoc(fields) {
    if (!fields || !fields.length) return;
    const rows = fields.map((f) => {
      const rule = { add: '计入应发/代扣累加', minus: '从应发中减去', none: '仅展示，不参与累加', sub: '系统自动小计', total: '系统自动合计' }[f.agg];
      return `<tr><td>${esc(f.label)}</td><td>${{ income: '应发项', deduct: '代扣项', net: '合计' }[f.group]}</td><td>${rule}</td></tr>`;
    });
    $('fieldDoc').innerHTML =
      'Excel 表头用下面的名称即可自动识别（同义叫法、单元格内换行、斜杠与空格差异都能容错）。' +
      '系统会按规则精确累加做交叉校验，但**以你表内写的合计为准**（工资表是银行发放依据）：' +
      '差异 1 元以内视为取整，放行并黄字提醒；超过 1 元或表内三个合计自相矛盾，该行拦下。' +
      '<div class="table-scroll" style="margin-top:8px"><table class="grid"><tr><th>字段</th><th>分组</th><th>计算规则</th></tr>' +
      rows.join('') + '</table></div>';
  }

  /* ---------------- 勾选发送（概览与发送页） ---------------- */
  function bindSelect() {
    $('btnSQuery').addEventListener('click', loadSelect);
    $('selAll').addEventListener('click', () => toggleAll(true));
    $('selNone').addEventListener('click', () => toggleAll(false));
    $('selPending').addEventListener('click', () => {
      state.selected = new Set(state.listRows.filter((r) => r.status === 'pending').map((r) => r.user_id));
      paintSelection();
    });
    $('selInvert').addEventListener('click', () => {
      const next = new Set();
      for (const r of state.listRows) if (!state.selected.has(r.user_id)) next.add(r.user_id);
      state.selected = next;
      paintSelection();
    });
    $('btnSendSel').addEventListener('click', () => sendSelected('send'));
    $('btnRemindSel').addEventListener('click', () => sendSelected('remind'));
    $('btnResetSel').addEventListener('click', resetSelected);
  }

  /** 重置为未发送：改错重发或联调测试用，会清空发送时间与签收凭证 */
  async function resetSelected() {
    const ids = [...state.selected];
    if (!ids.length) return PAuth.toast('先勾选要重置的人', true);
    const month = $('sMonth').value;
    const picked = state.listRows.filter((r) => state.selected.has(r.user_id));
    const confirmed = picked.filter((r) => r.status === 'confirmed').length;
    const tip = `将把勾选的 ${ids.length} 人重置为「未发送」，可以重新发送。\n\n` +
      (confirmed ? `注意：其中 ${confirmed} 人已签收，重置会清空他们的签收时间和签收IP凭证！\n\n` : '') +
      '确定要重置吗？';
    if (!window.confirm(tip)) return;
    try {
      const r = await PAuth.api('/api/admin/reset-pending', { method: 'POST', json: { month, userIds: ids, confirm: true } });
      PAuth.toast(`已重置 ${r.reset} 人为未发送`);
      state.selected = new Set();
      await loadSelect();
      await loadOverview();
    } catch (err) {
      PAuth.toast(err.message, true);
    }
  }

  /* ---------------- 签收明细（只读查询 + 导出台账） ---------------- */
  function bindList() {
    $('btnQuery').addEventListener('click', loadAudit);
    $('btnCsv').addEventListener('click', () => {
      const m = $('qMonth').value;
      if (!m) return PAuth.toast('请先选月份', true);
      downloadCsv(m).catch((e) => PAuth.toast(e.message, true));
    });
  }

  function toggleAll(on) {
    state.selected = on ? new Set(state.listRows.map((r) => r.user_id)) : new Set();
    paintSelection();
  }

  function paintSelection() {
    document.querySelectorAll('#listTable input[data-ck]').forEach((cb) => {
      cb.checked = state.selected.has(cb.dataset.ck);
    });
    $('selCount').textContent = state.selected.size;
    const all = $('ckAll');
    if (all) {
      all.checked = state.listRows.length > 0 && state.listRows.every((r) => state.selected.has(r.user_id));
      all.indeterminate = state.selected.size > 0 && !all.checked;
    }
  }

  /** 部门下拉：带人数与未发送数，方便按部门挑人 */
  async function loadDeptOptions(selEl, month, keep) {
    if (!month) return;
    const { rows } = await PAuth.api('/api/admin/depts?month=' + encodeURIComponent(month));
    selEl.innerHTML = '<option value="">全部部门</option>' +
      rows.map((d) => `<option value="${esc(d.dept)}">${esc(d.dept)}（${d.total}人·未发送${Number(d.pending || 0)}）</option>`).join('');
    selEl.value = rows.some((d) => d.dept === keep) ? keep : '';
  }

  const STATUS_TEXT = { pending: '未发送', sent: '未签收', confirmed: '已签收' };

  function rowCells(r) {
    return `<td>${r.pay_month}</td><td>${esc(r.name)}</td><td>${esc(r.job_number || '')}</td><td>${esc(r.dept_name || '')}</td>
      <td class="hint">${esc(r.remark && r.remark !== 'null' ? r.remark : '')}</td>
      <td class="r">${PAuth.money(r.gross_amount)}</td><td class="r">${PAuth.money(r.deduct_amount)}</td>
      <td class="r"><b>${PAuth.money(r.net_amount)}</b></td>
      <td><span class="pill ${r.status}">${STATUS_TEXT[r.status] || r.status}</span></td>
      <td>${esc(r.sent_at || '')}</td><td>${esc(r.confirmed_at || '')}</td>`;
  }

  async function fetchList(month, status, dept, kw) {
    const p = new URLSearchParams();
    p.set('month', month);
    if (status) p.set('status', status);
    if (dept) p.set('dept', dept);
    if (kw) p.set('kw', kw);
    const { rows } = await PAuth.api('/api/admin/payslips?' + p.toString());
    return rows;
  }

  /** 概览页的可勾选表格 */
  async function loadSelect() {
    const month = $('sMonth').value;
    if (!month) return PAuth.toast('请先选月份', true);
    await loadDeptOptions($('sDept'), month, $('sDept').value);
    const rows = await fetchList(month, $('sStatus').value, $('sDept').value, $('sKw').value.trim());
    state.listRows = rows;
    // 筛选变化后只保留仍在列表里的勾选，避免选中了看不见的人
    const here = new Set(rows.map((r) => r.user_id));
    state.selected = new Set([...state.selected].filter((id) => here.has(id)));

    $('listTable').innerHTML =
      '<tr><th><input type="checkbox" id="ckAll"></th><th>月份</th><th>姓名</th><th>工号</th><th>部门</th><th>备注</th><th class="r">应发</th><th class="r">代扣</th><th class="r">实发</th><th>状态</th><th>发送时间</th><th>确认时间</th></tr>' +
      (rows.length
        ? rows.map((r) => `<tr><td><input type="checkbox" data-ck="${esc(r.user_id)}"></td>${rowCells(r)}</tr>`).join('')
        : '<tr><td colspan="12" class="hint">没有数据</td></tr>');

    $('ckAll').addEventListener('change', (e) => {
      state.selected = e.target.checked ? new Set(state.listRows.map((r) => r.user_id)) : new Set();
      paintSelection();
    });
    document.querySelectorAll('#listTable input[data-ck]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(cb.dataset.ck);
        else state.selected.delete(cb.dataset.ck);
        paintSelection();
      });
    });
    paintSelection();
  }

  /** 签收明细页的只读表格 */
  async function loadAudit() {
    const month = $('qMonth').value;
    if (!month) return PAuth.toast('请先选月份', true);
    await loadDeptOptions($('qDept'), month, $('qDept').value);
    const rows = await fetchList(month, $('qStatus').value, $('qDept').value, $('qKw').value.trim());
    $('auditTable').innerHTML =
      '<tr><th>月份</th><th>姓名</th><th>工号</th><th>部门</th><th>备注</th><th class="r">应发</th><th class="r">代扣</th><th class="r">实发</th><th>状态</th><th>发送时间</th><th>确认时间</th></tr>' +
      (rows.length
        ? rows.map((r) => `<tr>${rowCells(r)}</tr>`).join('')
        : '<tr><td colspan="11" class="hint">没有数据</td></tr>');
  }

  async function sendSelected(action) {
    const ids = [...state.selected];
    if (!ids.length) return PAuth.toast('先勾选要发送的人', true);
    const month = $('sMonth').value;
    const isSend = action === 'send';
    const tip = isSend
      ? `将向勾选的 ${ids.length} 人发送 ${fmtMonth(month)} 工资条。\n\n点「确定」= 每人一张带各自实发金额的卡片\n点「取消」= 发统一内容，金额只在点开后可见（更快更保密）`
      : `向勾选的 ${ids.length} 人发送催办提醒？`;
    const choice = window.confirm(tip);
    if (!choice) return;
    try {
      const body = { month, userIds: ids };
      if (isSend) body.personalized = choice;
      const r = await PAuth.api(`/api/admin/${action}`, { method: 'POST', json: body });
      if (r.failed && r.failed.length) {
        const ok = r.delivered != null ? r.delivered : r.target;
        PAuth.toast(`成功 ${ok} 人，失败 ${r.failed.length} 人：${r.failed.slice(0, 6).map((x) => x.name).join('、')}`, true);
      } else {
        PAuth.toast(r.target ? `${isSend ? '已发送' : '已催办'} ${r.target} 人` : r.note);
      }
      state.selected = new Set();
      await loadSelect();
      await loadOverview();
    } catch (err) {
      PAuth.toast(err.message, true);
    }
  }

  /* ---------------- 花名册 ---------------- */
  function bindRoster() {
    $('btnSync').addEventListener('click', async () => {
      $('btnSync').disabled = true;
      $('btnSync').textContent = '同步中…';
      try {
        const r = await PAuth.api('/api/admin/employees/sync', { method: 'POST' });
        PAuth.toast(`同步完成，共 ${r.synced} 人`);
        await loadRoster();
      } catch (err) {
        PAuth.toast(err.message, true);
      } finally {
        $('btnSync').disabled = false;
        $('btnSync').textContent = '从钉钉同步通讯录';
      }
    });
    $('btnRSearch').addEventListener('click', loadRoster);
  }

  async function loadRoster() {
    const kw = $('rKw').value.trim();
    const { rows } = await PAuth.api('/api/admin/employees?kw=' + encodeURIComponent(kw));
    $('rosterTable').innerHTML =
      '<tr><th>姓名</th><th>工号</th><th>部门</th><th>userId</th><th>状态</th><th></th></tr>' +
      (rows.length
        ? rows
            .map(
              (r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.job_number || '—')}</td><td>${esc(r.dept_name || '')}</td>
              <td class="hint">${esc(r.user_id)}</td><td>${r.active ? '在职' : '离职'}</td>
              <td><button class="btn" data-bind="${esc(r.user_id)}" data-jn="${esc(r.job_number || '')}">改工号</button></td></tr>`
            )
            .join('')
        : '<tr><td colspan="6" class="hint">没有数据，先点「从钉钉同步通讯录」</td></tr>');

    $('rosterTable').querySelectorAll('button[data-bind]').forEach((b) => {
      b.addEventListener('click', async () => {
        const v = window.prompt('给该员工设置工号（用于与 Excel 对账，可留空清除）：', b.dataset.jn === '—' ? '' : b.dataset.jn);
        if (v === null) return;
        try {
          await PAuth.api('/api/admin/employees/bind', { method: 'POST', json: { userId: b.dataset.bind, jobNumber: v.trim() } });
          PAuth.toast('已保存');
          await loadRoster();
        } catch (err) {
          PAuth.toast(err.message, true);
        }
      });
    });
  }

  /* ---------------- 日志 ---------------- */
  async function loadLogs() {
    const [a, b] = await Promise.all([PAuth.api('/api/admin/logs'), PAuth.api('/api/admin/send-logs')]);
    $('logTable').innerHTML =
      '<tr><th>时间</th><th>操作人</th><th>动作</th><th>详情</th><th>IP</th></tr>' +
      (a.rows.length
        ? a.rows.map((r) => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc(r.detail || '')}</td><td>${esc(r.ip || '')}</td></tr>`).join('')
        : '<tr><td colspan="5" class="hint">暂无记录</td></tr>');
    const fl = (s) => {
      try {
        const arr = JSON.parse(s || '[]');
        return arr
          .map((x) => `${x.name || (x.ids ? `${x.ids.length}人` : '')} ${x.reason || ''}`.trim())
          .join('；');
      } catch {
        return '';
      }
    };
    $('sendLogTable').innerHTML =
      '<tr><th>时间</th><th>月份</th><th>动作</th><th>人数</th><th>操作人</th><th>失败明细</th></tr>' +
      (b.rows.length
        ? b.rows
            .map(
              (r) => `<tr><td>${esc(r.created_at)}</td><td>${r.pay_month}</td><td>${r.action === 'send' ? '发送' : '催办'}</td>
              <td class="r">${r.target_count}</td><td>${esc(r.operator || '')}</td><td class="hint">${esc(fl(r.failed))}</td></tr>`
            )
            .join('')
        : '<tr><td colspan="6" class="hint">暂无发送记录</td></tr>');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
