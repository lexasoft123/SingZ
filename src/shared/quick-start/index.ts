/** Copy shared by the desktop and phone tours of the actual interface. */
export { QUICK_START_SEEN } from './meta'
export const guideSections = [
  'library',
  'split',
  'stems',
  'lyrics',
  'practice',
  'training',
  'sync',
  'settings'
] as const
export type GuideSection = (typeof guideSections)[number]

const en = {
  title: 'Quick start',
  welcome: 'Make room for your voice',
  start: 'Take a tour',
  later: 'Maybe later',
  skip: 'Skip tour',
  back: 'Back',
  next: 'Next',
  done: 'Got it',
  steps: {
    library: [
      'Add your own MP3',
      'Tap Add a song and choose your MP3 in Files. Confirm the title and add it with or without lyrics. Back in the library, tap Split on that song’s card. The first split may ask you to download the splitter model.'
    ],
    split: [
      'Split your MP3 into stems',
      'Tap Split on this song’s card and follow the download and confirmation prompts. Keep SingZ open while it processes the song; progress appears in the library. Splitting may take several minutes. When it finishes, open the song and mute Vocals to sing with the backing tracks.'
    ],
    stems: [
      'Make space for your voice',
      'Each stem has its own volume and mute controls. Lower or mute Vocals to sing with the backing tracks. Solo a stem to hear just that part.'
    ],
    lyrics: [
      'Follow the words',
      'Synced lyrics highlight as the song plays. Select a line to jump to it. On desktop, you can find, edit and align lyrics for your songs.'
    ],
    practice: [
      'Practise a small section',
      'Select a region to loop a tricky passage. Slow the song down while you learn it, or transpose it into a comfortable key.'
    ],
    training: [
      'Build your voice',
      'Open Vocal training for guided exercises. Choose a comfortable range and follow the pitch display. Microphone access is only needed when you practise with it.'
    ],
    sync: [
      'Keep your songs with you',
      'Save projects to your desktop library and connect Google Drive to sync them. On your phone, sign in to the same account and download a song to practise offline.'
    ],
    settings: [
      'Help is always here',
      'Settings contains your audio options. Replay Quick start whenever you need a refresher. Choose Got it to return to your own workspace.'
    ]
  }
} as const
const ru = {
  title: 'Быстрый старт',
  welcome: 'Освободите место для своего голоса',
  start: 'Познакомиться',
  later: 'Позже',
  skip: 'Пропустить',
  back: 'Назад',
  next: 'Далее',
  done: 'Понятно',
  steps: {
    library: [
      'Добавьте свою песню в MP3',
      'Нажмите «Добавить песню» и выберите MP3 в «Файлах». Проверьте название и добавьте песню с текстом или без него. В библиотеке нажмите «Разделить» на карточке этой песни. При первом запуске может потребоваться скачать модель разделения.'
    ],
    split: [
      'Разделите MP3 на дорожки',
      'Нажмите «Разделить» на карточке песни и следуйте подсказкам для загрузки модели и подтверждения. Оставьте SingZ открытым: ход обработки появится в библиотеке. Разделение может занять несколько минут. Затем откройте песню и выключите вокал, чтобы петь под аккомпанемент.'
    ],
    stems: [
      'Освободите место для голоса',
      'У каждой дорожки есть громкость и выключение звука. Приглушите или выключите вокал и пойте под аккомпанемент. Соло позволяет послушать отдельную партию.'
    ],
    lyrics: [
      'Следите за словами',
      'Слова подсвечиваются по ходу песни. Выберите строку, чтобы перейти к ней. На компьютере можно найти, отредактировать и синхронизировать текст.'
    ],
    practice: [
      'Разучите сложное место',
      'Выделите фрагмент для повтора. Замедлите песню, пока учитесь, или измените тональность, чтобы петь было удобно.'
    ],
    training: [
      'Развивайте голос',
      'Откройте тренировку голоса для упражнений. Выберите удобный диапазон и следите за высотой нот. Доступ к микрофону нужен только для занятий с ним.'
    ],
    sync: [
      'Берите песни с собой',
      'Сохраняйте проекты в библиотеку на компьютере и подключите Google Drive для синхронизации. На телефоне войдите в тот же аккаунт и скачайте песню для занятий без интернета.'
    ],
    settings: [
      'Помощь всегда рядом',
      'В настройках находятся параметры звука. Повторите «Быстрый старт», когда понадобится подсказка. Нажмите «Понятно», чтобы вернуться к работе.'
    ]
  }
} as const
export function quickStartCopy(locale: string, platform: 'desktop' | 'mobile' = 'desktop') {
  const copy = locale === 'ru' ? ru : en
  if (platform === 'mobile') return copy
  return {
    ...copy,
    steps: {
      ...copy.steps,
      split:
        locale === 'ru'
          ? [
              'Разделите MP3 на дорожки',
              'Откройте это меню и нажмите «Разделить» для подтверждения. SingZ разделит песню на вокал и инструментальные дорожки. Если модель ещё не установлена, появится предложение скачать её. Ход обработки виден внизу; разделение может занять несколько минут. После завершения сохраните проект в библиотеку.'
            ]
          : [
              'Split your MP3 into stems',
              'Open this menu and press Split to confirm. SingZ separates the song into vocals and instrument stems. If the splitter model is missing, you will be prompted to download it. Progress appears along the bottom; splitting may take several minutes. Save the finished project to your library.'
            ],
      library:
        locale === 'ru'
          ? [
              'Откройте свою песню в MP3',
              'Нажмите «Обзор файлов» и выберите MP3 или перетащите файл в окно. После открытия нажмите «Разделить» справа внизу и подтвердите разделение в меню. Повторите гид кнопкой «?», чтобы увидеть подсказку у этой кнопки.'
            ]
          : [
              'Open your own MP3',
              'Choose Browse files and select your MP3, or drop the file into the window. Once it opens, use Split at the bottom right and confirm Split in its menu. Replay the guide with ? to see the balloon beside that button.'
            ]
    }
  }
}
