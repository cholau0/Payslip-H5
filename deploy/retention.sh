#!/usr/bin/env bash
# 工资数据留存：按月删除超期数据，并滚动清理备份文件
#   crontab 里加一行（紧跟在 backup.sh 之后）
#   30 3 * * * /opt/payslip-h5/deploy/retention.sh >> /var/log/payslip-retention.log 2>&1
set -euo pipefail

APP_DIR="/opt/payslip-h5"   # 按实际部署路径修改
BACKUP_DIR="/var/backups/payslip"   # 必须与 backup.sh 的 BACKUP_DIR 一致

# 读取 .env 里的数据库配置与留存策略
set -a
source "$APP_DIR/.env"
set +a

RETAIN_MONTHS="${RETAIN_MONTHS:-36}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-35}"

# 截止月：早于该月的整月数据都会被删除（pay_month 是 CHAR(7) 的 'YYYY-MM'，可直接比大小）
CUTOFF=$(date -d "-${RETAIN_MONTHS} months" +%Y-%m)
echo "$(date '+%F %T') 留存策略：保留 ${RETAIN_MONTHS} 个月，删除 pay_month < ${CUTOFF} 的数据"

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

# 工资条、导入批次、发送记录随工资数据一并滚动；
# admin_logs 是审计日志（只追加，用于事后还原事实），不参与删除。
mysql --defaults-extra-file="$CRED" --default-character-set=utf8mb4 "$DB_NAME" <<SQL
DELETE FROM payslips       WHERE pay_month < '${CUTOFF}';
DELETE FROM import_batches WHERE pay_month < '${CUTOFF}';
DELETE FROM send_logs      WHERE pay_month < '${CUTOFF}';
SQL

# 备份文件含全量工资数据，只删库不删备份等于没删，必须一并滚动
if [ -d "$BACKUP_DIR" ]; then
  find "$BACKUP_DIR" -name 'payslip-*.sql.gz' -mtime "+$BACKUP_KEEP_DAYS" -delete
fi

echo "$(date '+%F %T') 留存清理完成（备份保留 ${BACKUP_KEEP_DAYS} 天；admin_logs 审计日志未清理）"
