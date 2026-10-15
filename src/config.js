require('dotenv').config();

function str(key, def = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v.trim();
}
function int(key, def) {
  const v = parseInt(str(key, ''), 10);
  return Number.isFinite(v) ? v : def;
}
function bool(key) {
  return ['1', 'true', 'yes', 'on'].includes(str(key, '').toLowerCase());
}

const config = {
  env: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  publicBaseUrl: str('PUBLIC_BASE_URL').replace(/\/+$/, ''),

  dd: {
    corpId: str('DING_CORP_ID'),
    appKey: str('DING_APP_KEY'),
    appCredential: str('DING_APP_SECRET'),
    agentId: str('DING_AGENT_ID'),
    jsapiUrl: str('DING_JSAPI_URL', 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js'),
    oapi: 'https://oapi.dingtalk.com'
  },

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    user: str('DB_USER', 'payslip'),
    password: str('DB_PASSWORD'),
    database: str('DB_NAME', 'payslip'),
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 8,
    // 注意：不开启 multipleStatements，缩小堆叠注入的潜在破坏面；
    // 建表脚本（scripts/init-db.js）用独立连接单独开启
    dateStrings: true
  },

  auth: {
    sessionKey: str('JWT_SECRET'),
    ttlHours: int('JWT_TTL_HOURS', 12),
    adminJobNumbers: str('ADMIN_JOB_NUMBERS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /**
     * 管理员 userId 白名单。优先用它：钉钉通讯录里的「工号」字段质量不可控
     * （实测有人把入职日期填进了工号字段），而 userId 稳定唯一。
     */
    adminUserIds: str('ADMIN_USER_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminPassword: str('ADMIN_PASSWORD'),
    devMode: bool('DEV_MODE')
  }
};

/** 启动前自检：生产环境缺关键配置直接报错，避免带着空配置上线 */
config.assertReady = function assertReady() {
  const missing = [];
  if (!config.dd.corpId) missing.push('DING_CORP_ID');
  if (!config.dd.appKey) missing.push('DING_APP_KEY');
  if (!config.dd.appCredential) missing.push('DING_APP_SECRET');
  if (!config.dd.agentId) missing.push('DING_AGENT_ID');
  if (!config.publicBaseUrl) missing.push('PUBLIC_BASE_URL');
  if (!config.auth.sessionKey || config.auth.sessionKey.includes('change-me')) missing.push('JWT_SECRET(请改成随机串)');
  if (missing.length && config.env === 'production') {
    throw new Error('.env 缺少必填配置：' + missing.join('、'));
  }
  return missing;
};

module.exports = config;
