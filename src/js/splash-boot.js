/* 银河启动页零闪烁（head 同步执行，必须在 splash DOM 解析前跑完）
   app.js 是 module 延迟执行：从 HTML 解析到 boot() 兜底之间，splash 会先按
   默认星尘样式渲染几百毫秒（用户所见「第一秒还是老启动页」）。
   此处在渲染前读镜像键，给 <html> 挂 rv-sp-galaxy —— app.css 据此预隐藏
   星尘/网格/雾 DOM；app.js boot 的 applySplashTheme 幂等接管（WebGL 银河启动，
   非 galaxy 时移除类恢复默认样式）。双键兜底：spTheme（applySplashTheme 镜像）
   + splashGalaxyOn（早期手机设置页开关只写此键） */
try {
  if (localStorage.getItem('spTheme') === 'mr-galaxy'
    || localStorage.getItem('splashGalaxyOn') === '1') {
    document.documentElement.classList.add('rv-sp-galaxy');
  }
} catch (e) { /* localStorage 不可用时静默：仅损失零闪烁优化，不影响功能 */ }
