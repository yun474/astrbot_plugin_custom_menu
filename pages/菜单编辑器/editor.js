// =============================================================
//  AstrBot WebUI 桥接层
//
//  本页面跑在 WebUI 的 iframe 里，所有请求都通过 AstrBot 注入的
//  window.AstrBotPluginPage 走，鉴权直接复用 WebUI 的登录态。
//  素材取回 base64 后转成 blob URL 缓存，重绘时不会反复过桥。
// =============================================================

const BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const assetCache = new Map();   // "kind/name" -> blob URL
const assetSize = new Map();    // "kind/name" -> { w, h }，背景图按比例算画布高度要用
const assetPending = new Set();
let assetRerenderTimer = null;

async function bridge() {
    if (!window.AstrBotPluginPage) {
        throw new Error('没有检测到 AstrBot 插件页桥接，请从 WebUI 的插件页面打开本编辑器');
    }
    await window.AstrBotPluginPage.ready();
    return window.AstrBotPluginPage;
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function b64ToBlobUrl(b64, mime) {
    return URL.createObjectURL(new Blob([b64ToBytes(b64)], { type: mime || 'application/octet-stream' }));
}

const errMsg = e => (e && e.message) || String(e);

// 用户输入的文字拼进 HTML 前先转义，名字里带 < " 之类的字符也不会把页面搞乱
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 数字输入框清空时删掉字段，让它回落到默认值。
// 存成 NaN 会被序列化成 null，出图那边就会丢背景甚至直接渲染失败
function setNumber(obj, key, raw, parse = parseInt) {
    const n = parse(raw);
    if (Number.isFinite(n)) obj[key] = n;
    else delete obj[key];
}

// =============================================================
//  提示与确认
//  AstrBot 的插件页 iframe 没开 allow-modals，alert / confirm 会被浏览器
//  直接吞掉（confirm 恒为 false），所以一律用页面内的组件实现。
// =============================================================

function toast(msg, type = 'ok', ms = 2800) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.getElementById('toastBox').appendChild(el);
    const close = () => { el.classList.add('hide'); setTimeout(() => el.remove(), 300); };
    if (ms > 0) setTimeout(close, ms);
    return close;
}

function confirmBox(text, okText = '确定') {
    const modal = document.getElementById('confirmModal');
    const ok = document.getElementById('confirmOk');
    const cancel = document.getElementById('confirmCancel');
    document.getElementById('confirmText').textContent = text;
    ok.textContent = okText;
    modal.style.display = 'flex';
    ok.focus();

    return new Promise(resolve => {
        const finish = (value) => {
            modal.style.display = 'none';
            window.removeEventListener('keydown', onKey, true);
            ok.onclick = cancel.onclick = modal.onclick = null;
            resolve(value);
        };
        // 捕获阶段拦下所有按键，弹窗开着时 Delete / 方向键不会再去动画布
        const onKey = (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
            else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        };
        ok.onclick = () => finish(true);
        cancel.onclick = () => finish(false);
        modal.onclick = (e) => { if (e.target === modal) finish(false); };
        window.addEventListener('keydown', onKey, true);
    });
}

// 素材到货后合并触发一次重绘，避免每张图都重排一遍
function scheduleAssetRerender() {
    if (assetRerenderTimer) return;
    assetRerenderTimer = setTimeout(() => {
        assetRerenderTimer = null;
        try { renderAll(); } catch (e) { console.error(e); }
    }, 80);
}

async function fetchAsset(kind, name, thumb) {
    const key = `${kind}/${name}${thumb ? '#t' : ''}`;
    if (assetCache.has(key)) return assetCache.get(key);
    if (assetPending.has(key)) return BLANK_PX;

    assetPending.add(key);
    try {
        const sdk = await bridge();
        const params = { kind, name };
        if (thumb) params.thumb = '1';
        const res = await sdk.apiGet('asset', params);
        const url = b64ToBlobUrl(res.b64, res.mime);
        assetCache.set(key, url);
        if (res.width && res.height) assetSize.set(`${kind}/${name}`, { w: res.width, h: res.height });
        // 弹窗里的缩略图不会跟着画布重绘，到货后直接把占位图换掉
        document.querySelectorAll('img[data-asset]').forEach(img => {
            if (img.dataset.asset === key) img.src = url;
        });
        scheduleAssetRerender();
        return url;
    } catch (e) {
        console.error('素材加载失败:', kind, name, e);
        assetCache.set(key, BLANK_PX);   // 记下来，别反复重试
        toast(`素材「${name}」加载失败：${errMsg(e)}`, 'error', 5000);
        return BLANK_PX;
    } finally {
        assetPending.delete(key);
    }
}

// 字体直接用字节构造 FontFace，不经过任何 URL。
// 只加载当前菜单实际用到的字体，而且不阻塞首屏：内置字体一个就二十来 MB，
// 以前要等所有字体都过完桥才开始画，远程部署时编辑器会白屏很久。
const fontState = new Map();   // 字体文件名 -> 'loading' | 'loaded' | 'failed'

async function loadFont(name) {
    if (!name || fontState.has(name)) return;
    fontState.set(name, 'loading');
    try {
        const sdk = await bridge();
        const res = await sdk.apiGet('asset', { kind: 'font', name });
        const face = new FontFace(cssFont(name), b64ToBytes(res.b64).buffer);
        document.fonts.add(await face.load());
        fontState.set(name, 'loaded');
    } catch (e) {
        console.error('字体加载失败:', name, e);
        fontState.set(name, 'failed');
    }
}

function menuFonts(m) {
    const names = [m.title_font, m.subtitle_font, m.group_title_font, m.group_sub_font, m.item_name_font, m.item_desc_font];
    (m.groups || []).forEach(g => {
        names.push(g.title_font, g.sub_font, g.text_font);
        (g.items || []).forEach(i => names.push(i.name_font, i.desc_font));
    });
    (m.custom_widgets || []).forEach(w => names.push(w.font));
    return names.filter(Boolean);
}

// 同步取素材地址：命中缓存直接给，没有就先占位并在后台去拉
function assetUrl(kind, name, thumb) {
    if (!name) return '';
    const key = `${kind}/${name}${thumb ? '#t' : ''}`;
    if (assetCache.has(key)) return assetCache.get(key);
    fetchAsset(kind, name, thumb);
    return BLANK_PX;
}

// 素材图片的 src 和 data-asset：先放占位图，素材到货后 fetchAsset 按 data-asset 自动换上
function assetImg(kind, name, thumb) {
    return `src="${assetUrl(kind, name, thumb)}" data-asset="${esc(`${kind}/${name}${thumb ? '#t' : ''}`)}"`;
}

function clearAssetCache() {
    assetCache.forEach(url => {
        if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
    });
    assetCache.clear();
}

const appState = {
    fullConfig: { menus: [] },
    currentMenuId: null,
    assets: { backgrounds: [], icons: [], widget_imgs: [], fonts: [], videos: [] },
    clipboard: null,
    commandsData: null
};

// 拖拽核心状态
let dragData = {
    active: false,
    isDragging: false,
    mode: 'move', // 'move' or 'resize'
    type: null,   // 'item' or 'widget'
    gIdx: -1, iIdx: -1, targetIdx: -1,
    startX: 0, startY: 0,
    initialVals: {},
    cachedEl: null
};

// 渲染锁
let rafLock = false;
let viewState = { scale: 1 };
let selectedWidgetIdx = -1;
let selectedItem = { gIdx: -1, iIdx: -1 };

// =============================================================
//  初始化与 API
// =============================================================

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await Promise.all([loadAssets(), loadConfig()]);
        if (appState.fullConfig.menus && appState.fullConfig.menus.length > 0) {
            switchMenu(appState.fullConfig.menus[0].id);
        } else {
            createNewMenu();
        }

        // 页面在 WebUI 的 iframe 里，挂载初期宽度可能还没确定，
        // 侧栏折叠、窗口缩放也会改变可用宽度，所以持续跟随重绘。
        const workspace = document.querySelector('.workspace');
        if (workspace && window.ResizeObserver) {
            let lastWidth = 0;
            new ResizeObserver(() => {
                const w = workspace.clientWidth;
                if (w > 0 && Math.abs(w - lastWidth) > 1) {
                    lastWidth = w;
                    try { renderAll(); } catch (e) { console.error(e); }
                }
            }).observe(workspace);
        }

        // 全局事件监听
        window.addEventListener('mouseup', handleGlobalMouseUp);
        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('keydown', handleKeyDown);

        // 点击画布空白处取消选中
        const cvsWrapper = document.getElementById('canvas-wrapper');
        cvsWrapper.addEventListener('mousedown', (e) => {
            const ids = ['canvas-wrapper', 'canvas', 'bg-preview-layer', 'canvas-img-preview', 'canvas-video-preview'];
            if (ids.includes(e.target.id) || e.target.classList.contains('group-wrapper')) {
                clearSelection();
            }
        });
    } catch (e) {
        console.error("Init failed:", e);
        toast('编辑器初始化失败：' + errMsg(e), 'error', 0);
    }
});

function getCurrentMenu() {
    return appState.fullConfig.menus.find(m => m.id === appState.currentMenuId) || appState.fullConfig.menus[0];
}

async function api(url, method = "GET", body = null) {
    const sdk = await bridge();
    const endpoint = String(url).replace(/^\/+/, '');
    return method === "GET" ? sdk.apiGet(endpoint) : sdk.apiPost(endpoint, body);
}

async function loadConfig() { appState.fullConfig = await api("/config"); }
async function loadAssets() { appState.assets = await api("/assets"); }

async function saveAll() {
    const btn = document.querySelector('button[onclick="saveAll()"]');
    const oldText = btn ? btn.innerText : "💾 保存";
    if (btn) { btn.innerText = "⏳ 保存中..."; btn.disabled = true; }

    try {
        await api("/config", "POST", appState.fullConfig);
        toast("✅ 配置已保存");
    } catch (e) {
        toast("❌ 保存失败：" + errMsg(e), 'error', 6000);
    } finally {
        if (btn) { btn.innerText = oldText; btn.disabled = false; }
    }
}

// 先渲染（出错能拿到具体原因），成功后再下载缓存好的成品
async function exportImage() {
    const menu = getCurrentMenu();
    const done = toast(menu.bg_type === 'video'
        ? "⏳ 正在生成动态菜单，可能要几十秒..."
        : "⏳ 正在导出菜单图片...", 'info', 0);
    try {
        await api("/config", "POST", appState.fullConfig);
        const sdk = await bridge();
        const { filename } = await sdk.apiPost('export/prepare', { id: menu.id });
        await sdk.download('export', { id: menu.id }, filename);
        toast("✅ 已导出：" + filename);
    } catch (e) {
        toast("❌ 导出失败：" + errMsg(e), 'error', 8000);
    } finally {
        done();
    }
}

function getStyle(obj, key, fallbackGlobalKey) {
    const m = getCurrentMenu();
    if (obj && obj[key] !== undefined && obj[key] !== "") return obj[key];
    return m[fallbackGlobalKey];
}

// AstrBot 的插件接口跑在一个沿用 Quart 默认 16MB 请求体上限的兼容层里，
// 字体、视频、素材包动辄超过这个数，所以统一切成 4MB 一片顺序上传，后端再拼回去
const UPLOAD_CHUNK = 4 * 1024 * 1024;

async function uploadInChunks(endpoint, file, onProgress) {
    const sdk = await bridge();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const total = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK));
    let res;
    for (let i = 0; i < total; i++) {
        const part = file.slice(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK);
        res = await sdk.upload(`${endpoint}/${id}/${i}/${total}`, new File([part], file.name, { type: file.type }));
        if (onProgress) onProgress(part.size);
    }
    return res;   // 最后一片的响应就是最终结果
}

async function uploadFile(type, inp) {
    const files = Array.from(inp.files || []);
    if (files.length === 0) return;

    const btn = inp.previousElementSibling;
    const originalText = btn ? btn.innerText : '';
    const totalBytes = files.reduce((n, f) => n + f.size, 0) || 1;
    let sentBytes = 0;
    const progress = (n) => {
        sentBytes += n;
        if (btn) btn.innerText = `⏳ ${Math.floor(sentBytes * 100 / totalBytes)}%`;
    };
    progress(0);

    const results = await Promise.all(files.map(async (f) => {
        try {
            const json = await uploadInChunks(`upload/${type}`, f, progress);
            return { ok: true, name: f.name, saved: json.filename };
        } catch (e) {
            console.error(`File ${f.name} upload failed:`, e);
            return { ok: false, name: f.name, error: errMsg(e) };
        }
    }));

    if (btn) btn.innerText = originalText;
    inp.value = "";

    // 单文件时自动设置到当前项
    const saved = results.filter(r => r.ok);
    if (files.length === 1 && saved.length === 1) {
        const m = getCurrentMenu();
        const filename = saved[0].saved;
        if (type === 'video') m.bg_video = filename;
        else if (type === 'background') m.background = filename;
        else if (type === 'icon' && selectedItem.gIdx !== -1) m.groups[selectedItem.gIdx].items[selectedItem.iIdx].icon = filename;
        else if (type === 'widget_img' && selectedWidgetIdx !== -1) m.custom_widgets[selectedWidgetIdx].content = filename;
    }

    await loadAssets();
    renderAll();
    if (selectedItem.gIdx !== -1) openContextEditor('item', selectedItem.gIdx, selectedItem.iIdx);

    const failed = results.filter(r => !r.ok);
    if (failed.length === 0) {
        toast(`✅ 已上传 ${saved.length} 个文件`);
    } else {
        toast(`上传完成：成功 ${saved.length} 个，失败 ${failed.length} 个\n` +
            failed.map(r => `${r.name}：${r.error}`).join('\n'), 'error', 8000);
    }
}

