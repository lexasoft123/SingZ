export const QUICK_START_SEEN = 'singz.quick-start.v1'
export function quickStartTitle(locale: string): string {
  return locale === 'es-419' ? 'Inicio rápido' : locale === 'pt-BR' ? 'Início rápido' : locale === 'ru' ? 'Быстрый старт' : 'Quick start'
}
