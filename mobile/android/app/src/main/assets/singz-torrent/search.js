(()=>{
 if(!document.querySelector('#logged-in-username'))return JSON.stringify({ok:false,error:'Your RuTracker session has expired. Sign in again.'});
 const table=document.querySelector('#tor-tbl');
 if(!table&&!/не найден|нет подходящ/i.test(document.body.textContent))return JSON.stringify({ok:false,error:'RuTracker returned an unfamiliar search page. Try again later.'});
 const seen=new Set();const releases=[];
 for(const row of document.querySelectorAll('#tor-tbl tbody tr')){
  const title=row.querySelector('a.tLink'),download=row.querySelector('a.tr-dl');
  if(!title||!download)continue;
  const id=new URL(title.getAttribute('href'),location.href).searchParams.get('t');
  if(!/^[1-9][0-9]{0,11}$/.test(id||'')||seen.has(id))continue;
  const seed=row.querySelector('td.seedmed b')||row.querySelector('td:nth-child(7) b');
  const size=row.querySelector('td.tor-size');
  const seeders=Number((seed&&seed.textContent||'0').replace(/[^0-9]/g,''))||0;
  releases.push({id,title:title.textContent.trim(),size:Number(size&&size.getAttribute('data-ts_text'))||0,seeders});
  seen.add(id);
 }
 releases.sort((a,b)=>b.seeders-a.seeders);
 const offset=Number(new URL(location.href).searchParams.get('start'))||0;
 const hasMore=Array.from(document.querySelectorAll('a[href*="start="]')).some(a=>{
  try{const url=new URL(a.getAttribute('href'),location.href);return url.pathname.endsWith('/tracker.php')&&Number(url.searchParams.get('start'))>offset}catch{return false}
 });
 return JSON.stringify({ok:true,data:{releases,nextOffset:offset+50,hasMore}});
})()