async function exportTemplatePack() {
    const menu = getCurrentMenu();
    if (!await confirmBox(`即将导出菜单模板「${menu.name}」及其用到的图片、字体等素材，打包成一个 .zip 文件。\n\n导出前会先保存当前配置。`, '导出')) return;

    const done = toast("⏳ 正在打包...", 'info', 0);
    try {
        await api("/config", "POST", appState.fullConfig);
        const sdk = await bridge();
        await sdk.download('pack/export', { id: menu.id }, `${menu.name}_pack.zip`);
        toast("✅ 模板包已导出");
    } catch (e) {
        toast("❌ 导出失败：" + errMsg(e), 'error', 8000);
    } finally {
        done();
    }
}

async function importTemplatePack(inp) {
    const file = inp.files[0];
    if (!file) return;
    const btn = inp.previousElementSibling;
    btn.innerText = "⏳";
    btn.disabled = true;

    try {
        const data = await uploadInChunks('pack/import', file);
        clearAssetCache();
        await Promise.all([loadAssets(), loadConfig()]);
        const menus = appState.fullConfig.menus;
        if (menus.length > 0) switchMenu(menus[menus.length - 1].id);
        toast(`✅ 已导入菜单「${data.name}」，素材已自动解压`);
    } catch (e) {
        toast("❌ 导入失败：" + errMsg(e), 'error', 8000);
    } finally {
        inp.value = "";
        btn.innerText = "📦";
        btn.disabled = false;
    }
}

function switchMenu(id) {
    appState.currentMenuId = id;
    clearSelection();
    renderMenuSelect();
    renderAll();
}

function createNewMenu() {
    const newMenu = {
        id: "m_" + Date.now(),
        name: "新菜单",
        enabled: true,
        trigger_keywords: "",
        title: "标题",
        sub_title: "Subtitle",
        groups: [],
        custom_widgets: [],
        title_size: 60,
        group_title_size: 30,
        group_sub_size: 18,
        item_name_size: 26,
        item_desc_size: 16,
        title_color: "#FFFFFF",
        subtitle_color: "#DDDDDD",
        group_title_color: "#FFFFFF",
        group_sub_color: "#AAAAAA",
        item_name_color: "#FFFFFF",
        item_desc_color: "#AAAAAA",
        layout_columns: 3,
        group_bg_color: "#000000",
        group_bg_alpha: 50,
        item_bg_color: "#FFFFFF",
        item_bg_alpha: 20,
        use_canvas_size: false,
        canvas_width: 1000,
        canvas_height: 2000,
        export_scale: 1.0,
        bg_type: "image",
        bg_fit_mode: "cover",
        bg_align_x: "center",
        bg_align_y: "center",
        video_scale: 1.0,
        video_fps: 12,
        video_export_format: "webp"
    };

    if (!appState.fullConfig.menus) appState.fullConfig.menus = [];
    appState.fullConfig.menus.push(newMenu);
    switchMenu(newMenu.id);
}

function duplicateMenu() {
    const current = getCurrentMenu();
    if (!current) return;
    const newMenu = JSON.parse(JSON.stringify(current));
    newMenu.id = "m_" + Date.now();
    newMenu.name = newMenu.name + " (副本)";
    // 副本和原菜单的触发条件一模一样，都启用的话一次会发两张图
    newMenu.enabled = false;
    appState.fullConfig.menus.push(newMenu);
    switchMenu(newMenu.id);
    toast(`已复制为「${newMenu.name}」。副本默认停用，免得和原菜单一起响应；改好后点「已停用」启用，再保存`, 'ok', 6000);
}

async function deleteMenu() {
    const menus = appState.fullConfig.menus;
    if (menus.length <= 1) return toast("至少要保留一个菜单模板", 'warn');
    const menu = getCurrentMenu();
    if (!await confirmBox(`确定删除菜单模板「${menu.name}」？\n\n删除后会立即保存（连同其它未保存的修改），无法撤销。`, '删除')) return;

    appState.fullConfig.menus = menus.filter(m => m.id !== menu.id);
    try {
        await api("/config", "POST", appState.fullConfig);
        switchMenu(appState.fullConfig.menus[0].id);
        toast(`✅ 已删除「${menu.name}」`);
    } catch (e) {
        appState.fullConfig.menus = menus;
        toast("❌ 删除失败：" + errMsg(e), 'error', 6000);
    }
}

function toggleEnable() {
    const m = getCurrentMenu();
    m.enabled = !m.enabled;
    renderMenuSelect();
}

function renderMenuSelect() {
    document.getElementById("menuSelect").innerHTML = appState.fullConfig.menus.map(m =>
        `<option value="${esc(m.id)}" ${m.id === appState.currentMenuId ? 'selected' : ''}>${m.enabled ? '' : '[停] '}${esc(m.name)}</option>`
    ).join('');
    document.getElementById("menuNameInput").value = getCurrentMenu().name;
    const btn = document.getElementById("enableBtn");
    btn.innerText = getCurrentMenu().enabled ? "已启用" : "已停用";
    btn.style.color = getCurrentMenu().enabled ? "#4caf50" : "#f56c6c";
}

function renderAll() {
    const m = getCurrentMenu();
    if (!m.video_scale) m.video_scale = 1.0;
    if (!m.bg_fit_mode) m.bg_fit_mode = "cover";
    if (!m.title_size) m.title_size = 60;

    updateFormInputs(m);
    renderSidebarGroupList(m);
    renderCanvas(m);
    updateWidgetEditor(m);
}

// 正在输入的框不回写：否则敲 "1." 会被立刻改回 "1"，小数根本输不进去
function setValue(id, val) {
    const el = document.getElementById(id);
    if (el && el !== document.activeElement) el.value = val;
}

function renderSelect(id, opts, sel, def) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = (def ? `<option value="">${def}</option>` : '') + (opts || []).map(o =>
        `<option value="${esc(o)}" ${o === sel ? 'selected' : ''}>${esc(o)}</option>`
    ).join('');
}

function updateFormInputs(m) {
    setValue("menuNameInput", m.name);
    setValue("triggerKeywordsInput", m.trigger_keywords || "");

    setValue("columnInput", m.layout_columns || 3);
    setValue("rowHeightInput", m.item_height || '');
    setValue("cvsW", m.canvas_width || 1000);
    setValue("cvsH", m.canvas_height || 2000);
    if (document.getElementById("canvasMode")) document.getElementById("canvasMode").value = m.use_canvas_size ? "true" : "false";

    setValue("expScaleInput", m.export_scale || 1.0);
    setValue("cvsColorP", m.canvas_color || "#1e1e1e");
    setValue("cvsColorT", m.canvas_color || "#1e1e1e");

    setValue("bgType", m.bg_type || "image");
    setValue("bgFit", m.bg_fit_mode || "cover");
    setValue("bgAlignX", m.bg_align_x || "center");
    setValue("bgAlignY", m.bg_align_y || "center");

    const bgScale = m.video_scale !== undefined ? m.video_scale : 1.0;
    setValue("bgScaleRange", bgScale);
    setValue("bgScaleInput", bgScale);
    const scaleValSpan = document.getElementById("bgScaleVal");
    if(scaleValSpan) scaleValSpan.innerText = bgScale;

    setValue("bgCustomW", m.bg_custom_width || "");
    setValue("bgCustomH", m.bg_custom_height || "");
    setValue("groupCustomW", m.group_custom_width || "");
    setValue("groupCustomH", m.group_custom_height || "");
    setValue("itemCustomW", m.item_custom_width || "");
    setValue("itemCustomH", m.item_custom_height || "");
    toggleBgCustomInputs();

    // 使用带预览的背景图片选择器
    renderImageSelect("bgSelectPreview", "background", m.background, (v) => { updateBg(v); });
    renderSelect("vidSelect", appState.assets.videos, m.bg_video, "无视频");
    renderRandomBgList();  // 渲染随机背景列表

    setValue("vStart", m.video_start || 0);
    setValue("vEnd", m.video_end || "");
    setValue("vFps", m.video_fps || 12);
    setValue("vFormat", m.video_export_format || "webp");

    toggleBgPanel();

    setValue("cTextBgP", m.group_sub_bg_color || "#333333");
    setValue("cTextBgT", m.group_sub_bg_color || "#333333");
    setValue("textBgAlpha", m.group_sub_bg_alpha !== undefined ? m.group_sub_bg_alpha : 200);
    setValue("textBgBlur", m.group_sub_bg_blur !== undefined ? m.group_sub_bg_blur : "");

    setValue("boxColor", m.group_bg_color || "#000000");
    setValue("boxBlur", m.group_blur_radius || 0);
    setValue("boxAlpha", m.group_bg_alpha !== undefined ? m.group_bg_alpha : 50);
    if(document.getElementById("alphaVal")) document.getElementById("alphaVal").innerText = m.group_bg_alpha !== undefined ? m.group_bg_alpha : 50;

    setValue("iboxColor", m.item_bg_color || "#FFFFFF");
    setValue("iboxBlur", m.item_blur_radius || 0);
    setValue("iboxAlpha", m.item_bg_alpha !== undefined ? m.item_bg_alpha : 20);
    if(document.getElementById("ialphaVal")) document.getElementById("ialphaVal").innerText = m.item_bg_alpha !== undefined ? m.item_bg_alpha : 20;

    renderSelect("fTitle", appState.assets.fonts, m.title_font);
    renderSelect("fSubtitle", appState.assets.fonts, m.subtitle_font);
    renderSelect("fGTitle", appState.assets.fonts, m.group_title_font);
    renderSelect("fGSub", appState.assets.fonts, m.group_sub_font);
    setValue("fGSubAlign", m.group_sub_align || "bottom");
    renderSelect("fIName", appState.assets.fonts, m.item_name_font);
    renderSelect("fIDesc", appState.assets.fonts, m.item_desc_font);

    document.getElementById("shadowEn").checked = !!m.shadow_enabled;
    setValue("shadowColP", m.shadow_color || "#000000");
    setValue("shadowColT", m.shadow_color || "#000000");
    setValue("shadowX", m.shadow_offset_x !== undefined ? m.shadow_offset_x : 2);
    setValue("shadowY", m.shadow_offset_y !== undefined ? m.shadow_offset_y : 2);
    setValue("shadowR", m.shadow_radius !== undefined ? m.shadow_radius : 2);

    const colorMap = {
        'title_color': ['cTitleP', 'cTitleT'],
        'subtitle_color': ['cSubP', 'cSubT'],
        'group_title_color': ['cGTitleP', 'cGTitleT'],
        'group_sub_color': ['cGSubP', 'cGSubT'],
        'item_name_color': ['cItemNameP', 'cItemNameT'],
        'item_desc_color': ['cItemDescP', 'cItemDescT']
    };
    for (const [k, ids] of Object.entries(colorMap)) {
        const val = m[k] || "#FFFFFF";
        ids.forEach(id => {
            if (document.getElementById(id)) document.getElementById(id).value = val;
        });
    }
}

const MENU_INT_KEYS = ['layout_columns', 'item_height', 'canvas_width', 'canvas_height', 'group_blur_radius', 'item_blur_radius', 'group_bg_alpha', 'item_bg_alpha', 'shadow_offset_x', 'shadow_offset_y', 'shadow_radius', 'bg_custom_width', 'bg_custom_height', 'group_custom_width', 'group_custom_height', 'item_custom_width', 'item_custom_height', 'video_fps', 'group_sub_bg_alpha', 'group_sub_bg_blur'];
const MENU_FLOAT_KEYS = ['export_scale', 'video_start', 'video_end', 'video_scale'];

function updateMenuMeta(key, val) {
    const m = getCurrentMenu();
    if (MENU_INT_KEYS.includes(key)) {
        setNumber(m, key, val);
    } else if (MENU_FLOAT_KEYS.includes(key)) {
        setNumber(m, key, val, parseFloat);
    } else if (key === 'use_canvas_size' || key === 'shadow_enabled') {
        m[key] = val === 'true' || val === true;
    } else {
        m[key] = val;
    }
    renderAll();
}

