package com.tang.rhythmviz;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.app.ServiceCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;

/**
 * 通知栏 / 锁屏媒体控制器。
 * 播放本身在 WebView（HTMLAudio），本服务只承载 MediaSession 与 MediaStyle 通知：
 * JS 上报曲目/状态，按钮与线控事件经 MediaNotifPlugin 回流给 JS 引擎。
 */
public class MusicService extends Service {

    private static final String TAG = "RV-MediaNotif";
    private static final String CH_ID = "rv_media";
    private static final int NOTIF_ID = 7721;

    static final String ACT_PLAY = "com.tang.rhythmviz.ACT_PLAY";
    static final String ACT_PAUSE = "com.tang.rhythmviz.ACT_PAUSE";
    static final String ACT_NEXT = "com.tang.rhythmviz.ACT_NEXT";
    static final String ACT_PREV = "com.tang.rhythmviz.ACT_PREV";
    static final String ACT_STOP = "com.tang.rhythmviz.ACT_STOP";

    interface Sink { void onAction(String action); }
    static volatile Sink sink;
    static volatile MusicService inst;

    static final class State {
        String title = "律动 RhythmViz";
        String artist = "";
        boolean playing = false;
        long posMs = 0L;
        long durMs = 0L;
        Bitmap art = null;
    }

    private static final State pending = new State();

    static void start(Context ctx) {
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, MusicService.class));
        } catch (Throwable t) {
            Log.e(TAG, "启动前台服务失败", t);
        }
    }

    static synchronized void push(State s) {
        pending.title = s.title;
        pending.artist = s.artist;
        pending.playing = s.playing;
        pending.posMs = s.posMs;
        pending.durMs = s.durMs;
        if (s.art != null) pending.art = s.art;
        MusicService m = inst;
        if (m != null) m.handler.post(m::apply);
    }

    static void stopSvc(Context ctx) {
        try { ctx.stopService(new Intent(ctx, MusicService.class)); } catch (Throwable ignored) { }
    }

    private Handler handler;
    private MediaSessionCompat session;
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String a = intent != null ? intent.getAction() : null;
            if (a == null) return;
            switch (a) {
                case AudioManager.ACTION_AUDIO_BECOMING_NOISY:
                case ACT_PAUSE:
                    sendAction("pause");
                    break;
                case ACT_PLAY:
                    sendAction("play");
                    break;
                case ACT_NEXT:
                    sendAction("next");
                    break;
                case ACT_PREV:
                    sendAction("prev");
                    break;
                case ACT_STOP:
                    sendAction("pause");
                    stopSelf();
                    break;
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        handler = new Handler(Looper.getMainLooper());
        createChannel();

        session = new MediaSessionCompat(this, "RhythmViz");
        session.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { sendAction("play"); }
            @Override public void onPause() { sendAction("pause"); }
            @Override public void onSkipToNext() { sendAction("next"); }
            @Override public void onSkipToPrevious() { sendAction("prev"); }
            @Override public void onStop() { sendAction("pause"); stopSelf(); }
        }, handler);
        session.setActive(true);

        IntentFilter f = new IntentFilter();
        f.addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        f.addAction(ACT_PLAY);
        f.addAction(ACT_PAUSE);
        f.addAction(ACT_NEXT);
        f.addAction(ACT_PREV);
        f.addAction(ACT_STOP);
        ContextCompat.registerReceiver(this, receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        Log.i(TAG, "onCreate：渠道/MediaSession/接收器就绪");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        MediaButtonReceiver.handleIntent(session, intent);
        if (intent != null && ACT_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification n = build(pending);
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            Log.i(TAG, "startForeground(mediaPlayback) OK");
        } catch (Throwable t) {
            Log.e(TAG, "startForeground 失败", t);
        }
        handler.post(this::apply);
        return START_NOT_STICKY;
    }

    private void apply() {
        if (session == null) return;
        State s = pending;

        MediaMetadataCompat.Builder mb = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "律动 RhythmViz")
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, Math.max(0L, s.durMs));
        if (s.art != null) {
            mb.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, s.art);
            mb.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, s.art);
        }
        session.setMetadata(mb.build());

        long pbActions = PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_STOP;
        PlaybackStateCompat.Builder psb = new PlaybackStateCompat.Builder()
                .setActions(pbActions)
                .setState(s.playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        Math.max(0L, s.posMs), 1.0f, SystemClock.elapsedRealtime());
        session.setPlaybackState(psb.build());

        Notification n = build(s);
        try {
            NotificationManagerCompat.from(this).notify(NOTIF_ID, n);
        } catch (Throwable t) {
            // Android 13+ 用户拒绝通知权限时 post 会抛 SecurityException，服务仍在运行
            Log.w(TAG, "notify 被拒绝（可能未授予通知权限）: " + t.getMessage());
        }
    }

    private Notification build(State s) {
        PendingIntent contentPi = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_ID)
                .setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(s.title)
                .setContentText(s.artist == null || s.artist.isEmpty() ? "律动 RhythmViz" : s.artist)
                .setContentIntent(contentPi)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setDeleteIntent(pi(ACT_STOP));

        if (s.art != null) b.setLargeIcon(s.art);

        b.addAction(android.R.drawable.ic_media_previous, "上一首", pi(ACT_PREV));
        if (s.playing) {
            b.addAction(android.R.drawable.ic_media_pause, "暂停", pi(ACT_PAUSE));
        } else {
            b.addAction(android.R.drawable.ic_media_play, "播放", pi(ACT_PLAY));
        }
        b.addAction(android.R.drawable.ic_media_next, "下一首", pi(ACT_NEXT));

        MediaStyle style = new MediaStyle()
                .setMediaSession(session == null ? null : session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2)
                .setCancelButtonIntent(pi(ACT_STOP))
                .setShowCancelButton(true);
        b.setStyle(style);
        return b.build();
    }

    private PendingIntent pi(String action) {
        Intent i = new Intent(this, MusicService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CH_ID, "音乐播放控制", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("通知栏音乐播放控制器");
            ch.setShowBadge(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(ch);
                Log.i(TAG, "通知渠道已创建 importance=" + ch.getImportance());
            }
        }
    }

    private void sendAction(String action) {
        Sink k = sink;
        if (k != null) {
            try { k.onAction(action); } catch (Throwable ignored) { }
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 任务被划掉：WebView 会随之停止，通知没有继续存在的意义
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        inst = null;
        try { unregisterReceiver(receiver); } catch (Throwable ignored) { }
        if (session != null) {
            try { session.setActive(false); session.release(); } catch (Throwable ignored) { }
            session = null;
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        Log.i(TAG, "onDestroy");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
