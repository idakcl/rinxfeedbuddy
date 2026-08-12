import { getApp } from "./app-instance";
import { extractImageWithMetadata } from "../utils/image";
import { stripMarkdown } from "../utils/markdown";
import { encodeOgImageSrc, OG_IMAGE_ALLOWED_HOSTS } from "../services/og-image";

const ROOT_FEED_PATTERN = /^\/(rss\.xml|atom\.xml|rss\.json|feed\.json|feed\.xml)$/;
const APP_PUBLIC_ROUTE_PATTERN = /^\/(favicon|favicon\.ico)(?:\/|$)/;

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api/");
}

function rewriteApiRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  return new Request(url, request);
}

function isRootFeedRequest(pathname: string) {
  return ROOT_FEED_PATTERN.test(pathname);
}

function isAppPublicRoute(pathname: string) {
  return APP_PUBLIC_ROUTE_PATTERN.test(pathname);
}

function isStaticAssetRequest(pathname: string) {
  return /\.\w+$/.test(pathname);
}

async function tryServeAsset(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200 || (asset.status >= 300 && asset.status < 400)) {
      // 带 content-hash 的文件名天然支持长缓存：显式设为 immutable，
      // 让 CDN 边缘长期缓存、不再每次 revalidate（修复 max-age=0 导致重复下载）。
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      });
    }
  } catch {}

  return null;
}

