const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const dd = require('./dingtalk');
const { one, run, q } = require('./db');

function signToken(payload) {
  return jwt.sign(payload, config.auth.sessionKey, { expiresIn: `${config.auth.ttlHours}h` });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.auth.sessionKey);
  } catch {
    return null;
  }
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  // 不接受 URL 携带令牌：会进 nginx/ESA 访问日志，泄露后可被重放
  return null;
}

function isAdminJobNumber(jobNumber) {
  if (!jobNumber) return false;
  return config.auth.adminJobNumbers.includes(String(jobNumber).trim());
}

function isAdminUserId(userId) {
  if (!userId) return false;
  return config.auth.adminUserIds.includes(String(userId).trim());
}

function isAdminIdentity({ userId, jobNumber }) {
  return isAdminUserId(userId) || isAdminJobNumber(jobNumber);
}

/**
 * 免登登录：钉钉 code -> userId -> 补全身份 -> 签发会话
 * 管理员工号在白名单里则同时授予 admin 角色
 */
async function loginByCode(code) {
  const { userId } = await dd.userFromCode(code);
  let detail = null;
  try {
    detail = await dd.userDetail(userId);
  } catch (err) {
    console.warn('[auth] 取用户详情失败，降级为仅 userId：', err.message);
  }

  // 详情接口偶发失败时，用本地花名册兜底
  let jobNumber = detail ? detail.jobNumber : '';
  let name = detail ? detail.name : '';
  if (!jobNumber) {
    const local = await one('SELECT name, job_number FROM employees WHERE user_id=?', [userId]);
    if (local) {
      jobNumber = local.job_number || '';
      name = name || local.name;
    }
  }

  const role = isAdminIdentity({ userId, jobNumber }) ? 'admin' : 'employee';
  const token = signToken({ userId, name, jobNumber, role });
  return { token, user: { userId, name, jobNumber, role } };
}

/**
 * 口令登录（电脑浏览器用）。账号可以是工号，也可以是姓名。
 * 必须同时满足：账号能在花名册里唯一定位 + 该人在管理员白名单内 + 口令正确，
 * 这样审计日志记的是真实身份，而不是一个笼统的 password-admin。
 */
async function loginByPassword(account, password) {
  if (!config.auth.adminPassword) return { error: '未启用口令登录，请在钉钉里使用' };
  // 常数时间比较，避免口令逐字符比对的时序侧信道
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(config.auth.adminPassword);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: '口令不正确' };
  const acc = String(account || '').trim();
  if (!acc) return { error: '请输入工号或姓名' };

  let emp = await one('SELECT user_id, name, job_number FROM employees WHERE job_number=? AND active=1', [acc]);
  if (!emp) {
    const byName = await q('SELECT user_id, name, job_number FROM employees WHERE name=? AND active=1', [acc]);
    if (byName.length > 1) return { error: `花名册里有 ${byName.length} 个「${acc}」，请改用工号登录` };
    emp = byName[0] || null;
  }
  if (!emp) return { error: '花名册里找不到该工号或姓名' };
  if (!isAdminIdentity({ userId: emp.user_id, jobNumber: emp.job_number })) {
    return { error: '该账号不在管理员白名单内' };
  }

  const token = signToken({ userId: emp.user_id, name: emp.name, jobNumber: emp.job_number || '', role: 'admin' });
  return { token, user: { userId: emp.user_id, name: emp.name, jobNumber: emp.job_number || '', role: 'admin' } };
}

/** 调试登录：仅 DEV_MODE=1 时可用 */
function loginDev(userId) {
  if (!config.auth.devMode) return null;
  return loginByKnownUser(userId);
}

/** 用本地花名册构造会话（调试用） */
async function loginByKnownUser(userId) {
  const local = await one('SELECT name, job_number FROM employees WHERE user_id=?', [userId]);
  const jobNumber = local ? local.job_number || '' : '';
  const role = isAdminIdentity({ userId, jobNumber }) ? 'admin' : 'employee';
  const token = signToken({ userId, name: local ? local.name : userId, jobNumber, role });
  return { token, user: { userId, name: local ? local.name : userId, jobNumber, role } };
}

function requireLogin(req, res, next) {
  const payload = readToken(req);
  const user = payload ? verifyToken(payload) : null;
  if (!user) return res.status(401).json({ error: '登录已过期，请在钉钉里重新打开' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要 HR 管理员权限' });
  }
  next();
}

async function logAction(req, action, detail) {
  const actor = req.user ? req.user.userId : 'anonymous';
  const ip = clientIp(req);
  try {
    await run('INSERT INTO admin_logs (actor, action, detail, ip) VALUES (?,?,?,?)', [
      actor,
      action,
      String(detail || '').slice(0, 500),
      ip
    ]);
  } catch (err) {
    console.error('[auth] 写操作日志失败：', err.message);
  }
}

/** 取真实来访 IP（Nginx 反代场景，trust proxy=1 时 req.ip 已是可信的客户端 IP） */
function clientIp(req) {
  // 优先用 Express 解析过的 req.ip；直连且未启用 trust proxy 时回退 socket 地址
  if (req.ip) return String(req.ip).replace('::ffff:', '');
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

module.exports = {
  signToken,
  verifyToken,
  loginByCode,
  loginByPassword,
  loginDev,
  loginByKnownUser,
  requireLogin,
  requireAdmin,
  logAction,
  clientIp,
  isAdminJobNumber,
  isAdminUserId,
  isAdminIdentity
};
