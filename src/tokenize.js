// 分词。单独成一个文件是为了避免 context-selector 与 knowledge-base 互相 require。
// 中英文都用同一套：英文取词与数字串，中文按字与二元组切，够做本地检索。

function tokenize(value) {
  const source = String(value || '').toLowerCase();
  const latin = source.match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  const hanRuns = source.match(/[\p{Script=Han}]+/gu) || [];
  const han = [];
  for (const run of hanRuns) {
    if (run.length === 1) han.push(run);
    for (let index = 0; index < run.length - 1; index += 1) han.push(run.slice(index, index + 2));
  }
  return Array.from(new Set(latin.concat(han)));
}

module.exports = { tokenize: tokenize };
