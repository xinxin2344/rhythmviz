/* ============================================================
   自定义 NSIS 安装脚本 —— 三个可选插件组件
   ------------------------------------------------------------
   extraResources 预置（随 app 一并打进安装包）：
     sources/plugins/netease.js → resources/plug_src/netease.js
     sources/plugins/qq.js      → resources/plug_src/qq.js
     sources/qrologin.js        → resources/login_src/qrologin.mjs

   【关键·执行顺序】NSIS 按 Section 的定义顺序执行：
   本文件 customHeader 里定义的三个插件 Section 排在主程序段
   （installer.nsi 的 Section "install"）之前，此时 app 资源（含 *_src 预置副本）
   尚未解压 —— 原先写在 Section 内的 CopyFiles 必然「找不到源文件」而报
   「复制失败」（三个插件全中招）。故改为：Section 内只声明组件供组件页勾选，
   真正拷贝统一放到 customInstall（主程序段末尾、app 已解压后）按勾选结果执行。

   安装时勾选才复制到最终位置：
     登录插件   → resources/login/qrologin.mjs
     QQ音乐音源 → resources/plugins/qq.js
     网易云音源 → resources/plugins/netease.js
   customInstall 末尾统一清理 plug_src / login_src 临时目录。

   注意：登录模块打包后必须名为 qrologin.mjs —— resources/login 下没有 package.json，
   .js 会被 Node 按「最近 package.json」判为 CJS，import 语句直接报错。
   ============================================================ */

/* 目录页之后插入组件选择页（辅助安装器默认没有该页） */
!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_COMPONENTS
!macroend

/* 顶层展开：三个可选插件组件（默认全勾选）。
   此处只声明组件与悬停描述，不做任何拷贝（拷贝见 customInstall，那里 app 文件才已就位）。
   BUILD_UNINSTALLER 守卫：卸载器构建也会展开本宏，而卸载器没有组件页，
   描述函数会引用不存在的常量导致编译失败。 */
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Section "扫码登录插件（网易云 / QQ音乐）" SEC_PLUGIN_LOGIN
    SectionEnd

    Section "QQ音乐音源插件" SEC_PLUGIN_QQ
    SectionEnd

    Section "网易云音源插件" SEC_PLUGIN_NETEASE
    SectionEnd

    /* 组件页悬停描述 */
    !insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
      !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PLUGIN_LOGIN} "扫码登录网易云音乐 / QQ音乐账号，登录后可畅听 VIP 曲目。建议必装。"
      !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PLUGIN_QQ} "在线搜索、播放 QQ音乐曲库。建议必装。"
      !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PLUGIN_NETEASE} "在线搜索、播放网易云音乐曲库。建议必装。"
    !insertmacro MUI_FUNCTION_DESCRIPTION_END
  !endif
!macroend

/* .onInit 内运行：主程序段中文命名并锁定为必选。
   段序号推算：三个插件 Section 先定义（登录=0，QQ=1，网易云=2），
   主程序段紧随其后（=3），用 SEC_PLUGIN_NETEASE + 1 动态求序号。 */
!macro customInit
  IntOp $0 ${SEC_PLUGIN_NETEASE} + 1
  SectionSetText $0 "律动 RhythmViz 主程序（必需）"
  !insertmacro SetSectionFlag $0 ${SF_RO}
!macroend

/* 安装结束（主程序段末尾，app 资源与 *_src 预置副本均已解压）：
   按用户勾选把插件拷到最终位置 —— 勾选且源文件存在才拷，避免任何情况弹出「复制失败」。 */
!macro customInstall
  SectionGetFlags ${SEC_PLUGIN_LOGIN} $0
  IntOp $0 $0 & ${SF_SELECTED}
  ${If} $0 != 0
  ${AndIf} ${FileExists} "$INSTDIR\resources\login_src\qrologin.mjs"
    CreateDirectory "$INSTDIR\resources\login"
    CopyFiles /SILENT "$INSTDIR\resources\login_src\qrologin.mjs" "$INSTDIR\resources\login\"
  ${EndIf}

  SectionGetFlags ${SEC_PLUGIN_QQ} $0
  IntOp $0 $0 & ${SF_SELECTED}
  ${If} $0 != 0
  ${AndIf} ${FileExists} "$INSTDIR\resources\plug_src\qq.js"
    CreateDirectory "$INSTDIR\resources\plugins"
    CopyFiles /SILENT "$INSTDIR\resources\plug_src\qq.js" "$INSTDIR\resources\plugins\"
  ${EndIf}

  SectionGetFlags ${SEC_PLUGIN_NETEASE} $0
  IntOp $0 $0 & ${SF_SELECTED}
  ${If} $0 != 0
  ${AndIf} ${FileExists} "$INSTDIR\resources\plug_src\netease.js"
    CreateDirectory "$INSTDIR\resources\plugins"
    CopyFiles /SILENT "$INSTDIR\resources\plug_src\netease.js" "$INSTDIR\resources\plugins\"
  ${EndIf}

  /* 无论是否勾选，插件源临时目录一律清理 */
  RMDir /r "$INSTDIR\resources\plug_src"
  RMDir /r "$INSTDIR\resources\login_src"
!macroend
