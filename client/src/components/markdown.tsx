import "katex/dist/katex.min.css";
import React, { cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { AudioPlayer } from "./audio-player";
import {
  base16AteliersulphurpoolLight,
  vscDarkPlus,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import gfm from "remark-gfm";
import remarkMermaid from "../remark/remarkMermaid";
import { remarkAlert } from "remark-github-blockquote-alert";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import Lightbox, { SlideImage } from "yet-another-react-lightbox";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Download from "yet-another-react-lightbox/plugins/download";
import "yet-another-react-lightbox/styles.css";
import { drawBlurhashToCanvas } from "../utils/blurhash";
import { useColorMode } from "../utils/darkModeUtils";
import { parseImageUrlMetadata } from "../utils/image-upload";
import { useImageLoadState } from "../utils/use-image-load-state";

// ---------------------------------------------------------------------------
// 文章图片并发加载控制器
// 用 IntersectionObserver 决定「可见即加载」，并用「视口中心上下各 PRELOAD_* 张」
// 的滚动预取窗口提前发起加载，把「同时在飞」的图片限制在 MAX_CONCURRENT_IMAGES
// 张以内（按距视口中心远近排序，近的优先），避免长图文章一次性发起几十个请求
// 导致后面的图被并发「饿死」停在模糊占位。
// 控制器为模块级单例，整篇文章（乃至整页）共享同一组并发槽。
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_IMAGES = 24;
// 以当前浏览位置（视口中心）为基准，上下各预下载的图片张数。
// 只激活窗口内的图片去加载，不激活整篇文章几十张，避免并发洪泛。
const PRELOAD_AHEAD = 12;
const PRELOAD_BEHIND = 12;

type ImageLoadEntry = {
  el: HTMLImageElement;
  src: string;
  priority: number; // 距视口垂直距离，越小越优先
  load: () => void; // 通知 React 给 <img> 设置真实 src
};

let imageLoadingCount = 0;
const imageEntries = new Map<HTMLElement, ImageLoadEntry>();
let imageQueue: ImageLoadEntry[] = [];
let imageObserver: IntersectionObserver | null = null;

function getImageObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") {
    return null;
  }
  if (imageObserver) {
    return imageObserver;
  }
  imageObserver = new IntersectionObserver(
    (obsEntries) => {
      for (const entry of obsEntries) {
        const el = entry.target as HTMLImageElement;
        const item = imageEntries.get(el);
        // 进入视口(提前 200px)且尚未排队/加载，才请求
        if (entry.isIntersecting && item && !el.dataset.loadState) {
          requestImageLoad(item);
        }
      }
    },
    { rootMargin: "200px" }
  );
  ensurePreloadListeners();
  return imageObserver;
}

// ---------------------------------------------------------------------------
// 以「当前浏览位置（视口中心）」为基准的预下载调度
// 取视口中心上下各 PRELOAD_* 张未加载的图片，提前发起加载（受并发上限约束），
// 让用户在滚到之前图片就已就绪，避免边滚边等。
// ---------------------------------------------------------------------------
let preloadListenersAttached = false;
let preloadRafPending = false;

function schedulePreload() {
  if (typeof window === "undefined") return;
  const vh = window.innerHeight || 0;
  const center = vh / 2;
  type Cand = { item: ImageLoadEntry; dist: number; above: boolean };
  const above: Cand[] = [];
  const below: Cand[] = [];
  for (const item of imageEntries.values()) {
    if (item.el.dataset.loadState === "done") continue;
    const rect = item.el.getBoundingClientRect();
    const elCenter = rect.top + rect.height / 2;
    (elCenter < center ? above : below).push({
      item,
      dist: Math.abs(elCenter - center),
      above: elCenter < center,
    });
  }
  above.sort((a, b) => a.dist - b.dist);
  below.sort((a, b) => a.dist - b.dist);
  for (const c of above.slice(0, PRELOAD_BEHIND).concat(below.slice(0, PRELOAD_AHEAD))) {
    requestImageLoad(c.item);
  }
}

function schedulePreloadThrottled() {
  if (preloadRafPending) return;
  preloadRafPending = true;
  requestAnimationFrame(() => {
    preloadRafPending = false;
    schedulePreload();
  });
}

