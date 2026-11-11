// Compile only the fixture key's CSS text-shadow; the native label remains live.
// SINGZ_MUTE=1 SINGZ_NO_SYNC=1 node_modules/.bin/electron --force-color-profile=srgb experiments/gpui-player/assets/build-key-shadow.cjs
const {app, BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const sha=data=>crypto.createHash('sha256').update(data).digest('hex')
if(app.commandLine.getSwitchValue('force-color-profile')!=='srgb')throw Error('Startup --force-color-profile=srgb is required')
app.commandLine.appendSwitch('force-device-scale-factor','2')
app.commandLine.appendSwitch('mute-audio')
app.setPath('userData',`/tmp/singz-key-shadow-${process.pid}`)
app.dock?.hide()
process.on('uncaughtException',e=>{console.error(e);app.exit(1)})
process.on('unhandledRejection',e=>{console.error(e);app.exit(1)})
app.whenReady().then(async()=>{
 const root=path.resolve(__dirname,'../../..')
 const font=fs.readFileSync(path.resolve(__dirname,'../../../../singz-ui/gpui/assets/fonts/Bricolage700.ttf'))
 const source=fs.readFileSync(path.join(root,'src/renderer/src/styles.css'),'utf8')
 const valueCss=source.match(/\.psi-value \{[^}]+\}/)[0]
 const keyCss=source.match(/\.psi-key \{[^}]+\}/)[0]
 const window=new BrowserWindow({show:false,focusable:false,width:128,height:80,useContentSize:true,transparent:true,backgroundColor:'#00000000',webPreferences:{backgroundThrottling:false}})
 await window.loadURL('data:text/html,'+encodeURIComponent(`<!doctype html><style>
 @font-face{font-family:SourceDisplay;src:url(data:font/ttf;base64,${font.toString('base64')})}
 html,body{margin:0;background:transparent;overflow:hidden}body{font-family:SourceDisplay;-webkit-font-smoothing:antialiased}
 ${valueCss}${keyCss}
 .psi-key{position:absolute;left:28px;top:28px;color:transparent;line-height:normal}
 .marker{display:inline-block;width:0;height:0;vertical-align:baseline}
 </style><span class="psi-value psi-key">G#m<span class="marker"></span></span>`))
 const metrics=await window.webContents.executeJavaScript(`(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=document.querySelector('.psi-key').getBoundingClientRect(),m=document.querySelector('.marker').getBoundingClientRect();return{left:r.x,top:r.y,width:r.width,height:r.height,baseline:m.y-r.y,dpr:devicePixelRatio}})()`)
 window.webContents.debugger.attach('1.3')
 await window.webContents.debugger.sendCommand('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}})
 const capture=await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false})
 if(window.isVisible()||window.isFocused())throw Error('Shadow export escaped hidden/unfocused policy')
 const png=Buffer.from(capture.data,'base64')
 fs.writeFileSync(path.join(__dirname,'review-key-shadow.png'),png)
 fs.writeFileSync(path.join(__dirname,'review-key-shadow.json'),JSON.stringify({kind:'transparentGlyphShadowOnly',text:'G#m',fontFile:'Bricolage700.ttf',fontSha256:sha(font),sourceCssSha256:sha(source),sourceCss:[valueCss,keyCss],fontSize:19,fontVariationSettings:"'wdth' 92",padding:28,canvasCssSize:[128,80],metrics,electron:process.versions.electron,chromium:process.versions.chrome,colorProfile:'sRGB process-startup flag',pngSha256:sha(png),note:'Transparent foreground; only CSS text-shadow pixels. Native text remains separate.'},null,2)+'\n')
 console.log(JSON.stringify({metrics,pngSha256:sha(png),hidden:true,focused:false}))
 window.destroy();app.quit()
}).catch(e=>{console.error(e);app.exit(1)})
