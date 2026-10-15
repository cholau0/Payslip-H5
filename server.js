const path = require('path');
const dns = require('dns');
const express = require('express');
const config = require('./src/config');
const routes = require('./src/routes');

/**
 * 服务器 IPv6 路由不通时，Node 20 默认的双栈并发连接会先等 IPv6 超时（ETIMEDOUT），
 * 导致偶发调用钉钉失败。强制 DNS 优先返回 IPv4。
 */
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (err) {
  console.warn('[warn] 设置 dns 解析顺序失败：', err.message);
}

const app = express();
app.disable('x-powered-by');
// 只信任 Nginx 反代这一跳，防止客户端伪造 X-Forwarded-For
// 绕过登录限流、污染审计/签收 IP（true 会信任任意跳数）
app.set('trust proxy', 1); // Nginx 反代下取真实 IP

// 基础安全响应头
const jsapiOrigin = (() => {
  try { return new URL(config.dd.jsapiUrl).origin; } catch { return 'https://g.alicdn.com'; }
})();
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // 页面只加载同源资源与钉钉官方 CDN 脚本，压制 XSS 后果（令牌存 localStorage）
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' ${jsapiOrigin}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'`
  );
  next();
});

/** 登录类接口简易限流，防爆破（key 用 req.ip，伪造 XFF 已被 trust proxy=1 挡住） */
const hits = new Map();
// 每条限流记录 2 分钟后过期，避免 Map 无限增长
const HIT_TTL = 120_000;
function loginLimit(req, res, next) {
  const key = `${req.ip}|${req.path}`;
  const now = Date.now();
  // 惰性清理过期记录，避免整表清空被攻击者利用刷掉他人限流状态
  if (hits.size > 1000) {
    for (const [k, v] of hits) {
      if (now - v.start > HIT_TTL) hits.delete(k);
    }
  }
  const rec = hits.get(key) || { count: 0, start: now };
  if (now - rec.start > 60_000) {
    rec.count = 0;
    rec.start = now;
  }
  rec.count++;
  hits.set(key, rec);
  if (rec.count > 20) return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
  next();
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/**
 * 工资数据接口一律禁止缓存。
 * 域名走 ESA/CDN 时，若边缘缓存了某个员工的响应，可能把 A 的工资条返回给 B，
 * 这里显式下发 no-store，让任何中间缓存都无法留存响应。
 */
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use('/api/auth', loginLimit);
app.use('/api', routes);

/**
 * 静态资源不缓存，靠文件名上的 ?v= 版本号做更新（见 public/*.html）。
 * 域名走 ESA/CDN 时，.js/.css 默认会被边缘缓存，不设这个会导致
 * 前端改了但 HR 浏览器里还是旧脚本，排查时极易误判成后端问题。
 */
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || !/\.(js|css|png|ico|svg|woff2?)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=300');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));

// 兜底：非 /api 的未知路径回员工端
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 统一错误处理（multer 的文件校验错误也走这里）
// 生产环境不回显内部错误细节，避免泄露堆栈/SQL/内网信息
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server]', err.message);
  const status = err.name === 'MulterError' ? 400 : err.status || 400;
  const msg = config.env === 'production' && status >= 500 ? '服务器内部错误' : err.message || '请求失败';
  res.status(status).json({ error: msg });
});

const missing = config.assertReady();
if (missing.length) console.warn('[warn] 以下配置未填（开发模式允许启动）：', missing.join('、'));

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`电子工资条服务已启动: http://127.0.0.1:${config.port}`);
  console.log(`公网地址（钉钉里打开的地址）: ${config.publicBaseUrl || '未配置 PUBLIC_BASE_URL'}`);
  if (config.auth.devMode) console.log('!! 调试登录已开启（DEV_MODE=1），上线前请关闭');
});

function shutdown(signal) {
  console.log(`\n${signal}，正在关闭...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
