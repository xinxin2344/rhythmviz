/* ============ 音源管理 UI：插件导入 / 状态监控 / 代理 / 版本更新 ============ */
import { toast } from './ui.js';

const $ = (s) => document.querySelector(s);

const rateTxt = (st) => {
  if (!st || !st.calls) return '暂无请求';
  const rate = Math.round((st.ok / Math.max(1, st.calls)) * 100);
  return `成功率 ${rate}% · 请求 ${st.calls}`;
};

export function setupSourceMgr(app) {
  const els = {
    tabSrcBtn: $('#tabSrcBtn'), srcList: $('#srcList'),
    btnSrcImport: $('#btnSrcImport'), btnSrcProxy: $('#btnSrcProxy'),
    srcProxyBox: $('#srcProxyBox'), srcProxyList: $('#srcProxyList'),
    btnSrcProxySave: $('#btnSrcProxySave'), btnSrcProxyOff: $('#btnSrcProxyOff'),
    warnModal: $('#srcWarnModal'), swAck: $('#swAck'), swConfirm: $('#swConfirm'), swCancel: $('#swCancel')
  };
  if (!els.srcList) return;

  /* ---------- 源列表 ---------- */
  const render = async () => {
    let list = [];
    try { list = await window.api.sourceList(); } catch { /* noop */ }
    els.srcList.innerHTML = '';

    // 默认音源选择器：首页热歌/推荐/搜索优先使用该音源
    const defBox = document.createElement('div');
    defBox.className = 'src-card src-def-card';
    const defHead = document.createElement('div');
    defHead.className = 'src-head';
    const defTitle = document.createElement('b');
    defTitle.textContent = '默认音源';
    defHead.appendChild(defTitle);
    const defRow = document.createElement('div');
    defRow.className = 'src-acts';
    const sel = document.createElement('select');
    sel.className = 'src-def-sel';
    for (const s of list) {
      if (!s.enabled) continue;
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      sel.appendChild(o);
    }
    try {
      const cfg = await window.api.sourceConfigGet();
      sel.value = cfg?.defaultSource || 'netease';
    } catch { sel.value = 'netease'; }
    sel.addEventListener('change', async () => {
      await window.api.sourceConfigSet({ defaultSource: sel.value });
      toast(`默认音源已切换：${sel.selectedOptions[0]?.textContent || sel.value}，首页推荐已刷新`);
      app.syncDefaultSrc?.();
      app.reloadFeed?.();
    });
    const defHint = document.createElement('span');
    defHint.className = 'src-hint';
    defHint.textContent = '首页热歌 / 推荐歌单 / 搜索优先使用该音源';
    defRow.append(sel, defHint);
    defBox.append(defHead, defRow);
    els.srcList.appendChild(defBox);

    for (const s of list) {
      const card = document.createElement('div');
      card.className = 'src-card' + (s.stats?.dead ? ' dead' : '') + (s.enabled ? '' : ' off');

      const head = document.createElement('div');
      head.className = 'src-head';
      const nm = document.createElement('b');
      nm.textContent = s.name;
      const ver = document.createElement('span');
      ver.className = 'src-ver';
      ver.textContent = 'v' + (s.version || '0.0.0');
      const tag = document.createElement('span');
      tag.className = 'src-type plugin';
      tag.textContent = '外部';
      head.append(nm, ver, tag);
      card.append(head);

      const stats = document.createElement('div');
      stats.className = 'src-stats';
      const stTxt = rateTxt(s.stats);
      const stateTxt = s.stats?.dead ? ' · 状态：失效' : s.enabled ? ' · 状态：正常' : ' · 状态：已停用';
      stats.textContent = stTxt + stateTxt;
      if (s.stats?.lastErr) stats.title = s.stats.lastErr;

      const acts = document.createElement('div');
      acts.className = 'src-acts';
      const tgl = document.createElement('button');
      tgl.className = 'pill-btn small' + (s.enabled ? '' : ' ghost');
      tgl.textContent = s.enabled ? '停用' : '启用';
      tgl.addEventListener('click', async () => {
        await window.api.sourceToggle(s.id, !s.enabled);
        toast(s.enabled ? `音源「${s.name}」已停用` : `音源「${s.name}」已启用`);
        render();
      });
      const upd = document.createElement('button');
      upd.className = 'pill-btn small ghost';
      upd.textContent = '检查更新';
      upd.addEventListener('click', async () => {
        upd.textContent = '检测中…';
        try {
          const r = await window.api.sourceUpdateCheck(s.id);
          if (r.hasUpdate) {
            toast(`「${s.name}」发现新版本 v${r.latest}（当前 v${r.local}）${r.notes ? '：' + r.notes : ''}。请替换本地音源 js 文件后重新导入。`, 5200);
            card.classList.add('has-update');
            ver.textContent = `v${r.local} → v${r.latest}`;
          } else {
            toast(r.msg || `「${s.name}」已是最新版本`);
          }
        } catch { toast('更新检测失败'); }
        upd.textContent = '检查更新';
      });
      const del = document.createElement('button');
      del.className = 'pill-btn small ghost danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        await window.api.sourceRemove(s.id);
        toast(`音源「${s.name}」已删除`);
        render();
      });
      acts.append(tgl, upd, del);
      card.append(stats, acts);
      els.srcList.appendChild(card);
    }
  };
  render();
  // 每 30s 刷新一次统计
  setInterval(render, 30000);

  /* ---------- 导入：醒目警告弹窗 → 确认后选择文件 ---------- */
  const openWarn = () => {
    els.swAck.checked = false;
    els.swConfirm.disabled = true;
    els.warnModal.classList.remove('hidden');
  };
  els.swAck.addEventListener('change', () => { els.swConfirm.disabled = !els.swAck.checked; });
  els.swCancel.addEventListener('click', () => els.warnModal.classList.add('hidden'));
  els.warnModal.addEventListener('click', (e) => { if (e.target === els.warnModal) els.warnModal.classList.add('hidden'); });
  els.swConfirm.addEventListener('click', async () => {
    els.warnModal.classList.add('hidden');
    const p = await window.api.pickSourceJs();
    if (!p) return;
    try {
      const r = await window.api.sourceImport(p);
      toast(`音源「${r.name}」v${r.version} 导入成功，已启用`);
      render();
    } catch (e) {
      toast('音源导入失败：' + e.message, 4200);
    }
  });
  els.btnSrcImport.addEventListener('click', openWarn);

  /* ---------- 代理设置 ---------- */
  els.btnSrcProxy.addEventListener('click', async () => {
    const cfg = await window.api.sourceProxyGet();
    els.srcProxyList.value = (cfg.list || []).join('\n');
    els.srcProxyBox.classList.toggle('hidden');
  });
  els.btnSrcProxySave.addEventListener('click', async () => {
    const list = els.srcProxyList.value.split('\n').map(s => s.trim()).filter(Boolean);
    await window.api.sourceProxySet(list, true);
    toast(list.length ? `已启用 ${list.length} 条代理（HTTP/SOCKS 轮换）` : '代理列表为空，已保持直连');
  });
  els.btnSrcProxyOff.addEventListener('click', async () => {
    await window.api.sourceProxySet(els.srcProxyList.value.split('\n').map(s => s.trim()).filter(Boolean), false);
    toast('已停用代理，恢复直连');
  });
}
