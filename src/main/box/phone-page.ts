import { SONG_VOLUME_MAX_DB } from '../../shared/song-volume'

export function phoneControllerPage(clientNonce: string): string {
  const masterMaximum = 10 ** (SONG_VOLUME_MAX_DB / 20)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SingZ Box remote</title>
<style>
:root{color-scheme:dark;background:#12100d;color:#f4efe6;font:16px/1.45 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;padding:16px;max-width:760px;margin:auto}h1{font-size:1.45rem}h2{font-size:1.2rem}button,input{font:inherit}button{border:1px solid #504638;border-radius:10px;background:#252019;color:#f4efe6;padding:12px 16px;min-height:46px;cursor:pointer}button:hover,button:focus-visible{border-color:#ffa028;outline:2px solid #ffa028;outline-offset:2px}button:disabled{opacity:.45;cursor:wait}nav{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:16px 0}nav button{padding:10px 4px}nav button.active{background:#ffa028;color:#12100d}.row{display:flex;align-items:center;gap:10px;border-bottom:1px solid #3a332b;padding:13px 0}.row>div{flex:1;min-width:0}.title,.artist{overflow-wrap:anywhere}.artist,.muted{color:#bcb2a4;font-size:.9rem}.actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.actions button{padding:8px 10px;min-height:40px}#error{min-height:2.8em;color:#ffb3a7;background:#321e19;border-radius:8px;padding:10px;margin:10px 0}label{display:block;margin:10px 0}input[type=text]{width:100%;padding:12px;border-radius:8px;border:1px solid #655646;background:#1b1814;color:#f4efe6}input[type=range]{width:100%;accent-color:#ffa028}.mix-row{display:grid;grid-template-columns:minmax(80px,1fr) 2fr auto auto;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid #3a332b}.hidden{display:none!important}@media(max-width:520px){body{padding:10px}.row{align-items:flex-start;flex-direction:column}.actions{justify-content:flex-start}.mix-row{grid-template-columns:1fr 1fr}.mix-row input{grid-column:1/-1}nav{font-size:.86rem}}
</style>
</head>
<body>
<h1>SingZ Box remote</h1>
<div id="error" role="status" aria-live="polite"></div>
<section id="pairing">
<h2>Pair with the TV</h2>
<form id="pair-form">
<label>Invitation code<input id="invitation" type="text" required maxlength="16" autocomplete="off"></label>
<label>Your name<input id="name" type="text" required maxlength="80" autocomplete="name"></label>
<button type="submit">Request TV approval</button>
</form>
</section>
<div id="controller" class="hidden">
<nav aria-label="Remote sections">
<button data-view="songs" class="active">Songs</button><button data-view="playing">Playing</button><button data-view="queue">Queue</button><button data-view="mix">Mix</button>
</nav>
<main id="content"></main>
</div>
<script nonce=${JSON.stringify(clientNonce)}>
'use strict'
const clientNonce=${JSON.stringify(clientNonce)}
const masterMaximum=${JSON.stringify(masterMaximum)}
let sessionToken=null
let snapshot=null
let currentView='songs'
let busy=false
let stateUnavailable=false
let pollSecret=null
let requestId=null
let pairExpiresAt=0
let pairGeneration=0
let pairTimer=null
const errorBox=document.getElementById('error')
const pairing=document.getElementById('pairing')
const controller=document.getElementById('controller')
const content=document.getElementById('content')
const invitationInput=document.getElementById('invitation')
invitationInput.value=location.hash.slice(1)
history.replaceState(null,'',location.pathname)
function showError(message){errorBox.textContent=message||''}
function resetPairing(message){
  sessionToken=null
  snapshot=null
  stateUnavailable=false
  requestId=null
  pollSecret=null
  pairGeneration++
  clearTimeout(pairTimer)
  pairing.classList.remove('hidden')
  controller.classList.add('hidden')
  showError(message)
}
async function request(path,options={}){
  const token=sessionToken
  const generation=pairGeneration
  const headers={...(options.headers||{})}
  if(options.body){
    headers['Content-Type']='application/json'
    headers['X-SingZ-CSRF']=clientNonce
  }
  if(token)headers.Authorization='Bearer '+token
  const response=await fetch(path,{...options,headers,signal:AbortSignal.timeout(15000)})
  const value=await response.json().catch(()=>({ok:false,error:'The TV returned an invalid response.'}))
  if(response.status===401&&token&&token===sessionToken&&generation===pairGeneration){
    resetPairing('Phone authorization expired or was revoked. Pair again.')
  }
  if(!response.ok){const failure=new Error(value.error||'The TV request failed.');failure.status=response.status;throw failure}
  return value
}
function schedulePairStatus(generation,delay){
  if(generation!==pairGeneration||!requestId||!pollSecret||sessionToken)return
  if(Date.now()>=pairExpiresAt){showError('The pairing request expired. Request TV approval again.');return}
  pairTimer=setTimeout(()=>pairStatus(generation),delay)
}
async function pairStatus(generation){
  if(generation!==pairGeneration||!requestId||!pollSecret||sessionToken)return
  try{
    const result=await request('/api/pair-status',{method:'POST',body:JSON.stringify({requestId,pollSecret})})
    if(generation!==pairGeneration)return
    if(result.status==='pending'){pairExpiresAt=result.expiresAt;schedulePairStatus(generation,900);return}
    if(result.status!=='approved'){requestId=null;pollSecret=null;showError(result.error||'The TV denied this phone.');return}
    sessionToken=result.sessionToken
    requestId=null
    pollSecret=null
    clearTimeout(pairTimer)
    pairing.classList.add('hidden')
    controller.classList.remove('hidden')
    showError('')
    await loadState()
  }catch(error){
    if(error.status===401||error.status===403||error.status===404){requestId=null;pollSecret=null;showError(error.message);return}
    showError(error.message)
    schedulePairStatus(generation,1800)
  }
}
document.getElementById('pair-form').addEventListener('submit',async event=>{
  event.preventDefault()
  const generation=++pairGeneration
  clearTimeout(pairTimer)
  showError('')
  try{
    const result=await request('/api/pair',{method:'POST',body:JSON.stringify({invitation:invitationInput.value,name:document.getElementById('name').value})})
    if(generation!==pairGeneration)return
    requestId=result.requestId
    pollSecret=result.pollSecret
    pairExpiresAt=result.expiresAt
    showError('Waiting for approval on the TV.')
    await pairStatus(generation)
  }catch(error){showError(error.message)}
})
document.querySelectorAll('nav button').forEach(button=>button.addEventListener('click',()=>{
  currentView=button.dataset.view
  render()
}))
let stateRequest=null
let stateRequestKey=''
async function loadState(){
  const token=sessionToken
  const generation=pairGeneration
  if(!token)return
  const key=generation+':'+token
  if(stateRequest&&stateRequestKey===key)return stateRequest
  const pending=(async()=>{
    try{
      const result=await request('/api/state')
      if(token!==sessionToken||generation!==pairGeneration)return
      snapshot=result.snapshot
      if(stateUnavailable){stateUnavailable=false;if(!busy)showError('')}
      render()
    }catch(error){
      if(token===sessionToken&&generation===pairGeneration){
        snapshot=null
        stateUnavailable=true
        render()
        showError('Could not reach the TV. Retrying.')
      }
    }
  })()
  stateRequest=pending
  stateRequestKey=key
  try{await pending}finally{if(stateRequest===pending){stateRequest=null;stateRequestKey=''}}
}
function element(tag,text,className){const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node}
function action(label,command){
  const button=element('button',label)
  button.disabled=busy
  button.addEventListener('click',()=>runCommand(command))
  return button
}
async function runCommand(command){
  if(busy)return
  const token=sessionToken
  const generation=pairGeneration
  busy=true
  showError('Waiting for the TV to confirm.')
  render()
  try{
    const result=await request('/api/command',{method:'POST',body:JSON.stringify(command)})
    if(token!==sessionToken||generation!==pairGeneration)return
    if(!result.ok)showError(result.error||'The TV rejected that command.')
    else showError('')
    await loadState()
  }catch(error){
    if(token===sessionToken&&generation===pairGeneration)showError('The TV command failed; check the TV and retry.')
  }finally{busy=false;if(generation===pairGeneration)render()}
}
function row(title,subtitle,actions=[]){
  const line=element('div','','row')
  const labels=element('div')
  labels.append(element('div',title,'title'),element('div',subtitle,'artist'))
  const buttons=element('div','','actions')
  actions.forEach(button=>buttons.append(button))
  line.append(labels,buttons)
  return line
}
function renderSongs(){
  content.replaceChildren(element('h2','Songs'))
  if(!snapshot||!snapshot.songs.length){content.append(element('p','No songs are available.','muted'));return}
  snapshot.songs.forEach(song=>content.append(row(song.title,song.artist+(song.ready?'':' · Not ready'),[
    action('Show on TV',{type:'select',projectId:song.id}),
    action('Add to queue',{type:'queue-add',projectId:song.id})
  ])))
}
function renderPlaying(){
  content.replaceChildren(element('h2','Playing'))
  if(!snapshot||!snapshot.activeProjectId){content.append(element('p','No song is selected on the TV.','muted'));return}
  const song=snapshot.songs.find(item=>item.id===snapshot.activeProjectId)
  content.append(element('h3',song?song.title:'Current song'))
  content.append(element('p',snapshot.transport.playing?'Playing on TV':'Paused on TV','muted'))
  content.append(element('p',Math.round(snapshot.transport.position)+' / '+Math.round(snapshot.transport.duration)+' seconds'))
  content.append(action(snapshot.transport.playing?'Pause':'Play/Pause',{type:'play-pause'}))
}
function renderQueue(){
  content.replaceChildren(element('h2','Queue'))
  if(!snapshot||!snapshot.queue.length){content.append(element('p','The queue is empty.','muted'));return}
  snapshot.queue.forEach((entry,index)=>{
    const up=action('Up',{type:'queue-move',entryId:entry.entryId,delta:-1})
    const down=action('Down',{type:'queue-move',entryId:entry.entryId,delta:1})
    up.disabled=busy||index===0
    down.disabled=busy||index===snapshot.queue.length-1
    content.append(row(entry.title,entry.artist,[up,down,action('Remove',{type:'queue-remove',entryId:entry.entryId})]))
  })
}
function volumeControl(label,value,maximum,target){
  const wrapper=element('div','','mix-row')
  wrapper.append(element('div',label))
  const input=document.createElement('input')
  input.type='range'
  input.min='0'
  input.max=String(maximum)
  input.step='0.01'
  input.value=String(value)
  input.disabled=busy
  input.setAttribute('aria-label',label+' volume')
  input.addEventListener('change',()=>runCommand({type:'volume',target,value:Number(input.value)}))
  wrapper.append(input)
  return wrapper
}
function renderMix(){
  content.replaceChildren(element('h2','Mix'))
  if(!snapshot){content.append(element('p','No TV state is available.','muted'));return}
  content.append(volumeControl('Master',snapshot.transport.masterVolume,masterMaximum,'master'))
  snapshot.stems.forEach(stem=>{
    const control=volumeControl(stem.label,stem.volume,1,stem.id)
    control.append(action(stem.muted?'Unmute':'Mute',{type:'mute',target:stem.id,value:!stem.muted}))
    control.append(action(stem.solo?'Unsolo':'Solo',{type:'solo',target:stem.id,value:!stem.solo}))
    content.append(control)
  })
}
function render(){
  document.querySelectorAll('nav button').forEach(button=>button.classList.toggle('active',button.dataset.view===currentView))
  if(!snapshot){content.replaceChildren(element('h2','TV state unavailable'),element('p','Waiting for a current connection to the TV.','muted'));return}
  if(currentView==='songs')renderSongs()
  else if(currentView==='playing')renderPlaying()
  else if(currentView==='queue')renderQueue()
  else renderMix()
}
render()
setInterval(()=>{if(sessionToken&&!busy)loadState()},2000)
</script>
</body>
</html>`
}