function ensurePreloadListeners() {
  if (preloadListenersAttached || typeof window === "undefined") return;
  preloadListenersAttached = true;
  window.addEventListener("scroll", schedulePreloadThrottled, { passive: true });
  window.addEventListener("resize", schedulePreloadThrottled, { passive: true });
}

function requestImageLoad(item: ImageLoadEntry) {
  if (item.el.dataset.loadState) {
    return; // 已在排队/加载，防重
  }
  item.priority = Math.abs(item.el.getBoundingClientRect().top);
  if (imageLoadingCount >= MAX_CONCURRENT_IMAGES) {
    item.el.dataset.loadState = "queued";
    imageQueue.push(item);
    imageQueue.sort((a, b) => a.priority - b.priority); // 离视口近的优先
  } else {
    startImageLoad(item);
  }
}

function startImageLoad(item: ImageLoadEntry) {
  imageLoadingCount++;
  item.el.dataset.loadState = "loading";
  item.load(); // 触发 React 设置真实 src，浏览器开始拉取
}

function releaseImageSlot(el: HTMLElement | null) {
  if (!el) return;
  const item = imageEntries.get(el);
  if (!item || item.el.dataset.loadState !== "loading") {
    return;
  }
  item.el.dataset.loadState = "done"; // 已完成，避免滚回视口时重复请求导致并发槽泄漏
  imageLoadingCount--;
  drainImageQueue();
  schedulePreloadThrottled(); // 腾出槽位后，继续预取窗口内的下一批图片
}

function drainImageQueue() {
  while (imageLoadingCount < MAX_CONCURRENT_IMAGES && imageQueue.length > 0) {
    const next = imageQueue.shift()!;
    if (next.el.isConnected) {
      startImageLoad(next);
    } else {
      imageEntries.delete(next.el); // 元素已卸载，丢弃
    }
  }
}


const countNewlinesBeforeNode = (text: string, offset: number) => {
  let newlinesBefore = 0;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === "\n") {
      newlinesBefore++;
    } else {
      break;
    }
  }
  return newlinesBefore;
};

const isMarkdownImageLinkAtEnd = (text: string) => {
  const trimmed = text.trim();

  const match = trimmed.match(/(.*)(!\\[.*?\\]\\(.*?\\))$/s);

  if (match) {
    const [, beforeImage, _] = match;

    return beforeImage.trim().length === 0 || beforeImage.endsWith("\n");
  }

  return false;
};

