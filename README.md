# 律动 RhythmViz

> 音乐有形，律动可见 —— 聚合搜索 · 双曲库同屏 · 沉浸式音频可视化播放器。

QQ 音乐与网易云音乐聚合搜索、官方扫码登录、歌单云同步，配合封面粒子、星河、黑胶、全屏动态歌词等实时视觉场景。
同一套 Web 核心代码（`src/` + `sources/`）同时驱动 **Electron Windows 桌面端**与 **Capacitor 安卓端**。

官网：https://rhythmviz.me

## 源码结构

| 路径 | 说明 |
| --- | --- |
| `main.js` / `preload.cjs` / `scenes.js` | Electron 主进程、预加载桥与视觉场景 |
| `src/` | 播放器 Web 核心（界面 `js/`、样式 `css/`、可视化场景） |
| `sources/` | 音源框架：`manager.js` 音源管理器、`qrologin.js` 扫码登录、`plugins/qq.js`、`plugins/netease.js` |
| `build/` | 应用图标与 NSIS 安装脚本 |
| `mobile/` | 安卓端（Capacitor 6）：`src/bridge.js` 移动垫片、`mobile.css` 竖屏适配、`android/` 原生工程（QQ 登录插件） |
| `website/` | 官网静态页（粒子动效单页） |

## 桌面端（Windows / Electron 33）

```bash
npm install
npm start        # 开发运行
npm run dist:win # 打包 NSIS 安装包（输出到 dist13/）
```

## 安卓端（Capacitor 6，minSdk 22 / Android 5.1+）

```bash
cd mobile
npm install
npm run sync                                   # esbuild 构建 Web 核心并 cap sync
cd android
# 首次构建需自建签名：生成 keystore 并在 mobile/android/keystore.properties 配置
./gradlew assembleRelease                      # 产物：app/build/outputs/apk/release/app-release.apk
```

`keystore.properties`（不入库）格式：

```properties
storeFile=../app/rhythmviz.keystore
storePassword=你的密码
keyAlias=rhythmviz
keyPassword=你的密码
```

## 免责声明

本软件仅用于个人学习、研究与技术交流。音乐内容来自第三方平台，相关权利归原权利人所有，软件不存储、不分发任何音频文件。详见官网「版权与免责声明」。

## License

[MIT](./LICENSE)
