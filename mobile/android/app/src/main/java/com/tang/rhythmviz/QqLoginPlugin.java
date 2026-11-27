package com.tang.rhythmviz;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.LinkedHashSet;
import java.util.Set;

/**
 * QQ 音乐账号登录（扫码形态）：全屏 WebView（桌面 UA）打开 graph 授权页，
 * ptlogin 默认显示扫码二维码（无密码表单）；手机 QQ 扫码确认后由官方链
 * 自动换票，CookieManager 收割 qm_keyst 回传 JS 侧并入音源 CookieJar。
 * 确认后授权链若挂住（graph 页不跳转，用户停在「扫描成功」等待页），
 * 检测到 QQ 顶层登录态 3.5s 仍无票据 → 主动加载 y.qq.com SPA 强制换票
 * （桌面端同款兜底，SPA 读通用登录态自动签发 qm_keyst）→ 收割后自动关闭。
 */
@CapacitorPlugin(name = "QqLogin")
public class QqLoginPlugin extends Plugin {

    /* 桌面 UA + display=pc（PoC 实测）：ptlogin iframe 默认显示扫码二维码
       （「使用QQ手机版扫码登录」，86.6px 码 + 密码登录只是页内小链接）——
       用户要求 QQ 只扫码、不要密码表单。授权上下文完整（graph show 会话）：
       手机 QQ 扫码确认 → graph 302 wx_redirect?code 回 y.qq.com → qm_keyst
       种 y.qq.com 域 → onPageFinished/轮询收割（checkCookies 判定不变） */
    private static final String DEFAULT_URL =
            "https://graph.qq.com/oauth2.0/show?which=Login&display=pc&response_type=code"
            + "&client_id=100497308"
            + "&redirect_uri=" + Uri.encode("https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2Fn%2Fryqq_v2%2Fprofile")
            + "&state=state&scope=" + Uri.encode("get_user_info,get_app_friends");

    /* 桌面 Chrome UA：让 graph/ptlogin 下发 PC 版登录盒（默认扫码二维码 tab）。
       登录协议全部由官方页 JS 执行（浏览器级上下文，风控放行），收割不受影响 */
    private static final String UA_DESKTOP =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private static final String[] COOKIE_HOSTS = {
            "https://y.qq.com/",
            "https://ssl.ptlogin2.qq.com/",
            "https://xui.ptlogin2.qq.com/",
            "https://graph.qq.com/",
            "https://qq.com/"
    };

    /* ptlogin 通过隐藏 iframe 唤醒 QQ 时只走 shouldInterceptRequest；
       以下协议全部视为「唤起本机 QQ」 */
    private static final Set<String> WAKE_SCHEMES = new LinkedHashSet<String>() {{
        add("mqq"); add("mqqapi"); add("mqqopensdkapi"); add("mqqconnect"); add("tencent"); add("intent");
    }};

    private Dialog dialog;
    private WebView webView;
    private PluginCall pendingCall;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean finished = false;
    private String lastWakeUri;
    private long lastWakeAt = 0L;
    /* 首次检测到 QQ 顶层登录态（p_skey/skey，扫码确认后 ptlogin 才种）的时刻：
       授权链挂住时据此触发 SPA 兜底换票 */
    private long loginCookieAt = 0L;
    /* 登录流程开始时刻（总超时计时基准） */
    private long startAt = 0L;