function MarkdownImage({
  src,
  alt,
  show,
  rounded,
  scale,
  fill,
  className,
}: {
  src?: string;
  alt?: string;
  show: (src?: string) => void;
  rounded: boolean;
  scale: string;
  fill?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { src: cleanSrc, blurhash, width, height } = parseImageUrlMetadata(src);
  const [actualSrc, setActualSrc] = useState<string | undefined>(undefined);
  const [naturalRatio, setNaturalRatio] = useState<string | undefined>(undefined);
  const { failed, imageRef, loaded, onError, onLoad } = useImageLoadState(actualSrc);
  // fill=true 时图片满铺屏幕（全屏出血）：去掉圆角与 max-w 约束，容器/图片均 block w-full
  const roundedClass = rounded && !fill ? "rounded-xl" : "";
  // 预留宽高比：已知尺寸用真实比例；未知尺寸（含没有宽高元数据的旧文/行内图）
  // 一律退化为 16:9 占位，避免图片加载完成才撑开高度、把下方正在阅读的内容
  // 突然挤下去（CLS 抖动）。图片真正加载后会用自然尺寸再修正一次，未知尺寸
  // 图片也只有一次极小的二次微调。
  const knownRatio = width && height ? `${width} / ${height}` : undefined;
  const effectiveAspectRatio = naturalRatio || knownRatio || "16 / 9";

  useEffect(() => {
    if (!blurhash || !canvasRef.current) {
      return;
    }
    try {
      drawBlurhashToCanvas(canvasRef.current, blurhash);
    } catch (error) {
      console.error("Failed to render blurhash", error);
    }
  }, [blurhash]);

  // 注册到并发加载控制器：进入视口(提前 200px)才排队/加载，全局最多 24 张同时在飞。
  // 延迟设置真实 src，避免长图文章一次性发起几十个请求把后面的图「饿死」。
  useEffect(() => {
    const el = imageRef.current;
    if (!el || !cleanSrc) {
      return;
    }
    const item: ImageLoadEntry = {
      el,
      src: cleanSrc,
      priority: 0,
      load: () => {
        // 有宽高元数据：直接加载，比例已由 knownRatio 预留，零跳动。
        if (knownRatio) {
          setActualSrc(cleanSrc);
          return;
        }
        // 没有宽高元数据：先用一次探测拿到真实比例并预留空间，
        // 再加载真实像素（同源 URL 已缓存，几乎瞬时淡入），
        // 避免「先按 16:9 占位、加载瞬间撑开成真实比例/尺寸」的跳动。
        const probe = new Image();
        probe.onload = () => {
          if (probe.naturalWidth && probe.naturalHeight) {
            setNaturalRatio(`${probe.naturalWidth} / ${probe.naturalHeight}`);
          }
          setActualSrc(cleanSrc);
        };
        probe.onerror = () => setActualSrc(cleanSrc);
        probe.src = cleanSrc;
      },
    };
    imageEntries.set(el, item);
    const obs = getImageObserver();
    obs?.observe(el);
    schedulePreloadThrottled(); // 注册后立刻评估预取窗口，首屏附近图片提前加载
    // 同步检查：图片已在视口内（含 rootMargin 200px）则立即加载，不等观察器异步回调。
    // 避免 IntersectionObserver 偶发未触发导致首图不加载（需上下滑动才出现）。
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    if (rect.top < vh + 200 && rect.bottom > -200) {
      requestImageLoad(item);
    }
    return () => {
      obs?.unobserve(el);
      imageEntries.delete(el);
      imageQueue = imageQueue.filter((q) => q.el !== el);
      if (el.dataset.loadState === "loading") {
        imageLoadingCount--;
        drainImageQueue();
      }
      el.dataset.loadState = "";
      setActualSrc(undefined);
    };
  }, [cleanSrc]);

  const handleLoad = () => {
    const el = imageRef.current;
    if (el && el.naturalWidth && el.naturalHeight) {
      setNaturalRatio(`${el.naturalWidth} / ${el.naturalHeight}`);
    }
    onLoad();
    releaseImageSlot(imageRef.current);
  };
  const handleError = () => {
    onError();
    releaseImageSlot(imageRef.current);
  };

  const showPlaceholder = !loaded && !failed;

  return (
    <span
      className={`${fill ? "block w-full max-w-none" : "relative inline-block max-w-full"} overflow-hidden ${roundedClass} ${
        showPlaceholder && !fill ? "bg-w dark:bg-neutral-800" : ""
      }`}
      style={{ zoom: scale, aspectRatio: effectiveAspectRatio }}
    >
      {showPlaceholder && blurhash ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={`absolute inset-0 h-full w-full scale-110 blur-sm ${roundedClass}`}
        />
      ) : null}
      {showPlaceholder && !blurhash ? (
        <span
          aria-hidden="true"
          className={`absolute inset-0 block animate-pulse bg-gradient-to-br from-black/5 to-black/10 dark:from-white/5 dark:to-white/10 ${roundedClass}`}
        />
      ) : null}
      <img
        ref={imageRef}
        src={actualSrc}
        alt={alt}
        width={width}
        height={height}
        decoding="async"
        onDoubleClick={() => {
          show(cleanSrc);
        }}
        onLoad={handleLoad}
        onError={handleError}
        className={`${fill ? "block w-full" : "mx-auto max-w-full"} cursor-pointer transition-opacity duration-300 ${roundedClass} ${
          className || ""
        } ${showPlaceholder ? "opacity-0" : "opacity-100"}`}
      />
    </span>
  );
}

// 微信 Android(X5)/老 iOS 兼容属性：React 类型未定义，用 as any 透传到底层 DOM。
// x5-video-player-type="h5" 切到 H5 播放器，尊重 CSS object-fit 与 inline 布局，
// 消除画面偏移并支持页内小窗播放；webkit-playsinline 兼容老 WebView。
const X5_VIDEO_ATTRS = {
  "webkit-playsinline": "true",
  "x5-playsinline": "true",
  "x5-video-player-type": "h5",
} as any;

