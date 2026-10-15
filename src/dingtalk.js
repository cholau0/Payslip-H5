const crypto = require('crypto');
const config = require('./config');

const OAPI = config.dd.oapi;

/** 进程内缓存 access_token / jsapi_ticket，避免频繁换取被限流 */
const cache = { token: null, tokenExp: 0, ticket: null, ticketExp: 0 };

class DingError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = 'DingError';
    this.errcode = payload && payload.errcode;
    this.payload = payload;
  }
}

/** 统一带超时与重试的请求：钉钉偶发抖动时不至于让整批发放中断 */
async function fetchJson(url, options = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(15000) }, options));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new DingError(`钉钉接口 HTTP ${res.status}: ${JSON.stringify(data)}`, data);
      return data;
    } catch (err) {
      lastErr = err;
      const retryable = err.name === 'TimeoutError' || err.name === 'AbortError' ||
        ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(err.code) ||
        (err.cause && ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(err.cause.code));
      if (!retryable || i === attempts - 1) break;
      await new Promise((s) => setTimeout(s, 400 * (i + 1)));
    }
  }
  throw new DingError(`请求钉钉失败：${lastErr && lastErr.message ? lastErr.message : '未知网络错误'}`);
}

async function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

async function getJson(url) {
  return fetchJson(url);
}

/** 企业内部应用 access_token，有效期 7200s，提前 5 分钟刷新 */
async function getToken(force = false) {
  if (!force && cache.token && Date.now() < cache.tokenExp) return cache.token;
  const url = `${OAPI}/gettoken?appkey=${encodeURIComponent(config.dd.appKey)}&appsecret=${encodeURIComponent(config.dd.appCredential)}`;
  const data = await getJson(url);
  if (data.errcode !== 0) throw new DingError('获取 access_token 失败：' + data.errmsg, data);
  cache.token = data.access_token;
  cache.tokenExp = Date.now() + (data.expires_in || 7200) * 1000 - 5 * 60 * 1000;
  return cache.token;
}

/** 调用 oapi 接口，自动带 token，errcode 非 0 抛错 */
async function apiCall(pathName, body) {
  const token = await getToken();
  const data = await postJson(`${OAPI}${pathName}?access_token=${encodeURIComponent(token)}`, body);
  if (data.errcode !== 0) {
    // token 失效类错误强制刷新后重试一次
    if ([40014, 42001, 40001].includes(data.errcode)) {
      const fresh = await getToken(true);
      const retry = await postJson(`${OAPI}${pathName}?access_token=${encodeURIComponent(fresh)}`, body);
      if (retry.errcode === 0) return retry;
      throw new DingError(`调用 ${pathName} 失败：${retry.errmsg}`, retry);
    }
    throw new DingError(`调用 ${pathName} 失败：${data.errmsg}`, data);
  }
  return data;
}

async function getJsapiTicket() {
  if (cache.ticket && Date.now() < cache.ticketExp) return cache.ticket;
  const token = await getToken();
  const data = await getJson(`${OAPI}/get_jsapi_ticket?access_token=${encodeURIComponent(token)}`);
  if (data.errcode !== 0) throw new DingError('获取 jsapi_ticket 失败：' + data.errmsg, data);
  cache.ticket = data.ticket;
  cache.ticketExp = Date.now() + (data.expires_in || 7200) * 1000 - 5 * 60 * 1000;
  return cache.ticket;
}

/**
 * H5 免登鉴权签名
 * 注意：url 必须是前端当前页面完整地址（含 query，不含 #hash），且与钉钉里打开的地址一致
 */
