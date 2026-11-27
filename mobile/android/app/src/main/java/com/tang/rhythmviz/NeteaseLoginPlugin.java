package com.tang.rhythmviz;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
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

/**
 * 网易云音乐账号登录（官方网页承载）：
 * 原生 HttpURLConnection 指纹（Java TLS）会被网易登录端点风控直接拒绝
 * （实测 weapi 出码后轮询恒回 8821「服务端校验未通过」，加签名/清 Cookie 均无效）。
 * 改由全屏 WebView（桌面 UA）打开官方网页登录页——出码/轮询由页面自身 JS 执行
 * （同源 Chromium 指纹 = 官方浏览器路径，不受客户端风控影响），确认后 MUSIC_U
 * 种在 .music.163.com → CookieManager 轮询收割 → resolve 回 JS 并入音源 Jar。
 * 架构与 QqLoginPlugin（已验证可登录）同构。不清 WebView Cookie，保留 QQ 登录态。
 */
@CapacitorPlugin(name = "NeteaseLogin")
public class NeteaseLoginPlugin extends Plugin {

    /* PC 版网页登录页（#/login）：页面自带「扫码登录」二维码 tab。
       onPageFinished 会尽力自动点选「扫码登录」tab；失败时用户手动点一下即可 */
    private static final String DEFAULT_URL = "https://music.163.com/#/login";

    /* 桌面 Chrome UA：保证下发 PC 版页面（含扫码登录组件；移动版页面无独立扫码入口） */
    private static final String UA_DESKTOP =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private static final String[] COOKIE_HOSTS = {
            "https://music.163.com/",
            "https://interface.music.163.com/"
    };

    private Dialog dialog;
    private WebView webView;
    private PluginCall pendingCall;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean finished = false;
    private long startAt = 0L;

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
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.flush();
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
        title.setText("网易云音乐登录");
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
        /* PC 页面定宽布局：宽视口 + 初始 2.4 倍缩放（overview 会覆盖 initialScale，
           必须关闭），页面宽于屏幕可平移/双指调整 */
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(false);
        /* 双指缩放：初始 2.4 倍（码够大可扫），用户可随时双指自由调整 */
        ws.setBuiltInZoomControls(true);
        ws.setDisplayZoomControls(false);
        ws.setSupportZoom(true);
        webView.setInitialScale(240);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false; // 全部由页面内导航
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                checkCookies();
                /* 登录页默认可能停在「手机号登录」tab：尽力自动点选「扫码登录」
                   （页面大小由 initialScale 2.4 起步 + 双指手势自由调整） */
                mainHandler.postDelayed(() -> {
                    if (finished || webView == null) return;
                    webView.evaluateJavascript(
                        "(function(){try{var els=document.querySelectorAll('a,div,span,li,button');"
                        + "for(var i=0;i<els.length;i++){var t=(els[i].textContent||'').trim();"
                        + "if((t==='扫码登录'||t==='二维码登录')&&els[i].click){els[i].click();return '1';}}"
                        + "return '0';}catch(e){return '0';}})()", null);
                }, 1200);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
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
        mainHandler.postDelayed(cookiePoller, 2500);
    }

    private final Runnable cookiePoller = new Runnable() {
        @Override
        public void run() {
            if (!finished && dialog != null && dialog.isShowing()) {
                checkCookies();
                /* 总超时 5 分钟：另一台手机「拿起→开 App→扫一扫→确认」整链很慢，
                   75s 会在用户确认途中误杀（表现为「确认了却提示超时」） */
                if (!finished && SystemClock.elapsedRealtime() - startAt > 300000) {
                    fail("登录超时：未检测到登录成功，请重试");
                    return;
                }
                mainHandler.postDelayed(this, 1500);
            }
        }
    };

    private void checkCookies() {
        if (finished) return;
        String raw = CookieManager.getInstance().getCookie("https://music.163.com/");
        if (raw != null && raw.contains("MUSIC_U=")) {
            succeed();
        }
    }

    private void succeed() {
        if (finished) return;
        finished = true;
        mainHandler.removeCallbacks(cookiePoller);

        JSArray cookies = new JSArray();
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (String host : COOKIE_HOSTS) {
            String raw = CookieManager.getInstance().getCookie(host);
            if (raw == null) continue;
            String domain;
            try { domain = android.net.Uri.parse(host).getHost(); } catch (Exception e) { continue; }
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
        try {
            if (dialog != null) {
                dialog.dismiss();
                dialog = null;
            }
            if (webView != null) {
                webView.destroy();
                webView = null;
            }
        } catch (Exception ignored) { }
    }

    private int dp(int v) {
        Context ctx = getActivity();
        float d = ctx != null ? ctx.getResources().getDisplayMetrics().density : 2f;
        return Math.round(v * d);
    }
}