function updateUnifiedBgParams(type, val) {
    const m = getCurrentMenu();
    if (type === 'align_x') {
        m.bg_align_x = val;
        m.video_align_x = val;
    } else if (type === 'align_y') {
        m.bg_align_y = val;
        m.video_align = val;
        m.video_align_y = val;
    } else if (type === 'scale') {
        setNumber(m, 'video_scale', val, parseFloat);
        const scale = m.video_scale ?? 1.0;
        setValue("bgScaleRange", scale);
        setValue("bgScaleInput", scale);
        const span = document.getElementById("bgScaleVal");
        if (span) span.innerText = scale;
    }
    renderCanvas(m);
}

function updateBg(val) { updateMenuMeta('background', val); }
function updateColor(key, val, src) { if (src === 'text' && !val.startsWith('#')) val = '#' + val; updateMenuMeta(key, val); }

function toggleBgCustomInputs() {
    const fitMode = document.getElementById('bgFit').value;
    const customInputs = document.getElementById('bg-custom-size-inputs');
    if (customInputs) {
        customInputs.style.display = (fitMode === 'custom') ? 'block' : 'none';
    }
}

function toggleBgPanel() {
    const type = document.getElementById("bgType").value;
    const imgPanel = document.getElementById("panel-bg-image");
    const vidPanel = document.getElementById("panel-bg-video");
    if (type === 'video') {
        imgPanel.style.display = "none";
        vidPanel.style.display = "block";
    } else {
        imgPanel.style.display = "block";
        vidPanel.style.display = "none";
    }
}

// =============================================================
//  网格排布：支持半高功能项
//  规则与后端 renderer/menu.py 的 grid_slots 完全一致，改一边必须同步改另一边，
//  否则编辑器画布和实际出图会对不上。
// =============================================================

const GRID_GAP = 15;
const DEFAULT_ROW_H = 90;
// 前端拿不到字体真实度量，按内置字体实测（行高约为字号的 1.35 倍）估算
const LINE_H_RATIO = 1.36;

// 按顺序逐格排布；连续两个半高项叠进同一格（一上一下），
// 半高项后面紧跟整高项时，这一格的下半留空
function gridSlots(items, columns) {
    const cols = Math.max(1, parseInt(columns) || 1);
    const slots = [];
    let row = 0, col = 0, topTaken = false;
    const advance = () => {
        topTaken = false;
        if (++col >= cols) { col = 0; row++; }
    };
    (items || []).forEach(item => {
        if (item && item.half) {
            if (topTaken) { slots.push({ row, col, part: 'bottom' }); advance(); }
            else { slots.push({ row, col, part: 'top' }); topTaken = true; }
        } else {
            if (topTaken) advance();
            slots.push({ row, col, part: 'full' });
            advance();
        }
    });
    // 下一个空位：当前格上半被占了就是它的下半，否则是一个整格
    return { slots, next: { row, col, part: topTaken ? 'bottom' : 'full' } };
}

// 每个网格行拆成两条半高轨道：整高项跨两条，半高项占一条
function gridPlacementCSS(slot) {
    const start = slot.row * 2 + (slot.part === 'bottom' ? 2 : 1);
    const span = slot.part === 'full' ? 2 : 1;
    return `grid-column:${slot.col + 1};grid-row:${start} / span ${span};`;
}

// 与后端 clamp_lines 同一思路：估算格子能放几行，描述放不下就整段不显示
function itemTextFit(boxH, nameSz, descSz, hasDesc) {
    const spacing = 4, gap = 5;
    const nameLineH = nameSz * LINE_H_RATIO;
    const descLineH = descSz * LINE_H_RATIO;
    const nameLines = Math.max(1, Math.floor((boxH + spacing) / (nameLineH + spacing)));
    let descLines = 0;
    if (hasDesc) {
        const avail = boxH - nameLineH - gap;
        descLines = avail > 0 ? Math.floor((avail + spacing) / (descLineH + spacing)) : 0;
    }
    return { nameLines, descLines };
}

function lineClampCSS(lines) {
    return `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${lines};overflow:hidden;`;
}

// 用出图时同一套 Pillow 渲染出真实效果 —— 画布毕竟是 CSS 近似
async function previewReal() {
    const modal = document.getElementById('realPreviewModal');
    const img = document.getElementById('realPreviewImg');
    const status = document.getElementById('realPreviewStatus');
    const menu = getCurrentMenu();
    img.removeAttribute('src');
    status.innerText = '⏳ 正在渲染...';
    modal.style.display = 'flex';
    try {
        const sdk = await bridge();
        const res = await sdk.apiPost('preview', menu);
        if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
        img.dataset.url = b64ToBlobUrl(res.b64, res.mime);
        img.src = img.dataset.url;
        status.innerText = menu.bg_type === 'video' ? '动态背景菜单这里只预览静态排版' : '';
    } catch (e) {
        status.innerText = '❌ 渲染失败：' + (e && e.message ? e.message : e);
    }
}

function closeRealPreview() {
    document.getElementById('realPreviewModal').style.display = 'none';
}

// 出图时配了随机背景就只从随机列表里挑，单张背景不生效；画布上预览随机列表的第一张
function previewBackground(m) {
    const pool = (m.backgrounds || []).filter(Boolean);
    return pool.length ? pool[0] : (m.background || '');
}

