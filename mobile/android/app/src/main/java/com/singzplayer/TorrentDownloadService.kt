package com.singzplayer
import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Keeps actual native transfers alive. It always enters foreground first,
 * including a start racing with Pause, to satisfy Android's service deadline. */
class TorrentDownloadService:Service(){
 private val worker=Executors.newSingleThreadScheduledExecutor()
 private val id=7304
 private val channel="singz-torrent-download"
 private fun notification(name:String,percent:Int,active:Boolean):Notification{
  val launch=packageManager.getLaunchIntentForPackage(packageName)
  val open=PendingIntent.getActivity(this,0,launch,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  val pause=PendingIntent.getService(this,1,Intent(this,TorrentDownloadService::class.java).setAction("pause"),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  val builder=if(Build.VERSION.SDK_INT>=26)Notification.Builder(this,channel)else Notification.Builder(this)
  return builder.setSmallIcon(android.R.drawable.stat_sys_download).setContentTitle("Downloading a song")
   .setContentText(name).setContentIntent(open).setOnlyAlertOnce(true).setOngoing(active)
   .setProgress(100,percent,percent==0).addAction(Notification.Action.Builder(null,"Pause",pause).build()).build()
 }
 override fun onCreate(){
  super.onCreate()
  if(Build.VERSION.SDK_INT>=26)(getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(NotificationChannel(channel,"Song downloads",NotificationManager.IMPORTANCE_LOW))
 }
 override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int{
  val initial=notification("Connecting to seeders",0,true)
  if(Build.VERSION.SDK_INT>=29)startForeground(id,initial,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)else startForeground(id,initial)
  if(intent?.action=="pause"){
   worker.execute{TorrentNative.call(TorrentNative.root(this),"pause","",-1,null);stopSelf()}
  }else if(!polling){
   polling=true
   worker.scheduleWithFixedDelay({
    try{
     val result=JSONObject(TorrentNative.call(TorrentNative.root(this),"status","",-1,null))
     val job=result.optJSONObject("data")
     val state=job?.optString("state")
     if(!result.optBoolean("ok")||job==null||state !in listOf("downloading","verifying")){
      stopSelf()
     }else{
      val size=job.optLong("size",1).coerceAtLeast(1)
      val percent=(job.optLong("done")*100/size).toInt().coerceIn(0,100)
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(id,notification(job.optString("name"),percent,true))
     }
    }catch(_:Throwable){stopSelf()}
   },0,1,TimeUnit.SECONDS)
  }
  return START_NOT_STICKY
 }
 private var polling=false
 override fun onBind(intent:Intent?):IBinder?=null
 override fun onDestroy(){
  worker.shutdownNow()
  if(Build.VERSION.SDK_INT>=24)stopForeground(STOP_FOREGROUND_REMOVE)else stopForeground(true)
  super.onDestroy()
 }
}
