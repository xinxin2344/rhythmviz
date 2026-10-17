/* ============ 迷你悬浮播放器：精简控件 + 状态同步 ============ */
const $ = (s) => document.querySelector(s);

/* 全局玻璃透明度（设置·外观·GLOBAL）：读 settings.glass 写入本窗口 --glass-a，胶囊背景 alpha 实时跟随 */
window.api.getSettings?.().then((s) => {
  const v = Math.max(10, Math.min(90, Math.round(+(s?.glass ?? 45) || 45)));
  document.documentElement.style.setProperty('--glass-a', (v / 100).toFixed(3));
}).catch(() => { /* 读取失败保持 :root 默认 */ });

$('#btnToggle').addEventListener('click', () => window.api.miniControl('toggle'));
$('#btnNext').addEventListener('click', () => window.api.miniControl('next'));
$('#btnPrev').addEventListener('click', () => window.api.miniControl('prev'));
$('#btnClose').addEventListener('click', () => window.api.closeMini());

window.api.onMiniSync?.((st) => {
  $('#title').textContent = st.title || '未播放';
  $('#artist').textContent = st.artist || '';
  $('#btnToggle').textContent = st.playing ? '⏸' : '▶';
  if (st.cover !== undefined) $('#cover').src = st.cover || '';
});
