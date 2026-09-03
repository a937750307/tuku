const PREFIX = "tuku/";
const KV_PREFIX = "tuku_v2:";

const EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);
const CACHE_TTL_CAT = 3600;      // 分类列表缓存 1 小时
const CACHE_TTL_FILES = 3600;    // 文件列表缓存 1 小时
const CACHE_TTL_META = 2592000;  // 图片元数据缓存 30 天

// API 响应 CDN 缓存时间
const CDN_CACHE_IMAGES = 300;    // /api/images 缓存 5 分钟
const CDN_CACHE_CATEGORIES = 3600; // /api/categories 缓存 1 小时

function jsonResponse(data, status = 200, cacheSeconds = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };
  if (cacheSeconds > 0) {
    // 让 Cloudflare 边缘节点缓存这个 API 响应
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
    headers['CDN-Cache-Control'] = `public, max-age=${cacheSeconds}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function keyToUrl(base, key) {
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function batchTasks(tasks, concurrency = 8) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map((t) => t()))));
  }
  return results;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const R2_PUBLIC_URL = env.R2_PUBLIC_URL;

    if (url.pathname === '/api/categories') {
      const data = await getCategories(env.TUKU_BUCKET, env.TUKU_KV);
      return jsonResponse(data, 200, CDN_CACHE_CATEGORIES);
    }

    if (url.pathname === '/api/images') {
      const cat = url.searchParams.get('cat') || '';
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '60', 10) || 60);

      const files = await getFileList(env.TUKU_BUCKET, env.TUKU_KV, cat);
      const pageFiles = files.slice(offset, offset + limit);

      // 批量获取宽高：每个分类只读 1 次 KV，而不是每张图读 1 次
      const metaMap = await getBatchMeta(env.TUKU_BUCKET, env.TUKU_KV, cat, pageFiles);

      const items = pageFiles.map((key) => {
        const meta = metaMap[key] || { w: 0, h: 0 };
        return { u: keyToUrl(R2_PUBLIC_URL, key), w: meta.w, h: meta.h };
      });

      return jsonResponse({ total: files.length, items }, 200, CDN_CACHE_IMAGES);
    }

    if (url.pathname === '/api/admin/purge') {
      const token = url.searchParams.get('token');
      if (token !== env.ADMIN_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      await env.TUKU_KV.delete(KV_PREFIX + 'categories');
      // 批量缓存的前缀删除（KV 不支持前缀删，这里只删分类列表，meta 等自然过期）
      return jsonResponse({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }
};

/* ---------- 分类列表（1 次 KV 读） ---------- */
async function getCategories(bucket, kv) {
  const key = KV_PREFIX + 'categories';
  const cached = await kv.get(key, { type: 'json' });
  if (cached) return cached;

  const listed = await bucket.list({ prefix: PREFIX, delimiter: '/' });
  const categories = [];
  let total = 0;

  for (const prefix of listed.delimitedPrefixes || []) {
    const catName = prefix.slice(PREFIX.length).replace(/\/$/, '');
    if (!catName) continue;

    const catListed = await bucket.list({ prefix: `${PREFIX}${catName}/`, delimiter: '/' });
    const count = catListed.objects.filter((obj) => {
      const ext = obj.key.slice(obj.key.lastIndexOf('.')).toLowerCase();
      return EXTS.has(ext);
    }).length;

    if (count > 0) {
      categories.push({ name: catName, count });
      total += count;
    }
  }

  const result = { total, categories };
  await kv.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_CAT });
  return result;
}

/* ---------- 文件列表（1 次 KV 读） ---------- */
async function getFileList(bucket, kv, cat) {
  const cacheKey = KV_PREFIX + 'files:' + cat;
  const cached = await kv.get(cacheKey, { type: 'json' });
  if (cached) return cached;

  const prefix = `${PREFIX}${cat}/`;
  const files = [];
  let cursor = undefined;

  do {
    const listed = await bucket.list({ prefix, delimiter: '/', cursor });
    const page = listed.objects
      .filter((obj) => {
        const ext = obj.key.slice(obj.key.lastIndexOf('.')).toLowerCase();
        return EXTS.has(ext);
      })
      .map((obj) => obj.key);
    files.push(...page);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  files.sort();
  await kv.put(cacheKey, JSON.stringify(files), { expirationTtl: CACHE_TTL_FILES });
  return files;
}

/* ---------- 批量元数据（1 次 KV 读，替代原来的 60 次） ---------- */
async function getBatchMeta(bucket, kv, cat, fileKeys) {
  const batchKey = KV_PREFIX + 'batch-meta:' + cat;
  let metaMap = await kv.get(batchKey, { type: 'json' }) || {};

  // 找出本次请求中还没缓存宽高的图片
  const missing = fileKeys.filter((k) => !(k in metaMap));

  if (missing.length > 0) {
    // 并发从 R2 读取文件头解析宽高（不经过 KV，只读 R2）
    const newMetas = await batchTasks(
      missing.map((key) => async () => {
        try {
          const obj = await bucket.get(key);
          if (!obj) return [key, { w: 0, h: 0 }];
          const buffer = await obj.arrayBuffer();
          const wh = getImageSize(buffer, key);
          return [key, wh ? { w: wh[0], h: wh[1] } : { w: 0, h: 0 }];
        } catch (e) {
          return [key, { w: 0, h: 0 }];
        }
      }),
      8
    );

    // 合并到 metaMap 并写回 KV（1 次 KV 写）
    newMetas.forEach(([k, v]) => (metaMap[k] = v));
    await kv.put(batchKey, JSON.stringify(metaMap), { expirationTtl: CACHE_TTL_META });
  }

  return metaMap;
}

/* ---------- 图片头解析（零改动） ---------- */
function getImageSize(buffer, filename) {
  const view = new DataView(buffer);
  const b = new Uint8Array(buffer);
  const len = b.length;

  if (len >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
    if (b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
      return [view.getUint32(16, false), view.getUint32(20, false)];
    }
  }
  if (len >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return [view.getUint16(6, true), view.getUint16(8, true)];
  }
  if (len >= 26 && b[0] === 0x42 && b[1] === 0x4D) {
    return [view.getInt32(18, true), Math.abs(view.getInt32(22, true))];
  }
  if (len >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === 'VP8X' && len > 30) {
      const w = 1 + b[24] + (b[25] << 8) + (b[26] << 16);
      const h = 1 + b[27] + (b[28] << 8) + (b[29] << 16);
      return [w, h];
    }
    if (chunk === 'VP8L' && len > 25 && b[20] === 0x2F) {
      const bits = view.getUint32(21, true);
      return [(bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1];
    }
    if (chunk === 'VP8 ' && len > 30 && b[23] === 0x9D && b[24] === 0x01 && b[25] === 0x2A) {
      return [view.getUint16(26, true), view.getUint16(28, true)];
    }
  }
  if (len > 2 && b[0] === 0xFF && b[1] === 0xD8) {
    return parseJpegSize(b);
  }
  return null;
}

function parseJpegSize(bytes) {
  let i = 2;
  const len = bytes.length;
  while (i < len - 1) {
    while (i < len - 1 && bytes[i] !== 0xFF) i++;
    if (i >= len - 1) break;
    while (i < len && bytes[i] === 0xFF) i++;
    if (i >= len) break;
    const marker = bytes[i];
    i++;
    if (marker === 0xD9) return null;
    if ((marker >= 0xD0 && marker <= 0xD8) || marker === 0x01) continue;
    if (i + 1 >= len) break;
    const segLen = (bytes[i] << 8) | bytes[i + 1];
    i += 2;
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (i + 5 > len) break;
      const h = (bytes[i + 1] << 8) | bytes[i + 2];
      const w = (bytes[i + 3] << 8) | bytes[i + 4];
      return [w, h];
    }
    if (segLen < 2) return null;
    i += segLen - 2;
  }
  return null;
}