package com.singzplayer

import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.*
import android.widget.Button
import android.widget.LinearLayout
import android.view.ViewGroup
import com.facebook.react.bridge.*
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.util.concurrent.Executors

internal object TorrentNative {
 init { System.loadLibrary("singztorrent") }
 @JvmStatic external fun call(root:String,op:String,release:String,index:Int,metadata:ByteArray?):String
 @JvmStatic external fun shutdown(root:String)
 fun root(context:Context)=File(context.filesDir,"torrent-downloads").absolutePath
}
class TorrentModule(private val ctx:ReactApplicationContext):ReactContextBaseJavaModule(ctx){
 override fun getName()="SingzTorrent"
 private val main=Handler(Looper.getMainLooper())
 private val worker=Executors.newCachedThreadPool()
 private var web:WebView?=null
 private var dialog:Dialog?=null
 private var pending:((Any?,String?)->Unit)?=null
 private var auth:((Boolean)->Unit)?=null
 private var script=""
 private var generation=0
 private var asyncTicket:Int?=null
 private var closed=false
 private fun failure(text:String)=JSONObject().put("ok",false).put("error",text).toString()
 private fun connected(value:Boolean)=JSONObject().put("ok",true).put("data",JSONObject().put("connected",value)).toString()
 private fun trusted(url:String):Boolean=try{val u=android.net.Uri.parse(url);u.scheme=="https"&&u.host=="rutracker.org"&&(u.port==-1||u.port==443)}catch(_:Exception){false}
 private fun asset(name:String)=ctx.assets.open("singz-torrent/$name.js").bufferedReader().use{it.readText()}
 private fun finish(value:Any?,error:String?=null){
  val callback=pending;pending=null;asyncTicket=null;++generation;callback?.invoke(value,error)
 }
 private fun browser():WebView {
  web?.let{return it}
  val view=WebView(ctx.currentActivity?:ctx)
  view.settings.javaScriptEnabled=true;view.settings.domStorageEnabled=true
  view.settings.allowFileAccess=false;view.settings.allowContentAccess=false
  view.settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
  CookieManager.getInstance().setAcceptCookie(true)
  CookieManager.getInstance().setAcceptThirdPartyCookies(view,false)
  view.setDownloadListener{_,_,_,_,_->} // No default Downloads-folder path.
  view.addJavascriptInterface(object{
   @JavascriptInterface fun result(ticket:Int,value:String){
    main.post{
     if(ticket!=asyncTicket)return@post
     try{
      val decoded=JSONTokener(value).nextValue()
      if(decoded is JSONObject&&decoded.has("error"))finish(null,decoded.optString("error"))else finish(decoded)
     }catch(_:Exception){finish(null,"Invalid RuTracker response")}
    }
   }
  },"SingzTorrentResult")
  view.webChromeClient=object:WebChromeClient(){
   override fun onPermissionRequest(request:PermissionRequest){request.deny()}
   override fun onGeolocationPermissionsShowPrompt(origin:String,callback:GeolocationPermissions.Callback){callback.invoke(origin,false,false)}
  }
  view.webViewClient=object:WebViewClient(){
   override fun shouldOverrideUrlLoading(v:WebView,request:WebResourceRequest):Boolean=request.isForMainFrame&&!trusted(request.url.toString())
   override fun onPageFinished(v:WebView,url:String){
    if(!trusted(url)){finish(null,"RuTracker redirected to another site");return}
    if(auth!=null){
     v.evaluateJavascript(asset("account")){value->if(value=="true")completeAuth(true)}
    }else if(pending!=null&&asyncTicket==null){
     v.evaluateJavascript(script){value->
      try{finish(JSONTokener(value).nextValue())}catch(_:Exception){finish(null,"Could not read the RuTracker page")}
     }
    }
   }
   override fun onReceivedError(v:WebView,request:WebResourceRequest,error:WebResourceError){
    if(request.isForMainFrame){if(auth!=null)completeAuth(false)else finish(null,"Could not load RuTracker. Check your connection and try again.")}
   }
  }
  web=view;return view
 }
 private fun page(url:String,expression:String,done:(Any?,String?)->Unit){
  if(pending!=null||auth!=null){done(null,"Another RuTracker request is in progress");return}
  if(!trusted(url)){done(null,"Invalid RuTracker URL");return}
  pending=done;script=expression;val ticket=++generation
  browser().loadUrl(url)
  main.postDelayed({if(ticket==generation&&pending!=null){web?.stopLoading();finish(null,"Could not reach RuTracker. Check your connection and try again.")}},40000)
 }
 private fun completeAuth(value:Boolean){
  val callback=auth;auth=null
  CookieManager.getInstance().flush()
  (web?.parent as? ViewGroup)?.removeView(web)
  dialog?.dismiss();dialog=null;callback?.invoke(value)
 }
 private fun connect(done:(Boolean)->Unit){
  val activity=ctx.currentActivity
  if(activity==null||pending!=null||auth!=null){done(false);return}
  val view=browser();(view.parent as? ViewGroup)?.removeView(view)
  val layout=LinearLayout(activity);layout.orientation=LinearLayout.VERTICAL
  val close=Button(activity);close.text="Cancel"
  close.setOnClickListener{completeAuth(false)}
  layout.addView(close);layout.addView(view,LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1f))
  val window=Dialog(activity,android.R.style.Theme_Material_Light_NoActionBar)
  window.setContentView(layout);window.setOnCancelListener{completeAuth(false)}
  auth=done;dialog=window;window.show()
  window.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.MATCH_PARENT)
  view.loadUrl("https://rutracker.org/forum/login.php")
 }
 private fun metadata(topic:String,done:(ByteArray?,String?)->Unit){
  page("https://rutracker.org/forum/index.php",asset("account")){value,error->
   if(error!=null||value!=true){done(null,error?:"Your RuTracker session has expired. Sign in again.");return@page}
   pending={result,problem->
    if(problem!=null||result !is String){done(null,problem?:"Invalid torrent metadata")}
    else try{val bytes=Base64.decode(result,Base64.DEFAULT);if(bytes.size>16777216)done(null,"Torrent metadata is too large")else done(bytes,null)}catch(_:Exception){done(null,"Invalid torrent metadata")}
   }
   val ticket=++generation;asyncTicket=ticket
   val js="(async()=>{try{const topic="+JSONObject.quote(topic)+";const value=await(async()=>{"+asset("metadata")+"})();SingzTorrentResult.result("+ticket+",JSON.stringify(value));}catch(e){SingzTorrentResult.result("+ticket+",JSON.stringify({error:String(e.message||e)}));}})()"
   browser().evaluateJavascript(js,null)
   main.postDelayed({if(asyncTicket==ticket)finish(null,"RuTracker did not finish sending the torrent file. Try again.")},40000)
  }
 }
 // Stage into the picker's existing imports area before retiring the durable
 // torrent job. Cancelling Add song then uses the same cleanup as a local pick.
 private fun consume():String {
  val root=TorrentNative.root(ctx)
  val status=JSONObject(TorrentNative.call(root,"status","",-1,null))
  val job=status.optJSONObject("data")
  if(!status.optBoolean("ok")||job?.optString("state")!="complete") return failure("The song has not finished downloading")
  val source=File(job.getString("path"))
  val dir=File(ctx.filesDir,"singz-projects/imports/"+java.util.UUID.randomUUID())
  try {
   check(dir.mkdirs())
   val destination=File(dir,source.name)
   source.inputStream().use { input -> java.io.FileOutputStream(destination).use { output -> input.copyTo(output);output.fd.sync() } }
   check(destination.length()==job.getLong("size"))
   val result=JSONObject(TorrentNative.call(root,"consume","",-1,null))
   if(!result.optBoolean("ok")){dir.deleteRecursively();return result.toString()}
   result.getJSONObject("data").put("path",destination.absolutePath)
   source.delete();source.parentFile?.delete()
   return result.toString()
  }catch(_:Exception){dir.deleteRecursively();return failure("Could not prepare the downloaded song. Check free storage and try again.")}
 }
 @ReactMethod fun request(input:String,promise:Promise){
  if(input.length>8192){promise.resolve(failure("Torrent request is too large"));return}
  val request=try{JSONObject(input)}catch(_:Exception){promise.resolve(failure("Invalid torrent request"));return}
  val op=request.optString("op")
  if(op in listOf("status","start","pause","resume","cancel","consume","capabilities")){
   worker.execute{
    try{
     val result=if(op=="consume") consume() else TorrentNative.call(TorrentNative.root(ctx),op,request.optString("release"),request.optInt("index",-1),null)
     val data=JSONObject(result)
     if(op in listOf("start","resume")&&data.optBoolean("ok")&&data.optJSONObject("data")?.optString("state")=="downloading"){
      main.post{
       try{val intent=Intent(ctx,TorrentDownloadService::class.java);if(Build.VERSION.SDK_INT>=26)ctx.startForegroundService(intent)else ctx.startService(intent)}
       catch(_:Exception){worker.execute{TorrentNative.call(TorrentNative.root(ctx),"pause","",-1,null)}}
      }
     }
     promise.resolve(result)
    }catch(_:Throwable){promise.resolve(failure("The C++ torrent engine could not load. Rebuild and install the native app."))}
   };return
  }
  main.post{
   if(closed){promise.resolve(failure("Torrent screen is closed"));return@post}
   try{
    when(op){
     "connect"->connect{promise.resolve(connected(it))}
     "account"->promise.resolve(connected((CookieManager.getInstance().getCookie("https://rutracker.org/forum/")?:"").split(';').any{it.trim().startsWith("bb_data=")&&it.trim().length>8}))
     "logout"->{
      // WebView's CookieManager has no per-host removal API. Expire only
      // this host's cookies, preserving all other app WebView sessions.
      val manager=CookieManager.getInstance()
      val names=(manager.getCookie("https://rutracker.org/forum/")?:"").split(';').map{it.trim().substringBefore('=')}.filter{it.isNotBlank()}
      if(names.isEmpty())promise.resolve(connected(false))
      else {
       val remaining=java.util.concurrent.atomic.AtomicInteger(names.size*6)
       val completed=ValueCallback<Boolean>{if(remaining.decrementAndGet()==0){manager.flush();promise.resolve(connected(false))}}
       for(name in names)for(path in listOf("/","/forum","/forum/")){
        manager.setCookie("https://rutracker.org","$name=; Max-Age=0; Path=$path; Secure",completed)
        manager.setCookie("https://rutracker.org","$name=; Max-Age=0; Path=$path; Domain=.rutracker.org; Secure",completed)
       }
      }
     }
     "search"->{
      val url=request.optString("url")
      if(!trusted(url)||android.net.Uri.parse(url).path!="/forum/tracker.php")promise.resolve(failure("Invalid RuTracker search"))
      else page(url,asset("search")){value,error->promise.resolve(if(error!=null)failure(error)else value as? String?:failure("Invalid search result"))}
     }
     "files"->{
      val topic=request.optString("release")
      if(!Regex("^[1-9][0-9]{0,11}$").matches(topic))promise.resolve(failure("Invalid RuTracker release"))
      else metadata(topic){bytes,error->
       if(error!=null||bytes==null)promise.resolve(failure(error?:"Invalid torrent metadata"))
       else worker.execute{try{promise.resolve(TorrentNative.call(TorrentNative.root(ctx),"inspect",topic,-1,bytes))}catch(_:Throwable){promise.resolve(failure("The C++ torrent engine could not load"))}}
      }
     }
     else->promise.resolve(failure("Unknown torrent command"))
    }
   }catch(_:Exception){promise.resolve(failure("RuTracker operation failed. Try again."))}
  }
 }
 override fun invalidate(){
  closed=true
  main.post{completeAuth(false);finish(null,"Torrent browser closed");web?.destroy();web=null}
  // The foreground download service owns active jobs beyond JS reloads.
  worker.shutdown()
  super.invalidate()
 }
}
