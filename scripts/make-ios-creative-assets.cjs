#!/usr/bin/env node
// Real app captures, localized copy, and Apple's exact RGB creative sizes.
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright-core')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'docs/ios-assets/creative')
const image = file => `data:image/png;base64,${fs.readFileSync(path.join(root, file)).toString('base64')}`
const copies = {
  "en-US": {
    "header": "Your music.<br>Your voice.",
    "search": "Karaoke with<br>your own songs",
    "sub": "",
    "training": "Pitch, ear & vocal training"
  },
  "ru": {
    "header": "Ваша музыка.<br>Ваш голос.",
    "search": "Караоке<br>с вашей музыкой",
    "sub": "",
    "training": "Тренировка голоса и слуха"
  },
  "zh-Hans": {
    "header": "你的音乐。<br>你的声音。",
    "search": "用自己的音乐<br>唱卡拉OK",
    "sub": "",
    "training": "音准、听音与声乐训练"
  },
  "zh-Hant": {
    "header": "你的音樂。<br>你的聲音。",
    "search": "用自己的音樂<br>唱卡拉OK",
    "sub": "",
    "training": "音準、聽音與聲樂訓練"
  },
  "hi": {
    "header": "आपका संगीत।<br>आपकी आवाज़।",
    "search": "अपने गानों के साथ<br>कराओके गाएँ",
    "sub": "",
    "training": "सुर, आवाज़ और सुनने का अभ्यास"
  },
  "ja": {
    "header": "あなたの音楽。<br>あなたの歌声。",
    "search": "自分の曲で<br>カラオケ",
    "sub": "",
    "training": "音程・発声・耳のトレーニング"
  },
  "ko": {
    "header": "나의 음악.<br>나의 목소리.",
    "search": "내 노래로 즐기는<br>노래방",
    "sub": "",
    "training": "음정·청음·보컬 트레이닝"
  },
  "th": {
    "header": "เพลงของคุณ<br>เสียงของคุณ",
    "search": "ร้องคาราโอเกะ<br>กับเพลงของคุณ",
    "sub": "",
    "training": "ฝึกร้องเพลงและการฟัง"
  },
  "id": {
    "header": "Musikmu.<br>Suaramu.",
    "search": "Karaoke dengan<br>lagumu sendiri",
    "sub": "",
    "training": "Latihan nada & vokal"
  },
  "vi": {
    "header": "Nhạc của bạn.<br>Giọng hát của bạn.",
    "search": "Hát karaoke với<br>bài hát của bạn",
    "sub": "",
    "training": "Luyện cao độ, giọng hát & tai"
  },
  "ms": {
    "header": "Muzik anda.<br>Suara anda.",
    "search": "Karaoke dengan<br>lagu anda sendiri",
    "sub": "",
    "training": "Latihan vokal & pendengaran"
  },
  "tr": {
    "header": "Senin müziğin.<br>Senin sesin.",
    "search": "Kendi şarkılarınla<br>karaoke",
    "sub": "",
    "training": "Kulak ve ses eğitimi"
  },
  "es-MX": {
    "header": "Tu música.<br>Tu voz.",
    "search": "Karaoke con<br>tus canciones",
    "sub": "",
    "training": "Entrena tu voz y tu oído"
  },
  "pt-BR": {
    "header": "Sua música.<br>Sua voz.",
    "search": "Karaokê com<br>suas músicas",
    "sub": "",
    "training": "Treine sua voz e seu ouvido"
  }
}