async function signJsapi(url) {
  const ticket = await getJsapiTicket();
  const nonceStr = crypto.randomBytes(8).toString('hex');
  const timeStamp = Math.floor(Date.now() / 1000);
  const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timeStamp}&url=${url}`;
  const signature = crypto.createHash('sha1').update(raw).digest('hex');
  return {
    corpId: config.dd.corpId,
    agentId: config.dd.agentId,
    timeStamp: String(timeStamp),
    nonceStr,
    signature,
    jsapiUrl: config.dd.jsapiUrl
  };
}

/** 免登：前端拿到的 code 换 userId */
async function userFromCode(code) {
  const data = await apiCall('/topapi/v2/user/getuserinfo', { code });
  const r = data.result || {};
  if (!r.userid) throw new DingError('免登失败：未返回 userid', data);
  return { userId: r.userid, name: r.name || '' };
}

/** 用户详情（拿工号、部门，用于管理员白名单判断） */
async function userDetail(userId) {
  const data = await apiCall('/topapi/v2/user/get', { userid: userId });
  const r = data.result || {};
  return {
    userId: r.userid,
    name: r.name,
    jobNumber: r.job_number || '',
    deptIdList: r.dept_id_list || [],
    mobile: r.mobile || '',
    avatar: r.avatar || '',
    active: r.active === undefined ? true : !!r.active,
    title: r.title || ''
  };
}

/** 递归取全部部门 */
async function allDepartments() {
  const out = [];
  async function walk(parentId) {
    const data = await apiCall('/topapi/v2/department/listsub', { dept_id: parentId });
    const list = data.result || [];
    for (const d of list) {
      out.push(d);
      await walk(d.dept_id);
    }
  }
  out.push({ dept_id: 1, name: '根部门' });
  await walk(1);
  return out;
}

/**
 * 钉钉「工号」字段常被误填成入职日期（实测有人是 2017-08-22 00:00:00）。
 * 日期形态一律视为无效工号置空，避免污染匹配和界面展示；
 * 等 HR 整理完通讯录，重新同步即可自动恢复。
 */
const { cleanJobNumber } = require('./fields');

/** 同步通讯录：返回扁平员工列表（含部门名） */
async function syncContacts() {
  const depts = await allDepartments();
  const deptName = new Map(depts.map((d) => [d.dept_id, d.name]));
  const seen = new Map();

  for (const d of depts) {
    let cursor = 0;
    const size = 100;
    for (;;) {
      // 该接口的分页参数是 cursor（不是 offset），首页传 0
      const data = await apiCall('/topapi/v2/user/list', { dept_id: d.dept_id, cursor, size });
      const r = data.result || {};
      for (const u of r.list || []) {
        if (seen.has(u.userid)) continue;
        seen.set(u.userid, {
          userId: u.userid,
          name: u.name || '',
          jobNumber: cleanJobNumber(u.job_number),
          deptName: (u.dept_id_list || []).map((id) => deptName.get(id)).filter(Boolean).join(' / ') || d.name,
          mobile: u.mobile || '',
          avatar: u.avatar || '',
          active: true
        });
      }
      if (!r.has_more) break;
      cursor += size;
      if (cursor > 50000) break; // 防御死循环
    }
  }
  return Array.from(seen.values());
}

/**
 * 发送工作通知（ActionCard 卡片，点击进 H5）
 * userid_list 单次上限 100 人，超出自动分批
 * 注意：这是异步接口，返回成功只代表入队，真实投递结果要用 getSendResult 查
 * @returns {{tasks:Array<{taskId:string, ids:string[]}>, failed:Array}}
 */
async function sendWorkNotice({ userIds, title, markdown, linkUrl, btnTitle }) {
  const tasks = [];
  const failed = [];
  const chunks = [];
  for (let i = 0; i < userIds.length; i += 100) chunks.push(userIds.slice(i, i + 100));

  for (const chunk of chunks) {
    const body = {
      agent_id: Number(config.dd.agentId),
      userid_list: chunk.join(','),
      to_all_user: false,
      msg: {
        msgtype: 'action_card',
        action_card: {
          title,
          markdown,
          single_title: btnTitle || '查看并确认签收',
          single_url: linkUrl
        }
      }
    };
    try {
      const data = await apiCall('/topapi/message/corpconversation/asyncsend_v2', body);
      tasks.push({ taskId: String(data.task_id), ids: chunk.slice() });
    } catch (err) {
      failed.push({ ids: chunk.slice(), reason: err.message });
    }
  }
  return { tasks, failed };
}

/**
 * 查询某次工作通知的投递结果
 * 刚发完可能还没算好，调用方需容忍空结果
 */
async function getSendResult(taskId) {
  const data = await apiCall('/topapi/message/corpconversation/getsendresult', {
    agent_id: Number(config.dd.agentId),
    task_id: Number(taskId)
  });
  return data.send_result || {};
}

module.exports = {
  DingError,
  getToken,
  apiCall,
  signJsapi,
  userFromCode,
  userDetail,
  syncContacts,
  sendWorkNotice,
  getSendResult
};
