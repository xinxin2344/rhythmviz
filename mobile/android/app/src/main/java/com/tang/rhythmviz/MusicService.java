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
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
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
import android.widget.RemoteViews;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.app.ServiceCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

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
    static final String ACT_FAV = "com.tang.rhythmviz.ACT_FAV";
    static final String ACT_STOP = "com.tang.rhythmviz.ACT_STOP";

    interface Sink { void onAction(String action); }
    static volatile Sink sink;
    static volatile MusicService inst;

    static final class State {
        String title = "律动 RhythmViz";
        String artist = "";
        String album = "";
        boolean playing = false;
        boolean fav = false;
        long posMs = 0L;
        long durMs = 0L;
        Bitmap art = null;
    }

    private static final State pending = new State();

    /* 网易云式通知配色：控制键灰 / 喜欢红 / 品牌角标紫 */
    private static final int ICON_GRAY = 0xFF5F6168;
    private static final int FAV_RED = 0xFFEC4145;
    private static final int BRAND = 0xFF7C5CFF;
    /* 封面右下角标色：网易云视觉是「红底白音符」小圆标（对齐用户参考图） */
    private static final int BADGE_RED = 0xFFE64340;

    /* 封面衍生缓存：封面位图引用未变时复用（play/pause 高频刷新不重算取色/渐变） */
    private Bitmap artRef = null;
    private boolean artDerived = false;
    private Bitmap cachedBg = null;
    private Bitmap cachedCover = null;
    private int cachedAccent = BRAND;

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
        pending.album = s.album;
        pending.playing = s.playing;
        pending.fav = s.fav;
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
                case ACT_FAV:
                    sendAction("fav");
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
        f.addAction(ACT_FAV);
        f.addAction(ACT_STOP);
        ContextCompat.registerReceiver(this, receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        Log.i(TAG, "onCreate：渠道/MediaSession/接收器就绪");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        MediaButtonReceiver.handleIntent(session, intent);
        String a = intent != null ? intent.getAction() : null;
        if (a != null) {
            switch (a) {
                case ACT_PLAY:
                    sendAction("play");
                    break;
                case ACT_PAUSE:
                    sendAction("pause");
                    break;
                case ACT_NEXT:
                    sendAction("next");
                    break;
                case ACT_PREV:
                    sendAction("prev");
                    break;
                case ACT_FAV:
                    sendAction("fav");
                    break;
                case ACT_STOP:
                    sendAction("pause");
                    stopSelf();
                    return START_NOT_STICKY;
            }
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
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM,
                        s.album == null || s.album.isEmpty() ? "律动 RhythmViz" : s.album)
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

        // 网易云式副标题：歌手 - 专辑
        String artist = s.artist == null ? "" : s.artist;
        String album = s.album == null ? "" : s.album;
        String sub = artist.isEmpty() ? "律动 RhythmViz"
                : (album.isEmpty() ? artist : artist + " - " + album);

        // 封面衍生资源（渐变背景/圆角角标封面/着色主色）：封面引用未变直接复用缓存
        if (!artDerived || s.art != artRef) deriveArt(s.art);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_ID)
                .setSmallIcon(R.drawable.ic_stat_music)
                .setContentTitle(s.title)
                .setContentText(sub)
                .setContentIntent(contentPi)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setDeleteIntent(pi(ACT_STOP));

        /* Android 13+（TIRAMISU）：交给系统 MediaStyle + colorized 渲染 —— 用户截图的
           网易云效果（封面取色弥散渐变底、黑色标题、灰色系统按钮、右上展开角标）就是
           Android 13 系统 colorized 媒体通知的原生渲染，网易云自己也没画自定义视图；
           挂了 customContentView 反而会把系统渲染压掉（上一版「不对」的根因）。
           largeIcon 传「圆角封面 + 右下红色圆底白音符角标」位图 = 网易封面同款视觉。
           Android 12- 系统无弥散渲染 → 走自定义 RemoteViews 渐变卡片兜底。 */
        if (Build.VERSION.SDK_INT >= 33) {
            if (cachedCover != null) b.setLargeIcon(cachedCover);
        } else {
            try {
                RemoteViews rv = new RemoteViews(getPackageName(), R.layout.notif_media);
                RemoteViews rb = new RemoteViews(getPackageName(), R.layout.notif_media_big);
                fillViews(rv, s, sub, false, contentPi);
                fillViews(rb, s, sub, true, contentPi);
                b.setCustomContentView(rv);
                b.setCustomBigContentView(rb);
            } catch (Throwable t) {
                Log.w(TAG, "自定义通知视图构建失败，回退系统模板: " + t);
            }
        }

        // 系统模板兜底路径（Android 13+ 强制标准媒体模板的 ROM 走这里）：
        // 封面主色着色 + 动作按钮（喜欢 | 上一首 | 播放/暂停 | 下一首，无「桌面歌词」）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            b.setColorized(true);
            b.setColor(cachedAccent);
        }
        b.addAction(s.fav ? R.drawable.ic_notif_fav_on : R.drawable.ic_notif_fav_off,
                s.fav ? "取消喜欢" : "喜欢", pi(ACT_FAV));
        b.addAction(R.drawable.ic_notif_prev, "上一首", pi(ACT_PREV));
        if (s.playing) {
            b.addAction(R.drawable.ic_notif_pause, "暂停", pi(ACT_PAUSE));
        } else {
            b.addAction(R.drawable.ic_notif_play, "播放", pi(ACT_PLAY));
        }
        b.addAction(R.drawable.ic_notif_next, "下一首", pi(ACT_NEXT));

        MediaStyle style = new MediaStyle()
                .setMediaSession(session == null ? null : session.getSessionToken())
                .setShowActionsInCompactView(1, 2, 3)
                .setCancelButtonIntent(pi(ACT_STOP))
                .setShowCancelButton(true);
        b.setStyle(style);
        return b.build();
    }

    /* ---------- 网易云式通知：取色 / 衍生位图 / 自定义视图填充 ---------- */

    /** 封面衍生资源整备：双色提取 → 浅雾渐变背景 + 圆角角标封面 + 着色主色 */
    private void deriveArt(Bitmap art) {
        int A = BRAND, B = 0xFFFF6FA5;
        try {
            if (art != null) {
                int[] ab = extractColors(art);
                A = ab[0];
                B = ab[1];
            }
        } catch (Throwable t) {
            Log.w(TAG, "封面双色提取失败，用默认配色: " + t);
            A = BRAND;
            B = 0xFFFF6FA5;
        }
        // 系统兜底着色：主色提饱和提亮（避免深色封面把系统模板染得看不清）
        float[] hv = new float[3];
        Color.colorToHSV(A, hv);
        hv[1] = Math.max(0.40f, hv[1]);
        hv[2] = Math.max(0.50f, hv[2]);
        cachedAccent = 0xFF000000 | Color.HSVToColor(hv);
        try {
            cachedBg = makeGradient(pastel(A), pastel(B));
        } catch (Throwable t) {
            Log.w(TAG, "渐变背景生成失败: " + t);
            cachedBg = null;
        }
        try {
            cachedCover = roundedCover(art, BADGE_RED);
        } catch (Throwable t) {
            Log.w(TAG, "圆角封面生成失败: " + t);
            cachedCover = null;
        }
        artRef = art;
        artDerived = true;
    }

    /** 颜色桶（桶加权取色用） */
    private static final class Bucket {
        int n;
        long r, g, b;
        double wt;
    }

    /** 桶加权双色提取：主色 A = 加权最强桶；次色 B = 与 A 色相差 ≥26° 的次强桶，
     *  无则 A 色相 +32° 派生（与前端 bridge.js pickCoverColors 同一算法） */
    private static int[] extractColors(Bitmap art) {
        Bitmap small = Bitmap.createScaledBitmap(art, 24, 24, true);
        int w = small.getWidth(), h = small.getHeight();
        int[] px = new int[w * h];
        small.getPixels(px, 0, w, 0, 0, w, h);
        if (small != art) small.recycle();
        Map<Integer, Bucket> map = new HashMap<>();
        for (int c : px) {
            int r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, bl = c & 0xFF;
            int mx = Math.max(r, Math.max(g, bl)), mn = Math.min(r, Math.min(g, bl));
            double lum = (mx + mn) / 510.0;
            if (lum < 0.06 || lum > 0.96) continue; // 纯黑/纯白像素不参与
            double sat = mx == 0 ? 0 : (mx - mn) / (double) mx;
            int key = ((r >> 4) << 8) | ((g >> 4) << 4) | (bl >> 4);
            Bucket bk = map.get(key);
            if (bk == null) {
                bk = new Bucket();
                map.put(key, bk);
            }
            bk.n++;
            bk.r += r;
            bk.g += g;
            bk.b += bl;
            bk.wt += 1 + sat * 2.6 + (lum > 0.14 && lum < 0.92 ? 0.8 : 0);
        }
        if (map.isEmpty()) return new int[]{BRAND, 0xFFFF6FA5};
        List<Bucket> list = new ArrayList<>(map.values());
        Collections.sort(list, (x, y) -> Double.compare(y.wt, x.wt));
        int A = avgBucket(list.get(0));
        float[] hA = new float[3];
        Color.colorToHSV(A, hA);
        int B = 0;
        for (int i = 1; i < list.size(); i++) {
            int c = avgBucket(list.get(i));
            float[] hc = new float[3];
            Color.colorToHSV(c, hc);
            float dh = Math.abs(hc[0] - hA[0]);
            if (dh > 180f) dh = 360f - dh;
            if (dh >= 26f) {
                B = c;
                break;
            }
        }
        if (B == 0) {
            float[] hRot = hA.clone();
            hRot[0] = (hRot[0] + 32f) % 360f;
            hRot[2] = Math.max(0.18f, Math.min(0.8f, hRot[2] * 0.72f + 0.1f));
            B = 0xFF000000 | Color.HSVToColor(hRot);
        }
        return new int[]{A, B};
    }

    private static int avgBucket(Bucket bk) {
        return 0xFF000000
                | ((int) Math.round(bk.r / bk.n) << 16)
                | ((int) Math.round(bk.g / bk.n) << 8)
                | (int) Math.round(bk.b / bk.n);
    }

    /** 封面色 → 浅雾面（网易云玻璃卡片底色：降饱和 + 提亮，配深色文字） */
    private static int pastel(int c) {
        float[] hsv = new float[3];
        Color.colorToHSV(c, hsv);
        hsv[1] = hsv[1] * 0.52f;
        hsv[2] = Math.max(0.66f, Math.min(0.92f, hsv[2] * 0.60f + 0.38f));
        return 0xFF000000 | Color.HSVToColor(hsv);
    }

    /** 通知背景：对角双色柔和渐变 + 顶部白雾（玻璃质感） */
    private static Bitmap makeGradient(int a, int b) {
        int w = 360, h = 200;
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setShader(new LinearGradient(0, 0, w, h, a, b, Shader.TileMode.CLAMP));
        cv.drawRect(0, 0, w, h, p);
        Paint fog = new Paint(Paint.ANTI_ALIAS_FLAG);
        fog.setShader(new LinearGradient(0, 0, 0, h,
                0x59FFFFFF, 0x14FFFFFF, Shader.TileMode.CLAMP));
        cv.drawRect(0, 0, w, h, fog);
        return bmp;
    }

    /** 圆角封面 + 右下品牌角标（对应网易云封面右下角红色 Logo 的品牌位） */
    private static Bitmap roundedCover(Bitmap art, int badge) {
        int s = 256;
        Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        Path clip = new Path();
        clip.addRoundRect(new RectF(0, 0, s, s), s * 0.11f, s * 0.11f, Path.Direction.CW);
        cv.clipPath(clip);
        if (art != null) {
            Bitmap src = Bitmap.createScaledBitmap(art, s, s, true);
            cv.drawBitmap(src, 0, 0, p);
            if (src != art) src.recycle();
        } else {
            p.setShader(new LinearGradient(0, 0, s, s, 0xFF8A6BFF, 0xFF5B3FD1, Shader.TileMode.CLAMP));
            cv.drawRect(0, 0, s, s, p);
            p.setShader(null);
        }
        float br = s * 0.13f;
        float cx = s - br * 1.4f, cy = s - br * 1.4f;
        p.setColor(badge);
        cv.drawCircle(cx, cy, br, p);
        p.setColor(0xFFFFFFFF);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(s * 0.01f);
        cv.drawCircle(cx, cy, br, p);
        p.setStyle(Paint.Style.FILL);
        p.setTextSize(br * 1.05f);
        p.setTextAlign(Paint.Align.CENTER);
        cv.drawText("♪", cx, cy + br * 0.38f, p);
        return out;
    }

    /** 自定义视图填充：背景/封面/文字 + 灰色控制键（喜欢时红）+ 各键点击意图 */
    private void fillViews(RemoteViews v, State s, String sub, boolean big, PendingIntent contentPi) {
        if (cachedBg != null) v.setImageViewBitmap(R.id.notif_bg, cachedBg);
        if (cachedCover != null) v.setImageViewBitmap(R.id.notif_cover, cachedCover);
        v.setTextViewText(R.id.notif_title, s.title);
        v.setTextViewText(R.id.notif_sub, sub);
        v.setImageViewResource(R.id.notif_fav, s.fav ? R.drawable.ic_notif_fav_on : R.drawable.ic_notif_fav_off);
        v.setInt(R.id.notif_fav, "setColorFilter", s.fav ? FAV_RED : ICON_GRAY);
        v.setImageViewResource(R.id.notif_prev, R.drawable.ic_notif_prev);
        v.setInt(R.id.notif_prev, "setColorFilter", ICON_GRAY);
        v.setImageViewResource(R.id.notif_play, s.playing ? R.drawable.ic_notif_pause : R.drawable.ic_notif_play);
        v.setInt(R.id.notif_play, "setColorFilter", ICON_GRAY);
        v.setImageViewResource(R.id.notif_next, R.drawable.ic_notif_next);
        v.setInt(R.id.notif_next, "setColorFilter", ICON_GRAY);
        v.setOnClickPendingIntent(R.id.notif_fav, pi(ACT_FAV));
        v.setOnClickPendingIntent(R.id.notif_prev, pi(ACT_PREV));
        v.setOnClickPendingIntent(R.id.notif_play, s.playing ? pi(ACT_PAUSE) : pi(ACT_PLAY));
        v.setOnClickPendingIntent(R.id.notif_next, pi(ACT_NEXT));
        v.setOnClickPendingIntent(R.id.notif_root, contentPi);
        v.setOnClickPendingIntent(R.id.notif_expand, contentPi);
        if (big) {
            long dur = Math.max(1L, s.durMs);
            v.setProgressBar(R.id.notif_progress, (int) Math.min(dur, Integer.MAX_VALUE),
                    (int) Math.min(Math.max(0L, s.posMs), Integer.MAX_VALUE), false);
            v.setTextViewText(R.id.notif_t1, mmss(s.posMs));
            v.setTextViewText(R.id.notif_t2, mmss(s.durMs));
        }
    }

    private static String mmss(long ms) {
        long sec = Math.max(0L, ms) / 1000L;
        return String.format(Locale.US, "%d:%02d", sec / 60L, sec % 60L);
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
