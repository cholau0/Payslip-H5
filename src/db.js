const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./config');

let pool;

function getPool() {
  if (!pool) pool = mysql.createPool(config.db);
  return pool;
}

/** 查询：q('SELECT ... WHERE id=?', [id]) -> rows */
async function q(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

/** 取单行，没有返回 null */
async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows.length ? rows[0] : null;
}

/** 执行写入，返回 insertId / affectedRows */
async function run(sql, params = []) {
  const [res] = await getPool().query(sql, params);
  return res;
}

/** 事务包装 */
async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** 读取 items JSON 列（MySQL 驱动有时返回字符串） */
function parseItems(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

/** 按 scripts/init.sql 建表，供 npm run init-db 调用 */
async function initSchema() {
  const sqlFile = path.join(__dirname, '..', 'scripts', 'init.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  await conn.query(sql);
  await conn.end();
}

module.exports = { getPool, q, one, run, tx, parseItems, initSchema };
