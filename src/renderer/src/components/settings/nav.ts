import type { MessageKey } from '../../i18n/messages'

export type SettingsPageId =
  | 'general'
  | 'appearance'
  | 'agent'
  | 'model'
  | 'performance'
  | 'memory'
  | 'generation'
  | 'runtime'
  | 'mcp'

export type SettingsNavGroup = {
  labelKey: MessageKey
  items: { id: SettingsPageId; labelKey: MessageKey }[]
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    labelKey: 'settings.nav.group.settings',
    items: [
      { id: 'general', labelKey: 'settings.nav.general' },
      { id: 'appearance', labelKey: 'settings.nav.appearance' },
      { id: 'agent', labelKey: 'settings.nav.agent' }
    ]
  },
  {
    labelKey: 'settings.nav.group.model',
    items: [
      { id: 'model', labelKey: 'settings.nav.model' },
      { id: 'performance', labelKey: 'settings.nav.performance' },
      { id: 'memory', labelKey: 'settings.nav.memory' },
      { id: 'generation', labelKey: 'settings.nav.generation' },
      { id: 'runtime', labelKey: 'settings.nav.runtime' }
    ]
  },
  {
    labelKey: 'settings.nav.group.integrations',
    items: [{ id: 'mcp', labelKey: 'settings.nav.mcp' }]
  }
]

export const PAGE_TITLE: Record<SettingsPageId, MessageKey> = {
  general: 'settings.nav.general',
  appearance: 'settings.nav.appearance',
  agent: 'settings.nav.agent',
  model: 'settings.nav.model',
  performance: 'settings.nav.performance',
  memory: 'settings.nav.memory',
  generation: 'settings.nav.generation',
  runtime: 'settings.nav.runtime',
  mcp: 'settings.nav.mcp'
}
