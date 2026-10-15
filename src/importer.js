const XLSX = require('xlsx');
const { matchHeader, computeTotals, auditTotals, toNumber, cleanJobNumber } = require('./fields');

/**
 * 解析工资表 Excel
 * 规则：自动定位表头行（含「姓名」的那一行），按别名映射列，识别不了的列忽略
 * @param {Buffer} buffer 文件内容
 * @returns {{headerRow:number, columns:Object, rawRows:Array[]}}
 */
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', blankrows: false });
  if (!aoa.length) throw new Error('Excel 里没有数据');

  // 找表头行：优先含「姓名」，其次含「实发」
  let headerIdx = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const cells = aoa[i].map((c) => matchHeader(c));
    if (cells.includes('name')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
      if (aoa[i].some((c) => matchHeader(c) === 'net')) {
        headerIdx = i;
        break;
      }
    }
  }
  if (headerIdx === -1) {
    throw new Error('没找到表头行：Excel 里必须有「姓名」列（用于识别员工）');
  }

  const columns = {}; // 列下标 -> 字段key
  aoa[headerIdx].forEach((cell, idx) => {
    const key = matchHeader(cell);
    if (key) columns[idx] = key;
  });

  const recognized = Object.values(columns);
  if (!recognized.includes('name')) {
    throw new Error('表头里没有「姓名」列，无法把工资条对应到人');
  }

  const rawRows = aoa.slice(headerIdx + 1).filter((row) => row.some((c) => String(c).trim() !== ''));
  return { sheetName, headerRow: headerIdx + 1, columns, rawRows, headerCells: aoa[headerIdx], recognized };
}

function rowToItems(row, columns) {
  const items = {};
  for (const [idx, key] of Object.entries(columns)) {
    const raw = row[Number(idx)];
    if (raw === '' || raw === undefined || raw === null) continue;
    if (key === 'job_number') {
      const j = cleanJobNumber(raw);
      if (j) items[key] = j;
      continue;
    }
    items[key] = key === 'name' || key === 'remark' ? String(raw).trim() : toNumber(raw);
  }
  return items;
}

/**
 * 把一行匹配到员工
 *
 * 顺序以「姓名」为主：实测钉钉通讯录的工号字段被填成了入职日期、工资表里工号列又大多为空，
 * 工号当前不可靠。所以先按姓名唯一定位，只有重名时才要求用工号消歧；
 * 姓名完全找不到时，才退回用工号兜底（应对姓名带空格、繁简不一致等情况）。
 */
async function resolveEmployee(items, roster) {
  const name = String(items.name || '').trim();
  const jobNumber = String(items.job_number || '').trim();

  if (!name) {
    if (jobNumber && roster.byJob.has(jobNumber)) {
      return { emp: roster.byJob.get(jobNumber), how: 'job' };
    }
    return { emp: null, reason: '该行没有姓名，无法匹配到人', name: '' };
  }

  const list = roster.byName.get(name) || [];
  if (list.length === 1) return { emp: list[0], how: 'name' };

  if (list.length > 1) {
    if (jobNumber) {
      const hit = list.filter((e) => String(e.job_number || '').trim() === jobNumber);
      if (hit.length === 1) return { emp: hit[0], how: 'job' };
      return { emp: null, name, reason: `「${name}」有 ${list.length} 个重名，且工号 ${jobNumber} 无法唯一对应，请核对工号` };
    }
    return { emp: null, name, reason: `「${name}」在花名册里有 ${list.length} 个人重名，必须补工号才能区分，请去花名册页补` };
  }

  // 姓名没找到，退回工号兜底
  if (jobNumber && roster.byJob.has(jobNumber)) return { emp: roster.byJob.get(jobNumber), how: 'job' };
  return { emp: null, name, reason: `花名册里找不到「${name}」，请先同步通讯录或核对姓名写法` };
}

/** 载入花名册索引（工号先清洗，日期形态一律忽略；工号重复的视为不可用，避免匹配错人） */
async function loadRoster(db) {
  const rows = await db.q('SELECT user_id, name, job_number, dept_name FROM employees WHERE active=1');
  const byJob = new Map();
  const byName = new Map();
  for (const r of rows) {
    const jn = cleanJobNumber(r.job_number);
    if (jn) {
      if (byJob.has(jn)) byJob.delete(jn); // 工号撞号，宁可不用
      else byJob.set(jn, r);
    }
    const key = String(r.name || '').trim();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }
  return { byJob, byName, total: rows.length };
}

/**
 * 导入预检（不落库）：返回可导入行数、问题清单，供 HR 确认
 * @param {Buffer} buffer
 * @param {string} payMonth YYYY-MM
 */
