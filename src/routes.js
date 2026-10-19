const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const config = require('./config');
const dd = require('./dingtalk');
const db = require('./db');
const auth = require('./auth');
const importer = require('./importer');
const { FIELDS } = require('./fields');
const card = require('./card');

const router = express.Router();
const MONTH_RE = /^\d{4}-\d{2}$/;
/** Excel 直接读到内存解析，工资表体积很小，10MB 上限足够 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('只支持 .xlsx / .xls / .csv 文件'), ok);
  }
});

function bad(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

/**
 * 区分「可展示的业务提示」与「内部系统细节」。
 * SQL 报错、驱动错误码、堆栈片段一律屏蔽，只留通用文案，细节进服务端日志。
 * 钉钉接口返回的提示带「钉钉」字样，属 HR 排障需要的信息，予以保留。
 */
function clientMessage(err) {
  const m = err && err.message ? String(err.message) : '';
  if (!m) return '请求失败';
  if (/钉钉/.test(m)) return m;
  if (/SQL|syntax|ER_[A-Z_]|mysql|maria|sequelize|knex|at\s+\S+\s+\(|errno|EACCES|ENOENT|read ECONNRESET/i.test(m)) {
    return '服务处理失败，请稍后重试；若持续失败请联系管理员';
  }
  return m.slice(0, 200);
}

function guard(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[api]', req.method, req.path, err);
      const msg = clientMessage(err);
      bad(res, msg, err && err.name === 'DingError' ? 502 : 400);
    });
  };
}

function fmtMonth(m) {
  const [y, mo] = String(m).split('-');
  return `${y}年${Number(mo)}月`;
}

/* ---------------------------------------------------------------- 公共 */

router.get('/meta', (req, res) => {
  res.json({
    corpId: config.dd.corpId,
    agentId: config.dd.agentId,
    jsapiUrl: config.dd.jsapiUrl,
    devMode: config.auth.devMode,
    fields: FIELDS
  });
});

/** H5 免登鉴权签名：前端传当前页面完整 URL */
router.post('/js-sign', guard(async (req, res) => {
  const url = String((req.body && req.body.url) || '');
  /**
   * 只给本站域名下的页面签名。否则这个接口等于一个"签名 oracle"——
   * 任何人可拿它为本企业任意钓鱼页面签发合法的 dd.config 鉴权参数。
   */
  let target;
  let base;
  try {
    target = new URL(url);
    base = new URL(config.publicBaseUrl);
  } catch {
    return bad(res, 'url 参数不合法');
  }
  if (target.origin !== base.origin) return bad(res, 'url 与本站域名不一致，拒绝签名');
  res.json(await dd.signJsapi(url));
}));

router.post('/auth/login', guard(async (req, res) => {
  const code = String(req.body.code || '');
  if (!code) return bad(res, '缺少免登 code');
  res.json(await auth.loginByCode(code));
}));

router.post('/auth/password', guard(async (req, res) => {
  const result = await auth.loginByPassword(String(req.body.account || ''), String(req.body.password || ''));
  if (result.error) return bad(res, result.error, 401);
  // 必须用真实 req 记日志：伪造的 req 对象没有 req.ip，会把来访 IP 错记成 127.0.0.1
  req.user = result.user;
  auth.logAction(req, 'login_password', '口令登录成功');
  res.json(result);
}));

router.post('/auth/dev', guard(async (req, res) => {
  const result = await auth.loginDev(String(req.body.userId || ''));
  if (!result) return bad(res, '调试模式未开启（DEV_MODE=0）', 403);
  res.json(result);
}));

/* ---------------------------------------------------------------- 员工端 */

/** 当前会话身份（管理台水印与权限显隐用） */
router.get('/me/whoami', auth.requireLogin, (req, res) => {
  res.json({ user: req.user, canViewLogs: auth.canViewLogs(req.user) });
});

/** 我的月份列表（只返回自己的，userId 取自会话，不接受前端传入） */
router.get('/me/months', auth.requireLogin, guard(async (req, res) => {
  const rows = await db.q(
    `SELECT pay_month, status, net_amount, confirmed_at, sent_at
       FROM payslips WHERE user_id=? AND status<>'pending' ORDER BY pay_month DESC`,
    [req.user.userId]
  );
  res.json({ user: req.user, months: rows });
}));