;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ channel: 'chromium', headless: true })
  try {
    for (const [locale, copy] of Object.entries(copies)) {
      const player=image(`docs/ios-assets/localized/iphone/${locale}/01-player.png`)
      const training=image(`docs/ios-assets/localized/iphone/${locale}/03-training.png`)
      for (const placement of ['header', 'search']) {
        const header = placement === 'header'
        const width = header ? 3840 : 1920, height = header ? 1646 : 1280
        const scale = width / 1280
        const html = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><style>
@font-face{font-family:Brand;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(root,'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-ext-wght-normal.woff2')).toString('base64')})}
*{box-sizing:border-box}html,body{width:${width}px;height:${height}px;margin:0;background:#12100d;overflow:hidden}main{position:relative;width:1280px;height:${height/scale}px;transform:scale(${scale});transform-origin:top left;background:radial-gradient(ellipse at 74% 65%,#624019 0,transparent 52%),radial-gradient(ellipse at 5% 5%,#2a1c12 0,transparent 60%),#12100d;color:#f4efe6;font-family:Brand,-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden}.copy{position:absolute;left:${header ? 225 : 80}px;top:${header ? 112 : 114}px;width:${header ? 490 : 620}px}.brand{font-size:${header ? 26 : 32}px;font-weight:800;display:flex;align-items:center;gap:15px}.bars{display:flex;flex-direction:column;gap:4px;width:31px}.bars i{height:5px;border-radius:3px;background:#ff7068}.bars i:nth-child(2){width:24px;background:#ffd34b}.bars i:nth-child(3){width:28px;background:#687bff}.bars i:nth-child(4){width:18px;background:#2bc9a5}h1{font-size:${header ? 50 : 66}px;line-height:1.04;letter-spacing:-2.8px;margin:${header ? 20 : 28}px 0;color:#ffa028;font-weight:800}p{font-size:${header ? 21 : 24}px;line-height:1.4;color:#d5cab6;margin:22px 0;max-width:535px}.training-label{font-size:${header ? 19 : 20}px;color:#aa9d86}.phone{position:absolute;border:2px solid #534638;border-radius:30px;background:#18120c;box-shadow:0 25px 55px #0008;padding:5px;overflow:hidden}.phone img{display:block;width:100%;height:auto;border-radius:23px}.player{width:${header ? 150 : 310}px;right:${header ? 330 : 82}px;top:${header ? 110 : 80}px}.training{width:130px;right:220px;top:142px}.search .training{display:none}
/* Larger upper-screen crops keep lyrics and target notes readable in headers. */
.header .phone{width:230px;height:340px;border-radius:24px 24px 0 0;padding:6px;border-bottom:0;box-shadow:none;mask-image:linear-gradient(to bottom,#000 0%,#000 72%,transparent 100%);-webkit-mask-image:linear-gradient(to bottom,#000 0%,#000 72%,transparent 100%)}
.header .phone img{border-radius:16px 16px 0 0}
.header .player{right:390px;top:110px}
.header .training{right:190px;top:128px;z-index:2}
.header .copy{width:430px}
</style><main class="${placement}"><div class="copy"><div class="brand"><span class="bars"><i></i><i></i><i></i><i></i></span>SingZ</div><h1>${header ? copy.header : copy.search}</h1>${header ? '' : `<p>${copy.sub}</p>`}<p class="training-label">${copy.training}</p></div><div class="phone training"><img src="${training}"></div><div class="phone player"><img src="${player}"></div></main></html>`
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
        await page.setContent(html)
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())) })
        // Conservative crop checks inferred from the device previews. These are
        // local QA images, not replacements for App Store Connect's Preview tool.
        if (header) {
          await page.screenshot({ path: `/private/tmp/singz-header-${locale}-portrait-crop.png`, clip: { x: 180 * scale, y: 0, width: 920 * scale, height } })
          await page.screenshot({ path: `/private/tmp/singz-header-${locale}-landscape-crop.png`, clip: { x: 0, y: 80 * scale, width, height: 390 * scale } })
        }
        const file = path.join(out, `${placement}-${locale}.png`)
        await page.screenshot({ path: file })
        execFileSync('ffmpeg', ['-y','-loglevel','error','-i',file,'-pix_fmt','rgb24',`${file}.rgb.png`])
        fs.renameSync(`${file}.rgb.png`,file)
        execFileSync('ffmpeg',['-y','-loglevel','error','-i',file,'-vf','scale=800:-1:flags=lanczos','-pix_fmt','rgb24',path.join(out,`${placement}-${locale}-preview.png`)])
        console.log(`${placement} ${locale}: ${width}×${height} RGB`)
        await page.close()
      }
    }
  } finally { await browser.close() }
})().catch(error => { console.error(error.message); process.exitCode=1 })
