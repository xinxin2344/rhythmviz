package com.tang.rhythmviz;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 通知栏媒体控制器 JS 桥：
 *   start()                 首次播放时启动前台服务（并申请通知权限）
 *   update({title,artist,playing,position,duration,artB64})  曲目/状态同步
 *   stop()                  队列清空时撤销通知
 * 事件：addListener('action', ({action:'play|pause|next|prev'}))
 */
@CapacitorPlugin(name = "MediaNotif")
public class MediaNotifPlugin extends Plugin {

    private static final String TAG = "RV-MediaNotif";
    private static final int REQ_NOTIF = 7722;
    private static MediaNotifPlugin self;

    @Override
    public void load() {
        super.load();
        self = this;
        MusicService.sink = new MusicService.Sink() {
            @Override
            public void onAction(final String action) {
                final MediaNotifPlugin p = self;
                if (p == null) return;
                final JSObject o = new JSObject();
                o.put("action", action);
                p.notifyListeners("action", o);
            }
        };
    }

    @PluginMethod
    public void start(PluginCall call) {
        askNotificationPermission();
        MusicService.start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        MusicService.State s = new MusicService.State();
        s.title = call.getString("title", "律动 RhythmViz");
        s.artist = call.getString("artist", "");
        Boolean playing = call.getBoolean("playing", false);
        s.playing = Boolean.TRUE.equals(playing);
        try { s.posMs = call.getData().optLong("position", 0L); } catch (Throwable ignored) { }
        try { s.durMs = call.getData().optLong("duration", 0L); } catch (Throwable ignored) { }
        String b64 = call.getString("artB64", null);
        if (b64 != null && !b64.isEmpty()) {
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                s.art = decodeScaled(bytes, 512);
            } catch (Throwable t) {
                Log.w(TAG, "封面解码失败: " + t.getMessage());
            }
        }
        MusicService.push(s);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        MusicService.stopSvc(getContext());
        call.resolve();
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        try {
            boolean granted = ContextCompat.checkSelfPermission(getContext(),
                    Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
            if (granted) return;
            Activity a = getActivity();
            if (a != null && !a.isFinishing()) {
                ActivityCompat.requestPermissions(a,
                        new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIF);
            }
        } catch (Throwable t) {
            Log.w(TAG, "申请通知权限失败: " + t.getMessage());
        }
    }

    /** 解码并把封面压到 maxSide 以内，避免大图过 IPC 桥造成卡顿 */
    private static Bitmap decodeScaled(byte[] bytes, int maxSide) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        int sample = 1;
        int larger = Math.max(bounds.outWidth, bounds.outHeight);
        while (larger / sample > maxSide * 2) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
        if (bmp == null) return null;
        int side = Math.max(bmp.getWidth(), bmp.getHeight());
        if (side > maxSide) {
            float k = maxSide / (float) side;
            Bitmap scaled = Bitmap.createScaledBitmap(bmp,
                    Math.max(1, Math.round(bmp.getWidth() * k)),
                    Math.max(1, Math.round(bmp.getHeight() * k)), true);
            if (scaled != bmp) bmp.recycle();
            bmp = scaled;
        }
        return bmp;
    }
}