function MarkdownVideo({
  src,
  poster,
}: {
  src?: string;
  poster?: string;
}) {
  // 视频地址可能带 #t=0.1 媒体片段（桌面浏览器用它预览首帧），需原样保留给 <video>；
  // 仅用 parseImageUrlMetadata 解析 poster 里的尺寸，用于首屏占位比例（缓解 CLS）。
  const posterMeta = poster ? parseImageUrlMetadata(poster) : undefined;
  const posterSrc = posterMeta?.src;
  // 视频占位比例优先级：视频真实比例 > 海报自然尺寸 > 海报内嵌尺寸 > 16:9。
  // 容器(外层 div)用此比例预留高度避免 CLS；视频绝对定位填满容器。
  // 关键：容器比例对齐视频真实比例后，无论微信 X5 是否遵守 object-fit，都不会再出现
  // 因「盒子比例 ≠ 视频帧比例」导致的 letterbox(黑边)。
  const [posterRatio, setPosterRatio] = useState<string | null>(null);
  const [videoRatio, setVideoRatio] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const placeholderRatio =
    videoRatio ??
    posterRatio ??
    (posterMeta?.width && posterMeta?.height
      ? `${posterMeta.width} / ${posterMeta.height}`
      : "16 / 9");

  // 用 ref + 多事件监听，比单靠 React 的 onLoadedMetadata 更可靠：
  // 微信 X5 / 部分 WebView 可能延迟或仅在 loadeddata/canplay 时才给出 videoWidth/Height，
  // 也可能首帧就用缓存直接就绪。把容器比例对齐视频真实比例，是去掉黑边的根本手段。
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const read = () => {
      if (v.videoWidth && v.videoHeight) {
        setVideoRatio(`${v.videoWidth} / ${v.videoHeight}`);
      }
    };
    v.addEventListener("loadedmetadata", read);
    v.addEventListener("loadeddata", read);
    v.addEventListener("canplay", read);
    v.addEventListener("durationchange", read);
    read(); // 已就绪(缓存命中)时立即读一次
    return () => {
      v.removeEventListener("loadedmetadata", read);
      v.removeEventListener("loadeddata", read);
      v.removeEventListener("canplay", read);
      v.removeEventListener("durationchange", read);
    };
  }, [src]);

  return (
    <div
      className="relative my-4 -mx-4 w-[calc(100%+2rem)] overflow-hidden bg-black"
      // 容器按占位比例(视频真实比例)预留高度，避免 CLS；视频绝对定位填满容器。
      style={{ aspectRatio: placeholderRatio }}
    >
      {/* 隐藏的 poster <img>：仅用于读取自然尺寸设定占位比例（缓解 CLS），
          微信内 <img> 正常加载；不可见、不拦截点击，video 自身始终承担显示与交互。 */}
      {posterSrc ? (
        <img
          src={posterSrc}
          alt=""
          aria-hidden="true"
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) {
              setPosterRatio(`${img.naturalWidth} / ${img.naturalHeight}`);
            }
          }}
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        />
      ) : null}
      {/* 视频绝对定位 inset-0 占满容器(宽高显式 100%，不受视频自身 intrinsic 尺寸干扰)，
          objectFit:fill(inline 最高优先级)作为兜底：即便容器比例因元数据未就绪而瞬时偏差，
          也用拉伸填满而非 letterbox。容器比例一旦对齐视频真实比例，则无形变。 */}
      <video
        ref={videoRef}
        src={src}
        poster={posterSrc}
        controls
        preload="metadata"
        playsInline
        {...X5_VIDEO_ATTRS}
        className="absolute inset-0 block h-full w-full bg-black"
        style={{ objectFit: "fill" }}
      />
    </div>
  );
}

