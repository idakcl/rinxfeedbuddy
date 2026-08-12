import { useContext, useEffect, useRef, useState } from "react"
import { Helmet } from 'react-helmet'
import { useTranslation } from "react-i18next"
import { Link, useLocation, useSearch } from "wouter"
import { FeedCard } from "../components/feed_card"
import { Waiting } from "../components/loading"
import { ProfileContext } from "../state/profile"
import { client } from "../app/runtime"

import { useSiteConfig } from "../hooks/useSiteConfig";
import { siteName } from "../utils/constants"
import { tryInt } from "../utils/int"
import type { FeedType } from "../hooks/useInfiniteFeed";

type FeedsData = {
    size: number,
    data: any[],
    hasNext: boolean
}

export function FeedsPage() {
    const { t } = useTranslation()
    const siteConfig = useSiteConfig();
    const query = new URLSearchParams(useSearch());
    const [, navigate] = useLocation();
    const profile = useContext(ProfileContext);
    const type = ((query.get("type") as FeedType) || 'normal')
    const limit = tryInt(siteConfig.pageSize, query.get("limit"))
    const feedListClass = siteConfig.feedLayout === "masonry" ? "wauto-feed columns-1 gap-5 ani-show md:columns-2" : "wauto-feed flex flex-col ani-show";

    const [status, setStatus] = useState<'loading' | 'idle'>('idle')
    const [feeds, setFeeds] = useState<FeedsData>()
    const page = tryInt(1, query.get("page"))
    const totalPages = feeds?.size ? Math.max(1, Math.ceil(feeds.size / limit)) : 1
    const [goto, setGoto] = useState("")
    const ref = useRef("")

    function fetchFeeds() {
        client.feed.list({ page, limit, type }).then(({ data }) => {
            if (data) {
                setFeeds(data)
                setStatus('idle')
            }
        })
    }
    useEffect(() => {
        const key = `${page} ${limit} ${type}`
        if (ref.current == key) return
        setStatus('loading')
        fetchFeeds()
        ref.current = key
    }, [page, limit, type])

    // 翻页窗口：以当前页为中心 ±2
    const pageWindow: number[] = []
    const start = Math.max(1, page - 2)
    const end = Math.min(totalPages, page + 2)
    for (let i = start; i <= end; i++) pageWindow.push(i)

    const gotoHref = (p: number) => `/?type=${type}&page=${p}&limit=${limit}`
    const pageBtnClass = (active: boolean) =>
        `text-sm font-normal rounded-full px-4 py-2 ${active ? "text-white bg-theme" : "text-neutral-500 hover:text-theme"}`

    return (
        <>
            <Helmet>
                <title>{`${t('article.title')} - ${siteConfig.name}`}</title>
                <meta property="og:site_name" content={siteName} />
                <meta property="og:title" content={t('article.title')} />
                <meta property="og:image" content={siteConfig.avatar} />
                <meta property="og:type" content="article" />
                <meta property="og:url" content={document.URL} />
            </Helmet>
            <Waiting for={status === 'idle'}>
                <main className="w-full flex flex-col justify-center items-center mb-8">
                    <div className="wauto-feed text-start text-black dark:text-white py-4 text-4xl font-bold">
                        <p>
                            {type === 'draft' ? t('draft_bin') : type === 'normal' ? t('article.title') : t('unlisted')}
                        </p>
                        <div className="flex flex-row justify-between">
                            <p className="text-sm mt-4 text-neutral-500 font-normal">
                                {t('article.total$count', { count: feeds?.size })}
                            </p>
                            {profile?.permission &&
                                <div className="flex flex-row space-x-4">
                                    <Link href={type === 'draft' ? '/?type=normal' : '/?type=draft'} className={`text-sm mt-4 text-neutral-500 font-normal ${type === 'draft' ? "text-theme" : ""}`}>
                                        {t('draft_bin')}
                                    </Link>
                                    <Link href={type === 'unlisted' ? '/?type=normal' : '/?type=unlisted'} className={`text-sm mt-4 text-neutral-500 font-normal ${type === 'unlisted' ? "text-theme" : ""}`}>
                                        {t('unlisted')}
                                    </Link>
                                </div>
                            }
                        </div>
                    </div>
                    <div className={feedListClass}>
                        {(feeds?.data ?? []).map(({ id, ...feed }: any) => (
                            <FeedCard key={id} id={id} {...feed} />
                        ))}
                    </div>
                    <div className="wauto-feed flex flex-col items-center mt-4 ani-show">
                        {/* 当前页 / 总页数 */}
                        <div className="text-sm text-neutral-500 font-normal py-2">
                            {t('page_current', { page, total: totalPages })}
                        </div>
                        <div className="flex flex-row items-center justify-center gap-2 flex-wrap">
                            {/* 首页 */}
                            {page > 1 && (
                                <Link href={gotoHref(1)} className={pageBtnClass(false)}>
                                    {t('first')}
                                </Link>
                            )}
                            {/* 上一页 */}
                            {page > 1 && (
                                <Link href={gotoHref(page - 1)} className={pageBtnClass(false)}>
                                    {t('previous')}
                                </Link>
                            )}
                            {/* 页码窗口 */}
                            {pageWindow.map((p) => (
                                <Link key={p} href={gotoHref(p)} className={pageBtnClass(p === page)}>
                                    {p}
                                </Link>
                            ))}
                            {/* 下一页 */}
                            {feeds?.hasNext && (
                                <Link href={gotoHref(page + 1)} className={pageBtnClass(false)}>
                                    {t('next')}
                                </Link>
                            )}
                            {/* 末页 */}
                            {feeds?.hasNext && (
                                <Link href={gotoHref(totalPages)} className={pageBtnClass(false)}>
                                    {t('last')}
                                </Link>
                            )}
                        </div>
                        {/* 输入数字确认跳转 */}
                        <form
                            className="flex flex-row items-center gap-2 mt-3"
                            onSubmit={(e) => {
                                e.preventDefault()
                                const n = tryInt(0, goto)
                                if (n >= 1 && n <= totalPages) {
                                    navigate(gotoHref(n))
                                }
                            }}
                        >
                            <input
                                type="number"
                                min={1}
                                max={totalPages}
                                value={goto}
                                onChange={(e) => setGoto(e.target.value)}
                                placeholder={t('page_goto')}
                                className="w-20 text-sm rounded-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-transparent text-black dark:text-white outline-none focus:border-theme"
                            />
                            <button type="submit" className="text-sm font-normal rounded-full px-4 py-2 text-neutral-500 hover:text-theme">
                                {t('page_goto')}
                            </button>
                        </form>
                    </div>
                </main>
            </Waiting>
        </>
    )
}