function renderCanvas(m) {
    const cvsWrapper = document.getElementById("canvas-wrapper");
    const cvs = document.getElementById("canvas");
    const bgPreviewLayer = document.getElementById("bg-preview-layer");
    const vidPreview = document.getElementById("canvas-video-preview");
    const imgPreview = document.getElementById("canvas-img-preview");

    const useFixedSize = String(m.use_canvas_size) === 'true';
    const targetW = parseInt(m.canvas_width) || 1000;
    const targetH = parseInt(m.canvas_height) || 2000;

    // iframe 里挂载初期 clientWidth 可能还是 0，这时别算出 scale(0) 把画布缩没了
    const editorWidth = cvsWrapper.parentElement.clientWidth - 120;
    let scale = 1;
    if (editorWidth > 0 && editorWidth < targetW) scale = editorWidth / targetW;
    viewState.scale = scale;

    const bgType = m.bg_type || 'image';
    const bgName = bgType === 'image' ? previewBackground(m) : '';
    const hasVideo = bgType === 'video' && !!m.bg_video;
    const hasImage = !!bgName;

    cvs.style.width = targetW + "px";
    cvs.style.transform = `scale(${scale})`;
    cvs.style.transformOrigin = "top left";
    cvsWrapper.style.width = (targetW * scale) + "px";

    if (useFixedSize) {
        cvs.style.height = targetH + "px";
        cvs.style.minHeight = targetH + "px";
        cvsWrapper.style.height = (targetH * scale) + "px";
    } else {
        // 和出图规则一致：自动高度时，画布至少拉长到按宽度等比铺开的背景图那么高
        const size = hasImage && assetSize.get('background/' + bgName);
        cvs.style.height = "auto";
        cvs.style.minHeight = size ? Math.round(targetW * size.h / size.w) + "px" : "0";
        cvsWrapper.style.height = "auto";
    }

    const bgFit = m.bg_fit_mode || 'cover';
    const alignX = m.bg_align_x || 'center';
    const alignY = m.bg_align_y || 'center';
    const userBgColor = m.canvas_color || '#1e1e1e';
    const transformCSS = `scale(${m.video_scale ?? 1.0})`;
    // 背景层在缩放后的包裹层里，自定义尺寸这类像素值要跟着画布一起缩
    const customW = (m.bg_custom_width || 1000) * scale;
    const customH = (m.bg_custom_height || 1000) * scale;

    cvs.style.backgroundImage = 'none';
    cvs.style.backgroundColor = (hasVideo || hasImage) ? 'transparent' : userBgColor;

    bgPreviewLayer.style.display = (hasVideo || hasImage) ? 'flex' : 'none';
    bgPreviewLayer.style.flexDirection = 'column';
    bgPreviewLayer.style.overflow = 'hidden';
    bgPreviewLayer.style.backgroundColor = userBgColor;

    const flexMapY = { 'top': 'flex-start', 'center': 'center', 'bottom': 'flex-end' };
    const flexMapX = { 'left': 'flex-start', 'center': 'center', 'right': 'flex-end' };
    bgPreviewLayer.style.justifyContent = flexMapY[alignY] || 'center';
    bgPreviewLayer.style.alignItems = flexMapX[alignX] || 'center';

    if (hasVideo) {
        vidPreview.style.display = 'block';
        imgPreview.style.display = 'none';

        // 只在换了视频时才换 src，否则每次重绘都会让视频从头播放
        const url = assetUrl('video', m.bg_video);
        if (url !== BLANK_PX && vidPreview.dataset.src !== url) {
            vidPreview.src = url;
            vidPreview.dataset.src = url;
        }
        if (vidPreview.paused && vidPreview.dataset.src) vidPreview.play().catch(() => {});

        vidPreview.style.transform = transformCSS;
        vidPreview.style.transformOrigin = 'center center';

        if (bgFit === 'cover' || bgFit === 'contain') {
            vidPreview.style.width = '100%';
            vidPreview.style.height = '100%';
            vidPreview.style.objectFit = bgFit;
            vidPreview.style.objectPosition = `${alignX} ${alignY}`;
        } else {
            vidPreview.style.objectFit = 'fill';

            if (bgFit === 'cover_w') {
                vidPreview.style.width = '100%';
                vidPreview.style.height = 'auto';
            } else if (bgFit === 'cover_h') {
                vidPreview.style.width = 'auto';
                vidPreview.style.height = '100%';
            } else if (bgFit === 'custom') {
                vidPreview.style.width = customW + 'px';
                vidPreview.style.height = customH + 'px';
            }
        }
    } else {
        vidPreview.style.display = 'none';
        if (!vidPreview.paused) vidPreview.pause();
    }

    if (hasImage) {
        imgPreview.style.display = 'block';
        imgPreview.style.backgroundImage = `url('${assetUrl('background', bgName)}')`;
        imgPreview.style.backgroundRepeat = 'no-repeat';

        imgPreview.style.backgroundPosition = `${alignX} ${alignY}`;
        imgPreview.style.transform = transformCSS;
        imgPreview.style.transformOrigin = `${alignX} ${alignY}`;
        imgPreview.style.width = '100%';
        imgPreview.style.height = '100%';

        if (bgFit === 'cover') imgPreview.style.backgroundSize = 'cover';
        else if (bgFit === 'contain') imgPreview.style.backgroundSize = 'contain';
        else if (bgFit === 'cover_w') imgPreview.style.backgroundSize = '100% auto';
        else if (bgFit === 'cover_h') imgPreview.style.backgroundSize = 'auto 100%';
        else if (bgFit === 'custom') imgPreview.style.backgroundSize = `${customW}px ${customH}px`;
    } else {
        imgPreview.style.display = 'none';
    }

    // 缺省值与出图一致，免得拼出 "undefinedpx" 这种无效的 CSS
    let shadowCss = 'none';
    if (m.shadow_enabled) {
        shadowCss = `${m.shadow_offset_x ?? 2}px ${m.shadow_offset_y ?? 2}px ${m.shadow_radius ?? 2}px ${m.shadow_color || '#000000'}`;
    }

    // 主标题阴影
    let titleShadowCss = 'none';
    if (m.title_shadow_enabled) {
        const tShadowColor = m.title_shadow_color || '#000000';
        const tShadowX = m.title_shadow_offset_x !== undefined ? m.title_shadow_offset_x : 2;
        const tShadowY = m.title_shadow_offset_y !== undefined ? m.title_shadow_offset_y : 2;
        const tShadowR = m.title_shadow_radius !== undefined ? m.title_shadow_radius : 0;
        titleShadowCss = `${tShadowX}px ${tShadowY}px ${tShadowR}px ${tShadowColor}`;
    }

    // 副标题阴影
    let subShadowCss = 'none';
    if (m.subtitle_shadow_enabled) {
        const sShadowColor = m.subtitle_shadow_color || '#000000';
        const sShadowX = m.subtitle_shadow_offset_x !== undefined ? m.subtitle_shadow_offset_x : 2;
        const sShadowY = m.subtitle_shadow_offset_y !== undefined ? m.subtitle_shadow_offset_y : 2;
        const sShadowR = m.subtitle_shadow_radius !== undefined ? m.subtitle_shadow_radius : 0;
        subShadowCss = `${sShadowX}px ${sShadowY}px ${sShadowR}px ${sShadowColor}`;
    }

    const gfTitle = cssFont(m.title_font);
    const gfSubtitle = cssFont(m.subtitle_font || m.title_font);
    const titleAlign = m.title_align || 'center';
    const titleSz = m.title_size || 60;
    const subSz = m.subtitle_size !== undefined ? m.subtitle_size : (titleSz * 0.5);

    let html = `
        <div class="header-area title-clickable" style="text-align:${titleAlign};"
             onclick="openContextEditor('title')">
            <div style="color:${m.title_color}; font-family:'${gfTitle}', sans-serif; font-size:${titleSz}px; text-shadow:${titleShadowCss}; ${getTextStyleCSS(m, 'title')}">${esc(m.title)}</div>
            <div style="color:${m.subtitle_color}; font-family:'${gfSubtitle}', sans-serif; font-size:${subSz}px; text-shadow:${subShadowCss}; ${getTextStyleCSS(m, 'subtitle')}">${esc(m.sub_title)}</div>
        </div>
    `;

    (m.groups || []).forEach((g, gIdx) => {
        const gRgba = hexToRgba(getStyle(g, 'bg_color', 'group_bg_color'), (g.bg_alpha !== undefined ? g.bg_alpha : m.group_bg_alpha) / 255);
        
        // 分组自定义模糊或使用全局模糊
        const gGroupBlur = g.blur_radius !== undefined ? g.blur_radius : m.group_blur_radius;
        const gBlur = gGroupBlur > 0 ? `backdrop-filter: blur(${gGroupBlur}px);` : '';
        const freeMode = g.free_mode === true;
        const isTextGroup = g.group_type === 'text';

        let contentHeight = "auto";
        let groupWidth = "auto";
        let groupHeight = "auto";
        
        // 处理分组自定义大小
        if (g.custom_width !== undefined) groupWidth = g.custom_width + "px";
        if (g.custom_height !== undefined) groupHeight = g.custom_height + "px";
        
        if (freeMode && !isTextGroup) {
            let maxBottom = 0;
            (g.items || []).forEach(item => { const b = (parseInt(item.y) || 0) + (parseInt(item.h) || 100); if (b > maxBottom) maxBottom = b; });
            contentHeight = Math.max(Number(g.min_height) || 100, maxBottom + 20) + "px";
        }

        const gridCols = parseInt(g.layout_columns || m.layout_columns) || 3;
        const rowH = parseInt(g.item_height || m.item_height) || DEFAULT_ROW_H;
        const halfTrack = Math.max(1, (rowH - GRID_GAP) / 2);
        const gridLayout = gridSlots(g.items, gridCols);
        const gridStyle = (freeMode && !isTextGroup) ? '' : `display:grid; gap:${GRID_GAP}px; padding:20px; grid-template-columns: repeat(${gridCols}, 1fr); grid-auto-rows:${halfTrack}px;`;

        const gTitleSz = getStyle(g, 'title_size', 'group_title_size') || 30;
        const gTitleFont = cssFont(getStyle(g, 'title_font', 'group_title_font'));
        const gSubSz = getStyle(g, 'sub_size', 'group_sub_size') || 18;
        const gSubFont = cssFont(getStyle(g, 'sub_font', 'group_sub_font'));
        const gSubColor = getStyle(g, 'sub_color', 'group_sub_color');

        const subAlign = getStyle(g, 'sub_align', 'group_sub_align') || 'bottom';
        let alignItems = 'flex-end';
        if (subAlign === 'center') alignItems = 'center';
        if (subAlign === 'top') alignItems = 'flex-start';
        
        // 计算分组标题的阴影
        let gTitleShadowCss = shadowCss;
        if (g.group_title_shadow_enabled) {
            const gTitleShadowColor = g.group_title_shadow_color || '#000000';
            const gTitleShadowX = g.group_title_shadow_offset_x !== undefined ? g.group_title_shadow_offset_x : 2;
            const gTitleShadowY = g.group_title_shadow_offset_y !== undefined ? g.group_title_shadow_offset_y : 2;
            const gTitleShadowR = g.group_title_shadow_radius !== undefined ? g.group_title_shadow_radius : 0;
            gTitleShadowCss = `${gTitleShadowX}px ${gTitleShadowY}px ${gTitleShadowR}px ${gTitleShadowColor}`;
        }
        
        // 计算副标题阴影
        let gSubShadowCss = shadowCss;
        if (g.group_sub_shadow_enabled) {
            const gSubShadowColor = g.group_sub_shadow_color || '#000000';
            const gSubShadowX = g.group_sub_shadow_offset_x !== undefined ? g.group_sub_shadow_offset_x : 2;
            const gSubShadowY = g.group_sub_shadow_offset_y !== undefined ? g.group_sub_shadow_offset_y : 2;
            const gSubShadowR = g.group_sub_shadow_radius !== undefined ? g.group_sub_shadow_radius : 0;
            gSubShadowCss = `${gSubShadowX}px ${gSubShadowY}px ${gSubShadowR}px ${gSubShadowColor}`;
        }

        html += `
        <div class="group-wrapper">
            <div class="group-header-wrap" onclick="openContextEditor('group', ${gIdx}, -1)"
                 style="padding:0 0 10px 10px; cursor:pointer; text-shadow:${gTitleShadowCss}; display:flex; gap:15px; align-items:${alignItems};">
                <span style="color:${getStyle(g, 'title_color', 'group_title_color')}; font-family:'${gTitleFont}', sans-serif; font-size:${gTitleSz}px; line-height:1; ${getTextStyleCSS(g, 'group_title')}">${esc(g.title)}</span>
                ${(g.subtitle && !isTextGroup) ? `<span style="color:${gSubColor}; font-family:'${gSubFont}', sans-serif; font-size:${gSubSz}px; line-height:1; text-shadow:${gSubShadowCss}; ${getTextStyleCSS(g, 'group_sub')}">${esc(g.subtitle)}</span>` : ''}
            </div>`;
        
        // 纯文本分组
        if (isTextGroup) {
            const textContent = g.text_content || g.subtitle || '';
            const textSize = g.text_size || m.group_sub_size || 30;
            const textFont = cssFont(g.text_font || m.group_sub_font);
            const textColor = getStyle(g, 'text_color', 'group_sub_color');
            const textStyleCSS = getTextStyleCSS(g, 'text');
            const bgColor = g.text_bg_color || m.group_sub_bg_color || '#333333';
            const bgAlpha = (g.text_bg_alpha !== undefined ? g.text_bg_alpha : (m.group_sub_bg_alpha || 200)) / 255;
            const bgBlur = g.text_bg_blur !== undefined ? g.text_bg_blur : (m.group_sub_bg_blur || 5);
            const bgRgba = hexToRgba(bgColor, bgAlpha);
            const bgBlurCSS = bgBlur > 0 ? `backdrop-filter: blur(${bgBlur}px);` : '';
            
            // 纯文本阴影
            let iTextShadowCss = 'none';
            if (g.text_shadow_enabled) {
                const tShadowColor = g.text_shadow_color || '#000000';
                const tShadowX = g.text_shadow_offset_x !== undefined ? g.text_shadow_offset_x : 2;
                const tShadowY = g.text_shadow_offset_y !== undefined ? g.text_shadow_offset_y : 2;
                const tShadowR = g.text_shadow_radius !== undefined ? g.text_shadow_radius : 0;
                iTextShadowCss = `${tShadowX}px ${tShadowY}px ${tShadowR}px ${tShadowColor}`;
            }
            
            html += `<div class="group-content-box" style="background-color:${bgRgba}; ${bgBlurCSS}; width:${groupWidth}; min-height:${groupHeight !== 'auto' ? groupHeight : 'auto'}; padding:20px; position:relative; border-radius:15px; word-wrap:break-word; white-space:pre-wrap; overflow-wrap:break-word;">
                <div style="color:${textColor}; font-family:'${textFont}', sans-serif; font-size:${textSize}px; line-height:1.6; text-shadow:${iTextShadowCss}; ${textStyleCSS}">${esc(textContent)}</div>
            </div>`;
        } else {
            // 功能项分组
            html += `<div class="group-content-box" style="background-color:${gRgba}; ${gBlur}; height:${contentHeight}; width:${groupWidth}; min-height:${groupHeight !== 'auto' ? groupHeight : 'auto'}; position:relative; ${freeMode ? 'overflow:visible' : gridStyle} border-radius:15px;">`;

            (g.items || []).forEach((item, iIdx) => {
                // 功能项自定义模糊或使用全局模糊
                const iItemBlur = item.blur_radius !== undefined ? item.blur_radius : m.item_blur_radius;
                const iBlur = iItemBlur > 0 ? `backdrop-filter: blur(${iItemBlur}px);` : '';
                
                const iRgba = hexToRgba(getStyle(item, 'bg_color', 'item_bg_color'), (item.bg_alpha !== undefined ? item.bg_alpha : m.item_bg_alpha) / 255);
                const icon = item.icon ? `<img ${assetImg('icon', item.icon)} class="item-icon" style="${item.icon_size ? `height:${item.icon_size}px` : ''}">` : '';

                const iNameSz = getStyle(item, 'name_size', 'item_name_size') || 26;
                const iDescSz = getStyle(item, 'desc_size', 'item_desc_size') || 16;
                const iNameFont = cssFont(getStyle(item, 'name_font', 'item_name_font'));
                const iDescFont = cssFont(getStyle(item, 'desc_font', 'item_desc_font'));
                
                // 计算功能项名称阴影
                let iNameShadowCss = shadowCss;
                if (item.item_name_shadow_enabled) {
                    const iNameShadowColor = item.item_name_shadow_color || '#000000';
                    const iNameShadowX = item.item_name_shadow_offset_x !== undefined ? item.item_name_shadow_offset_x : 2;
                    const iNameShadowY = item.item_name_shadow_offset_y !== undefined ? item.item_name_shadow_offset_y : 2;
                    const iNameShadowR = item.item_name_shadow_radius !== undefined ? item.item_name_shadow_radius : 0;
                    iNameShadowCss = `${iNameShadowX}px ${iNameShadowY}px ${iNameShadowR}px ${iNameShadowColor}`;
                }
                
                // 计算功能项描述阴影
                let iDescShadowCss = shadowCss;
                if (item.item_desc_shadow_enabled) {
                    const iDescShadowColor = item.item_desc_shadow_color || '#000000';
                    const iDescShadowX = item.item_desc_shadow_offset_x !== undefined ? item.item_desc_shadow_offset_x : 2;
                    const iDescShadowY = item.item_desc_shadow_offset_y !== undefined ? item.item_desc_shadow_offset_y : 2;
                    const iDescShadowR = item.item_desc_shadow_radius !== undefined ? item.item_desc_shadow_radius : 0;
                    iDescShadowCss = `${iDescShadowX}px ${iDescShadowY}px ${iDescShadowR}px ${iDescShadowColor}`;
                }
                
                // 网格模式按格子定位，高度交给网格轨道；自定义大小仍然优先
                const slot = gridLayout.slots[iIdx];
                let itemStyles = freeMode ? '' : gridPlacementCSS(slot);
                if (item.custom_width !== undefined) itemStyles += `width:${item.custom_width}px;`;
                if (item.custom_height !== undefined) itemStyles += `height:${item.custom_height}px;`;

                let boxH = slot.part === 'full' ? rowH : halfTrack;
                if (freeMode) boxH = parseInt(item.h) || 100;
                else if (item.custom_height !== undefined) boxH = item.custom_height;
                const fit = itemTextFit(boxH, iNameSz, iDescSz, !!item.desc);
                const descHtml = fit.descLines > 0
                    ? `<div style="color:${getStyle(item, 'desc_color', 'item_desc_color')};font-family:'${iDescFont}', sans-serif;font-size:${iDescSz}px;margin-top:5px;white-space:pre-wrap;text-shadow:${iDescShadowCss};${getTextStyleCSS(item, 'item_desc')}${lineClampCSS(fit.descLines)}">${esc(item.desc)}</div>`
                    : '';

                const txt = `
                    <div class="item-text-content" style="text-shadow:${shadowCss};">
                        <div style="color:${getStyle(item, 'name_color', 'item_name_color')};font-family:'${iNameFont}', sans-serif;font-size:${iNameSz}px;text-shadow:${iNameShadowCss};${getTextStyleCSS(item, 'item_name')}${lineClampCSS(fit.nameLines)}">${esc(item.name)}</div>
                        ${descHtml}
                    </div>`;

                if (freeMode) {
                    const isSel = selectedItem.gIdx === gIdx && selectedItem.iIdx === iIdx;
                    html += `<div class="free-item ${isSel ? 'selected' : ''}" id="item-${gIdx}-${iIdx}" style="left:${item.x}px;top:${item.y}px;width:${item.w}px;height:${item.h}px;background-color:${iRgba}; ${iBlur}" onmousedown="initItemDrag(event,${gIdx},${iIdx},'move')">${icon}${txt}${isSel ? `<div class="resize-handle" onmousedown="initItemDrag(event,${gIdx},${iIdx},'resize')"></div>` : ''}</div>`;
                } else {
                    html += `<div class="grid-item" style="background-color:${iRgba}; ${iBlur} ${itemStyles}" onclick="openContextEditor('item', ${gIdx}, ${iIdx})">${icon}${txt}</div>`;
                }
            });

            if (!freeMode) {
                // 加号占下一个空位：上一个半高项下面还空着，就放进那个下半格，点了直接补一个半高项
                const next = gridLayout.next;
                const addHalf = next.part === 'bottom';
                html += `<div class="grid-item add-item-btn" style="${gridPlacementCSS(next)}" title="${addHalf ? '在这个下半格添加半高项' : '添加功能项'}" onclick="addItem(${gIdx}, ${addHalf})"><span>+</span></div>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
    });

    cvs.innerHTML = html;
    renderWidgets(cvs, m, shadowCss);
    // 字体到货后浏览器会自动重排，不用再重绘
    menuFonts(m).forEach(loadFont);

    if (!useFixedSize) {
        requestAnimationFrame(() => {
            cvsWrapper.style.height = (cvs.offsetHeight * scale) + "px";
        });
    }
}

function renderWidgets(container, m, shadowCss) {
    (m.custom_widgets || []).forEach((wid, idx) => {
        const el = document.createElement("div");
        el.className = "draggable-widget";
        el.id = `widget-${idx}`;
        if (selectedWidgetIdx === idx) el.classList.add("selected");

        el.style.left = (parseInt(wid.x)||0) + "px";
        el.style.top = (parseInt(wid.y)||0) + "px";

        if (wid.type === 'image') {
            const imgUrl = wid.content ? `${assetUrl('widget', wid.content)}` : '';
            // 出图时组件图是直接拉伸到设定宽高的，这里照实显示，别用 cover 裁出一张出图里不存在的效果
            el.innerHTML = imgUrl ? `<img src="${imgUrl}" style="width:100%;height:100%;object-fit:fill;pointer-events:none">` : `无图`;
            el.style.width = (parseInt(wid.width)||100) + "px";
            el.style.height = (parseInt(wid.height)||100) + "px";
        } else {
            el.innerText = wid.text || "Text";
            el.style.fontSize = (parseInt(wid.size)||40) + "px";
            el.style.color = wid.color || "#FFF";
            if (wid.font) {
                el.style.fontFamily = `"${cssFont(wid.font)}", sans-serif`;
            }
            el.style.textShadow = shadowCss;
        }

        el.onmousedown = (e) => initWidgetDrag(e, idx, 'move');

        const handle = document.createElement("div");
        handle.className = "resize-handle";
        handle.onmousedown = (e) => initWidgetDrag(e, idx, 'resize');
        el.appendChild(handle);

        container.appendChild(el);
    });
}

function hexToRgba(hex, alpha) {
    let h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');   // 出图那边也认 #fff 这种简写
    const r = parseInt(h.slice(0, 2), 16),
        g = parseInt(h.slice(2, 4), 16),
        b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function getTextStyleCSS(obj, stylePrefix) {
    let css = '';
    if (obj[stylePrefix + '_bold']) css += 'font-weight:bold;';
    if (obj[stylePrefix + '_italic']) css += 'font-style:italic;';
    if (obj[stylePrefix + '_underline']) css += 'text-decoration:underline;';
    return css;
}

function toggleGroupFreeMode(gIdx, isFree) {
    const m = getCurrentMenu();
    m.groups[gIdx].free_mode = isFree;
    renderAll();
    openContextEditor('group', gIdx, -1);
}

function updateShadowFieldsVisibility(shadowId, isEnabled) {
    const elem = document.getElementById(shadowId);
    if (elem) {
        elem.style.display = isEnabled ? 'block' : 'none';
    }
}

function renderSidebarGroupList(m) {
    const list = document.getElementById("groupList");
    list.innerHTML = "";
    (m.groups || []).forEach((g, idx) => {
        const div = document.createElement("div");
        div.className = "group-item";
        const isTextGroup = g.group_type === 'text';
        const badges = [
            isTextGroup ? ' <span style="font-size:9px;background:#8b5cf6;padding:1px 3px;border-radius:2px;">纯文本</span>' : '',
            g.free_mode ? ' <span style="font-size:9px;background:#0e639c;padding:1px 3px;border-radius:2px;">自由</span>' : ''
        ].join('');
        div.innerHTML = `<div style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;"><div style="font-weight:500;">${esc(g.title)}${badges}</div></div><div class="group-actions">${isTextGroup ? '' : `<span class="icon-btn" onclick="addItem(${idx})">+</span>`}<span class="icon-btn" onclick="moveGroup(${idx}, -1)">↑</span><span class="icon-btn" onclick="moveGroup(${idx}, 1)">↓</span></div>`;
        div.firstElementChild.onclick = () => openContextEditor('group', idx, -1);
        list.appendChild(div);
    });
}

function addItem(gIdx, half) {
    const g = getCurrentMenu().groups[gIdx];
    let nextY = 20;
    if (g.free_mode) {
        let max = 0;
        g.items.forEach(i => {
            const b = (parseInt(i.y) || 0) + (parseInt(i.h) || 100);
            if (b > max) max = b;
        });
        if (max > 0) nextY = max + 15;
    }
    const item = { name: "新功能", desc: "...", icon: "", x: 20, y: nextY, w: 200, h: 80 };
    if (half) item.half = true;
    g.items.push(item);
    renderAll();
}

function moveItem(gIdx, iIdx, dir) {
    const g = getCurrentMenu().groups[gIdx];
    if (iIdx + dir < 0 || iIdx + dir >= g.items.length) return;
    [g.items[iIdx], g.items[iIdx + dir]] = [g.items[iIdx + dir], g.items[iIdx]];
    renderAll();
    // 更新选中状态和打开编辑面板
    selectedItem = { gIdx, iIdx: iIdx + dir };
    openContextEditor('item', gIdx, iIdx + dir);
}

function addGroup() {
    getCurrentMenu().groups.push({ title: "新分组", subtitle: "", items: [], free_mode: false });
    renderAll();
}

async function deleteGroup(idx) {
    const g = getCurrentMenu().groups[idx];
    const count = (g.items || []).length;
    if (!await confirmBox(`确定删除分组「${g.title || '未命名'}」${count ? `及其中的 ${count} 个功能项` : ''}？`, '删除')) return;
    getCurrentMenu().groups.splice(idx, 1);
    clearSelection();
    renderSidebarGroupList(getCurrentMenu());
}

function moveGroup(idx, dir) {
    const g = getCurrentMenu().groups;
    if (idx + dir < 0 || idx + dir >= g.length) return;
    [g[idx], g[idx + dir]] = [g[idx + dir], g[idx]];
    renderAll();
}

function addWidget(type) {
    const m = getCurrentMenu();
    if (!m.custom_widgets) m.custom_widgets = [];
    if (type === 'image') m.custom_widgets.push({ type: 'image', content: '', x: 50, y: 50, width: 100, height: 100 });
    else m.custom_widgets.push({ type: 'text', text: "新文本", x: 50, y: 50, size: 40, color: "#FFFFFF" });
    selectedWidgetIdx = m.custom_widgets.length - 1;
    renderAll();
    updateWidgetEditor(m);
}

function updateWidget(key, val) {
    if (selectedWidgetIdx === -1) return;
    const m = getCurrentMenu();
    const w = m.custom_widgets[selectedWidgetIdx];
    if (['size', 'width', 'height'].includes(key)) setNumber(w, key, val);
    else w[key] = val;
    renderCanvas(m);
}

function updateWidgetEditor(m) {
    const ed = document.getElementById("widgetEditor");
    if (selectedWidgetIdx === -1) { ed.style.display = "none"; return; }
    ed.style.display = "block";
    const w = m.custom_widgets[selectedWidgetIdx];
    if (w.type === 'image') {
        document.getElementById("wEdit-text").style.display = "none";
        document.getElementById("wEdit-image").style.display = "block";
        setValue("widW", w.width);
        setValue("widH", w.height);
        // 使用带预览的组件图片选择器
        renderImageSelect("widImgSelectPreview", "widget", w.content, (v) => { updateWidget('content', v); });
    } else {
        document.getElementById("wEdit-image").style.display = "none";
        document.getElementById("wEdit-text").style.display = "block";
        setValue("widText", w.text);
        setValue("widSize", w.size || 40);
        setValue("widColor", w.color || "#FFFFFF");
        renderSelect("widFontSelect", appState.assets.fonts, w.font || "", "默认字体");
    }
}

async function deleteWidget() {
    if (selectedWidgetIdx === -1) return;
    if (!await confirmBox("确定删除这个装饰组件？", '删除')) return;
    getCurrentMenu().custom_widgets.splice(selectedWidgetIdx, 1);
    selectedWidgetIdx = -1;
    renderAll();
}

const PROP_INT_KEYS = ['title_size', 'sub_size', 'name_size', 'desc_size', 'text_size', 'bg_alpha', 'layout_columns', 'item_height', 'width', 'height', 'x', 'y', 'w', 'h', 'group_blur_radius', 'item_blur_radius', 'canvas_width', 'canvas_height', 'icon_size', 'bg_custom_width', 'bg_custom_height', 'blur_radius', 'custom_width', 'custom_height', 'title_shadow_offset_x', 'title_shadow_offset_y', 'title_shadow_radius', 'subtitle_shadow_offset_x', 'subtitle_shadow_offset_y', 'subtitle_shadow_radius', 'group_title_shadow_offset_x', 'group_title_shadow_offset_y', 'group_title_shadow_radius', 'group_sub_shadow_offset_x', 'group_sub_shadow_offset_y', 'group_sub_shadow_radius', 'item_name_shadow_offset_x', 'item_name_shadow_offset_y', 'item_name_shadow_radius', 'item_desc_shadow_offset_x', 'item_desc_shadow_offset_y', 'item_desc_shadow_radius', 'text_shadow_offset_x', 'text_shadow_offset_y', 'text_shadow_radius', 'text_bg_alpha', 'text_bg_blur'];

function updateProp(type, gIdx, iIdx, key, val) {
    const m = getCurrentMenu();
    const obj = type === 'title' ? m : type === 'group' ? m.groups[gIdx] : m.groups[gIdx].items[iIdx];

    if (val === "" || val === undefined) delete obj[key];
    else if (PROP_INT_KEYS.includes(key)) setNumber(obj, key, val);
    else if (/_(enabled|bold|italic|underline)$/.test(key)) obj[key] = val === true || val === 'true';
    else obj[key] = val;

    if (key === 'icon' || key === 'group_type') {
        // 换图标 / 换分组类型时编辑面板里的字段也跟着变，整个重建
        renderCanvas(m);
        openContextEditor(type, gIdx, iIdx);
    } else {
        renderCanvas(m);
    }
    if (type === 'group') renderSidebarGroupList(m);
}

async function deleteCurrentItemProp(gIdx, iIdx) {
    const item = getCurrentMenu().groups[gIdx].items[iIdx];
    if (!await confirmBox(`确定删除功能项「${item.name || '未命名'}」？`, '删除')) return;
    getCurrentMenu().groups[gIdx].items.splice(iIdx, 1);
    clearSelection();
}

// 字体文件名转成 font-family。非 ASCII 字符按码位编码，
// 否则「字魂.ttf」「站酷.ttf」这类同长度的中文名会撞成同一个名字
function cssFont(n) { return n ? 'f_' + n.replace(/[^a-zA-Z0-9]/g, c => '_' + c.codePointAt(0).toString(16)) : 'sans-serif'; }

async function openAutoFillModal() {
    const modal = document.getElementById('autoFillModal');
    const listEl = document.getElementById('pluginList');
    modal.style.display = 'flex';
    listEl.innerHTML = '<div style="text-align:center; color:#888;">正在加载指令...</div>';

    try {
        if (!appState.commandsData) {
            appState.commandsData = await api("/commands");
        }
        renderAutoFillList(appState.commandsData);
    } catch (e) {
        listEl.innerHTML = `<div style="text-align:center; color:#f56c6c;">加载失败: ${e}</div>`;
    }
}

function renderAutoFillList(data) {
    const listEl = document.getElementById('pluginList');
    listEl.innerHTML = '';

    if (Object.keys(data).length === 0) {
        listEl.innerHTML = '<div style="text-align:center; color:#888;">没有找到可用的插件指令数据。</div>';
        return;
    }

    const sortedPlugins = Object.keys(data).sort();

    sortedPlugins.forEach(pluginName => {
        const cmds = data[pluginName];
        if (!cmds || cmds.length === 0) return;

        const groupDiv = document.createElement('div');
        groupDiv.style.marginBottom = '10px';

        const header = document.createElement('div');
        header.style.background = '#333';
        header.style.padding = '5px 10px';
        header.style.borderRadius = '4px';
        header.style.marginBottom = '5px';
        header.style.display = 'flex';
        header.style.alignItems = 'center';

        const pCheck = document.createElement('input');
        pCheck.type = 'checkbox';
        pCheck.id = `chk-plugin-${pluginName}`;
        pCheck.style.width = '16px'; pCheck.style.height = '16px'; pCheck.style.marginRight = '8px';
        pCheck.onclick = (e) => {
            const children = document.querySelectorAll(`.chk-item-${pluginName.replace(/[^a-zA-Z0-9]/g, '_')}`);
            children.forEach(c => c.checked = e.target.checked);
        };

        const label = document.createElement('label');
        label.innerText = pluginName;
        label.htmlFor = `chk-plugin-${pluginName}`;
        label.style.fontWeight = 'bold';
        label.style.cursor = 'pointer';

        header.appendChild(pCheck);
        header.appendChild(label);
        groupDiv.appendChild(header);

        const cmdsDiv = document.createElement('div');
        cmdsDiv.style.paddingLeft = '20px';
        cmdsDiv.style.display = 'grid';
        cmdsDiv.style.gridTemplateColumns = '1fr 1fr';
        cmdsDiv.style.gap = '5px';

        const safePName = pluginName.replace(/[^a-zA-Z0-9]/g, '_');

        cmds.forEach((cmdObj, idx) => {
            const itemDiv = document.createElement('div');
            itemDiv.style.display = 'flex';
            itemDiv.style.alignItems = 'center';

            const iCheck = document.createElement('input');
            iCheck.type = 'checkbox';
            iCheck.className = `chk-item-${safePName}`;
            iCheck.value = JSON.stringify({p: pluginName, c: cmdObj});
            iCheck.style.width = '14px'; iCheck.style.height = '14px'; iCheck.style.marginRight = '5px';

            const iLabel = document.createElement('span');
            iLabel.innerText = cmdObj.cmd;
            iLabel.title = cmdObj.desc || '';
            iLabel.style.fontSize = '12px';
            iLabel.style.color = '#ccc';

            itemDiv.appendChild(iCheck);
            itemDiv.appendChild(iLabel);
            cmdsDiv.appendChild(itemDiv);
        });

        groupDiv.appendChild(cmdsDiv);
        listEl.appendChild(groupDiv);
    });
}

function confirmAutoFill() {
    const listEl = document.getElementById('pluginList');
    const checks = listEl.querySelectorAll('input[type="checkbox"]:checked');
    const selectedData = [];

    checks.forEach(chk => {
        if (chk.value) {
            try {
                selectedData.push(JSON.parse(chk.value));
            } catch(e){}
        }
    });

    if (selectedData.length === 0) {
        toast("请先勾选要导入的指令", 'warn');
        return;
    }

    const grouped = {};
    selectedData.forEach(item => {
        if (!grouped[item.p]) grouped[item.p] = [];
        grouped[item.p].push(item.c);
    });

    const m = getCurrentMenu();
    let addedCount = 0;

    for (const [pluginName, cmds] of Object.entries(grouped)) {
        const newGroup = {
            title: pluginName,
            subtitle: "Plugin Commands",
            items: [],
            free_mode: false
        };

        cmds.forEach(c => {
            newGroup.items.push({
                name: c.cmd,
                desc: c.desc || "...",
                icon: "",
                x: 0, y: 0, w: 200, h: 80
            });
            addedCount++;
        });

        m.groups.push(newGroup);
    }

    document.getElementById('autoFillModal').style.display='none';
    renderAll();
    toast(`✅ 已导入 ${addedCount} 个指令到新分组`);
}

function clearSelection() {
    selectedItem = { gIdx: -1, iIdx: -1 };
    selectedWidgetIdx = -1;
    document.getElementById("widgetEditor").style.display = "none";
    document.getElementById("globalPanel").style.display = "block";
    document.getElementById("propPanel").style.display = "none";
    renderCanvas(getCurrentMenu());
}

function openContextEditor(type, gIdx, iIdx) {
    if (dragData.active && dragData.isDragging) return;

    selectedWidgetIdx = -1;
    if (type === 'item') {
        selectedItem = { gIdx, iIdx };
    } else {
        selectedItem = { gIdx: -1, iIdx: -1 };
    }

    document.getElementById("widgetEditor").style.display = "none";
    const m = getCurrentMenu();
    let targetObj, title, desc;
    if (type === 'title') {
        targetObj = m;
        title = "编辑主标题";
        desc = "设置菜单的主标题、副标题及全局样式";
    } else if (type === 'group') {
        targetObj = m.groups[gIdx];
        title = `编辑分组`;
        desc = "此处修改样式仅影响当前分组";
    } else if (type === 'item') {
        targetObj = m.groups[gIdx].items[iIdx];
        title = `编辑功能项`;
        desc = "此处修改样式仅影响当前选中项";
    }
    document.getElementById("globalPanel").style.display = "none";
    document.getElementById("propPanel").style.display = "block";
    document.getElementById("propTitle").innerText = title;
    document.getElementById("propDesc").innerText = desc;
    document.getElementById("propContent").innerHTML = generatePropForm(type, targetObj, gIdx, iIdx);
    renderCanvas(getCurrentMenu());
}

function selectWidget(idx) {
    if (selectedWidgetIdx !== idx) {
        selectedItem = { gIdx: -1, iIdx: -1 };
        selectedWidgetIdx = idx;

        document.getElementById("propPanel").style.display = "none";
        document.getElementById("globalPanel").style.display = "block";

        renderCanvas(getCurrentMenu());
        updateWidgetEditor(getCurrentMenu());
    }
}

function generatePropForm(type, obj, gIdx, iIdx) {
    const input = (label, key, val, itype='text', extra='') => `
        <div class="form-row">
            <label>${label}</label>
            <input type="${itype}" value="${esc(val)}" class="form-control"
                oninput="updateProp('${type}', ${gIdx}, ${iIdx}, '${key}', this.value)" ${extra}>
        </div>`;
    const textarea = (label, key, val) => `
        <div class="form-row">
            <label>${label}</label>
            <textarea class="form-control" style="height: 80px; resize: vertical;"
                oninput="updateProp('${type}', ${gIdx}, ${iIdx}, '${key}', this.value)">${esc(val)}</textarea>
        </div>`;
    const color = (label, key, globalKey) => {
        const val = obj[key] || "";
        const globalVal = (type==='title') ? (val || "#FFFFFF") : (getCurrentMenu()[globalKey] || "#FFFFFF");
        const showInherit = (type !== 'title');
        return `
        <div class="form-row">
            <label>${label} ${showInherit ? `<span style="font-size:10px;color:#aaa">${val ? '(私有)' : '(继承全局)'}</span>` : ''}</label>
            <div class="color-picker-row">
                <input type="color" value="${val || globalVal}" oninput="updateProp('${type}', ${gIdx}, ${iIdx}, '${key}', this.value)">
                <input type="text" class="color-value" value="${val}" placeholder="${showInherit?'继承':'#FFFFFF'}" onchange="updateProp('${type}', ${gIdx}, ${iIdx}, '${key}', this.value)">
                ${(showInherit && val) ? `<span class="icon-btn" onclick="updateProp('${type}', ${gIdx}, ${iIdx}, '${key}', '')" title="重置">↺</span>` : ''}
            </div>
        </div>`;
    };
    const fonts = (label, key, globalKey) => {
        const val = obj[key] || "";
        const globalVal = (type==='title') ? val : (getCurrentMenu()[globalKey] || "");
        const opts = (appState.assets.fonts || []).map(f => `<option value="${f}" ${f===val?'selected':''}>${f}</option>`).join('');
        return `
        <div class="form-row">
            <label>${label}</label>
            <select onchange="updateProp('${type}', ${gIdx}, ${iIdx}, '${key}', this.value)">
                <option value="">${type==='title' ? '-- 默认 --' : `-- 继承 (${globalVal||'默认'}) --`}</option>
                ${opts}
            </select>
        </div>`;
    };
    const textStyles = (labelPrefix, keyPrefix) => {
        const boldVal = obj[keyPrefix + '_bold'] ? 'checked' : '';
        const italicVal = obj[keyPrefix + '_italic'] ? 'checked' : '';
        const underlineVal = obj[keyPrefix + '_underline'] ? 'checked' : '';
        return `
        <div class="form-row">
            <label>${labelPrefix} 文本样式</label>
            <div style="display:flex;gap:10px;align-items:center;">
                <label style="display:flex;align-items:center;gap:5px;margin:0;cursor:pointer;">
                    <input type="checkbox" ${boldVal} onchange="updateProp('${type}', ${gIdx}, ${iIdx}, '${keyPrefix}_bold', this.checked)">
                    <strong>加粗</strong>
                </label>
                <label style="display:flex;align-items:center;gap:5px;margin:0;cursor:pointer;">
                    <input type="checkbox" ${italicVal} onchange="updateProp('${type}', ${gIdx}, ${iIdx}, '${keyPrefix}_italic', this.checked)">
                    <em>斜体</em>
                </label>
                <label style="display:flex;align-items:center;gap:5px;margin:0;cursor:pointer;">
                    <input type="checkbox" ${underlineVal} onchange="updateProp('${type}', ${gIdx}, ${iIdx}, '${keyPrefix}_underline', this.checked)">
                    <u>下划线</u>
                </label>
            </div>
        </div>`;
    };
    const shadowSettings = (labelPrefix, keyPrefix) => {
        const enabledVal = obj[keyPrefix + '_shadow_enabled'] ? 'checked' : '';
        const colorVal = obj[keyPrefix + '_shadow_color'] || '#000000';
        const offsetXVal = obj[keyPrefix + '_shadow_offset_x'] !== undefined ? obj[keyPrefix + '_shadow_offset_x'] : '';
        const offsetYVal = obj[keyPrefix + '_shadow_offset_y'] !== undefined ? obj[keyPrefix + '_shadow_offset_y'] : '';
        const radiusVal = obj[keyPrefix + '_shadow_radius'] !== undefined ? obj[keyPrefix + '_shadow_radius'] : '';
        const globalMenu = getCurrentMenu();
        const shadowId = `shadow-${type}-${gIdx}-${iIdx}-${keyPrefix}`;
        return `
        <div style="background:#333;padding:10px;border-radius:4px;margin:10px 0;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                <label style="display:flex;align-items:center;gap:5px;margin:0;cursor:pointer;flex:1">
                    <input type="checkbox" ${enabledVal} onchange="updateProp('${type}', ${gIdx}, ${iIdx}, '${keyPrefix}_shadow_enabled', this.checked); updateShadowFieldsVisibility('${shadowId}', this.checked)">
                    <strong>${labelPrefix}阴影</strong>
                    <span style="font-size:10px;color:#aaa">${obj[keyPrefix + '_shadow_enabled'] ? '(自定义)' : '(继承全局)'}</span>
                </label>
            </div>
            <div id="${shadowId}" style="display:${obj[keyPrefix + '_shadow_enabled'] ? 'block' : 'none'};">
                <div class="form-row" style="margin:5px 0;">
                    <label style="font-size:12px;">颜色</label>
                    <input type="color" value="${colorVal}" oninput="updateProp('${type}', ${gIdx}, ${iIdx}, '${keyPrefix}_shadow_color', this.value)" style="height:30px;cursor:pointer;">
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:5px 0;">
                    <div class="form-row" style="margin:0;">
                        <label style="font-size:12px;">偏移X</label>
                        <input type="number" value="${offsetXVal}" oninput="updateProp('${type}', ${gIdx}, ${iIdx}, '${keyPrefix}_shadow_offset_x', this.value)" placeholder="2">
                    </div>
                    <div class="form-row" style="margin:0;">
                        <label style="font-size:12px;">偏移Y</label>
                        <input type="number" value="${offsetYVal}" oninput="updateProp('${type}', ${gIdx}, ${iIdx}, '${keyPrefix}_shadow_offset_y', this.value)" placeholder="2">
                    </div>
                </div>
                <div class="form-row" style="margin:5px 0;">
                    <label style="font-size:12px;">模糊半径</label>
                    <input type="range" min="0" max="20" value="${radiusVal}" oninput="updateProp('${type}', ${gIdx}, ${iIdx}, '${keyPrefix}_shadow_radius', this.value)">
                </div>
            </div>
        </div>`;
    };
    let html = "";
    if (type === 'title') {
        html += input("主标题内容", "title", obj.title);
        html += input("副标题内容", "sub_title", obj.sub_title);
        html += `<div class="form-row"><label>对齐方式</label>
        <select onchange="updateProp('${type}', 0, 0, 'title_align', this.value)">
            <option value="center" ${obj.title_align==='center'?'selected':''}>居中</option>
            <option value="left" ${obj.title_align==='left'?'selected':''}>居左</option>
            <option value="right" ${obj.title_align==='right'?'selected':''}>居右</option>
        </select></div>`;
        html += `<hr style="border-color:#444; margin: 20px 0;">`;
        html += `<div class="section-title">样式设置</div>`;
        html += color("主标题颜色", "title_color", "title_color");
        html += input("主标题大小 (px)", "title_size", obj.title_size, "number");
        html += fonts("主标题字体", "title_font", "title_font");
        html += textStyles("主标题", "title");
        html += shadowSettings("主标题", "title");
        html += color("副标题颜色", "subtitle_color", "subtitle_color");
        html += input("副标题大小 (px)", "subtitle_size", obj.subtitle_size, "number", "placeholder='默认'");
        html += fonts("副标题字体", "subtitle_font", "subtitle_font");
        html += textStyles("副标题", "subtitle");
        html += shadowSettings("副标题", "subtitle");
    } else if (type === 'group') {
        html += input("分组标题", "title", obj.title);
        html += input("副标题", "subtitle", obj.subtitle);

        const currentAlign = obj.sub_align || "";
        const globalAlign = getCurrentMenu().group_sub_align || "bottom";
        html += `
        <div class="form-row">
            <label>副标题对齐方式 <span style="font-size:10px;color:#aaa">(${obj.sub_align ? '私有' : '全局:'+globalAlign})</span></label>
            <select onchange="updateProp('${type}', ${gIdx}, ${iIdx}, 'sub_align', this.value)">
                <option value="">-- 继承 --</option>
                <option value="bottom" ${currentAlign==='bottom'?'selected':''}>底对齐 (Bottom)</option>
                <option value="center" ${currentAlign==='center'?'selected':''}>居中 (Center)</option>
                <option value="top" ${currentAlign==='top'?'selected':''}>顶对齐 (Top)</option>
            </select>
        </div>`;

        html += input("每行列数 (Grid模式)", "layout_columns", obj.layout_columns, "number", "placeholder='默认跟随全局'");
        html += input("行高 (px, Grid模式)", "item_height", obj.item_height, "number", "placeholder='默认跟随全局'");
        
        // 分组类型选择
        const isTextGroup = obj.group_type === 'text';
        html += `<div class="form-row">
            <label>分组类型</label>
            <select onchange="updateProp('${type}', ${gIdx}, ${iIdx}, 'group_type', this.value)">
                <option value="normal" ${(!obj.group_type || obj.group_type === 'normal')?'selected':''}>功能项分组</option>
                <option value="text" ${obj.group_type === 'text'?'selected':''}>纯文本分组</option>
            </select>
        </div>`;
        
        // 纯文本分组的文本内容编辑
        if (isTextGroup) {
            html += textarea("文本内容", "text_content", obj.text_content || obj.subtitle || "");
            html += `<hr style="border-color:#444; margin: 20px 0;">`;
            html += `<div class="section-title">纯文本样式</div>`;
            html += color("文本颜色", "text_color", "group_sub_color");
            html += input("文本大小 (px)", "text_size", obj.text_size, "number", "placeholder='默认30'");
            html += fonts("文本字体", "text_font", "group_sub_font");
            html += textStyles("文本", "text");
            html += shadowSettings("文本", "text");
            
            html += `<hr style="border-color:#444; margin: 20px 0;">`;
            html += `<div class="section-title">背景毛玻璃效果</div>`;
            html += color("背景颜色", "text_bg_color", "group_sub_bg_color");
            html += input("背景透明度", "text_bg_alpha", obj.text_bg_alpha, "range", "min='0' max='255' placeholder='0-255'");
            html += input("模糊半径", "text_bg_blur", obj.text_bg_blur, "number", "min='0' placeholder='0-15'");
            
            html += `<div class="form-row" style="background:#333;padding:10px;border-radius:4px;margin-top:10px;display:flex;align-items:center;justify-content:space-between">
                <label style="margin:0">✨ 自由排版模式</label>
                <input type="checkbox" ${obj.free_mode?'checked':''} onclick="toggleGroupFreeMode(${gIdx}, this.checked)" style="width:20px;height:20px;" disabled>
            </div>`;
            html += `<button class="btn btn-danger btn-block" style="margin-top:10px" onclick="deleteGroup(${gIdx})">删除此分组</button>`;
        } else {
            // 功能项分组的设置
            html += `<div class="form-row" style="background:#333;padding:10px;border-radius:4px;margin-top:10px;display:flex;align-items:center;justify-content:space-between">
                <label style="margin:0">✨ 自由排版模式</label>
                <input type="checkbox" ${obj.free_mode?'checked':''} onclick="toggleGroupFreeMode(${gIdx}, this.checked)" style="width:20px;height:20px;">
            </div>`;
            html += `<button class="btn btn-danger btn-block" style="margin-top:10px" onclick="deleteGroup(${gIdx})">删除此分组</button>`;
            
            // 毛玻璃设置 (仅功能项分组)
            html += `<hr style="border-color:#444; margin: 20px 0;">`;
            html += `<div class="section-title">毛玻璃效果</div>`;
            html += color("背景颜色", "bg_color", "group_bg_color");
            html += `<div class="form-row"><label>背景透明度 (0-255)</label><input type="range" max="255" value="${obj.bg_alpha!==undefined?obj.bg_alpha:''}" oninput="updateProp('${type}', ${gIdx}, ${iIdx}, 'bg_alpha', this.value)"></div>`;
            html += input("毛玻璃模糊半径 (px)", "blur_radius", obj.blur_radius, "number", "placeholder='默认继承全局'");
            html += input("自定义宽度 (px)", "custom_width", obj.custom_width, "number", "placeholder='默认自适应'");
            html += input("自定义高度 (px)", "custom_height", obj.custom_height, "number", "placeholder='默认自适应'");
        }
        
        // 分组样式设置（对所有分组类型）
        html += `<hr style="border-color:#444; margin: 20px 0;">`;
        html += `<div class="section-title">样式覆盖 (独立设置)</div>`;
        html += color("标题颜色", "title_color", "group_title_color");
        html += input("标题大小 (px)", "title_size", obj.title_size, "number", "placeholder='默认'");
        html += fonts("标题字体", "title_font", "group_title_font");
        html += textStyles("标题", "group_title");
        html += shadowSettings("标题", "group_title");
        html += color("副标题颜色", "sub_color", "group_sub_color");
        html += input("副标题大小 (px)", "sub_size", obj.sub_size, "number", "placeholder='默认'");
        html += fonts("副标题字体", "sub_font", "group_sub_font");
        html += textStyles("副标题", "group_sub");
        html += shadowSettings("副标题", "group_sub");
    } else if (type === 'item') {
        html += input("功能名称", "name", obj.name);
        html += textarea("功能描述", "desc", obj.desc);

        // 图标选择器 - 使用全局函数调用
        const iconPreview = obj.icon ? 
            `<img ${assetImg('icon', obj.icon, true)} style="width:32px;height:32px;object-fit:cover;border-radius:4px;border:1px solid #555;">` :
            `<div style="width:32px;height:32px;background:#333;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#666;font-size:12px;border:1px solid #555;">无</div>`;
        html += `
        <div class="form-row">
            <label>图标</label>
            <div style="display:flex; gap:5px; align-items:center;">
                <div style="flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;padding:5px;background:#2a2a2a;border-radius:4px;border:1px solid #444;" onclick="openIconPicker(${gIdx}, ${iIdx})">
                    ${iconPreview}
                    <span style="flex:1;font-size:12px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(obj.icon || '点击选择...')}</span>
                    <span style="color:#888;font-size:14px;">▼</span>
                </div>
                <button class="btn btn-secondary" onclick="document.getElementById('itemIconUp').click()" title="上传新图标">⬆</button>
                <input type="file" id="itemIconUp" hidden accept="image/*" multiple onchange="uploadFile('icon', this)">
            </div>
        </div>`;

        if (obj.icon) {
            html += input("图标高度 (px)", "icon_size", obj.icon_size, "number", "placeholder='默认自适应'");
        }

        // 在非自由模式下显示顺序调整按钮
        const m = getCurrentMenu();
        const grp = m.groups[gIdx];
        if (!grp.free_mode) {
            const canMoveUp = iIdx > 0;
            const canMoveDown = iIdx < grp.items.length - 1;
            html += `<div class="form-row" style="display:flex;gap:5px;">
                <button class="btn btn-secondary" ${!canMoveUp ? 'disabled' : ''} onclick="moveItem(${gIdx}, ${iIdx}, -1)">⬆ 前进一位</button>
                <button class="btn btn-secondary" ${!canMoveDown ? 'disabled' : ''} onclick="moveItem(${gIdx}, ${iIdx}, 1)">⬇ 后退一位</button>
            </div>`;
            html += `<div class="form-row">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;">
                    <input type="checkbox" ${obj.half ? 'checked' : ''} onchange="updateProp('item', ${gIdx}, ${iIdx}, 'half', this.checked || '')" style="width:18px;height:18px;">
                    半高（占半行，相邻两个半高项上下叠在同一格）
                </label>
                <div style="font-size:11px;color:#888;margin-top:4px;">默认行高 90 时半高格只放得下一行名称；想同时显示描述，把分组或全局的行高调到 140 左右。</div>
            </div>`;
        }

        html += `<button class="btn btn-danger btn-block" style="margin-top:10px" onclick="deleteCurrentItemProp(${gIdx}, ${iIdx})">删除此功能项</button>`;
        html += `<hr style="border-color:#444; margin: 20px 0;">`;
        html += `<div class="section-title">样式覆盖 (独立设置)</div>`;
        html += color("名称颜色", "name_color", "item_name_color");
        html += input("名称大小 (px)", "name_size", obj.name_size, "number", "placeholder='默认'");
        html += fonts("名称字体", "name_font", "item_name_font");
        html += textStyles("名称", "item_name");
        html += color("描述颜色", "desc_color", "item_desc_color");
        html += input("描述大小 (px)", "desc_size", obj.desc_size, "number", "placeholder='默认'");
        html += fonts("描述字体", "desc_font", "item_desc_font");
        html += textStyles("描述", "item_desc");
        html += shadowSettings("名称", "item_name");
        html += shadowSettings("描述", "item_desc");
        
        // 毛玻璃效果
        html += `<hr style="border-color:#444; margin: 20px 0;">`;
        html += `<div class="section-title">毛玻璃效果</div>`;
        html += color("背景颜色", "bg_color", "item_bg_color");
        html += `<div class="form-row"><label>背景透明度 (0-255)</label><input type="range" max="255" value="${obj.bg_alpha!==undefined?obj.bg_alpha:''}" oninput="updateProp('${type}', ${gIdx}, ${iIdx}, 'bg_alpha', this.value)"></div>`;
        html += input("毛玻璃模糊半径 (px)", "blur_radius", obj.blur_radius, "number", "placeholder='默认继承全局'");
        html += input("自定义宽度 (px)", "custom_width", obj.custom_width, "number", "placeholder='默认自适应'");
        html += input("自定义高度 (px)", "custom_height", obj.custom_height, "number", "placeholder='默认自适应'");
    }
    return html;
}

function initItemDrag(e, gIdx, iIdx, mode) {
    if (e.button !== 0) return;
    const m = getCurrentMenu();
    const grp = m.groups[gIdx];
    if (!grp.free_mode) return;
    e.stopPropagation();

    openContextEditor('item', gIdx, iIdx);

    const item = grp.items[iIdx];
    const el = document.getElementById(`item-${gIdx}-${iIdx}`);
    if (!el) return;

    const zoom = viewState.scale;

    dragData = {
        active: true,
        isDragging: false,
        mode: mode,
        type: 'item',
        gIdx: gIdx,
        iIdx: iIdx,
        startX: e.clientX,
        startY: e.clientY,
        initialVals: { x: item.x, y: item.y, w: item.w, h: item.h },
        cachedEl: el,
        zoom: zoom
    };
}

function initWidgetDrag(e, wIdx, mode) {
    if (e.button !== 0) return;
    e.stopPropagation();

    selectWidget(wIdx);

    const m = getCurrentMenu();
    const w = m.custom_widgets[wIdx];
    const el = document.getElementById(`widget-${wIdx}`);
    if (!el) return;

    const zoom = viewState.scale;

    dragData = {
        active: true,
        isDragging: false,
        mode: mode,
        type: 'widget',
        targetIdx: wIdx,
        startX: e.clientX,
        startY: e.clientY,
        initialVals: { x: w.x, y: w.y, w: w.width||100, h: w.height||100 },
        cachedEl: el,
        zoom: zoom
    };
}

function handleGlobalMouseMove(e) {
    if (!dragData.active) return;
    if (!dragData.isDragging) {
        if (Math.abs(e.clientX - dragData.startX) > 3 || Math.abs(e.clientY - dragData.startY) > 3) {
            dragData.isDragging = true;
            // 拖动开始时添加拖动样式
            if (dragData.cachedEl) {
                dragData.cachedEl.style.willChange = 'transform';
                dragData.cachedEl.style.zIndex = '9999';
            }
        } else return;
    }

    e.preventDefault();

    // 使用 RAF 节流，但核心逻辑使用 CSS transform 实现流畅拖动
    if (!rafLock) {
        rafLock = true;
        requestAnimationFrame(() => {
            if (!dragData.cachedEl) { rafLock = false; return; }
            
            const dx = (e.clientX - dragData.startX) / dragData.zoom;
            const dy = (e.clientY - dragData.startY) / dragData.zoom;

            if (dragData.mode === 'move') {
                // 使用 CSS transform 进行流畅移动，不更新数据
                dragData.cachedEl.style.transform = `translate(${dx}px, ${dy}px)`;
                // 缓存当前偏移量
                dragData.currentDx = dx;
                dragData.currentDy = dy;
            } else {
                // resize 模式：计算新尺寸
                let nw = dragData.initialVals.w + dx;
                let nh = dragData.initialVals.h + dy;
                if (nw < 20) nw = 20;
                if (nh < 20) nh = 20;
                
                dragData.cachedEl.style.width = Math.round(nw) + "px";
                dragData.cachedEl.style.height = Math.round(nh) + "px";
                // 缓存当前尺寸
                dragData.currentW = nw;
                dragData.currentH = nh;
            }
            rafLock = false;
        });
    }
}

function handleGlobalMouseUp(e) {
    if (dragData.active && dragData.isDragging) {
        const m = getCurrentMenu();
        let obj;
        
        if (dragData.type === 'item') {
            obj = m.groups[dragData.gIdx].items[dragData.iIdx];
        } else {
            obj = m.custom_widgets[dragData.targetIdx];
        }

        if (dragData.mode === 'move' && dragData.currentDx !== undefined) {
            // 计算最终位置
            let nx = dragData.initialVals.x + dragData.currentDx;
            let ny = dragData.initialVals.y + dragData.currentDy;
            
            // 吸附到0
            if (Math.abs(nx) < 10) nx = 0;
            if (Math.abs(ny) < 10) ny = 0;
            
            obj.x = Math.round(nx);
            obj.y = Math.round(ny);
        } else if (dragData.mode === 'resize') {
            if (dragData.type === 'item') {
                obj.w = Math.round(dragData.currentW || dragData.initialVals.w);
                obj.h = Math.round(dragData.currentH || dragData.initialVals.h);
            } else {
                obj.width = Math.round(dragData.currentW || dragData.initialVals.w);
                obj.height = Math.round(dragData.currentH || dragData.initialVals.h);
            }
        }

        // 清除拖动样式
        if (dragData.cachedEl) {
            dragData.cachedEl.style.transform = '';
            dragData.cachedEl.style.willChange = '';
            dragData.cachedEl.style.zIndex = '';
        }

        // 重绘画布更新最终位置
        renderCanvas(m);
        
        if (dragData.type === 'widget') updateWidgetEditor(m);
        else if (dragData.type === 'item') openContextEditor('item', dragData.gIdx, dragData.iIdx);
    }
    
    // 重置拖动状态
    dragData.active = false;
    dragData.isDragging = false;
    dragData.cachedEl = null;
    dragData.currentDx = undefined;
    dragData.currentDy = undefined;
    dragData.currentW = undefined;
    dragData.currentH = undefined;
}

function isTyping() {
    const el = document.activeElement;
    return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
}

function handleKeyDown(e) {
    // 有弹窗开着时不响应画布快捷键
    if (document.querySelector('.modal-overlay[style*="flex"]')) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isTyping()) return;

        if (selectedWidgetIdx !== -1) deleteWidget();
        else if (selectedItem.gIdx !== -1) deleteCurrentItemProp(selectedItem.gIdx, selectedItem.iIdx);
    }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
        if (isTyping()) return;
        e.preventDefault();

        const m = getCurrentMenu();
        let obj, updateFn;

        if (selectedWidgetIdx !== -1) {
            obj = m.custom_widgets[selectedWidgetIdx];
            updateFn = () => updateWidgetEditor(m);
        } else if (selectedItem.gIdx !== -1 && m.groups[selectedItem.gIdx].free_mode) {
            obj = m.groups[selectedItem.gIdx].items[selectedItem.iIdx];
            updateFn = () => openContextEditor('item', selectedItem.gIdx, selectedItem.iIdx);
        } else return;

        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft') obj.x = (parseInt(obj.x)||0) - step;
        if (e.key === 'ArrowRight') obj.x = (parseInt(obj.x)||0) + step;
        if (e.key === 'ArrowUp') obj.y = (parseInt(obj.y)||0) - step;
        if (e.key === 'ArrowDown') obj.y = (parseInt(obj.y)||0) + step;

        renderCanvas(m);
        updateFn();
    }
}

