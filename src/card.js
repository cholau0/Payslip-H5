/**
 * 钉钉卡片文案
 * 抽成独立模块，便于「预览测试」与「正式发送」共用同一套排版，
 * 避免测试通过但线上格式不一致。
 *
 * 卡片顶部带横幅插画（ActionCard 的 markdown 支持图片）。
 * 图片要求：公网可直接访问的 URL（钉钉客户端自行拉取，相对路径无效），
 * 比例约 16:9，JPEG 控制在 200KB 内。
 */

const config = require('./config');
const BANNER_MD = `![](${config.publicBaseUrl}/assets/banner.jpg)`;

function fmtMonth(m) {
  const [y, mo] = String(m).split('-');
  return `${y}年${Number(mo)}月`;
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 卡片正文：横幅图 + 加粗标题 + 「标签：值」逐行排版。
 * 不要把姓名写进行内加粗的句子——钉钉对行内加粗的字号渲染偏小，
 * 独立成行才能与正文同大；段落之间必须空行才会真正换行。
 */
function buildCardMd({ title, lines = [], note }) {
  const parts = [BANNER_MD, '', `**${title}**`];
  for (const l of lines) parts.push('', l);
  if (note) parts.push('', `> ${note}`);
  return parts.join('\n');
}

/** 个人工资条卡片（金额不外露，只提示有工资条与个人备注） */
function payslipCard({ month, name, remark }) {
  const lines = ['感谢您的辛勤劳动，请及时查收本月工资。', `姓名：${name}`];
  const rm = String(remark || '').trim();
  if (rm && rm !== 'null') lines.push(`备注：${rm}`);
  return buildCardMd({
    title: `${fmtMonth(month)} 工资条`,
    lines,
    note: '工资条属敏感信息，请注意保密'
  });
}

/** 统一内容卡片（不带金额，金额只在点开后可见） */
function genericCard({ month }) {
  return buildCardMd({
    title: `${fmtMonth(month)} 工资条已发放`,
    lines: ['感谢您的辛勤劳动，请及时查看本人工资条。'],
    note: '工资条属敏感信息，请注意保密'
  });
}

/** 催办卡片 */
function remindCard({ month }) {
  return buildCardMd({
    title: `${fmtMonth(month)} 工资条待确认`,
    lines: ['您还有本月工资条未确认签收，请及时处理。'],
    note: '点击下方按钮查看并确认'
  });
}

module.exports = { fmtMonth, fmtMoney, buildCardMd, payslipCard, genericCard, remindCard };
