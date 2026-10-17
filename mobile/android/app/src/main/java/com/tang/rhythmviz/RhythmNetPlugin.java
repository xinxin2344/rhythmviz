package com.tang.rhythmviz;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.CookieStore;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * RhythmNet：音源专用 HTTP 插件
 * - 无 CORS 限制（原生直发，可自定义 UA/Referer/Cookie）
 * - 内存 CookieStore 跨请求共享，手动逐跳跟随重定向，收集整条重定向链的 Set-Cookie
 * - 请求/响应体经 Base64 桥接，支持音频整曲二进制下载
 * Cookie 的持久化与归属由 JS 侧 CookieJar 负责；本插件只保证同一次安装生命周期内的会话连续性。
 */
@CapacitorPlugin(name = "RhythmNet")
public class RhythmNetPlugin extends Plugin {

    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private final CookieStore cookieStore = new CookieManager(null, CookiePolicy.ACCEPT_ALL).getCookieStore();

    @PluginMethod
    public void request(final PluginCall call) {
        final String surl = call.getString("url");
        if (surl == null || surl.isEmpty()) {
            call.reject("url is required");
            return;
        }
        final String method = call.getString("method", "GET").toUpperCase();
        final boolean follow = call.getBoolean("followRedirects", true);
        final int timeoutMs = call.getInt("timeoutMs", 20000);
        final String bodyText = call.getString("bodyText", null);
        final String bodyB64 = call.getString("bodyBase64", null);
        final JSArray headerArr;
        try {
            headerArr = call.getArray("headers", new JSArray());
        } catch (Exception e) {
            call.reject("bad headers: " + e.getMessage());
            return;
        }

        pool.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    byte[] body = null;
                    if (bodyText != null) body = bodyText.getBytes("UTF-8");
                    else if (bodyB64 != null) body = Base64.decode(bodyB64, Base64.NO_WRAP);

                    URI uri = new URI(surl);
                    String curMethod = method;
                    int redirects = 0;
                    int status = 0;
                    Map<String, List<String>> respHeaders = null;
                    URL finalUrl = null;

                    while (true) {
                        conn = (HttpURLConnection) uri.toURL().openConnection();
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(timeoutMs);
                        conn.setInstanceFollowRedirects(false);
                        conn.setRequestMethod(curMethod);
                        conn.setDoInput(true);

                        String jsCookie = applyHeaders(conn, headerArr, uri);

                        boolean hasBody = body != null && !"GET".equals(curMethod) && !"HEAD".equals(curMethod);
                        if (hasBody) {
                            conn.setDoOutput(true);
                            OutputStream os = conn.getOutputStream();
                            os.write(body);
                            os.flush();
                            os.close();
                        }

                        status = conn.getResponseCode();
                        respHeaders = conn.getHeaderFields();
                        collectCookies(uri, respHeaders);
                        finalUrl = uri.toURL();

                        String location = conn.getHeaderField("Location");
                        if (follow && location != null && isRedirect(status) && redirects < 10) {
                            URI next = uri.resolve(location);
                            redirects++;
                            conn.disconnect();
                            conn = null;
                            // 303 一律转 GET；301/302 的 POST 按浏览器惯例也转 GET；307/308 保留方法与 body
                            if (status == 303 || (status <= 302 && "POST".equals(curMethod))) {
                                curMethod = "GET";
                                body = null;
                            }
                            uri = next;
                            continue;
                        }
                        break;
                    }

                    InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    byte[] bytes = readAll(is);

                    JSObject ret = new JSObject();
                    ret.put("status", status);
                    ret.put("finalUrl", finalUrl != null ? finalUrl.toString() : surl);

                    JSArray harr = new JSArray();
                    for (Map.Entry<String, List<String>> e : respHeaders.entrySet()) {
                        if (e.getKey() == null) continue; // 状态行 key 为 null
                        for (String v : e.getValue()) {
                            JSObject h = new JSObject();
                            h.put("name", e.getKey());
                            h.put("value", v == null ? "" : v);
                            harr.put(h);
                        }
                    }
                    ret.put("headers", harr);
                    ret.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    ret.put("cookies", exportCookies());
                    call.resolve(ret);
                } catch (Exception ex) {
                    call.reject(ex.getClass().getSimpleName() + ": " + ex.getMessage());
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        });
    }

    private boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    /** 写入请求头；返回 JS 显式传入的 Cookie 头（与 store cookie 合并，JS 同名优先） */
    private String applyHeaders(HttpURLConnection conn, JSArray headerArr, URI uri) {
        Map<String, String> headers = new LinkedHashMap<>();
        String jsCookie = null;
        try {
            for (int i = 0; i < headerArr.length(); i++) {
                JSONObject o = headerArr.getJSONObject(i);
                String name = o.optString("name");
                String value = o.optString("value");
                if (name == null || name.isEmpty()) continue;
                headers.put(name, value);
                if ("cookie".equalsIgnoreCase(name)) jsCookie = value;
            }
        } catch (Exception ignored) { }

        for (Map.Entry<String, String> e : headers.entrySet()) {
            if ("cookie".equalsIgnoreCase(e.getKey())) continue; // Cookie 统一合并后设置
            conn.setRequestProperty(e.getKey(), e.getValue());
        }

        Map<String, String> merged = new LinkedHashMap<>();
        try {
            for (HttpCookie c : cookieStore.get(uri)) {
                merged.put(c.getName(), c.getValue());
            }
        } catch (Exception ignored) { }
        if (jsCookie != null) {
            for (String pair : jsCookie.split(";")) {
                int eq = pair.indexOf('=');
                if (eq > 0) merged.put(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim());
            }
        }
        if (!merged.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<String, String> e : merged.entrySet()) {
                if (sb.length() > 0) sb.append("; ");
                sb.append(e.getKey()).append('=').append(e.getValue());
            }
            conn.setRequestProperty("Cookie", sb.toString());
        }
        return jsCookie;
    }

    /** 从响应头解析并写入 CookieStore（重定向链每一跳都调用） */
    private void collectCookies(URI uri, Map<String, List<String>> headers) {
        for (Map.Entry<String, List<String>> e : headers.entrySet()) {
            if (e.getKey() == null || !"set-cookie".equalsIgnoreCase(e.getKey())) continue;
            for (String value : e.getValue()) {
                if (value == null) continue;
                try {
                    for (HttpCookie c : HttpCookie.parse(value)) {
                        cookieStore.add(uri, c);
                    }
                } catch (Exception ignored) { }
            }
        }
    }

    private JSArray exportCookies() {
        JSArray carr = new JSArray();
        try {
            for (URI u : cookieStore.getURIs()) {
                for (HttpCookie c : cookieStore.get(u)) {
                    JSObject o = new JSObject();
                    o.put("name", c.getName());
                    o.put("value", c.getValue() == null ? "" : c.getValue());
                    o.put("domain", c.getDomain() == null ? "" : c.getDomain());
                    o.put("path", c.getPath() == null ? "/" : c.getPath());
                    long maxAge = c.getMaxAge();
                    o.put("persistent", !c.getDiscard() && maxAge >= 0);
                    o.put("expiresAt", (c.getDiscard() || maxAge < 0) ? 0 : System.currentTimeMillis() + maxAge * 1000L);
                    carr.put(o);
                }
            }
        } catch (Exception ignored) { }
        return carr;
    }

    private static byte[] readAll(InputStream is) throws Exception {
        if (is == null) return new byte[0];
        ByteArrayOutputStream bos = new ByteArrayOutputStream(16 * 1024);
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        is.close();
        return bos.toByteArray();
    }
}