// =============================================================
//  通用图片选择器
// =============================================================

const PICKER_TYPES = {
    background: { list: 'backgrounds', title: '选择背景图片' },
    icon: { list: 'icons', title: '选择图标' },
    widget: { list: 'widget_imgs', title: '选择组件图片' },
};

let imagePicker = { type: '', current: '', callback: null };

function openImagePicker(type, currentValue, callback) {
    imagePicker = { type, current: currentValue || '', callback };
    document.getElementById('imagePickerTitle').innerText = PICKER_TYPES[type].title;
    document.getElementById('imagePickerSearch').value = '';
    renderImagePickerGrid('');
    document.getElementById('imagePickerModal').style.display = 'flex';
}

function renderImagePickerGrid(keyword) {
    const container = document.getElementById('imagePickerGrid');
    const all = appState.assets[PICKER_TYPES[imagePicker.type].list] || [];
    const kw = (keyword || '').trim().toLowerCase();
    const images = kw ? all.filter(n => n.toLowerCase().includes(kw)) : all;
    container.innerHTML = '';

    if (all.length === 0) {
        container.innerHTML = '<div style="color:#888; text-align:center; grid-column:1/-1; padding:40px;">暂无图片，请先上传</div>';
        return;
    }

    const none = document.createElement('div');
    none.className = 'image-picker-item' + (!imagePicker.current ? ' selected' : '');
    none.innerHTML = '<div class="picker-none">✕</div><span>无</span>';
    none.onclick = () => doSelectImage('');
    container.appendChild(none);

    if (images.length === 0) {
        container.insertAdjacentHTML('beforeend', '<div style="color:#888; text-align:center; grid-column:1/-1; padding:20px;">没有匹配的图片</div>');
        return;
    }

    images.forEach(name => {
        const item = document.createElement('div');
        item.className = 'image-picker-item' + (name === imagePicker.current ? ' selected' : '');
        item.title = name;
        item.innerHTML = `
            <img ${assetImg(imagePicker.type, name, true)}>
            <span>${esc(name)}</span>
            <div class="asset-actions">
                <button class="btn btn-xs" title="下载">📥</button>
                <button class="btn btn-xs btn-danger" title="删除">🗑</button>
            </div>`;
        const [dl, del] = item.querySelectorAll('.asset-actions button');
        dl.onclick = (e) => { e.stopPropagation(); downloadAsset(imagePicker.type, name); };
        del.onclick = (e) => { e.stopPropagation(); deleteAssetAndRefresh(imagePicker.type, name); };
        item.onclick = () => doSelectImage(name);
        container.appendChild(item);
    });
}