router.get('/me/payslip', auth.requireLogin, guard(async (req, res) => {
  const month = String(req.query.month || '');
  let row;
  if (MONTH_RE.test(month)) {
    row = await db.one('SELECT * FROM payslips WHERE user_id=? AND pay_month=?', [req.user.userId, month]);
    if (!row) return bad(res, '没有该月份的工资条', 404);
  } else {
    row = await db.one(
      `SELECT * FROM payslips WHERE user_id=? AND status<>'pending' ORDER BY pay_month DESC LIMIT 1`,
      [req.user.userId]
    );
    if (!row) return bad(res, '暂时没有可查看的工资条', 404);
  }
  if (row.status === 'pending') return bad(res, '工资条尚未发放', 403);

  const s_items = db.parseItems(row.items) || {};
  res.json({
    user: req.user,
    fields: FIELDS,
    payslip: {
      payMonth: row.pay_month,
      name: row.name,
      deptName: row.dept_name,
      items: db.parseItems(row.items),
      gross: Number(row.gross_amount),
      deduct: Number(row.deduct_amount),
      net: Number(row.net_amount),
      status: row.status,
      sentAt: row.sent_at,
      confirmedAt: row.confirmed_at,
      remark: String(s_items.remark || '')
    }
  });
}));

/** 一键确认签收：记录时间、IP、设备，形成证据链 */
router.post('/me/confirm', auth.requireLogin, guard(async (req, res) => {
  const month = String(req.body.month || '');
  if (!MONTH_RE.test(month)) return bad(res, '月份格式不正确');

  const row = await db.one('SELECT * FROM payslips WHERE user_id=? AND pay_month=?', [req.user.userId, month]);
  if (!row) return bad(res, '没有该月份的工资条', 404);
  if (row.status === 'pending') return bad(res, '工资条尚未发放', 403);
  if (row.status === 'confirmed') {
    return res.json({ ok: true, already: true, confirmedAt: row.confirmed_at });
  }

  const ua = String(req.headers['user-agent'] || '').slice(0, 250);
  const ip = auth.clientIp(req);
  await db.run(
    `UPDATE payslips SET status='confirmed', confirmed_at=NOW(), confirm_ip=?, confirm_ua=?
       WHERE user_id=? AND pay_month=? AND status='sent'`,
    [ip, ua, req.user.userId, month]
  );
  const after = await db.one('SELECT confirmed_at FROM payslips WHERE user_id=? AND pay_month=?', [req.user.userId, month]);
  auth.logAction(req, 'confirm', `${month} 本人签收`);
  res.json({ ok: true, confirmedAt: after ? after.confirmed_at : null });
}));

/* ---------------------------------------------------------------- 管理端 */

router.get('/admin/overview', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const months = await db.q(
    `SELECT pay_month,
            COUNT(*) AS total,
            SUM(status='sent') AS sent,
            SUM(status='confirmed') AS confirmed,
            SUM(status='pending') AS pending,
            SUM(net_amount) AS total_net
       FROM payslips GROUP BY pay_month ORDER BY pay_month DESC`
  );
  const roster = await db.one('SELECT COUNT(*) AS n FROM employees WHERE active=1');
  res.json({ months, rosterSize: roster ? Number(roster.n) : 0 });
}));

router.get('/admin/depts', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const month = String(req.query.month || '');
  if (!MONTH_RE.test(month)) return bad(res, '请选择月份');
  const rows = await db.q(
    `SELECT COALESCE(NULLIF(dept_name, ''), '未分配部门') AS dept,
            COUNT(*) AS total,
            SUM(status='pending') AS pending,
            SUM(status='sent') AS sent,
            SUM(status='confirmed') AS confirmed
       FROM payslips WHERE pay_month=? GROUP BY dept ORDER BY total DESC`,
    [month]
  );
  res.json({ rows });
}));

