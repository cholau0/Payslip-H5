/**
 * 工资项定义 —— 全系统的唯一字段来源
 * 想增删工资项只改这里：导入映射、页面渲染、合计校验都会自动跟随。
 *
 * agg 取值：
 *   add    参与「应发/代扣」累加
 *   minus  从应发中减去（如各项扣款）
 *   none   仅展示，不参与累加（如约定工资、绩效系数）
 *   sub    小计（由系统算出，Excel 里有值时用于校验）
 *   total  实发合计
 */
const FIELDS = [
  { key: 'agreed', label: '约定工资', group: 'income', agg: 'none' },
  { key: 'base', label: '基本工资', group: 'income', agg: 'add' },
  { key: 'perfCoef', label: '部门绩效系数', group: 'income', agg: 'none', decimals: 2 },
  { key: 'deptAssess', label: '部门考核', group: 'income', agg: 'add' },
  { key: 'projAssess', label: '项目考核', group: 'income', agg: 'add' },
  { key: 'attendance', label: '全勤奖', group: 'income', agg: 'add' },
  { key: 'seniority', label: '工龄奖', group: 'income', agg: 'add' },
  { key: 'meal', label: '餐补', group: 'income', agg: 'add' },
  { key: 'traffic', label: '交通补贴', group: 'income', agg: 'add' },
  { key: 'overtime', label: '加班费/补助', group: 'income', agg: 'add' },
  { key: 'otherDeduct', label: '各项扣款', group: 'income', agg: 'minus' },
  { key: 'gross', label: '应发数合计', group: 'income', agg: 'sub' },

  { key: 'social', label: '社保', group: 'deduct', agg: 'add' },
  { key: 'housing', label: '公积金', group: 'deduct', agg: 'add' },
  { key: 'annuity', label: '企业年金', group: 'deduct', agg: 'add' },
  { key: 'tax', label: '个税', group: 'deduct', agg: 'add' },
  { key: 'deductTotal', label: '代扣合计', group: 'deduct', agg: 'sub' },

  { key: 'net', label: '实发合计', group: 'net', agg: 'total' }
];

/** Excel 表头别名：容忍空格、斜杠、同叫法 */
const HEADER_ALIASES = {
  agreed: ['约定工资', '合同工资', '月薪标准'],
  base: ['基本工资', '底薪', '岗位工资'],
  perfCoef: ['部门绩效系数', '绩效系数', '系数'],
  deptAssess: ['部门考核', '部门绩效', '部门考核奖金'],
  projAssess: ['项目考核', '项目绩效', '项目奖金'],
  attendance: ['全勤奖', '全勤'],
  seniority: ['工龄奖', '工龄工资', '工龄'],
  meal: ['餐补', '伙食补贴', '餐费'],
  traffic: ['交通补贴', '交通补助', '车费', '交通'],
  overtime: ['加班费/补助', '加班费 /补助', '加班费', '加班补助', '加班工资'],
  otherDeduct: ['各项扣款', '其他扣款', '扣款', '其他'],
  gross: ['应发数合计', '应发合计', '应发'],
  social: ['社保', '社会保险', '代扣社保', '代扣社会保险', '养老医疗失业'],
  housing: ['公积金', '住房公积金', '代扣公积金', '代扣住房公积金'],
  annuity: ['企业年金', '年金', '代扣企业年金', '代扣年金'],
  tax: ['个税', '个人所得税', '代扣个税', '代扣个人所得税'],
  deductTotal: ['代扣合计', '扣款合计', '代扣项合计'],
  net: ['实发合计', '实发', '实发金额', '本月实发'],
  // 定位员工用的辅助列
  name: ['姓名', '员工姓名'],
  job_number: ['工号', '员工编号', '编号', '职号'],
  // 个人提醒信息，如「本月有代扣事项」，不参与任何金额计算
  remark: ['备注', '说明', '提醒', '注', '附注']
};

/**
 * 归一化表头：去括号注释，再剥掉所有符号与空白
 * 这样「加班费/补助」「加班费\n补助」「加班费 补助」都会收敛成同一个键，
 * 单元格内换行、斜杠、全半角空格 differences 全部容忍。
 */
