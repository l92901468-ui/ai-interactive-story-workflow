// 模拟大模型。仓库承诺不调用任何在线模型，这里用确定性算法替代：
// 同样的输入永远得到同样的输出，便于回归比对。
// 真实环境把 generateDraft / interpretFeedback 换成实际 API 调用即可，接口不变。

const { sha256 } = require('./hash');

const OPENERS = ['灯塔守先检查了潮位图。', '她把月盐电池放回槽位。', '码头上的灯还没有亮。'];
const RESPONSES = ['“先别急着供电。”', '“潮位不对，供电会出事。”', '“我去 greenhouse 拿备用晶体。”'];
const ACTIONS = ['他记下电池余量。', '她核对了航线标记。', '两人把潮位图摊在桌上。'];

function pick(list, seed, offset) {
  const digest = sha256(seed + ':' + offset);
  const index = parseInt(digest.slice(0, 8), 16) % list.length;
  return list[index];
}

function generateDraft(input) {
  const seed = sha256(JSON.stringify({ plan: input.plan, evidence: input.evidenceIds }));
  const lines = [];
  let offset = 0;

  lines.push('【开篇】' + pick(OPENERS, seed, offset++));
  for (const decision of input.plan.decisionNodes || []) {
    lines.push('【决策 ' + decision.id + '】' + pick(ACTIONS, seed, offset++));
    lines.push(pick(RESPONSES, seed, offset++));
  }
  lines.push('【收束】' + pick(ACTIONS, seed, offset++));

  // 决策节点 -> 正文行区间的实现链接（回看用）
  const decisionLinks = [];
  for (const decision of input.plan.decisionNodes || []) {
    const startIndex = lines.findIndex((line) => line.indexOf('【决策 ' + decision.id + '】') === 0);
    if (startIndex === -1) continue;
    decisionLinks.push({
      nodeId: decision.id,
      fromLine: startIndex + 1,
      toLine: startIndex + 3,
      excerpt: lines[startIndex]
    });
  }

  const text = lines.join('\n');
  return {
    model: 'mock-llm-v0',
    draftId: 'draft_' + sha256(text).slice(0, 12),
    text: text,
    decisionLinks: decisionLinks,
    promptHash: seed,
    requestHash: sha256(JSON.stringify({ seed: seed, model: 'mock-llm-v0' }))
  };
}

// 把自由文本意见解释成结构化方面（aspect）与极性（polarity）
const ASPECT_LEXICON = [
  { aspect: 'structure', positive: ['结构清楚', '层次清楚', '节奏好'], negative: ['结构散', '层次乱', '节奏拖'] },
  { aspect: 'branch', positive: ['分支好', '选择有张力'], negative: ['分支少', '没有失败分支', '选择太顺'] },
  { aspect: 'variable', positive: ['伏笔回收好'], negative: ['伏笔没回收', '变量没结算'] },
  { aspect: 'dialogue', positive: ['对白到位', '人物立住'], negative: ['对白假', '人物扁平', '库存回应'] },
  { aspect: 'evidence', positive: ['引用得当'], negative: ['没引用资料', '证据不足'] }
];

function interpretFeedback(text) {
  const source = String(text || '');
  const aspects = [];
  for (const entry of ASPECT_LEXICON) {
    for (const word of entry.positive) {
      if (source.indexOf(word) !== -1) aspects.push({ aspect: entry.aspect, polarity: 1, matched: word });
    }
    for (const word of entry.negative) {
      if (source.indexOf(word) !== -1) aspects.push({ aspect: entry.aspect, polarity: -1, matched: word });
    }
  }
  const polarity = source.indexOf('不好') !== -1 || source.indexOf('不行') !== -1 ? -1 : aspects.length ? Math.sign(aspects.reduce((sum, item) => sum + item.polarity, 0)) : 0;
  return { aspects: aspects, polarity: polarity, model: 'mock-llm-v0' };
}

module.exports = { generateDraft: generateDraft, interpretFeedback: interpretFeedback, ASPECT_LEXICON: ASPECT_LEXICON };