router.get('/admin/payslips', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const { month, status, kw, dept } = req.query;
  const where = [];
  const params = [];
  if (MONTH_RE.test(String(month))) {
    where.push('pay_month=?');
    params.push(month);
  }
  if (['pending', 'sent', 'confirmed'].includes(String(status))) {
    where.push('status=?');
    params.push(status);
  }
  if (dept) {
    where.push("COALESCE(NULLIF(dept_name, ''), '未分配部门')=?");
    params.push(String(dept));
  }
  if (kw) {
    where.push('(name LIKE ? OR job_number LIKE ? OR dept_name LIKE ?)');
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
  }
  const sql = `SELECT id, pay_month, user_id, name, job_number, dept_name, gross_amount, deduct_amount, net_amount,
                      status, sent_at, confirmed_at,
                      JSON_UNQUOTE(JSON_EXTRACT(items, '$.remark')) AS remark
                 FROM payslips ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY pay_month DESC, name ASC LIMIT 2000`;
  const rows = await db.q(sql, params);
  res.json({ rows });
}));

/** 导入预检：不落库，返回可导入条数与问题清单 */
router.post('/admin/import/preview', auth.requireLogin, auth.requireAdmin, upload.single('file'), guard(async (req, res) => {
  const month = String(req.body.month || '');
  if (!req.file) return bad(res, '请选择 Excel 文件');
  if (!MONTH_RE.test(month)) return bad(res, '请选择工资月份');
  const preview = await importer.previewImport(req.file.buffer, month);
  preview.sourceFilename = req.file.originalname;
  res.json(preview);
}));

/**
 * 确认导入：重新解析一次上传的文件后落库（幂等，且避免依赖跨请求缓存）
 */
router.post('/admin/import/commit', auth.requireLogin, auth.requireAdmin, upload.single('file'), guard(async (req, res) => {
  const month = String(req.body.month || '');
  const mode = req.body.mode === 'skip' ? 'skip' : 'overwrite';
  if (!req.file) return bad(res, '请重新上传 Excel 文件');
  if (!MONTH_RE.test(month)) return bad(res, '请选择工资月份');

  const preview = await importer.previewImport(req.file.buffer, month);
  preview.sourceFilename = req.file.originalname;
  const result = await importer.commitImport(preview, mode, req.user.userId);
  auth.logAction(req, 'import', `${month} 导入 新增${result.inserted} 覆盖${result.updated} 跳过${result.skipped} 文件:${req.file.originalname}`);
  res.json({ ...result, ready: preview.rows.length, problems: preview.problems });
}));