function filterImagePicker(keyword) {
    renderImagePickerGrid(keyword);
}

function doSelectImage(value) {
    const callback = imagePicker.callback;
    closeImagePicker();
    if (callback) callback(value);
}

function closeImagePicker() {
    document.getElementById('imagePickerModal').style.display = 'none';
    imagePicker.callback = null;
}

async function downloadAsset(kind, name) {
    try {
        const sdk = await bridge();
        await sdk.download('asset/download', { kind, name }, name);
    } catch (e) {
        toast("❌ 下载失败：" + errMsg(e), 'error', 6000);
    }
}

// 还在用这个素材的菜单，删除前提醒一句
function assetUsers(kind, name) {
    return appState.fullConfig.menus.filter(m => {
        if (kind === 'background') return m.background === name || (m.backgrounds || []).includes(name);
        if (kind === 'icon') return (m.groups || []).some(g => (g.items || []).some(i => i.icon === name));
        if (kind === 'widget') return (m.custom_widgets || []).some(w => w.type === 'image' && w.content === name);
        return false;
    }).map(m => m.name);
}

async function deleteAssetAndRefresh(kind, name) {
    const users = assetUsers(kind, name);
    const warn = users.length ? `\n\n「${users.join('」「')}」还在用它，删掉后那里会变成空白。` : '';
    if (!await confirmBox(`确定删除素材「${name}」？此操作不可撤销。${warn}`, '删除')) return;

    try {
        await api("/asset/delete", "POST", { kind, name });
        for (const key of [`${kind}/${name}`, `${kind}/${name}#t`]) {
            const url = assetCache.get(key);
            if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
            assetCache.delete(key);
        }
        await loadAssets();
        renderAll();
        if (document.getElementById('imagePickerModal').style.display === 'flex') {
            renderImagePickerGrid(document.getElementById('imagePickerSearch').value);
        }
        toast("✅ 已删除 " + name);
    } catch (e) {
        toast("❌ 删除失败：" + errMsg(e), 'error', 6000);
    }
}

