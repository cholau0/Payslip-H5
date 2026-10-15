-- 电子工资条 H5 微应用 数据库初始化
-- 执行方式：node scripts/init-db.js  或  mysql -u root -p < scripts/init.sql

CREATE DATABASE IF NOT EXISTS payslip DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE payslip;

-- 员工表（从钉钉通讯录同步而来，也可手工补）
CREATE TABLE IF NOT EXISTS employees (
  user_id      VARCHAR(64)  NOT NULL COMMENT '钉钉 userId',
  name         VARCHAR(64)  NOT NULL COMMENT '姓名',
  job_number   VARCHAR(64)  DEFAULT NULL COMMENT '工号，用于与 Excel 对账',
  dept_name    VARCHAR(128) DEFAULT NULL COMMENT '部门',
  mobile       VARCHAR(32)  DEFAULT NULL,
  active       TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1在职 0离职',
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uk_job_number (job_number),
  KEY idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='员工花名册';

-- 工资条主表：工资项以 JSON 存储，增删字段无需改表结构
CREATE TABLE IF NOT EXISTS payslips (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  pay_month    CHAR(7)      NOT NULL COMMENT '工资月份 YYYY-MM',
  user_id      VARCHAR(64)  NOT NULL COMMENT '钉钉 userId',
  name         VARCHAR(64)  NOT NULL,
  job_number   VARCHAR(64)  DEFAULT NULL,
  dept_name    VARCHAR(128) DEFAULT NULL,
  items        JSON         NOT NULL COMMENT '各工资项键值',
  gross_amount DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '应发合计',
  deduct_amount DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '代扣合计',
  net_amount   DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '实发合计',
  status       ENUM('pending','sent','confirmed') NOT NULL DEFAULT 'pending' COMMENT '待发送/已发送/已确认',
  batch_id     BIGINT       DEFAULT NULL COMMENT '导入批次',
  sent_at      DATETIME     DEFAULT NULL,
  confirmed_at DATETIME     DEFAULT NULL COMMENT '员工点击确认的时刻',
  confirm_ip   VARCHAR(64)  DEFAULT NULL,
  confirm_ua   VARCHAR(255) DEFAULT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_month_user (pay_month, user_id),
  KEY idx_month_status (pay_month, status),
  KEY idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工资条';

-- 导入批次
CREATE TABLE IF NOT EXISTS import_batches (
  id           BIGINT      NOT NULL AUTO_INCREMENT,
  pay_month    CHAR(7)     NOT NULL,
  filename     VARCHAR(255) DEFAULT NULL,
  total_rows   INT         NOT NULL DEFAULT 0,
  ok_rows      INT         NOT NULL DEFAULT 0,
  skip_rows    INT         NOT NULL DEFAULT 0,
  operator     VARCHAR(64) DEFAULT NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_month (pay_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='导入批次';

-- 发送记录
CREATE TABLE IF NOT EXISTS send_logs (
  id           BIGINT      NOT NULL AUTO_INCREMENT,
  pay_month    CHAR(7)     NOT NULL,
  action       VARCHAR(16) NOT NULL COMMENT 'send 首次发送 / remind 催办',
  target_count INT         NOT NULL DEFAULT 0,
  task_ids     VARCHAR(512) DEFAULT NULL COMMENT '钉钉异步任务ID',
  failed       TEXT        DEFAULT NULL COMMENT '失败明细',
  operator     VARCHAR(64) DEFAULT NULL,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_month (pay_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='发送记录';

-- 操作日志（谁导入了什么、谁发了工资条，工资数据敏感必须留痕）
CREATE TABLE IF NOT EXISTS admin_logs (
  id         BIGINT      NOT NULL AUTO_INCREMENT,
  actor      VARCHAR(64) NOT NULL COMMENT '操作人 userId 或 admin',
  action     VARCHAR(32) NOT NULL,
  detail     VARCHAR(512) DEFAULT NULL,
  ip         VARCHAR(64)  DEFAULT NULL,
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志';
