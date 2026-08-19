const { createClient } = require('redis');
const config = require('../config');

let client = null;
// 缓存「正在进行的连接 Promise」，避免并发冷启动时多个请求各发起一次 connect，
// 导致后续请求拿到尚未连接就绪的 client 而抛 ClientClosedError。
let connectingPromise = null;

async function getClient() {
  // 已连接且就绪，直接复用
  if (client && client.isReady) return client;
  // 有连接在进行中，复用同一个 Promise
  if (connectingPromise) return connectingPromise;

  const connect = async () => {
    const c = createClient({
      socket: {
        host: config.redis.host,
        port: config.redis.port
      },
      password: config.redis.password || undefined
    });

    // 运行时错误仅记录，不退出进程；连接断开后清空缓存以便下次重连
    c.on('error', (err) => console.error('[redis] runtime error:', err));
    c.on('end', () => {
      client = null;
      connectingPromise = null;
    });

    await c.connect();
    console.log('[redis] connected');
    return c;
  };

  connectingPromise = connect();
  try {
    client = await connectingPromise;
  } finally {
    // 无论成功失败都清空进行中标记；失败时 client 仍为 null，下次调用会重试
    connectingPromise = null;
  }
  return client;
}

async function get(key) {
  const c = await getClient();
  const val = await c.get(key);
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

async function set(key, value, ttl = 3600) {
  const c = await getClient();
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  await c.set(key, str, { EX: ttl });
}

async function del(key) {
  const c = await getClient();
  await c.del(key);
}

async function incr(key) {
  const c = await getClient();
  return c.incr(key);
}

async function setnx(key, value, ttl = 3600) {
  const c = await getClient();
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const result = await c.set(key, str, { NX: true, EX: ttl });
  return result === 'OK';
}

module.exports = { get, set, del, incr, setnx, getClient };