    /** 从 QQ 授权页返回 App 时补检 Cookie（QQ 回跳可能不触发 onPageFinished） */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        mainHandler.postDelayed(() -> { if (!finished) checkCookies(); }, 500);
    }

    private final Runnable cookiePoller = new Runnable() {
        @Override
        public void run() {
            if (!finished && dialog != null && dialog.isShowing()) {
                checkCookies();
                /* 总超时 75s：授权链彻底挂死/用户始终没确认 → 明确失败回传
                   （JS 侧弹提示），不再无限停在等待页「没有反应」 */
                if (!finished && SystemClock.elapsedRealtime() - startAt > 75000) {
                    fail("登录超时：未检测到登录成功，请重试");
                    return;
                }
                mainHandler.postDelayed(this, 1500);
            }
        }
    };

    @PluginMethod
    public void open(final PluginCall call) {
        final String url = call.getString("url", DEFAULT_URL);
        call.setKeepAlive(true);
        pendingCall = call;
        finished = false;

        mainHandler.post(() -> buildAndShow(url));
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void buildAndShow(String url) {
        Context ctx = getActivity();
        if (ctx == null) {
            fail("no activity");
            return;
        }
        // 全新会话：清掉历史 QQ 网页 Cookie，确保走授权而不是沿用旧态
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.removeAllCookies(null);
        cm.flush();
        lastWakeUri = null;
        lastWakeAt = 0L;
        loginCookieAt = 0L;
        startAt = SystemClock.elapsedRealtime(); // 75s 总超时基准

        LinearLayout root = new LinearLayout(ctx);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0e0e12"));

        LinearLayout bar = new LinearLayout(ctx);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(12), dp(8), dp(8), dp(8));
        bar.setBackgroundColor(Color.parseColor("#16161c"));

        TextView title = new TextView(ctx);
        title.setText("QQ 音乐账号登录");
        title.setTextColor(Color.WHITE);
        title.setTextSize(15);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(title, tp);

        Button close = new Button(ctx);
        close.setText("取消");
        close.setAllCaps(false);
        close.setTextColor(Color.WHITE);
        close.setBackgroundColor(Color.TRANSPARENT);
        close.setOnClickListener(v -> fail("cancelled"));
        bar.addView(close);

        webView = new WebView(ctx);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        ws.setUserAgentString(UA_DESKTOP);
        /* 桌面 UA 的 PC 登录盒定宽 ~430px：宽视口 + 概览缩放让它整体缩放到手机屏宽，
           二维码完整可见可扫（PoC 实测 86.6px 码 + 周边留白，缩放后清晰） */
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        // 关掉多窗口：所有 target=_blank / window.open 导航都走主 WebView，
        // 保证自定义协议一定经过下面的拦截器（多窗口时拦截发生在拿不到的 dummy 视图上）
        ws.setSupportMultipleWindows(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            /* 关键：ptlogin 用隐藏 iframe 跳 mqqapi:// 唤起 QQ 时，
               shouldOverrideUrlLoading 不触发，只有资源拦截能拿到 */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                handleUrl(request.getUrl());
                return null; // http(s) 正常加载；自定义协议交给系统后 WebView 自身会报 ERR_BEST_MATCH，无影响
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                checkCookies();
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.proceed();
            }
        });

        root.addView(bar);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        dialog = new Dialog(ctx, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(root);
        dialog.setCancelable(true);
        dialog.setOnCancelListener(d -> fail("cancelled"));
        dialog.show();

        webView.loadUrl(url);
        mainHandler.postDelayed(cookiePoller, 2000);
    }

    /** 非 http(s) 协议（mqq / mqqapi / intent 等）：交给系统/QQ App 处理。
     *  会被 shouldOverrideUrlLoading 与 shouldInterceptRequest 双通道调用，需去重，
     *  且后者在 binder 线程触发，统一 post 到主线程执行。 */
    private boolean handleUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        scheme = scheme.toLowerCase();
        if (scheme.equals("http") || scheme.equals("https")) return false;
        if (!WAKE_SCHEMES.contains(scheme)) return false;

        final String us = uri.toString();
        final long now = System.currentTimeMillis();
        if (us.equals(lastWakeUri) && now - lastWakeAt < 3000) return true;
        lastWakeUri = us;
        lastWakeAt = now;

        mainHandler.post(() -> launchWake(us));
        return true;
    }

    private void launchWake(String us) {
        try {
            Uri uri = Uri.parse(us);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
            Intent intent = null;
            if (scheme.equals("intent")) {
                intent = Intent.parseUri(us, Intent.URI_INTENT_SCHEME);
            } else {
                intent = new Intent(Intent.ACTION_VIEW, uri);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Context ctx = getActivity();
            if (ctx != null && intent.resolveActivity(ctx.getPackageManager()) != null) {
                ctx.startActivity(intent);
                return;
            }
            // 协议直拉失败：intent:// 自带浏览器回退页则加载；否则尝试直接启动 QQ 主程序
            if (scheme.equals("intent")) {
                String fallback = intent.getStringExtra("browser_fallback_url");
                if (fallback != null && webView != null) {
                    webView.loadUrl(fallback);
                    return;
                }
            }
            Intent qq = ctx != null
                    ? ctx.getPackageManager().getLaunchIntentForPackage("com.tencent.mobileqq") : null;
            if (qq != null) {
                qq.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(qq);
            } else if (ctx != null) {
                // 没装 QQ：明确告知用户，避免点了登录毫无反应
                try {
                    android.widget.Toast.makeText(ctx,
                            "未检测到手机 QQ，请在网页内扫码或输入账号登录", android.widget.Toast.LENGTH_LONG).show();
                } catch (Throwable ignored) { }
            }
        } catch (Exception e) {
            // 没装 QQ（ActivityNotFoundException 等）：留在网页继续账号密码/扫码登录
        }
    }

    private void checkCookies() {
        if (finished) return;
        String yqq = CookieManager.getInstance().getCookie("https://y.qq.com/");
        if (yqq != null) {
            boolean hasKey = yqq.contains("qm_keyst=") || yqq.contains("qqmusic_key=");
            if (hasKey) { succeed(); return; }
        }
        /* 授权链挂住兜底：手机 QQ 已确认（.qq.com 顶层种下 p_skey/skey）但
           graph 页 3.5s 内没走到 wx_redirect（网络慢/链断）——用户会一直停在
           「扫描成功，请在手机上确认」等待页。此时主动加载 y.qq.com SPA：
           它读到通用登录态会自动换票签发 qm_keyst（桌面端验证过的链路），
           后续轮询收割 → succeed → 自动关闭 WebView */
        /* 确认态检测扩到三个域：手机 QQ 确认后 p_skey/skey 可能种在 .qq.com
           顶层域，也可能 host-only 在 ssl/xui.ptlogin2.qq.com（getCookie 只回
           匹配该域的 Cookie，此前只查 qq.com → confirmed 永不触发 → 用户停在
           「请在手机上确认」等待页干等超时 = 「卡住」） */
        boolean loginState = hasLoginCookie("https://qq.com/")
                || hasLoginCookie("https://ssl.ptlogin2.qq.com/")
                || hasLoginCookie("https://xui.ptlogin2.qq.com/");
        long now = SystemClock.elapsedRealtime();
        if (loginState) {
            if (loginCookieAt == 0) {
                loginCookieAt = now;
                notifyListeners("qqStage", stage("confirmed")); // 手机已确认 → 等/换票
            } else if (now - loginCookieAt > 2500) {
                loginCookieAt = now; // 防重复触发；SPA 换票失败时每 2.5s 重试一次
                notifyListeners("qqStage", stage("fallback"));
                if (webView != null) {
                    webView.loadUrl("https://y.qq.com/n/ryqq_v2/profile");
                }
            }
        } else {
            loginCookieAt = 0; // 尚未确认/已登出：重置
        }
    }

    /** 该域是否存在 QQ 通用登录态 Cookie（确认后 ptlogin 种下） */
    private boolean hasLoginCookie(String url) {
        String c = CookieManager.getInstance().getCookie(url);
        return c != null && (c.contains("p_skey=") || c.contains("skey="));
    }

    /** 登录阶段事件（JS 侧 toast 展示，让用户看到卡在哪一步） */
    private JSObject stage(String s) {
        JSObject o = new JSObject();
        o.put("stage", s);
        return o;
    }

    private void succeed() {
        if (finished) return;
        finished = true;
        mainHandler.removeCallbacks(cookiePoller);

        JSArray cookies = new JSArray();
        Set<String> seen = new LinkedHashSet<>();
        for (String host : COOKIE_HOSTS) {
            String raw = CookieManager.getInstance().getCookie(host);
            if (raw == null) continue;
            String domain;
            try { domain = Uri.parse(host).getHost(); } catch (Exception e) { continue; }
            for (String pair : raw.split(";")) {
                String kv = pair.trim();
                int eq = kv.indexOf('=');
                if (eq <= 0) continue;
                String name = kv.substring(0, eq);
                String value = kv.substring(eq + 1);
                String key = domain + "|" + name;
                if (seen.contains(key)) continue;
                seen.add(key);
                JSObject c = new JSObject();
                c.put("name", name);
                c.put("value", value);
                c.put("domain", domain);
                c.put("path", "/");
                cookies.put(c);
            }
        }

        JSObject ret = new JSObject();
        ret.put("cookies", cookies);
        PluginCall call = pendingCall;
        dismissDialog();
        if (call != null) call.resolve(ret);
        pendingCall = null;
    }

    private void fail(String msg) {
        if (finished) return;
        finished = true;
        mainHandler.removeCallbacks(cookiePoller);
        PluginCall call = pendingCall;
        dismissDialog();
        if (call != null) call.reject(msg);
        pendingCall = null;
    }

    private void dismissDialog() {
        mainHandler.post(() -> {
            try {
                if (webView != null) {
                    webView.stopLoading();
                    webView.loadUrl("about:blank");
                    ((ViewGroup) webView.getParent()).removeView(webView);
                    webView.destroy();
                    webView = null;
                }
                if (dialog != null && dialog.isShowing()) dialog.dismiss();
            } catch (Exception ignored) {
            }
            dialog = null;
        });
    }

    private int dp(int v) {
        return Math.round(v * getActivity().getResources().getDisplayMetrics().density);
    }
}
