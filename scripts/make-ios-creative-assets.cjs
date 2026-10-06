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
  'en-US': { header: 'Your music.<br>Your voice.', search: 'Karaoke with<br>your own songs', sub: 'Sing along. Make the band your backing track.', training: 'Build your voice with guided practice.' },
  ru: { header: 'Ваша музыка.<br>Ваш голос.', search: 'Караоке<br>с вашей музыкой', sub: 'Пойте под любимую музыку без ведущего вокала.', training: 'Развивайте голос с пошаговыми упражнениями.' },
  'zh-Hans': { header: '你的音乐。<br>你的声音。', search: '用自己的音乐<br>唱卡拉OK', sub: '跟着歌词唱，让乐队为你伴奏。', training: '通过循序渐进的练习提升歌唱能力。' }
}
const player = image('docs/ios-assets/raw/hero-lyrics.png')
const training = image('docs/ios-assets/05-practice.png')
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  try {
    for (const [locale, copy] of Object.entries(copies)) {
      for (const placement of ['header', 'search']) {
        const header = placement === 'header'
        const width = header ? 3840 : 1920, height = header ? 1646 : 1280
        const scale = width / 1280
        const html = `<!doctype html><html lang="${locale}"><meta charset="utf-8"><style>
@font-face{font-family:Brand;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(root,'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-ext-wght-normal.woff2')).toString('base64')})}
*{box-sizing:border-box}html,body{width:${width}px;height:${height}px;margin:0;background:#12100d;overflow:hidden}main{position:relative;width:1280px;height:${height/scale}px;transform:scale(${scale});transform-origin:top left;background:radial-gradient(ellipse at 74% 65%,#624019 0,transparent 52%),radial-gradient(ellipse at 5% 5%,#2a1c12 0,transparent 60%),#12100d;color:#f4efe6;font-family:Brand,-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden}.copy{position:absolute;left:80px;top:${header ? 58 : 114}px;width:${header ? 585 : 620}px}.brand{font-size:32px;font-weight:800;display:flex;align-items:center;gap:15px}.bars{display:flex;flex-direction:column;gap:4px;width:31px}.bars i{height:5px;border-radius:3px;background:#ff7068}.bars i:nth-child(2){width:24px;background:#ffd34b}.bars i:nth-child(3){width:28px;background:#687bff}.bars i:nth-child(4){width:18px;background:#2bc9a5}h1{font-size:${header ? 69 : 76}px;line-height:1.04;letter-spacing:-2.8px;margin:28px 0;color:#ffa028;font-weight:800}p{font-size:24px;line-height:1.4;color:#d5cab6;margin:22px 0;max-width:535px}.training-label{font-size:20px;color:#aa9d86}.phone{position:absolute;border:2px solid #534638;border-radius:30px;background:#18120c;box-shadow:0 25px 55px #0008;padding:5px;overflow:hidden}.phone img{display:block;width:100%;height:auto;border-radius:23px}.player{width:${header ? 210 : 310}px;right:${header ? 274 : 82}px;top:${header ? 39 : 80}px}.training{width:180px;right:74px;top:95px}.search .training{display:none}
</style><main class="${placement}"><div class="copy"><div class="brand"><span class="bars"><i></i><i></i><i></i><i></i></span>SingZ</div><h1>${header ? copy.header : copy.search}</h1><p>${copy.sub}</p><p class="training-label">${copy.training}</p></div><div class="phone training"><img src="${training}"></div><div class="phone player"><img src="${player}"></div></main></html>`
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
        await page.setContent(html)
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode())) })
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