export function Markdown({ content }: { content: string }) {
  const colorMode = useColorMode();
  const { t } = useTranslation();
  const [index, setIndex] = React.useState(-1);
  const slides = useRef<SlideImage[]>();

  useEffect(() => {
    slides.current = undefined;
  }, [content]);



  const Content = useMemo(() => (
    <ReactMarkdown
      className="toc-content dark:text-neutral-300"
      remarkPlugins={[gfm, remarkMermaid, remarkMath, remarkAlert, remarkBreaks]}
      children={content}
      rehypePlugins={[rehypeKatex, rehypeRaw]}
      components={{
        img({ node, src, ...props }) {
          const offset = node!.position!.start.offset!;
          const previousContent = content.slice(0, offset);
          const newlinesBefore = countNewlinesBeforeNode(
            previousContent,
            offset
          );
          const Image = ({
            rounded,
            scale,
            fill,
          }: {
            rounded: boolean;
            scale: string;
            fill?: boolean;
          }) => (
            <MarkdownImage
              src={src}
              alt={props.alt}
              show={show}
              rounded={rounded}
              scale={scale}
              fill={fill}
              className={props.className}
            />
          );
          if (
            newlinesBefore >= 1 ||
            previousContent.trim().length === 0 ||
            isMarkdownImageLinkAtEnd(previousContent)
          ) {
            // 块级图：全屏满铺（负边距出血到屏幕边缘），去掉圆角
            return (
              <span className="block -mx-4 w-[calc(100%+2rem)] my-4">
                <Image scale="1" rounded={false} fill={true} />
              </span>
            );
          } else {
            return (
              <span className="inline-block align-middle mx-1 ">
                <Image scale="0.5" rounded={false} />
              </span>
            );
          }
        },
        video({ src, poster }) {
          return <MarkdownVideo src={src} poster={poster} />;
        },
        code(props) {
          const [copied, setCopied] = React.useState(false);
          const { children, className, node, ...rest } = props;
          const match = /language-(\w+)/.exec(className || "");

          const curContent = content.slice(node?.position?.start.offset || 0);
          const isCodeBlock = curContent.trimStart().startsWith("```");

          const codeBlockStyle = {
            fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
            fontSize: "14px",
            fontVariantLigatures: "normal",
            WebkitFontFeatureSettings: '"liga" 1',
            fontFeatureSettings: '"liga" 1',
          };

          const inlineCodeStyle = {
            ...codeBlockStyle,
            fontSize: "13px",
          };

          const language = match ? match[1] : "";

          if (isCodeBlock) {
            return (
              <div className="relative group">
                <SyntaxHighlighter
                  PreTag="div"
                  className="rounded"
                  language={language}
                  style={
                    colorMode === "dark"
                      ? vscDarkPlus
                      : base16AteliersulphurpoolLight
                  }
                  wrapLongLines={true}
                  codeTagProps={{ style: codeBlockStyle }}
                >
                  {String(children).replace(/\n$/, "")}
                </SyntaxHighlighter>
                <button className="absolute top-1 right-1 px-2 py-1 bg-w rounded-md text-sm bg-hover select-none invisible group-hover:visible"
                  onClick={() => {
                    navigator.clipboard.writeText(String(children));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            );
          } else {
            return (
              <code
                {...rest}
                className={`bg-[#eff1f3] dark:bg-[#4a5061] h-[24px] px-[4px] rounded-md mx-[2px] py-[2px] text-neutral-800 dark:text-neutral-300 ${className || ""
                  }`}
                style={inlineCodeStyle}
              >
                {children}
              </code>
            );
          }
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote
              className="border-l-4 border-gray-300 dark:border-gray-500 pl-4 italic text-gray-500 dark:text-gray-400"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        em({ children, ...props }) {
          return (
            <em className="ml-[1px] mr-[4px]" {...props}>
              {children}
            </em>
          );
        },
        strong({ children, ...props }) {
          return (
            <strong className="mx-[1px]" {...props}>
              {children}
            </strong>
          );
        },

        ul({ children, className, ...props }) {
          const listClass = className?.includes("contains-task-list")
            ? "list-none pl-5"
            : "list-disc pl-5 mt-2";
          return (
            <ul className={listClass} {...props}>
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol className="list-decimal pl-5" {...props}>
              {children}
            </ol>
          );
        },
        li({ children, ...props }) {
          return (
            <li className="pl-2 py-1" {...props}>
              {children}
            </li>
          );
        },
        a({ children, ...props }) {
          return (
            <a
              className="text-[#0686c8] dark:text-[#2590f1] hover:underline"
              {...props}
            >
              {children}
            </a>
          );
        },
        h1({ children, ...props }) {
          return (
            <h1
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-3xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h1>
          );
        },
        h2({ children, ...props }) {
          return (
            <h2
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-2xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h2>
          );
        },
        h3({ children, ...props }) {
          return (
            <h3
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-xl font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h3>
          );
        },
        h4({ children, ...props }) {
          return (
            <h4
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-lg font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h4>
          );
        },
        h5({ children, ...props }) {
          return (
            <h5
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-base font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h5>
          );
        },
        h6({ children, ...props }) {
          return (
            <h6
              id={children?.toString()}
              {...props}
              className={`${props.className || ""} text-sm font-bold mt-4`.trim()}
              style={{ ...props.style, scrollMarginTop: "var(--header-scroll-offset, 7rem)" }}
            >
              {children}
            </h6>
          );
        },
        p({ children, node, ...props }) {
          return (
            <p className="mt-2 py-1" {...props}>
              {children}
            </p>
          );
        },
        hr({ children, ...props }) {
          return <hr className="my-4" {...props} />;
        },
        table: ({ node, ...props }) => <table className="table" {...props} />,
        th: ({ node, ...props }) => (
          <th className="px-4 py-2 border bg-gray-600" {...props} />
        ),
        td: ({ node, ...props }) => (
          <td className="px-4 py-2 border" {...props} />
        ),
        sup: ({ children, ...props }) => (
          <sup className="text-xs mr-[4px]" {...props}>
            {children}
          </sup>
        ),
        sub: ({ children, ...props }) => (
          <sub className="text-xs mr-[4px]" {...props}>
            {children}
          </sub>
        ),
        section({ children, ...props }) {
          if (props.hasOwnProperty("data-footnotes")) {
            props.className = `${props.className || ""} mt-8`.trim();
          }
          const modifiedChildren = React.Children.map(children, (child) => {
            if (isValidElement(child) && child.props.node.tagName === "ol") {
              return cloneElement(child, {
                ...child.props,
                className: "list-decimal px-10 text-sm text-[#6B7280]",
              } as React.HTMLAttributes<HTMLParagraphElement>);
            }
            return child;
          });
          return <section {...props}>{modifiedChildren}</section>;
        },
        iframe({ node, src, title, ...props }) {
          return (
            <div className="my-4 w-full">
              <iframe
                {...props}
                src={src}
                title={title || "Embedded content"}
                className="w-full rounded-xl border border-black/10 dark:border-white/10"
                style={{ minHeight: "400px" }}
                loading="lazy"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              />
            </div>
          );
        },
        div({ children, node, ...props }) {
          return <div {...props}>{children}</div>;
        },
        audio({ node }) {
          // Read all attributes from the hast node directly: this avoids
          // relying on react-markdown's per-tag prop typings (which omit
          // autoplay/loop on <audio>) and handles data-* uniformly.
          const props = (node?.properties ?? {}) as Record<string, unknown>;
          const src = typeof props.src === "string" ? props.src : undefined;
          const autoplay = props.autoplay !== undefined && props.autoplay !== false;
          const loop = props.loop !== undefined && props.loop !== false;
          const dataName = (props.dataName ?? props["data-name"]) as string | undefined;
          return (
            <AudioPlayer
              src={src}
              autoplay={autoplay}
              loop={loop}
              name={dataName}
            />
          );
        },
      }}
    />), [content])



  const show = (src: string | undefined) => {
    let slidesLocal = slides.current;
    if (!slidesLocal) {
      const parent = document.getElementsByClassName("toc-content")[0];
      if (!parent) return;
      const images = parent.querySelectorAll("img");
      slidesLocal = Array.from(images)
        .map((image) => {
          const url = image.getAttribute("src") || "";
          const filename = url.split("/").pop() || "";
          const alt = image.getAttribute("alt") || "";
          return {
            src: url,
            alt: alt,
            imageFit: "contain" as const,
            download: {
              url: url,
              filename: filename,
            },
          };
        })
        .filter((slide) => slide.src !== "");
      slides.current = (slidesLocal);
    }
    const index = slidesLocal?.findIndex((slide) => slide.src === src) ?? -1;
    setIndex(index);
  };

  return (
    <>
      {Content}
      <Lightbox
        plugins={[Download, Counter]}
        index={index}
        slides={slides.current}
        open={index >= 0}
        close={() => setIndex(-1)}
        on={{
          // 点击灯箱图片本身即关闭（退回文章）。库的 click 回调在 slide 被点击时触发
          // （含图片与背景，工具栏按钮已 stopPropagation 不冒泡到此），故直接关闭。
          click: () => {
            setIndex(-1);
          },
        }}
        render={{
          // 右上角显式渲染一个清晰的关闭按钮（深色圆底 + 白色叉），
          // 替换库默认的弱提示关闭图标，确保一眼可见、点击区域够大。
          buttonClose: () => (
            <button
              type="button"
              onClick={() => setIndex(-1)}
              aria-label={t("close")}
              className="yarl__button flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          ),
        }}
      />
    </>
  );
}