router.post('/admin/send', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const month = String(req.body.month || '');
  const personalized = !!req.body.personalized;
  if (!MONTH_RE.test(month)) return bad(res, '月份格式不正确');

  // 支持只发给勾选到的人；不传 userIds 则发给该月全部待发送
  const picked = (Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String).filter(Boolean).slice(0, 500);
  const baseSql = `SELECT user_id, name, net_amount, JSON_UNQUOTE(JSON_EXTRACT(items, '$.remark')) AS remark
       FROM payslips WHERE pay_month=? AND status='pending'`;
  const rows = picked.length
    ? await db.q(`${baseSql} AND user_id IN (${picked.map(() => '?').join(',')}) ORDER BY name`, [month, ...picked])
    : await db.q(`${baseSql} ORDER BY name`, [month]);
  if (!rows.length) {
    return bad(res, picked.length ? '勾选的人里没有待发送的工资条（可能已发送过）' : '该月份没有待发送的工资条（可能已经发过了）');
  }

  const linkUrl = `${config.publicBaseUrl}/?month=${month}`;
  const tasks = [];
  const failed = [];

  if (personalized) {
    // 每人一条带金额的卡片，控制在 5 并发避免触发频率限制
    const queue = rows.slice();
    const workers = Array.from({ length: 5 }, async () => {
      while (queue.length) {
        const r = queue.shift();
        const md = card.payslipCard({ month, name: r.name, remark: r.remark });
        try {
          const one = await dd.sendWorkNotice({
            userIds: [r.user_id],
            title: `${fmtMonth(month)}工资条`,
            markdown: md,
            linkUrl
          });
          tasks.push(...one.tasks);
          failed.push(...one.failed.map((f) => ({ ...f, name: r.name })));
        } catch (err) {
          failed.push({ ids: [r.user_id], name: r.name, reason: err.message });
        }
        await new Promise((s) => setTimeout(s, 60));
      }
    });
    await Promise.all(workers);
  } else {
    const r = await dd.sendWorkNotice({
      userIds: rows.map((x) => x.user_id),
      title: `${fmtMonth(month)}工资条已发放`,
      markdown: card.genericCard({ month }),
      linkUrl
    });
    tasks.push(...r.tasks);
    failed.push(...r.failed);
  }

  // 异步接口返回成功只代表入队，查投递结果确认谁没收到
  const nameOf = new Map(rows.map((r) => [r.user_id, r.name]));
  const failedIds = new Set();
  if (tasks.length) {
    await new Promise((s) => setTimeout(s, 1500));
    for (const t of tasks) {
      try {
        const sr = await dd.getSendResult(t.taskId);
        for (const uid of sr.failed_user_list || []) failedIds.add(String(uid));
      } catch (err) {
        console.warn('[send] 查询投递结果失败（不影响已发出的消息）：', err.message);
      }
    }
  }
  for (const f of failed) for (const id of f.ids || []) failedIds.add(String(id));

  if (tasks.length) {
    await db.run(
      'INSERT INTO send_logs (pay_month, action, target_count, task_ids, failed, operator) VALUES (?,?,?,?,?,?)',
      [month, 'send', rows.length, tasks.map((t) => t.taskId).join(','), JSON.stringify(summarizeFailed(failedIds, nameOf)), req.user.userId]
    );
  }

  // 只把确实投递成功的人标记为已发送，失败的人保持未发送以便重发
  const okIds = rows.map((r) => r.user_id).filter((id) => !failedIds.has(String(id)));
  if (okIds.length) {
    const marks = okIds.map(() => '?').join(',');
    await db.run(
      `UPDATE payslips SET status='sent', sent_at=NOW() WHERE pay_month=? AND status='pending' AND user_id IN (${marks})`,
      [month, ...okIds]
    );
  }
  auth.logAction(req, 'send', `${month} 发送 成功${okIds.length} 失败${failedIds.size}`);

  res.json({
    target: rows.length,
    delivered: okIds.length,
    failed: [...failedIds].map((id) => ({ userId: id, name: nameOf.get(id) || id })),
    note: failedIds.size
      ? `${failedIds.size} 人投递失败，他们的状态仍是「未发送」，多为不在应用可见范围内，修正后可直接重发`
      : '全部发送成功'
  });
}));

/** 失败 userId 汇总成可读明细，供日志展示 */
function summarizeFailed(failedIds, nameOf) {
  return [...failedIds].map((id) => ({ count: 1, name: nameOf.get(id) || id, reason: '投递失败（多为不在应用可见范围内）' }));
}

/** 催办：只发给已发送但未签收的人 */
router.post('/admin/remind', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const month = String(req.body.month || '');
  if (!MONTH_RE.test(month)) return bad(res, '月份格式不正确');
  const picked = (Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String).filter(Boolean).slice(0, 500);
  const rows = picked.length
    ? await db.q(`SELECT user_id FROM payslips WHERE pay_month=? AND status='sent' AND user_id IN (${picked.map(() => '?').join(',')})`, [month, ...picked])
    : await db.q(`SELECT user_id FROM payslips WHERE pay_month=? AND status='sent'`, [month]);
  if (!rows.length) return res.json({ target: 0, note: '没有未签收的人，无需催办' });

  const result = await dd.sendWorkNotice({
    userIds: rows.map((r) => r.user_id),
    title: `请确认签收 ${fmtMonth(month)} 工资条`,
    markdown: card.remindCard({ month }),
    linkUrl: `${config.publicBaseUrl}/?month=${month}`,
    btnTitle: '去确认签收'
  });
  await db.run(
    'INSERT INTO send_logs (pay_month, action, target_count, task_ids, failed, operator) VALUES (?,?,?,?,?,?)',
    [month, 'remind', rows.length, result.tasks.map((t) => t.taskId).join(','), JSON.stringify(result.failed), req.user.userId]
  );
  auth.logAction(req, 'remind', `${month} 催办${rows.length}人`);
  res.json({ target: rows.length, failed: result.failed });
}));

