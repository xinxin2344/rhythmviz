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
 * QQ 音乐快捷登录：
 * 全屏 WebView 打开 QQ 音乐官方 ptlogin 授权页。手机已安装 QQ 时，
 * 页面可唤起 QQ 完成一键授权（无需第二台设备扫码）；授权后重定向链
 * 由系统 WebView 自动走完，本插件在 CookieManager 中收割 qm_keyst
 * 等业务域 Cookie 回传 JS 侧，并入音源 CookieJar。
 */
@CapacitorPlugin(name = "QqLogin")
public class QqLoginPlugin extends Plugin {

    private static final String DEFAULT_URL =
            "https://xui.ptlogin2.qq.com/cgi-bin/xlogin"
            + "?appid=716027609&daid=384&style=40&target=self"
            + "&ptredirect=0&pt_no_auth=1&qlogin_auto_login=1"
            + "&s_url=" + Uri.encode("https://y.qq.com/");

    /* QQ 浏览器 UA：ptlogin 对 QQ 浏览器直接下发「QQ 一键登录」，
       其页面 JS 走 mqqapi:// 唤起本机 QQ（而不是给普通浏览器的扫码兜底页） */
    private static final String UA_MOBILE =
            "Mozilla/5.0 (Linux; U; Android 13; zh-cn; Pixel 7 Build/TQ3A.230705.001) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
            + "Chrome/116.0.0.0 MQQBrowser/13.9 Mobile Safari/537.36";

    /* 页面加载后自动触发「QQ 一键登录」：
       1) 直接抓页面里所有 mqq/mqqapi/intent 协议链接，交给顶层导航（必走拦截器）；
       2) 合成完整触摸序列点击 qlogin 入口（部分页面不认裸 .click()）；
       3) 兜底按文案找「一键登录/快速登录/本机QQ」节点 */
    private static final String JS_CLICK_QLOGIN =
            "(function(){"
            + "var links=document.querySelectorAll('a[href],area[href]');"
            + "for(var k=0;k<links.length;k++){var h=links[k].href||'';"
            + "if(/^(mqq|mqqapi|mqqopensdkapi|mqqconnect|tencent|intent):/i.test(h)){"
            + "try{window.location.href=h;return;}catch(e){}}"
            + "var pool=[document.getElementById('qlogin'),document.getElementById('qlogin_img'),"
            + "document.querySelector('.quick-login'),document.querySelector('[data-type=qlogin]'),"
            + "document.querySelector('.qlogin-btn'),document.querySelector('#qlogin_quick')];"
            + "var nodes=document.querySelectorAll('a,div,span,button,img,li,i');"
            + "for(var i=0;i<nodes.length;i++){var t=(nodes[i].innerText||nodes[i].title||nodes[i].alt||'');"
            + "if(t.indexOf('一键登录')>=0||t.indexOf('快速登录')>=0||t.indexOf('本机QQ')>=0"
            + "||t.indexOf('QQ登录')>=0){pool.push(nodes[i]);}}"
            + "function tap(el){['pointerdown','mousedown','touchstart','pointerup','mouseup','touchend','click']"
            + ".forEach(function(ev){var evo;try{evo=new PointerEvent(ev,{bubbles:true,cancelable:true});}"
            + "catch(e){evo=new MouseEvent(ev,{bubbles:true,cancelable:true});}el.dispatchEvent(evo);});}"
            + "for(var j=0;j<pool.length;j++){try{tap(pool[j]);pool[j].click&&pool[j].click();}catch(e){}}"
            + "})();";

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

        LinearLayout root = new LinearLayout(ctx);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0e0e12"));

        LinearLayout bar = new LinearLayout(ctx);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(12), dp(8), dp(8), dp(8));
        bar.setBackgroundColor(Color.parseColor("#16161c"));

        TextView title = new TextView(ctx);
        title.setText("QQ 音乐快捷登录");
        title.setTextColor(Color.WHITE);
        title.setTextSize(15);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(title, tp);

        Button wake = new Button(ctx);
        wake.setText("唤起QQ");
        wake.setAllCaps(false);
        wake.setTextColor(Color.WHITE);
        wake.setBackgroundColor(Color.TRANSPARENT);
        wake.setOnClickListener(v -> {
            if (webView != null) webView.evaluateJavascript(JS_CLICK_QLOGIN, null);
        });
        bar.addView(wake);

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
        ws.setUserAgentString(UA_MOBILE);
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
                // 延迟一点等页面把快捷登录入口渲染出来，再自动点击
                mainHandler.postDelayed(() -> {
                    if (!finished && webView != null) {
                        webView.evaluateJavascript(JS_CLICK_QLOGIN, null);
                    }
                }, 700);
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
            }
        } catch (Exception e) {
            // 没装 QQ（ActivityNotFoundException 等）：留在网页继续账号密码/扫码登录
        }
    }

    private void checkCookies() {
        if (finished) return;
        String yqq = CookieManager.getInstance().getCookie("https://y.qq.com/");
        if (yqq == null) return;
        boolean hasKey = yqq.contains("qm_keyst=") || yqq.contains("qqmusic_key=");
        if (!hasKey) return;
        succeed();
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