async function serveSpaEntry(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const url = new URL(request.url);
    const indexRequest = new Request(new URL("/", url.origin), request);
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (indexResponse.status === 200 || (indexResponse.status >= 300 && indexResponse.status < 400)) {
      return indexResponse;
    }
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// 分享卡片(Open Graph / Twitter Card)服务端注入
// 社交爬虫基本不执行 JS，纯 SPA 空壳 HTML 显示不出预览卡片，因此必须在服务端
// 按 URL 把 og:/twitter: 元标签注入到 <head>，再返回。
// ---------------------------------------------------------------------------
type OgData = {
  type: string;
  title?: string;
  description?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageType?: string;
  url?: string;
  siteName?: string;
  twitterCard: string;
};

// 转义 HTML 属性值，防止文章字段破坏标签或注入脚本
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 仅允许 http/https 的 URL 进入属性，避免 javascript:/data: 等危险协议
function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

// 站点级卡片(首页/标签页/关于等非文章页)的头像解析：
// - 相对路径(如 /api/blob/images/xxx)按当前站点 origin 补全为同源绝对 URL；
// - 仅同源头像可被微信爬虫稳定抓取：跨域头像(如 netpan)抓取不稳，返回 undefined，
//   由 getSiteOg 回退到同源静态 default-og.jpg，避免卡片退化。
function resolveSiteAvatarOg(request: Request, avatar: string | undefined): string | undefined {
  if (!avatar) return undefined;
  let abs: string;
  try {
    const u = new URL(avatar);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    abs = u.toString();
  } catch {
    // 相对路径按当前站点 origin 补全为绝对 URL
    abs = new URL(avatar, new URL(request.url).origin).toString();
  }
  const reqHost = new URL(request.url).host;
  if (new URL(abs).host !== reqHost) return undefined; // 跨域头像不稳定，回退
  return abs;
}

function buildOgMetaTags(og: OgData): string {
  const tags: string[] = [`<meta property="og:type" content="${og.type}">`];
  if (og.title) tags.push(`<meta property="og:title" content="${og.title}">`);
  if (og.description) tags.push(`<meta property="og:description" content="${og.description}">`);
  if (og.image) tags.push(`<meta property="og:image" content="${og.image}">`);
  // og:image 的显式尺寸/MIME 仅在「已知真实值」时才写；尺寸写错(与实际图不符)
  // 反而会让微信丢弃缩略图。参照同基建站实测，留空让微信按真实图自读最稳。
  if (og.image) {
    if (og.imageWidth) tags.push(`<meta property="og:image:width" content="${og.imageWidth}">`);
    if (og.imageHeight) tags.push(`<meta property="og:image:height" content="${og.imageHeight}">`);
    if (og.imageType) tags.push(`<meta property="og:image:type" content="${og.imageType}">`);
  }
  if (og.url) tags.push(`<meta property="og:url" content="${og.url}">`);
  if (og.siteName) tags.push(`<meta property="og:site_name" content="${og.siteName}">`);
  // Twitter Card：大图预览(summary_large_image)，微信/Telegram/X/Discord 通用
  tags.push(`<meta name="twitter:card" content="${og.twitterCard}">`);
  if (og.title) tags.push(`<meta name="twitter:title" content="${og.title}">`);
  if (og.description) tags.push(`<meta name="twitter:description" content="${og.description}">`);
  if (og.image) tags.push(`<meta name="twitter:image" content="${og.image}">`);
  return tags.join("\n    ");
}

async function injectOgIntoHtml(indexResponse: Response, og: OgData): Promise<Response> {
  const html = await indexResponse.text();
  const metas = buildOgMetaTags(og);
  const newHtml = html.replace("</head>", `    ${metas}\n</head>`);
  const headers = new Headers(indexResponse.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  // 分享卡片需服务端动态注入，且随文章/站点配置变化；若被边缘缓存，爬虫会拿到陈旧卡片。
  // no-store 让每次请求都进 Worker 重新注入，保证分享卡片永远最新(OG 爬虫请求量很小，无压力)。
  headers.set("Cache-Control", "no-store");
  return new Response(newHtml, {
    status: indexResponse.status,
    statusText: indexResponse.statusText,
    headers,
  });
}

// 文章页卡片：标题 + 正文摘要 + 第一张图
async function getArticleOg(request: Request, env: Env, id: string): Promise<OgData | null> {
  try {
    const origin = new URL(request.url).origin;
    // getApp().fetch 走 Hono 路由(不经 handleFetch 的 /api 重写)，故用已重写路径 /feed/<id>
    const ogHeaders = new Headers(request.headers);
    ogHeaders.set("x-og-preview", "1"); // 告诉 FeedService 跳过访问计数
    const apiReq = new Request(new URL(`/feed/${encodeURIComponent(id)}`, origin), {
      method: request.method,
      headers: ogHeaders,
    });
    const res = await getApp().fetch(apiReq, env);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const title = typeof data?.title === "string" ? data.title : "";
    const content = typeof data?.content === "string" ? data.content : "";
    const summaryRaw =
      data?.summary && String(data.summary).length > 0
        ? String(data.summary)
        : stripMarkdown(content);
    // 描述兜底：正文摘要为空时退回标题或纯文本正文前 N 字，保证分享卡片有描述文字。
    const description = (
      summaryRaw.replace(/\s+/g, " ").trim() ||
      title ||
      content.replace(/\s+/g, " ").trim()
    ).slice(0, 200);
    // og:image 剥离 #blurhash=...&width=...&height=... 片段：爬虫忽略 #，但留着不干净；
    // 同时本端点不支持按 width 缩放，缩略图需另立后端任务，此处先保证 URL 干净。
    // 文章正文里的图片常为相对路径(如 /api/blob/images/xxx)，爬虫无法识别，需补全为绝对 URL。
    const rawImage = extractImageWithMetadata(content);
    let image: string | undefined;
    if (rawImage) {
      const base = new URL(request.url).origin;
      const raw = rawImage.split("#")[0];
      const abs =
        raw.startsWith("http://") || raw.startsWith("https://")
          ? raw
          : new URL(raw, base).toString();
      const safe = safeUrl(abs) ?? safeUrl(raw);
      if (safe) {
        const reqHost = new URL(request.url).host;
        const u = new URL(safe);
        if (u.host === reqHost) {
          // 已同源(站点主域 /api/blob/images/...)，直链最稳
          image = safe;
        } else if (OG_IMAGE_ALLOWED_HOSTS.includes(u.host)) {
          // 跨域白名单图床(如 netpan)：不能直接给微信爬虫(跨域抓取不稳/易超时)，
          // 改为同源路径式代理 /og-image/<base64url>，卡片才能稳定抓到文章首图。
          image = `${base}/og-image/${encodeOgImageSrc(safe)}?v=2`;
        }
        // 其它跨域图：image 保持 undefined，最终回退 default-og.jpg
      }
    }
    // 站点名取自后台实时配置(与站点卡片一致)，env 仅作兜底
    const liveSite = await fetchLiveSiteConfig(request, env);
    const ev = env as unknown as Record<string, any>;
    const siteName = liveSite.name || (typeof ev?.NAME === "string" ? ev.NAME : "");
    // og:image：文章首图(同源直链 / 跨域走同源代理)优先；都不可用才回退品牌渐变 default-og.jpg。
    const ogImage = image || `${origin}/default-og.jpg?v=2`;
    return {
      type: "article",
      title: escapeHtmlAttr(title),
      description: escapeHtmlAttr(description),
      image: escapeHtmlAttr(ogImage),
      // 不写死 og:image 尺寸/MIME：参照同基建站 log.hello.nyc.mn 实测，微信对
      // 「声明尺寸与实际图不符」的图会丢弃缩略图；留空让微信按真实图自读，最稳。
      url: escapeHtmlAttr(new URL(request.url).toString()),
      siteName: escapeHtmlAttr(siteName),
      twitterCard: "summary_large_image",
    };
  } catch {
    return null;
  }
}

// 读取后台实时站点配置(站名/描述/头像)：来自公开端点 /config/client(clientConfig，存于 D1)。
// 不能依赖部署时固定的 Worker 环境变量(NAME/DESCRIPTION/AVATAR，仅为默认值)，
// 否则分享卡片不会反映用户在后台改过的简介与图标。该端点无需管理员鉴权。
async function fetchLiveSiteConfig(
  request: Request,
  env: Env,
): Promise<{ name: string; description: string; avatar: string }> {
  const empty = { name: "", description: "", avatar: "" };
  try {
    const origin = new URL(request.url).origin;
    const cfgReq = new Request(new URL("/config/client", origin), request);
    const res = await getApp().fetch(cfgReq, env);
    if (!res.ok) return empty;
    const data = (await res.json()) as any;
    const site = data?.site ?? {};
    const name = site.name ?? data?.["site.name"];
    const description = site.description ?? data?.["site.description"];
    const avatar = site.avatar ?? data?.["site.avatar"];
    return {
      name: typeof name === "string" ? name : "",
      description: typeof description === "string" ? description : "",
      avatar: typeof avatar === "string" ? avatar : "",
    };
  } catch {
    return empty;
  }
}

// 站点级卡片(首页/标签页/关于等非文章页)：用站点配置
async function getSiteOg(request: Request, env: Env): Promise<OgData> {
  const live = await fetchLiveSiteConfig(request, env);
  let name = live.name;
  let description = live.description;
  let avatar = live.avatar;
  // env 兜底：仅当 /config/client 未提供对应值时，才用部署时固定的默认值
  const ev = env as unknown as Record<string, any>;
  if (!name && typeof ev?.NAME === "string" && ev.NAME) name = ev.NAME;
  if (!description && typeof ev?.DESCRIPTION === "string" && ev.DESCRIPTION) description = ev.DESCRIPTION;
  if (!avatar && typeof ev?.AVATAR === "string" && ev.AVATAR) avatar = ev.AVATAR;
  const origin = new URL(request.url).origin;
  // 首页/站点级分享卡片优先用网站头像(同源 /api/blob/images/...)，微信爬虫可稳定抓取；
  // 头像为空/非法/跨域(如 netpan)时回退到品牌渐变 default-og.jpg，避免卡片退化。
  const image = resolveSiteAvatarOg(request, avatar) ?? `${origin}/default-og.jpg`;
  return {
    type: "website",
    title: escapeHtmlAttr(name),
    description: escapeHtmlAttr(description),
    image: escapeHtmlAttr(image),
    // 不写死尺寸/MIME，参照 log.hello.nyc.mn 实测：留空让微信按真实图自读最稳
    url: escapeHtmlAttr(new URL(request.url).toString()),
    siteName: escapeHtmlAttr(name),
    twitterCard: "summary_large_image",
  };
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (isRootFeedRequest(pathname)) {
    return getApp().fetch(request, env);
  }

  if (isApiRequest(pathname)) {
    return getApp().fetch(rewriteApiRequest(request), env);
  }

  if (isAppPublicRoute(pathname)) {
    return getApp().fetch(request, env);
  }

  // 同源 OG 图代理 /og-image/<base64url>：文章首图若为跨域图床(如 netpan)，经此同源
  // 暴露给微信等爬虫，卡片才能稳定抓取缩略图。必须路由给 Hono(代理服务挂在其上)，
  // 否则会落到下方 serveSpaEntry 被当成 SPA 空壳返回，代理永远不生效。
  if (pathname.startsWith("/og-image")) {
    return getApp().fetch(request, env);
  }

  if (isStaticAssetRequest(pathname)) {
    const asset = await tryServeAsset(request, env);
    if (asset) {
      return asset;
    }
  }

  const indexResponse = await serveSpaEntry(request, env);
  if (indexResponse) {
    // 注入分享卡片元标签：爬虫不执行 JS，必须在服务端 HTML 的 <head> 写入 og:/twitter:。
    // 文章页取文章数据做文章级卡片；其余页回退到站点级卡片。
    const url = new URL(request.url);
    const feedMatch = url.pathname.match(/^\/feed\/([^/]+)\/?$/);
    let og: OgData | null = null;
    if (feedMatch && feedMatch[1]) {
      og = await getArticleOg(request, env, feedMatch[1]);
    }
    if (!og) {
      og = await getSiteOg(request, env);
    }
    if (og) {
      return injectOgIntoHtml(indexResponse, og);
    }
    // 兜底：即便取不到 OG 数据，也不要透传 ASSETS 的 immutable 长缓存，
    // 否则首页 HTML 会被边缘永久缓存、Worker 再也无法接管注入。
    const fallbackHeaders = new Headers(indexResponse.headers);
    fallbackHeaders.set("Cache-Control", "no-store");
    return new Response(indexResponse.body, {
      status: indexResponse.status,
      statusText: indexResponse.statusText,
      headers: fallbackHeaders,
    });
  }

  return new Response("Hi", { status: 200 });
}
