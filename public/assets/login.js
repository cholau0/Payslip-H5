/**
 * 钉钉 H5 免登 + 会话管理（员工端与管理端共用）
 */
window.PAuth = (function () {
  const TOKEN_KEY = 'payslip_token';
  let metaCache = null;
  let logging = null;

  async function meta() {
    if (metaCache) return metaCache;
    metaCache = await fetch('/api/meta').then((r) => r.json());
    return metaCache;
  }

  const token = () => localStorage.getItem(TOKEN_KEY) || '';
  const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  function inDingTalk() {
    return /dingtalk/i.test(navigator.userAgent);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.dd) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('钉钉 JSAPI 加载失败，请检查 .env 里的 DING_JSAPI_URL 是否可用'));
      document.head.appendChild(s);
    });
  }

  /** 鉴权签名必须用钉钉里打开的完整地址（含 query、不含 hash） */
  function pageUrl() {
    return location.href.split('#')[0];
  }

  async function getAuthCode() {
    const m = await meta();
    await loadScript(m.jsapiUrl);
    if (!window.dd) throw new Error('dd 对象不可用');

    const sign = await fetch('/api/js-sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pageUrl() })
    }).then((r) => r.json());
    if (sign.error) throw new Error(sign.error);

    await new Promise((resolve, reject) => {
      window.dd.config({
        appId: sign.corpId,
        corpId: sign.corpId,
        agentId: sign.agentId,
        timeStamp: sign.timeStamp,
        nonceStr: sign.nonceStr,
        signature: sign.signature,
        type: 0,
        jsApiList: ['runtime.permission.requestAuthCode']
      });
      window.dd.ready(() => resolve());
      window.dd.error((err) => reject(new Error('钉钉鉴权失败：' + JSON.stringify(err))));
    });

    return new Promise((resolve, reject) => {
      window.dd.runtime.permission.requestAuthCode({
        corpId: sign.corpId,
        onSuccess: (res) => resolve(res && res.code),
        onFail: (err) => reject(new Error('免登失败：' + JSON.stringify(err)))
      });
    });
  }

  async function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then((r) => r.json());
  }

  /** 免登并换取会话；并发调用只跑一次 */
  async function login() {
    if (logging) return logging;
    logging = (async () => {
      const code = await getAuthCode();
      if (!code) throw new Error('未拿到免登 code');
      const r = await post('/api/auth/login', { code });
      if (r.error) throw new Error(r.error);
      setToken(r.token);
      return r.user;
    })();
    try {
      return await logging;
    } finally {
      logging = null;
    }
  }

  async function loginByPassword(account, password) {
    const r = await post('/api/auth/password', { account, password });
    if (r.error) throw new Error(r.error);
    setToken(r.token);
    return r.user;
  }

  async function loginDev(userId) {
    const r = await post('/api/auth/dev', { userId });
    if (r.error) throw new Error(r.error);
    setToken(r.token);
    return r.user;
  }

  /** 带鉴权的请求；401 时自动重新免登一次 */
  async function api(path, options = {}, retry = true) {
    const headers = Object.assign({}, options.headers);
    if (token()) headers.Authorization = 'Bearer ' + token();
    if (options.json) {
      headers['Content-Type'] = 'application/json';
      options = Object.assign({}, options, { body: JSON.stringify(options.json) });
      delete options.json;
    }
    const res = await fetch(path, Object.assign({}, options, { headers }));
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && retry && inDingTalk()) {
      clearToken();
      await login();
      return api(path, Object.assign({}, options, { headers }), false);
    }
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  /** 带文件的表单请求 */
  async function apiForm(path, formData, retry = true) {
    const headers = {};
    if (token()) headers.Authorization = 'Bearer ' + token();
    const res = await fetch(path, { method: 'POST', headers, body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && retry && inDingTalk()) {
      clearToken();
      await login();
      return apiForm(path, formData, false);
    }
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  function toast(msg, isErr) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isErr ? 3600 : 2200);
  }

  function money(n) {
    return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { meta, token, setToken, clearToken, inDingTalk, login, loginByPassword, loginDev, api, apiForm, toast, money, esc };
})();
