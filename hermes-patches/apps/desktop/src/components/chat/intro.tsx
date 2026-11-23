import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { $profiles, newSessionInProfile, profileLabel } from '@/store/profile'
import { useI18n } from '@/i18n'
import { capitalize, normalize } from '@/lib/text'

import introCopyJsonl from './intro-copy.jsonl?raw'
import { Wordmark } from './wordmark'

type IntroCopy = {
  headline: string
  body: string
}

type IntroCopyRecord = IntroCopy & {
  personality: string
}

export type IntroProps = {
  personality?: string
  seed?: number
}

const NEUTRAL_PERSONALITIES = new Set(['', 'default', 'none', 'neutral'])

const FALLBACK_COPY: IntroCopy[] = [
  {
    headline: 'What are we moving today?',
    body: "Send a bug, branch, plan, or rough idea. I'll inspect the repo and turn it into the next concrete step."
  },
  {
    headline: "What's on your mind?",
    body: "Bring the code, question, or stuck part. I'll read the room before making changes."
  },
  {
    headline: 'What should Hermes look at?',
    body: "Send the task, failing path, or half-formed plan. I'll help turn it into action."
  },
  {
    headline: 'Where should we start?',
    body: "Bring the problem, goal, or file. I'll inspect first and keep the next step concrete."
  },
  {
    headline: 'What needs attention?',
    body: "Send the context you have. I'll help sort it into a plan or a fix."
  }
]

function normalizeKey(value?: string): string {
  return normalize(value)
}

function titleize(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ')
}

function isIntroCopyRecord(value: unknown): value is IntroCopyRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>

  return (
    typeof record.personality === 'string' &&
    typeof record.headline === 'string' &&
    typeof record.body === 'string' &&
    Boolean(record.personality.trim()) &&
    Boolean(record.headline.trim()) &&
    Boolean(record.body.trim())
  )
}

function parseIntroCopy(raw: string): Record<string, IntroCopy[]> {
  const byPersonality: Record<string, IntroCopy[]> = {}

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed) {
      continue
    }

    try {
      const parsed: unknown = JSON.parse(trimmed)

      if (!isIntroCopyRecord(parsed)) {
        continue
      }

      const key = normalizeKey(parsed.personality)
      byPersonality[key] ??= []
      byPersonality[key].push({
        headline: parsed.headline.trim(),
        body: parsed.body.trim()
      })
    } catch {
      // Bad generated copy should not break the whole desktop app.
    }
  }

  return byPersonality
}

const INTRO_COPY_BY_PERSONALITY = parseIntroCopy(introCopyJsonl)

function neutralCopy(): IntroCopy[] {
  return INTRO_COPY_BY_PERSONALITY.none || INTRO_COPY_BY_PERSONALITY.default || FALLBACK_COPY
}

function fallbackCopyForPersonality(personalityKey: string): IntroCopy[] {
  if (NEUTRAL_PERSONALITIES.has(personalityKey)) {
    return neutralCopy()
  }

  const label = titleize(personalityKey)

  return [
    {
      headline: `${label} mode is on. What should we work on?`,
      body: "Send the task, file, or rough idea. I'll use your configured voice and keep the work grounded in this repo."
    },
    {
      headline: `What does ${label} Hermes need to see?`,
      body: "Bring the context or the stuck part. I'll adapt to your configured personality."
    },
    {
      headline: `${label} mode is ready.`,
      body: "Send the problem, file, or idea. I'll follow the personality you've configured."
    },
    {
      headline: `What should ${label} Hermes tackle?`,
      body: "Drop the task here. I'll keep the work grounded in the repo."
    },
    {
      headline: 'Where should we begin?',
      body: `Give me the context and I'll answer in ${label} mode.`
    }
  ]
}

function pickCopy(copies: IntroCopy[], seed = 0): IntroCopy {
  return copies[Math.abs(seed) % copies.length] || FALLBACK_COPY[0]
}

const WORDMARK = 'HERMES AGENT'

function resolveCopy(personality?: string, seed?: number): IntroCopy {
  const personalityKey = normalizeKey(personality)

  const copies = NEUTRAL_PERSONALITIES.has(personalityKey)
    ? INTRO_COPY_BY_PERSONALITY[personalityKey] || neutralCopy()
    : INTRO_COPY_BY_PERSONALITY[personalityKey] || fallbackCopyForPersonality(personalityKey)

  return pickCopy(copies, seed)
}

export function Intro({ personality, seed }: IntroProps) {
  const [mountSeed] = useState(() => Math.floor(Math.random() * 100000))
  const { t } = useI18n()
  const rotationSeed = mountSeed + (seed ?? 0)
  const copy = resolveCopy(personality, rotationSeed)
  const key = normalizeKey(personality)

  const bodies =
    t.intro.stock[key] ?? (NEUTRAL_PERSONALITIES.has(key) ? t.intro.stock.none : t.intro.custom(personality || ''))

  const body = bodies?.[Math.abs(rotationSeed) % bodies.length] ?? copy.body

  // 场景入口的数据源：hermes 的 profile 列表（display_name 由
  // prototype/hermes-agents/sync-profile-display.mjs 从 workbench/外壳/scenarios 单向同步）。
  // 组件里不硬编码任何场景名 —— 硬编码就是漂移的起点（ECC 45% 漂移就是这么来的）。
  const profiles = useStore($profiles)
  const scenes = useMemo(() => profiles.filter((p) => !p.is_default && p.name !== 'default'), [profiles])

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center text-muted-foreground sm:px-6 lg:px-8"
      data-slot="aui_intro"
    >
      <div className="w-full min-w-0">
        <Wordmark className="mb-1" text={WORDMARK} />

        <p className="m-0 text-center leading-normal tracking-tight">{body}</p>

        {/* 空态不该只有一句文案。借鉴 ChatGPT 的建议卡 / DSH 的 conversation.hero.* slot：
            把 12 个场景做成可点入口，点一下在该场景的 profile 里开新会话。 */}
        {scenes.length > 0 && (
          <div
            className="pointer-events-auto mx-auto mt-7 grid w-full max-w-3xl grid-cols-2 gap-2 text-left sm:grid-cols-3 lg:grid-cols-4"
            data-slot="aui_intro_scenes"
          >
            {scenes.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => newSessionInProfile(p.name)}
                aria-label={t.profiles.switchToProfile(profileLabel(p))}
                className="group flex min-w-0 flex-col gap-0.5 rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
              >
                <span className="truncate text-[0.82rem] font-medium leading-tight text-foreground">
                  {profileLabel(p)}
                </span>
                <span className="truncate font-mono text-[0.64rem] leading-tight text-muted-foreground">
                  {p.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