function normalizeHeader(raw) {
  return String(raw || '')
    .replace(/[（(][^（）()]*[)）]/g, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .trim();
}

const ALIAS_INDEX = new Map();
for (const [key, list] of Object.entries(HEADER_ALIASES)) {
  for (const alias of list) ALIAS_INDEX.set(normalizeHeader(alias), key);
}

/** 把 Excel 表头映射到字段 key；识别不了返回 null */
function matchHeader(raw) {
  const n = normalizeHeader(raw);
  if (!n) return null;
  if (ALIAS_INDEX.has(n)) return ALIAS_INDEX.get(n);

  // 容错一：去掉「代扣/应扣/扣除/减」前缀再试，兼容「代扣社保」这类叫法
  const stripped = n.replace(/^(代扣|应扣|扣除|减)/, '');
  if (stripped && ALIAS_INDEX.has(stripped)) return ALIAS_INDEX.get(stripped);

  // 容错二：备注/姓名/工号 允许包含匹配（如「备注说明」「员工姓名」）
  for (const key of ['remark', 'name', 'job_number']) {
    if ((HEADER_ALIASES[key] || []).some((a) => n.includes(normalizeHeader(a)))) return key;
  }
  return null;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[,，¥￥\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 清洗工号：钉钉通讯录的「工号」字段常被误填成入职日期（实测 2017-08-22 00:00:00），
 * 日期形态一律视为无效并置空，避免污染人员匹配与界面展示。
 * HR 整理完通讯录后重新同步即可自动恢复。
 */
function cleanJobNumber(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return '';
  if (/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(s)) return '';
  return s;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * 按 FIELDS 定义重算三项合计
 * @returns {{items:Object, gross:number, deduct:number, net:number}}
 */
/**
 * 合计口径：
 *   1) 先按 FIELDS 的 agg 规则精确累加，得到「系统算」值；
 *   2) 表里若已写明合计，则以表为准（工资表是银行发放依据，不能被系统覆盖），
 *      系统算值仅用于事后校验，差异超阈值才拦下。
 * 这样员工看到的工资条永远等于实际到账金额。
 */
function declaredNum(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = toNumber(v);
  return Number.isFinite(n) ? round2(n) : null;
}

function computeTotals(rawItems) {
  const items = {};
  let gross = 0;
  let deduct = 0;

  for (const f of FIELDS) {
    if (f.agg === 'sub' || f.agg === 'total') continue;
    const v = round2(toNumber(rawItems[f.key]));
    items[f.key] = v;
    if (f.group === 'income' && f.agg === 'add') gross += v;
    else if (f.group === 'income' && f.agg === 'minus') gross -= v;
    else if (f.group === 'deduct' && f.agg === 'add') deduct += v;
  }

  const computed = { gross: round2(gross), deduct: round2(deduct), net: round2(gross - deduct) };
  const declared = { gross: declaredNum(rawItems.gross), deduct: declaredNum(rawItems.deductTotal), net: declaredNum(rawItems.net) };

  items.gross = declared.gross !== null ? declared.gross : computed.gross;
  items.deductTotal = declared.deduct !== null ? declared.deduct : computed.deduct;
  items.net = declared.net !== null ? declared.net : round2(items.gross - items.deductTotal);

  // 备注是文本，原样带过去，不参与任何累加
  const remark = String(rawItems.remark || '').trim();
  if (remark) items.remark = remark.slice(0, 200);

  return { items, gross: items.gross, deduct: items.deductTotal, net: items.net, computed, declared };
}

/** 合计差异容忍度：1 元以内视为 Excel 取整，放行并提示；超过则拦下 */
const SOFT_TOLERANCE = 1;

/**
 * 校验：返回 { hard: [信息], soft: [信息] }
 *   hard  -> 该行拒绝导入
 *   soft  -> 可导入，但要在预检里黄字提醒 HR 复核
 */
function auditTotals(r) {
  const hard = [];
  const soft = [];
  const labels = { gross: '应发数合计', deduct: '代扣合计', net: '实发合计' };

  for (const k of ['gross', 'deduct', 'net']) {
    const d = r.declared[k];
    if (d === null) continue;
    const diff = Math.abs(d - r.computed[k]);
    if (diff <= 0.01) continue;
    const msg = `${labels[k]}：表内 ${d.toFixed(2)}，明细累加 ${r.computed[k].toFixed(2)}，差 ${diff.toFixed(2)}`;
    if (diff > SOFT_TOLERANCE) hard.push(msg);
    else soft.push(msg);
  }

  // 表内三个合计自相矛盾（应发-代扣≠实发）属于真错，必须拦
  if (r.declared.gross !== null && r.declared.deduct !== null && r.declared.net !== null) {
    const inner = Math.abs(r.declared.gross - r.declared.deduct - r.declared.net);
    if (inner > 0.01) hard.push(`表内合计自相矛盾：应发 ${r.declared.gross.toFixed(2)} − 代扣 ${r.declared.deduct.toFixed(2)} ≠ 实发 ${r.declared.net.toFixed(2)}`);
  }

  return { hard, soft };
}

/** 兼容旧调用：只返回拦截类信息 */
function checkTotals(rawItems, computedLike) {
  const r = computeTotals(rawItems);
  return auditTotals({ computed: computedLike || r.computed, declared: r.declared }).hard;
}

module.exports = {
  FIELDS,
  HEADER_ALIASES,
  matchHeader,
  normalizeHeader,
  toNumber,
  round2,
  cleanJobNumber,
  computeTotals,
  auditTotals,
  checkTotals,
  SOFT_TOLERANCE
};