/** 删除某月未发送的数据（只删 pending，已发送的保留证据） */
router.post('/admin/drop-pending', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const month = String(req.body.month || '');
  const yes = String(req.body.confirmText || '');
  if (!MONTH_RE.test(month)) return bad(res, '月份格式不正确');
  if (yes !== 'DELETE') return bad(res, '请输入 DELETE 以确认');
  const res2 = await db.run(`DELETE FROM payslips WHERE pay_month=? AND status='pending'`, [month]);
  auth.logAction(req, 'drop_pending', `${month} 删除未发送 ${res2.affectedRows} 条`);
  res.json({ deleted: res2.affectedRows });
}));

/**
 * 把选中的人重置为「未发送」，用于改错重发和联调测试。
 * 会一并清掉发送时间与签收凭证，所以必须显式确认；操作写入审计日志。
 */
router.post('/admin/reset-pending', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const month = String(req.body.month || '');
  const ids = (Array.isArray(req.body.userIds) ? req.body.userIds : []).map(String).filter(Boolean).slice(0, 500);
  if (!MONTH_RE.test(month)) return bad(res, '月份格式不正确');
  if (!ids.length) return bad(res, '请先勾选要重置的人');
  if (req.body.confirm !== true) return bad(res, '需要明确确认后才执行重置');

  const marks = ids.map(() => '?').join(',');
  // 先把被清除的签收凭证落到审计日志，避免"重置即销毁证据"
  const before = await db.q(
    `SELECT name, status, sent_at, confirmed_at, confirm_ip FROM payslips
      WHERE pay_month=? AND user_id IN (${marks}) AND status<>'pending'`,
    [month, ...ids]
  );
  const affected = await db.run(
    `UPDATE payslips SET status='pending', sent_at=NULL, confirmed_at=NULL, confirm_ip=NULL, confirm_ua=NULL
       WHERE pay_month=? AND user_id IN (${marks}) AND status<>'pending'`,
    [month, ...ids]
  );
  const evidence = before
    .filter((r) => r.status === 'confirmed')
    .map((r) => `${r.name}:${r.confirmed_at}@${r.confirm_ip || '-'}`)
    .join('; ')
    .slice(0, 400);
  auth.logAction(
    req,
    'reset_pending',
    `${month} 重置 ${affected.affectedRows} 人为未发送（选中 ${ids.length} 人）` +
      (evidence ? `；被清除的原签收凭证 -> ${evidence}` : '')
  );
  res.json({ reset: affected.affectedRows, note: '这些人的发送时间与签收记录已清空，可重新发送' });
}));

router.get('/admin/employees', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const kw = String(req.query.kw || '').trim();
  const rows = kw
    ? await db.q(
        `SELECT user_id, name, job_number, dept_name, active FROM employees
          WHERE name LIKE ? OR job_number LIKE ? ORDER BY active DESC, name LIMIT 500`,
        [`%${kw}%`, `%${kw}%`]
      )
    : await db.q('SELECT user_id, name, job_number, dept_name, active FROM employees ORDER BY active DESC, name LIMIT 1000');
  res.json({ rows });
}));

/** 从钉钉同步通讯录到本地花名册 */
router.post('/admin/employees/sync', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const list = await dd.syncContacts();
  if (!list.length) return bad(res, '没取到任何成员，请检查应用的通讯录读取权限');
  let affected = 0;
  await db.tx(async (conn) => {
    await conn.query('UPDATE employees SET active=0');
    for (const e of list) {
      await conn.query(
        `INSERT INTO employees (user_id, name, job_number, dept_name, mobile, active)
         VALUES (?,?,?,?,?,1)
         ON DUPLICATE KEY UPDATE name=VALUES(name), job_number=VALUES(job_number),
           dept_name=VALUES(dept_name), mobile=VALUES(mobile), active=1`,
        [e.userId, e.name, e.jobNumber || null, e.deptName || null, e.mobile || null]
      );
      affected++;
    }
  });
  auth.logAction(req, 'sync_contacts', `同步 ${affected} 人`);
  res.json({ synced: affected });
}));

