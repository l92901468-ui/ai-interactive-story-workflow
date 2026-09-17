// 监督式改稿差分：比较 AI 候选稿与编剧改稿，产出逐行 hunk。
//
// 差分只负责「哪里变了」，不负责「为什么变了」。
// 为什么变了必须由人工归因（见 feedback.js），否则不得据此调权。

const { sha256 } = require('./hash');

function toLines(value) {
  return String(value || '').split('\n');
}

function lcsMatrix(left, right) {
  const rows = left.length;
  const cols = right.length;
  const matrix = [];
  for (let i = 0; i <= rows; i += 1) matrix.push(new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      matrix[i][j] = left[i] === right[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  return matrix;
}

function diffHunks(before, after) {
  const left = toLines(before);
  const right = toLines(after);
  const matrix = lcsMatrix(left, right);
  const hunks = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      const start = i;
      const removed = [];
      while (i < left.length && (matrix[i + 1][j] >= matrix[i][j + 1] || i === start)) {
        if (matrix[i + 1][j] < matrix[i][j + 1] && i !== start) break;
        removed.push(left[i]);
        i += 1;
        if (i < left.length && left[i] === right[j]) break;
      }
      hunks.push({ type: 'removed', beforeStart: start + 1, beforeLines: removed, afterStart: null, afterLines: [] });
    } else {
      const start = j;
      const added = [];
      while (j < right.length && (matrix[i][j + 1] > matrix[i + 1][j] || j === start)) {
        if (matrix[i][j + 1] <= matrix[i + 1][j] && j !== start) break;
        added.push(right[j]);
        j += 1;
        if (j < right.length && left[i] === right[j]) break;
      }
      hunks.push({ type: 'added', beforeStart: null, beforeLines: [], afterStart: start + 1, afterLines: added });
    }
  }
  while (i < left.length) {
    hunks.push({ type: 'removed', beforeStart: i + 1, beforeLines: [left[i]], afterStart: null, afterLines: [] });
    i += 1;
  }
  while (j < right.length) {
    hunks.push({ type: 'added', beforeStart: null, beforeLines: [], afterStart: j + 1, afterLines: [right[j]] });
    j += 1;
  }

  // 把相邻的 removed + added 合并成 modified，读起来更接近「改了什么」
  const merged = [];
  for (const hunk of hunks) {
    const previous = merged[merged.length - 1];
    if (previous && previous.type === 'removed' && hunk.type === 'added') {
      merged[merged.length - 1] = {
        type: 'modified',
        beforeStart: previous.beforeStart,
        beforeLines: previous.beforeLines,
        afterStart: hunk.afterStart,
        afterLines: hunk.afterLines
      };
      continue;
    }
    merged.push(hunk);
  }
  return merged;
}

function diffSummary(before, after) {
  const hunks = diffHunks(before, after);
  const counts = { added: 0, removed: 0, modified: 0 };
  for (const hunk of hunks) counts[hunk.type] += 1;
  return {
    aiTextHash: sha256(before || ''),
    writerTextHash: sha256(after || ''),
    hunks: hunks,
    counts: counts,
    changed: hunks.length > 0
  };
}

module.exports = { diffHunks: diffHunks, diffSummary: diffSummary };
