const crypto = require('node:crypto');

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) result[key] = normalize(value[key]);
        return result;
      }, {});
  }
  return value;
}

function stableStringify(value, spacing = 2) {
  return JSON.stringify(normalize(value), null, spacing);
}

function sha256(value) {
  const payload = typeof value === 'string' ? value : stableStringify(value, 0);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

module.exports = { normalize, stableStringify, sha256 };
