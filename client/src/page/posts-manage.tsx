import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { client } from "../app/runtime";
import { useAlert, useConfirm } from "../components/dialog";
import { parseImageUrlMetadata } from "../utils/image-upload";
import { useTranslation } from "react-i18next";
import type { FeedListResponse } from "@rin/api";
import { useSiteConfig } from "../hooks/useSiteConfig";

// 列表项类型（后端 FeedListResponse.data 未声明 alias，这里补一个可选别名用于构造链接）。
type ManagePost = FeedListResponse["data"][number] & { alias?: string | null };

type FilterType = "all" | "normal" | "draft" | "unlisted" | "scheduled";

// 每页数量跟随全局「分页大小」设置（site.page_size），不再硬编码固定值。

// 拉取一页文章：keyword 非空走搜索，否则走列表（可带 type 状态筛选）。
// 模块级纯函数，避免副作用闭包导致的 lint 依赖告警；错误以返回值带回，由调用处提示。
async function fetchPosts(
  page: number,
  filter: FilterType,
  keyword: string,
  limit: number,
): Promise<{ items: ManagePost[]; total: number; hasNext: boolean; error?: string } | null> {
  const params = { page, limit };
  const req = keyword.trim()
    ? client.search.search(keyword.trim(), params)
    : client.feed.list({ ...params, type: filter === "all" ? undefined : filter });
  const { data, error } = await req;
  if (error) {
    return { items: [], total: 0, hasNext: false, error: error.value as string };
  }
  if (!data) {
    return { items: [], total: 0, hasNext: false };
  }
  // 后端用 limit+1 探测下一页，hasNext 为真时 data 会多带一条探测项，需截掉。
  const items = (data.hasNext ? data.data.slice(0, limit) : data.data) as ManagePost[];
  return { items, total: data.size, hasNext: data.hasNext };
}

