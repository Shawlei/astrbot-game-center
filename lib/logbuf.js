'use strict';
// 环形日志缓冲：拦截 console 输出供管理后台查看，同时透传到真实 stdout/stderr（保证 docker logs 仍可用）。
const MAX = 2000;
const entries = [];

const originals = { log: console.log, warn: console.warn, error: console.error };

function push(level, args) {
  let text;
  try {
    text = args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
  } catch (e) {
    text = '(unserializable)';
  }
  entries.push({ t: Date.now(), level, text });
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
}

console.log = function (...args) { push('info', args); originals.log.apply(console, args); };
console.warn = function (...args) { push('warn', args); originals.warn.apply(console, args); };
console.error = function (...args) { push('error', args); originals.error.apply(console, args); };

function tail(n) {
  const count = typeof n === 'number' && n > 0 ? Math.min(n, MAX) : 200;
  return entries.slice(-count);
}

module.exports = { tail, size: () => entries.length, clear: () => { entries.length = 0; } };
