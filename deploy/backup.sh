#!/usr/bin/env bash
# 工资数据每日备份：crontab 里加一行
#   15 3 * * * /opt/payslip-h5/deploy/backup.sh >> /var/log/payslip-backup.log 2>&1
set -euo pipefail

APP_DIR="/opt/payslip-h5"   # 按实际部署路径修改
BACKUP_DIR="/var/backups/payslip"   # 与 crontab 日志同目录
# 备份文件的滚动清理由 retention.sh 统一负责（备份含全量工资数据，
# 与数据库留存策略分两处清理容易漏，故只保留一个执行点）

# 读取 .env 里的数据库配置
set -a
source "$APP_DIR/.env"
set +a

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$BACKUP_DIR/payslip-$STAMP.sql.gz"

# 口令写入仅 root 可读的临时凭据文件，避免 -p"密码" 出现在 ps 进程列表里
CRED=$(mktemp /etc/payslip-cred.XXXXXX)
umask 077
cat > "$CRED" <<CRED
[client]
host=$DB_HOST
port=$DB_PORT
user=$DB_USER
password="$DB_PASSWORD"
CRED
chmod 600 "$CRED"
trap 'rm -f "$CRED"' EXIT

mysqldump --defaults-extra-file="$CRED" --single-transaction --routines --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip > "$FILE"

chmod 600 "$FILE"
echo "$(date '+%F %T') 备份完成 $FILE $(du -h "$FILE" | cut -f1)"
