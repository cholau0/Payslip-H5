/** 建库建表：npm run init-db */
const readline = require('readline');
const mysql = require('mysql2/promise');
const config = require('../src/config');
const { initSchema } = require('../src/db');

async function ensureDatabase() {
  const conn = await mysql.createConnection({
    ...config.db,
    database: undefined,
    multipleStatements: false
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
  );
  await conn.end();
}

async function main() {
  console.log(`连接 ${config.db.user}@${config.db.host}:${config.db.port} ...`);
  await ensureDatabase();
  await initSchema();
  console.log(`数据库 ${config.db.database} 初始化完成，共 5 张表。`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('初始化失败：', err.message);
  process.exit(1);
});
