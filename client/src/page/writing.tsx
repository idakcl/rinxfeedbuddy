import i18n from 'i18next';
import _ from 'lodash';
import {lazy, Suspense, useCallback, useEffect, useState} from "react";
import {Helmet} from "react-helmet";
import {useTranslation} from "react-i18next";
import Loading from 'react-loading';
import {ShowAlertType, useAlert} from '../components/dialog';
import {Checkbox, Input} from "../components/input";
import { DateTimeInput, FlatMetaRow, FlatPanel } from "@rin/ui";
import { client } from "../app/runtime";
import {Cache} from '../utils/cache';
import {useSiteConfig} from "../hooks/useSiteConfig";
import {siteName} from "../utils/constants";

// 写作编辑器（含 monaco-editor ~2MB）按需懒加载，移出首屏 bundle
const MarkdownEditor = lazy(() =>
  import("../components/markdown_editor").then((m) => ({ default: m.MarkdownEditor })),
);

async function publish({
  title,
  alias,
  listed,
  content,
  summary,
  tags,
  draft,
  createdAt,
  scheduledAt,
  successKey,
  onCompleted,
  showAlert
}: {
  title: string;
  listed: boolean;
  content: string;
  summary: string;
  tags: string[];
  draft: boolean;
  alias?: string;
  createdAt?: Date;
  scheduledAt?: string | null;
  successKey?: string;
  onCompleted?: () => void;
  showAlert: ShowAlertType;
}) {
  const t = i18n.t
  const { data, error } = await client.feed.create(
    {
      title,
      alias,
      content,
      summary,
      tags,
      listed,
      draft,
      createdAt: createdAt?.toISOString(),
      scheduledAt,
    }
  );
  if (onCompleted) {
    onCompleted();
  }
  if (error) {
    showAlert(error.value as string);
  }
  if (data) {
    showAlert(t(successKey ?? "publish.success"), () => {
      Cache.with().clear();
      window.location.href = "/feed/" + (data.alias || data.insertedId);
    });
  }
}

async function update({
  id,
  title,
  alias,
  content,
  summary,
  tags,
  listed,
  draft,
  createdAt,
  scheduledAt,
  successKey,
  onCompleted,
  showAlert
}: {
  id: number;
  listed: boolean;
  title?: string;
  alias?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  draft?: boolean;
  createdAt?: Date;
  scheduledAt?: string | null;
  successKey?: string;
  onCompleted?: () => void;
  showAlert: ShowAlertType;
}) {
  const t = i18n.t
  const { error } = await client.feed.update(
    id,
    {
      title,
      alias,
      content,
      summary,
      tags,
      listed,
      draft,
      createdAt: createdAt?.toISOString(),
      scheduledAt,
    }
  );
  if (onCompleted) {
    onCompleted();
  }
  if (error) {
    showAlert(error.value as string);
  } else {
    showAlert(t(successKey ?? "update.success"), () => {
      Cache.with(id).clear();
      window.location.href = "/feed/" + (alias || id);
    });
  }
}

