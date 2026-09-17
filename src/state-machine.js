// 状态机。
//
// 之前 feedback.js 里是直接用赋值改状态（item.state = 'attributed'），
// 谁能跳到哪一步全靠读代码的人自觉。这里改成转换表集中声明，
// 所有状态变更只走 transition() 一个入口，非法跳转当场拒绝。

const PENDING_STATES = {
  AWAITING: 'awaiting_attribution',
  ATTRIBUTED: 'attributed',
  DISMISSED: 'dismissed',
  ESCALATED: 'escalated'
};

const PENDING_TRANSITIONS = {
  // 差分挂起后：人工可以归因、可以忽略、也可以升级（挂太久没人处理）
  awaiting_attribution: ['attributed', 'dismissed', 'escalated'],
  escalated: ['attributed', 'dismissed'],
  attributed: [],
  dismissed: []
};

const PROPOSAL_STATES = {
  AWAITING: 'awaiting_human',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  ROLLED_BACK: 'rolled_back'
};

const PROPOSAL_TRANSITIONS = {
  awaiting_human: ['applied', 'rejected'],
  applied: ['rolled_back'],
  rejected: [],
  rolled_back: ['applied']
};

const PENDING_LABELS = {
  awaiting_attribution: '等待人工归因',
  attributed: '已归因',
  dismissed: '已忽略',
  escalated: '已升级（挂起过久）'
};

const PROPOSAL_LABELS = {
  awaiting_human: '等待人工确认',
  applied: '已应用',
  rejected: '被人工否决',
  rolled_back: '已回滚'
};

function isTerminal(state, table) {
  const next = table[state];
  return !next || next.length === 0;
}

function transition(entity, to, options) {
  const table = options.table;
  const from = entity[options.field];
  const allowed = table[from] || [];

  if (from === to) {
    return { changed: false, from: from, to: to, reason: 'already_in_state' };
  }
  if (allowed.indexOf(to) === -1) {
    const error = new Error('非法状态跳转：' + from + ' -> ' + to + '（允许：' + (allowed.length ? allowed.join(' / ') : '无，已是终态') + '）');
    error.code = 'ILLEGAL_TRANSITION';
    throw error;
  }
  entity[options.field] = to;
  return { changed: true, from: from, to: to, reason: null };
}

module.exports = {
  PENDING_STATES: PENDING_STATES,
  PENDING_TRANSITIONS: PENDING_TRANSITIONS,
  PENDING_LABELS: PENDING_LABELS,
  PROPOSAL_STATES: PROPOSAL_STATES,
  PROPOSAL_TRANSITIONS: PROPOSAL_TRANSITIONS,
  PROPOSAL_LABELS: PROPOSAL_LABELS,
  transition: transition,
  isTerminal: isTerminal
};