export function PostsManagePage() {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  // 每页数量跟随全局「分页大小」设置；限制在 [1,100] 防止异常值拖垮加载。
  const limit = Math.min(100, Math.max(1, siteConfig.pageSize || 20));
  const { showAlert, AlertUI } = useAlert();
  const { showConfirm, ConfirmUI } = useConfirm();

  const [filter, setFilter] = useState<FilterType>("all");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ManagePost[]>([]);
  const [total, setTotal] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<number | null>(null);

  const run = async (p: number, f: FilterType, kw: string) => {
    setLoading(true);
    const r = await fetchPosts(p, f, kw, limit);
    setLoading(false);
    if (r?.error) {
      showAlert(r.error);
    } else if (r) {
      setItems(r.items);
      setTotal(r.total);
      setHasNext(r.hasNext);
    }
  };

  // 仅挂载时加载第一页（全部）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const r = await fetchPosts(1, "all", "", limit);
      if (cancelled) return;
      setLoading(false);
      if (r?.error) showAlert(r.error);
      else if (r) {
        setItems(r.items);
        setTotal(r.total);
        setHasNext(r.hasNext);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅挂载加载一次；showAlert 来自 hook，闭包稳定，禁用该规则以免重复加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeFilter = (f: FilterType) => {
    setFilter(f);
    setSelected(new Set());
    setPage(1);
    run(1, f, keyword);
  };

  const changeKeyword = (kw: string) => {
    setKeyword(kw);
    setSelected(new Set());
    setPage(1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => run(1, filter, kw), 400);
  };

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allChecked = items.length > 0 && items.every((it) => selected.has(it.id));
  const toggleAll = () => {
    setSelected((prev) => {
      if (prev.size > 0 && items.every((it) => prev.has(it.id))) {
        return new Set();
      }
      return new Set(items.map((it) => it.id));
    });
  };

  const batchDelete = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    showConfirm(
      t("admin.posts.batch_delete"),
      t("admin.posts.delete_selected_confirm", { count: ids.length }),
      async () => {
        const results = await Promise.allSettled(ids.map((id) => client.feed.delete(id)));
        const ok = results.filter(
          (r) => r.status === "fulfilled" && !(r.value as { error?: unknown } | undefined)?.error,
        ).length;
        const fail = ids.length - ok;
        showAlert(fail === 0 ? t("delete.success") : t("admin.posts.partial", { ok, fail }));
        setSelected(new Set());
        run(page, filter, keyword);
      },
    );
  };

  // 批量变更文章状态。后端 POST /feed/:id 为合并更新：仅传 listed/draft，
  // 其余字段 undefined 会被跳过，因此无需先读取现有状态即可直接设定目标状态。
  // - toList：移入文章列表（公开）  listed=true,  draft=false
  // - outList：移出文章列表（未发布）listed=false, draft=false
  // - toDraft：移入草稿箱          listed=false, draft=true
  type MoveAction = "toList" | "outList" | "toDraft";
  const moveConfig: Record<MoveAction, { listed: boolean; draft: boolean; btn: string; confirm: string }> = {
    toList: { listed: true, draft: false, btn: "admin.posts.move_to_list", confirm: "admin.posts.move_to_list_confirm" },
    outList: { listed: false, draft: false, btn: "admin.posts.move_out_list", confirm: "admin.posts.move_out_list_confirm" },
    toDraft: { listed: false, draft: true, btn: "admin.posts.move_to_draft", confirm: "admin.posts.move_to_draft_confirm" },
  };
  const batchMove = (action: MoveAction) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const cfg = moveConfig[action];
    showConfirm(
      t(cfg.btn),
      t(cfg.confirm, { count: ids.length }),
      async () => {
        const results = await Promise.allSettled(
          ids.map((id) => client.feed.update(id, { listed: cfg.listed, draft: cfg.draft })),
        );
        const ok = results.filter(
          (r) => r.status === "fulfilled" && !(r.value as { error?: unknown } | undefined)?.error,
        ).length;
        const fail = ids.length - ok;
        showAlert(fail === 0 ? t("admin.posts.move_done", { count: ok }) : t("admin.posts.partial", { ok, fail }));
        setSelected(new Set());
        run(page, filter, keyword);
      },
    );
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-6">
      {/* 工具栏：状态筛选 + 搜索 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {(["all", "normal", "draft", "unlisted", "scheduled"] as FilterType[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => changeFilter(f)}
            className={`px-3 py-1 rounded-full text-sm border transition-colors ${
              filter === f
                ? "bg-theme text-white border-theme"
                : "border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300"
            }`}
          >
            {t(`admin.posts.filter_${f}`)}
          </button>
        ))}
        <input
          type="text"
          value={keyword}
          onChange={(e) => changeKeyword(e.target.value)}
          placeholder={t("admin.posts.search_placeholder")}
          className="ml-auto px-3 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent text-sm w-48 focus:outline-none focus:border-theme"
        />
      </div>

      {/* 批量操作条：全选 + 删除选中 + 批量移动状态 */}
      <div className="flex flex-wrap items-center gap-3 text-sm mb-4">
        <label className="flex items-center gap-1 cursor-pointer select-none text-neutral-600 dark:text-neutral-300">
          <input type="checkbox" checked={allChecked} onChange={toggleAll} className="accent-theme h-4 w-4" />
          {t("admin.posts.select_all")}
        </label>
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={batchDelete}
              className="px-3 py-1 rounded bg-red-500 text-white text-sm hover:bg-red-600 inline-flex items-center gap-1"
            >
              <i className="ri-delete-bin-line" />
              {t("admin.posts.batch_delete")} ({selected.size})
            </button>
            <button
              type="button"
              onClick={() => batchMove("toList")}
              className="px-3 py-1 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 text-sm hover:bg-neutral-100 dark:hover:bg-white/10 inline-flex items-center gap-1"
            >
              <i className="ri-eye-line" />
              {t("admin.posts.move_to_list")}
            </button>
            <button
              type="button"
              onClick={() => batchMove("outList")}
              className="px-3 py-1 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 text-sm hover:bg-neutral-100 dark:hover:bg-white/10 inline-flex items-center gap-1"
            >
              <i className="ri-eye-off-line" />
              {t("admin.posts.move_out_list")}
            </button>
            <button
              type="button"
              onClick={() => batchMove("toDraft")}
              className="px-3 py-1 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 text-sm hover:bg-neutral-100 dark:hover:bg-white/10 inline-flex items-center gap-1"
            >
              <i className="ri-file-edit-line" />
              {t("admin.posts.move_to_draft")}
            </button>
            <span className="text-neutral-500">{t("admin.posts.selected", { count: selected.size })}</span>
          </div>
        )}
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="py-10 text-center text-neutral-500">{t("admin.posts.loading")}</div>
      ) : items.length === 0 ? (
        <div className="py-10 text-center text-neutral-500">{t("admin.posts.empty")}</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 hover:border-theme"
            >
              <input
                type="checkbox"
                checked={selected.has(it.id)}
                onChange={() => toggle(it.id)}
                className="accent-theme h-4 w-4 shrink-0"
                aria-label={t("admin.posts.select_all")}
              />
              {it.avatar ? (
                <Link
                  href={`/feed/${it.alias || it.id}`}
                  target="_blank"
                  className="block h-14 w-20 shrink-0 overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800"
                >
                  <img
                    src={parseImageUrlMetadata(it.avatar).src}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </Link>
              ) : (
                <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-400 dark:bg-neutral-800">
                  <i className="ri-image-line text-lg" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <Link
                  href={`/feed/${it.alias || it.id}`}
                  target="_blank"
                  className="block truncate hover:text-theme text-black dark:text-white"
                >
                  {it.title || t("admin.posts.untitled")}
                </Link>
                {it.scheduledAt ? (
                  <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-theme/10 px-2 py-0.5 text-xs font-medium text-theme">
                    <i className="ri-time-line" />
                    {t("scheduled.hint", { time: new Date(it.scheduledAt).toLocaleString() })}
                  </span>
                ) : null}
                {it.summary ? (
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                    {it.summary}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 text-xs text-neutral-400">
                {new Date(it.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 分页 */}
      <div className="flex items-center justify-center gap-4 mt-6 text-sm">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => {
            const p = page - 1;
            setPage(p);
            run(p, filter, keyword);
          }}
          className="px-3 py-1 rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-40"
        >
          {t("admin.posts.prev")}
        </button>
        <span className="text-neutral-500">{t("admin.posts.page_info", { page, total })}</span>
        <button
          type="button"
          disabled={!hasNext}
          onClick={() => {
            const p = page + 1;
            setPage(p);
            run(p, filter, keyword);
          }}
          className="px-3 py-1 rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-40"
        >
          {t("admin.posts.next")}
        </button>
      </div>

      <ConfirmUI />
      <AlertUI />
    </div>
  );
}