// 写作页面
export function WritingPage({ id }: { id?: number }) {
  const { t } = useTranslation();
  const siteConfig = useSiteConfig();
  const cache = Cache.with(id);
  const [title, setTitle] = cache.useCache("title", "");
  const [summary, setSummary] = cache.useCache("summary", "");
  const [tags, setTags] = cache.useCache("tags", "");
  const [alias, setAlias] = cache.useCache("alias", "");
  const [draft, setDraft] = useState(false);
  const [listed, setListed] = useState(true);
  const [content, setContent] = cache.useCache("content", "");
  const [createdAt, setCreatedAt] = useState<Date | undefined>(new Date());
  const [scheduledAt, setScheduledAt] = useState<Date | undefined>(undefined);
  const [publishing, setPublishing] = useState(false)
  const { showAlert, AlertUI } = useAlert()
  function publishButton() {
    if (publishing) return;
    const tagsplit =
      tags
        .split("#")
        .filter((tag) => tag !== "")
        .map((tag) => tag.trim()) || [];
    if (id !== undefined) {
      setPublishing(true)
      update({
        id,
        title,
        content,
        summary,
        alias,
        tags: tagsplit,
        draft,
        listed,
        createdAt,
        scheduledAt: null,
        onCompleted: () => {
          setPublishing(false)
        },
        showAlert
      });
    } else {
      if (!title) {
        showAlert(t("title_empty"))
        return;
      }
      if (!content) {
        showAlert(t("content.empty"))
        return;
      }
      setPublishing(true)
      publish({
        title,
        content,
        summary,
        tags: tagsplit,
        draft,
        alias,
        listed,
        createdAt,
        scheduledAt: null,
        onCompleted: () => {
          setPublishing(false)
        },
        showAlert
      });
    }
  }

  // 定时发布：校验时间合法性后，以草稿（隐藏）状态保存并带上排期时间，等待 cron 到点翻转。
  function scheduledPublishButton() {
    if (publishing) return;
    const tagsplit =
      tags
        .split("#")
        .filter((tag) => tag !== "")
        .map((tag) => tag.trim()) || [];
    if (!title) {
      showAlert(t("title_empty"));
      return;
    }
    if (!content) {
      showAlert(t("content.empty"));
      return;
    }
    if (!scheduledAt || scheduledAt.getTime() <= Date.now() + 60000) {
      showAlert(t("scheduled.past"));
      return;
    }
    setPublishing(true);
    const common = {
      title,
      content,
      summary,
      tags: tagsplit,
      alias,
      listed,
      draft: true,
      createdAt,
      scheduledAt: scheduledAt.toISOString(),
      successKey: "scheduled.success",
      onCompleted: () => setPublishing(false),
      showAlert,
    };
    if (id !== undefined) {
      update({ id, ...common });
    } else {
      publish({ ...common });
    }
  }

  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    client.feed
      .get(id)
      .then(({ data }) => {
        if (cancelled || !data) return;
        // 始终以服务端已保存内容为准回填：避免组件实例复用 / 本地缓存残留
        // 导致编辑框显示上一次文章或陈旧内容（“乱了”的根因）
        setTitle(data.title ?? "");
        if (Array.isArray(data.hashtags))
          setTags(data.hashtags.map(({ name }: {name: string}) => `#${name}`).join(" "));
        setAlias((data as any).alias ?? "");
        setContent(data.content ?? "");
        setSummary((data as any).summary ?? "");
        setListed((data as any).listed === 1);
        setDraft((data as any).draft === 1);
        setCreatedAt(new Date(data.createdAt));
        setScheduledAt((data as any).scheduledAt ? new Date((data as any).scheduledAt) : undefined);
      });
    return () => { cancelled = true; };
  }, [id]);
  const debouncedUpdate = useCallback(
    _.debounce(() => {
      // mermaid 体积大，按需动态加载
      void (async () => {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: "default" });
        await mermaid.run({
          suppressErrors: true,
          nodes: document.querySelectorAll("pre.mermaid_default"),
        });
        mermaid.initialize({ startOnLoad: false, theme: "dark" });
        await mermaid.run({
          suppressErrors: true,
          nodes: document.querySelectorAll("pre.mermaid_dark"),
        });
      })();
    }, 100),
    []
  );
  useEffect(() => {
    debouncedUpdate();
  }, [content, debouncedUpdate]);
  function PublishButton({ className }: { className?: string }) {
    return (
      <button
        onClick={publishButton}
        className={`inline-flex items-center justify-center gap-2 rounded-xl bg-theme px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-theme-hover active:bg-theme-active disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ""}`}
        disabled={publishing}
      >
        {publishing && <Loading type="spin" height={16} width={16} />}
        <span>{t('publish.title')}</span>
      </button>
    );
  }

  function ScheduledPublishButton({ className }: { className?: string }) {
    return (
      <button
        onClick={scheduledPublishButton}
        className={`inline-flex items-center justify-center gap-2 rounded-xl border border-theme px-5 py-3 text-sm font-medium text-theme transition-colors hover:bg-theme/10 active:bg-theme/20 disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ""}`}
        disabled={publishing}
      >
        {publishing && <Loading type="spin" height={16} width={16} />}
        <span>{t('scheduled.publish')}</span>
      </button>
    );
  }

  function MetaInput({ className }: { className?: string }) {
    return (
        <FlatPanel className={className}>
          <div className="flex flex-row gap-4 border-b border-black/5 pb-5 dark:border-white/5 items-start justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-theme/70">{t('writing')}</p>
              <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                {id !== undefined ? t("update.title") : t("publish.title")}
              </p>
            </div>
            <PublishButton className="w-auto" />
            <ScheduledPublishButton className="w-auto" />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <Input
                id={id}
                value={title}
                setValue={setTitle}
                placeholder={t("title")}
                variant="flat"
                className="text-base"
              />
            </div>
            <Input
              id={id}
              value={summary}
              setValue={setSummary}
              placeholder={t("summary")}
              variant="flat"
            />
            <Input
              id={id}
              value={alias}
              setValue={setAlias}
              placeholder={t("alias")}
              variant="flat"
            />
            <Input
              id={id}
              value={tags}
              setValue={setTags}
              placeholder={t("tags")}
              variant="flat"
              className="lg:col-span-2"
            />
          </div>

          <div className="mt-5 grid gap-2 sm:gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(18rem,2fr)]">
            <FlatMetaRow
              className="cursor-pointer rounded-none border-0 bg-transparent px-0 py-2 sm:rounded-2xl sm:border sm:bg-secondary sm:px-4 sm:py-3"
              onClick={() => setDraft(!draft)}
            >
              <p>{t('visible.self_only')}</p>
              <Checkbox
                id="draft"
                value={draft}
                setValue={setDraft}
                placeholder={t('draft')}
              />
            </FlatMetaRow>
            <FlatMetaRow
              className="cursor-pointer rounded-none border-0 bg-transparent px-0 py-2 sm:rounded-2xl sm:border sm:bg-secondary sm:px-4 sm:py-3"
              onClick={() => setListed(!listed)}
            >
              <p>{t('listed')}</p>
              <Checkbox
                id="listed"
                value={listed}
                setValue={setListed}
                placeholder={t('listed')}
              />
            </FlatMetaRow>
            <FlatMetaRow className="gap-3 rounded-none border-0 bg-transparent px-0 py-2 sm:rounded-2xl sm:border sm:bg-secondary sm:px-4 sm:py-3 xl:col-span-1">
              <p className="mr-2 whitespace-nowrap">
                {t('created_at')}
              </p>
              <DateTimeInput value={createdAt} onChange={setCreatedAt} className="w-full max-w-[16rem]" />
            </FlatMetaRow>
            <FlatMetaRow className="gap-3 rounded-none border-0 bg-transparent px-0 py-2 sm:rounded-2xl sm:border sm:bg-secondary sm:px-4 sm:py-3 xl:col-span-1">
              <p className="mr-2 whitespace-nowrap">
                {t('scheduled_at')}
              </p>
              <DateTimeInput value={scheduledAt} onChange={setScheduledAt} className="w-full max-w-[16rem]" />
            </FlatMetaRow>
          </div>
        </FlatPanel>
    )
  }

  return (
    <>
      <Helmet>
        <title>{`${t('writing')} - ${siteConfig.name}`}</title>
        <meta property="og:site_name" content={siteName} />
        <meta property="og:title" content={t('writing')} />
        <meta property="og:image" content={siteConfig.avatar} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={document.URL} />
      </Helmet>
      <div className="mt-2 flex flex-col gap-4 t-primary sm:gap-6">
        {MetaInput({ className: "p-4 sm:p-5 md:p-6" })}

        <FlatPanel className="overflow-hidden p-0">
          <Suspense fallback={null}>
            <MarkdownEditor content={content} setContent={setContent} height='680px' />
          </Suspense>
        </FlatPanel>
      </div>
      <AlertUI />
    </>
  );
}
