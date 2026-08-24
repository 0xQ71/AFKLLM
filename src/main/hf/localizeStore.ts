import {
  HF_RECOMMENDED_MODELS,
  HF_VISION_RECOMMENDED_MODELS,
  type HfModelDetail,
  type HfModelListItem,
  type HfStoreHomeResult
} from '../../shared/hfStore'
import type { UiLanguage } from '../../shared/i18n'
import { translateEnToRu, translateMarkdownEnToRu } from './translateRu'

function curatedRu(repoId: string, preferredFile?: string): string | undefined {
  const catalogs = [...HF_RECOMMENDED_MODELS, ...HF_VISION_RECOMMENDED_MODELS]
  const hits = catalogs.filter((r) => r.repoId === repoId)
  if (!hits.length) return undefined
  const hit =
    (preferredFile
      ? hits.find(
          (h) =>
            h.preferredFile === preferredFile ||
            h.preferredMmproj === preferredFile
        )
      : undefined) ?? hits[0]
  return hit?.descriptionRu
}

async function localizeOneDescription(
  text: string | undefined,
  repoId: string,
  preferredFile?: string
): Promise<string | undefined> {
  const curated = curatedRu(repoId, preferredFile)
  if (curated) return curated
  if (!text) return undefined
  return translateEnToRu(text)
}

export async function localizeHfListItems(
  items: HfModelListItem[],
  lang: UiLanguage
): Promise<HfModelListItem[]> {
  if (lang !== 'ru') return items
  return Promise.all(
    items.map(async (item) => {
      const description = await localizeOneDescription(
        item.description,
        item.id,
        item.preferredFile
      )
      return description === item.description ? item : { ...item, description }
    })
  )
}

export async function localizeHfHome(
  home: HfStoreHomeResult,
  lang: UiLanguage
): Promise<HfStoreHomeResult> {
  if (lang !== 'ru') return home
  const items = await localizeHfListItems(home.items, lang)
  return { ...home, items }
}

export async function localizeHfDetail(
  detail: HfModelDetail,
  lang: UiLanguage
): Promise<HfModelDetail> {
  if (lang !== 'ru') return detail
  // Short blurb only — README is localized async so opening a model stays fast.
  const description = await localizeOneDescription(
    detail.description,
    detail.id,
    detail.preferredFile
  )
  return {
    ...detail,
    description: description ?? detail.description
  }
}

/** Background README EN→RU. Caller should push result to UI when done. */
export async function localizeHfReadme(
  detail: HfModelDetail,
  lang: UiLanguage
): Promise<string | null> {
  if (lang !== 'ru') return null
  if (!detail.readmeMarkdown?.trim()) return null
  const next = await translateMarkdownEnToRu(detail.readmeMarkdown)
  return next === detail.readmeMarkdown ? null : next
}
