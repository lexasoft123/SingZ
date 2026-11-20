
 const response=await fetch('/forum/dl.php?t='+topic,{credentials:'same-origin'});
 if(!response.ok)throw new Error('RuTracker did not return the torrent file. Sign in again or try later.');
 if(new URL(response.url).origin!=='https://rutracker.org')throw new Error('RuTracker redirected to another site.');
 if(!response.body)throw new Error('RuTracker returned an empty torrent file.');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;
  if(size>16777216)throw new Error('RuTracker returned an unexpectedly large torrent file.');
  chunks.push(next.value);
 }}finally{reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 if(bytes[0]!==100)throw new Error('Your RuTracker session may have expired. Sign in again.');
 let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));
 return btoa(binary);
