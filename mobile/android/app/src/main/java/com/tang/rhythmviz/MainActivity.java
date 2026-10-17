package com.tang.rhythmviz;

import android.os.Bundle;
import android.util.Log;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 单个插件异常绝不允许拖垮整个启动
        try { registerPlugin(RhythmNetPlugin.class); }
        catch (Throwable t) { Log.e("RhythmViz", "RhythmNet 插件注册失败", t); }
        try { registerPlugin(QqLoginPlugin.class); }
        catch (Throwable t) { Log.e("RhythmViz", "QqLogin 插件注册失败", t); }
        try { registerPlugin(MediaNotifPlugin.class); }
        catch (Throwable t) { Log.e("RhythmViz", "MediaNotif 插件注册失败", t); }
        super.onCreate(savedInstanceState);
        // 沉浸式：内容延伸到状态栏/导航栏之下（配合 Web 端 env(safe-area-inset-*) 让位）
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // 深色 UI → 状态栏/导航栏用浅色图标
        WindowInsetsControllerCompat ctl = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        ctl.setAppearanceLightStatusBars(false);
        ctl.setAppearanceLightNavigationBars(false);
    }
}