async function previewImport(buffer, payMonth) {
  const db = require('./db');
  if (!/^\d{4}-\d{2}$/.test(payMonth)) throw new Error('工资月份格式应为 YYYY-MM，例如 2026-09');

  const { columns, rawRows, headerCells, recognized, sheetName, headerRow } = parseWorkbook(buffer);
  const roster = await loadRoster(db);

  const ok = [];
  const problems = [];
  const warnings = [];

  for (let i = 0; i < rawRows.length; i++) {
    const excelLine = headerRow + i + 1;
    const items = rowToItems(rawRows[i], columns);
    const name = String(items.name || '').trim();

    // 全空行或合计行跳过
    if (!name) {
      const looksTotal = rawRows[i].some((c) => /合计|总计|小计/.test(String(c)));
      if (looksTotal) continue;
      problems.push({ line: excelLine, name: '', type: 'no_name', message: '缺少姓名，已跳过' });
      continue;
    }

    const t = computeTotals(items);
    const audit = auditTotals(t);
    const resolved = await resolveEmployee(items, roster);

    // 人员匹配问题与金额硬差异一次全报出来，避免改一轮才露一轮
    const blockers = [];
    if (!resolved.emp) blockers.push(resolved.reason);
    if (audit.hard.length) blockers.push(audit.hard.join('；'));
    if (blockers.length) {
      problems.push({
        line: excelLine,
        name,
        type: resolved.emp ? 'math' : 'unmatched',
        message: blockers.join('；')
      });
      continue;
    }
    // 1 元以内的差异是 Excel 取整，放行但提醒复核
    if (audit.soft.length) warnings.push({ line: excelLine, name, type: 'rounding', message: audit.soft.join('；') });

    ok.push({
      line: excelLine,
      userId: resolved.emp.user_id,
      name: resolved.emp.name,
      jobNumber: resolved.emp.job_number || items.job_number || '',
      deptName: resolved.emp.dept_name || '',
      items: t.items,
      gross: t.gross,
      deduct: t.deduct,
      net: t.net,
      matchedBy: resolved.how,
      remark: t.items.remark || ''
    });
  }

  const dupCheck = new Map();
  for (const r of ok) {
    if (dupCheck.has(r.userId)) {
      problems.push({
        line: r.line,
        name: r.name,
        type: 'duplicate',
        message: `同一月份里 ${r.name} 出现了两次（第 ${dupCheck.get(r.userId)} 行和本行），已跳过后一条`
      });
    } else {
      dupCheck.set(r.userId, r.line);
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const r of ok) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    deduped.push(r);
  }

  const sum = deduped.reduce((acc, r) => ({ gross: acc.gross + r.gross, net: acc.net + r.net }), { gross: 0, net: 0 });

  return {
    payMonth,
    sheetName,
    headerRow,
    unrecognizedHeaders: headerCells
      .map((c, idx) => (columns[idx] ? null : String(c).trim()))
      .filter((s) => s && !/^[\d.\s]+$/.test(s)),
    recognizedFields: recognized,
    rows: deduped,
    problems,
    warnings,
    summary: {
      excelRows: rawRows.length,
      ready: deduped.length,
      problem: problems.length,
      warning: warnings.length,
      totalGross: Math.round(sum.gross * 100) / 100,
      totalNet: Math.round(sum.net * 100) / 100,
      rosterSize: roster.total
    }
  };
}

/**
 * 确认导入（落库）
 * @param {string} mode 'overwrite' 覆盖同月已有人 | 'skip' 跳过已存在
 */
async function commitImport(preview, mode = 'overwrite', operator = '') {
  const db = require('./db');
  const month = preview.payMonth;

  const existing = await db.q('SELECT user_id FROM payslips WHERE pay_month=?', [month]);
  const existingSet = new Set(existing.map((r) => r.user_id));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  await db.tx(async (conn) => {
    const [batchRes] = await conn.query(
      'INSERT INTO import_batches (pay_month, filename, total_rows, ok_rows, operator) VALUES (?,?,?,?,?)',
      [month, preview.sourceFilename || null, preview.summary.excelRows, preview.rows.length, operator || null]
    );
    const batchId = batchRes.insertId;

    for (const r of preview.rows) {
      const exists = existingSet.has(r.userId);
      if (exists && mode === 'skip') {
        skipped++;
        continue;
      }
      await conn.query(
        `INSERT INTO payslips
           (pay_month, user_id, name, job_number, dept_name, items, gross_amount, deduct_amount, net_amount, status, batch_id)
         VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)
         ON DUPLICATE KEY UPDATE
           name=VALUES(name), job_number=VALUES(job_number), dept_name=VALUES(dept_name),
           items=VALUES(items), gross_amount=VALUES(gross_amount), deduct_amount=VALUES(deduct_amount),
           net_amount=VALUES(net_amount), status='pending', sent_at=NULL, confirmed_at=NULL,
           confirm_ip=NULL, confirm_ua=NULL, batch_id=VALUES(batch_id)`,
        [
          month,
          r.userId,
          r.name,
          r.jobNumber || null,
          r.deptName || null,
          JSON.stringify(r.items),
          r.gross,
          r.deduct,
          r.net,
          batchId
        ]
      );
      if (exists) updated++;
      else inserted++;
    }

    await conn.query('UPDATE import_batches SET ok_rows=? WHERE id=?', [inserted + updated, batchId]);
    preview.batchId = batchId;
  });

  return { inserted, updated, skipped, batchId: preview.batchId };
}

module.exports = { parseWorkbook, previewImport, commitImport, loadRoster };
