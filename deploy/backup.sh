#!/usr/bin/env bash
# 工资数据每日备份：crontab 里加一行
#   15 3 * * * /opt/payslip-h5/deploy/backup.sh >> /var/log/payslip-backup.log 2>&1
set -euo pipefail

APP_DIR="/opt/payslip-h5"
BACKUP_DIR="/data/backup/payslip"
KEEP_DAYS=90

# 读取 .env 里的数据库配置
set -a
source "$APP_DIR/.env"
set +a

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$BACKUP_DIR/payslip-$STAMP.sql.gz"

# 用 defaults-extra-file 传凭据，避免密码出现在进程列表（ps 可见）
MY_CNF=$(mktemp)
trap 'rm -f "$MY_CNF"' EXIT
chmod 600 "$MY_CNF"
cat > "$MY_CNF" <<EOF
[client]
host=$DB_HOST
port=$DB_PORT
user=$DB_USER
password=$DB_PASSWORD
EOF

mysqldump --defaults-extra-file="$MY_CNF" --single-transaction --routines \
  --default-character-set=utf8mb4 "$DB_NAME" | gzip > "$FILE"

chmod 600 "$FILE"
echo "$(date '+%F %T') 备份完成 $FILE $(du -h "$FILE" | cut -f1)"

# 只保留最近 KEEP_DAYS 天
find "$BACKUP_DIR" -name 'payslip-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