/** 手工补/改工号（用于重名或钉钉里没填工号的人） */
router.post('/admin/employees/bind', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const userId = String(req.body.userId || '');
  const jobNumber = String(req.body.jobNumber || '').trim();
  if (!userId) return bad(res, '缺少 userId');
  const r = await db.run('UPDATE employees SET job_number=? WHERE user_id=?', [jobNumber || null, userId]);
  if (!r.affectedRows) return bad(res, '找不到该员工', 404);
  auth.logAction(req, 'bind_job_number', `${userId} -> ${jobNumber}`);
  res.json({ ok: true });
}));

/** 签收台账导出（CSV，带 BOM 防 Excel 乱码） */
router.get('/admin/export.csv', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const month = String(req.query.month || '');
  if (!MONTH_RE.test(month)) return bad(res, '请选择月份');
  const rows = await db.q('SELECT * FROM payslips WHERE pay_month=? ORDER BY name', [month]);
  const head = ['姓名', '工号', '部门', '备注', ...FIELDS.map((f) => f.label), '状态', '发送时间', '确认时间', '确认IP'];
  const statusText = { pending: '未发送', sent: '已发送未签收', confirmed: '已签收' };
  const lines = [head.join(',')];
  /** 防公式注入：=、+、-、@ 开头的单元格加前缀使其成为纯文本（Excel 打开才安全） */
  const csvCell = (v) => {
    const s = String(v == null ? '' : v);
    const guarded = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  for (const r of rows) {
    const items = db.parseItems(r.items);
    const cells = [
      r.name,
      r.job_number || '',
      r.dept_name || '',
      items.remark || '',
      ...FIELDS.map((f) => {
        const v = items[f.key];
        return v === undefined || v === null ? '' : Number(v).toFixed(f.decimals || 2);
      }),
      statusText[r.status] || r.status,
      r.sent_at || '',
      r.confirmed_at || '',
      r.confirm_ip || ''
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  auth.logAction(req, 'export', `${month} 导出 ${rows.length} 条`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${month}.csv"`);
  res.send('\ufeff' + lines.join('\r\n'));
}));

/** 下载导入模板 */
router.get('/admin/template.xlsx', auth.requireLogin, auth.requireAdmin, guard(async (req, res) => {
  const header = ['姓名', '工号', ...FIELDS.filter((f) => f.key !== 'name' && f.key !== 'job_number').map((f) => f.label), '备注'];
  const sample = ['张三', '1001', 10000, 5000, 1, 2000, 1000, 100, 100, 300, 200, 0, 0, 8700, 800, 500, 0, 60, 1360, 7340, '示例备注，可留空'];
  const ws = XLSX.utils.aoa_to_sheet([header, sample]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '工资表');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="payslip-template.xlsx"');
  res.send(buf);
}));

router.get('/admin/logs', auth.requireLogin, auth.requireAdmin, auth.requireLogViewer, guard(async (req, res) => {
  // 左连花名册把 userId 翻成姓名；离职或同步前的记录回退显示 userId
  const rows = await db.q(
    `SELECT l.actor, e.name, e.job_number, e.dept_name, l.action, l.detail, l.ip, l.created_at
       FROM admin_logs l LEFT JOIN employees e ON e.user_id = l.actor
      ORDER BY l.id DESC LIMIT 200`
  );
  res.json({ rows });
}));

router.get('/admin/send-logs', auth.requireLogin, auth.requireAdmin, auth.requireLogViewer, guard(async (req, res) => {
  const rows = await db.q(
    `SELECT s.pay_month, s.action, s.target_count, s.failed, s.operator, e.name, s.created_at
       FROM send_logs s LEFT JOIN employees e ON e.user_id = s.operator
      ORDER BY s.id DESC LIMIT 100`
  );
  res.json({ rows });
}));

module.exports = router;