function openIconPicker(gIdx, iIdx) {
    const item = getCurrentMenu().groups[gIdx].items[iIdx];
    openImagePicker('icon', item.icon || '', v => updateProp('item', gIdx, iIdx, 'icon', v));
}

// =============================================================
//  带预览的选择器渲染（用于侧边栏）
// =============================================================
function renderImageSelect(containerId, type, currentValue, onChangeCallback) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const preview = currentValue
        ? `<img ${assetImg(type, currentValue, true)} class="select-preview-img">`
        : '<div class="select-preview-img select-preview-none">无</div>';
    container.innerHTML = `
        <div class="image-select">
            ${preview}
            <span class="image-select-name" title="${esc(currentValue)}">${esc(currentValue || '点击选择...')}</span>
            <span style="color:#888;font-size:14px;flex-shrink:0;">▼</span>
        </div>`;
    container.firstElementChild.onclick = () => openImagePicker(type, currentValue || '', onChangeCallback);
}


// =============================================================
//  随机背景功能
// =============================================================

function openRandomBgModal() {
    const m = getCurrentMenu();
    const bgList = appState.assets.backgrounds || [];
    const selectedBgs = m.backgrounds || [];

    const container = document.getElementById('randomBgCheckList');
    container.innerHTML = '';

    if (bgList.length === 0) {
        container.innerHTML = '<div style="color:#888; text-align:center; grid-column:1/-1;">暂无背景图片，请先上传</div>';
        document.getElementById('randomBgModal').style.display = 'flex';
        return;
    }

    bgList.forEach(bg => {
        const item = document.createElement('label');
        item.style.cssText = 'display:flex; align-items:center; gap:8px; padding:5px; background:#333; border-radius:4px; cursor:pointer;';
        item.innerHTML = `
            <input type="checkbox" class="random-bg-check" value="${esc(bg)}" ${selectedBgs.includes(bg) ? 'checked' : ''} style="width:16px;height:16px;">
            <img ${assetImg('background', bg, true)} style="width:40px;height:40px;object-fit:cover;border-radius:4px;">
            <span style="font-size:11px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="${esc(bg)}">${esc(bg)}</span>
        `;
        container.appendChild(item);
    });

    document.getElementById('randomBgModal').style.display = 'flex';
}

function confirmRandomBgSelection() {
    const m = getCurrentMenu();
    m.backgrounds = Array.from(document.querySelectorAll('.random-bg-check:checked')).map(c => c.value);
    document.getElementById('randomBgModal').style.display = 'none';
    renderRandomBgList();
    renderCanvas(m);   // 画布预览的背景可能跟着变
}

function renderRandomBgList() {
    const m = getCurrentMenu();
    const container = document.getElementById('randomBgList');
    if (!container) return;

    const bgList = m.backgrounds || [];
    const hint = document.getElementById('randomBgHint');
    if (hint) hint.style.display = bgList.length ? 'block' : 'none';

    if (bgList.length === 0) {
        container.innerHTML = '<div style="color:#666; font-size:11px; text-align:center;">未配置随机背景</div>';
        return;
    }

    container.innerHTML = '';
    bgList.forEach((bg, idx) => {
        const chip = document.createElement('div');
        chip.className = 'random-bg-chip';
        chip.innerHTML = `
            <img ${assetImg('background', bg, true)}>
            <span title="${esc(bg)}">${esc(bg)}</span>
            <span class="chip-x" title="移出随机列表">&times;</span>`;
        chip.querySelector('.chip-x').onclick = () => removeRandomBg(idx);
        container.appendChild(chip);
    });
}

function removeRandomBg(idx) {
    const m = getCurrentMenu();
    m.backgrounds = (m.backgrounds || []).filter((_, i) => i !== idx);
    renderRandomBgList();
    renderCanvas(m);
}
